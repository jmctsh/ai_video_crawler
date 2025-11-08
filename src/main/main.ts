const { app, BrowserWindow, ipcMain, dialog } = require('electron')
import path from 'path'
import fs from 'fs'
import type { IpcMainInvokeEvent } from 'electron'
import { createDoubaoClientFromEnv } from './doubaoClient'
import { startCoordinator, getCoordinatorStatus } from './coordinator'
import { startCoordinatorLLM, getCoordinatorLLMStatus } from './coordinatorLLM'
import { downloadAndMerge, runStoredAlgorithm, probeMedia } from './tools/downloader'
import { runHumanAcceptanceFlowWithStore } from './tools/humanAcceptanceFlow'
import { spawnSync } from 'child_process'
import { cleanupAlgorithmMakingCaches, cleanupLogsTransientDirs } from './tools/cacheCleanup'
import { ensureSampleSeed, listAlgorithms as listAlgoFiles, readAlgorithmCode, deleteAlgorithm as deleteAlgorithmFile } from './tools/algStore'

let mainWindow: any = null
let selectedDownloadDir: string | null = null

// 在主进程启动时加载 .env 到 process.env，避免出现 Missing ARK_API_KEY 等环境变量缺失
function bootstrapEnvFromDotenv() {
  try {
    const envPath = path.join(process.cwd(), '.env')
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8')
      const lines = content.split(/\r?\n/)
      for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (m) {
          const key = m[1]
          const value = m[2]
          if (!process.env[key]) process.env[key] = value
        }
      }
    }
  } catch (e) {
    console.error('Failed to bootstrap env from .env:', e)
  }
}

bootstrapEnvFromDotenv()

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // 允许在开发环境下从 http 页面加载 file:// 视频预览
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  })
  mainWindow = win
  mainWindow.loadURL('http://localhost:5173/')
}

function findFfmpegPath(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(process.cwd(), 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : null,
    path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean) as string[]
  for (const fp of candidates) {
    try {
      const r = spawnSync(fp, ['-version'], { stdio: 'ignore' })
      if (r.status === 0) return fp
    } catch {}
  }
  return null
}

function ensureMp4(srcPath: string, finalDir: string, baseName: string): { ok: boolean; outPath?: string; notes?: string } {
  const ext = path.extname(srcPath).toLowerCase()
  const target = path.join(finalDir, `${baseName}.mp4`)
  if (ext === '.mp4') {
    try {
      fs.copyFileSync(srcPath, target)
      return { ok: true, outPath: target, notes: 'copied mp4' }
    } catch (e: any) {
      return { ok: false, notes: e?.message || String(e) }
    }
  }
  const ffmpegPath = findFfmpegPath()
  if (!ffmpegPath) {
    return { ok: false, notes: 'ffmpeg not found; cannot produce mp4' }
  }
  const run = spawnSync(ffmpegPath, ['-y', '-i', srcPath, '-c', 'copy', target], { stdio: 'ignore' })
  if (run.status === 0 && fs.existsSync(target)) {
    return { ok: true, outPath: target, notes: 'remuxed to mp4' }
  }
  return { ok: false, notes: 'ffmpeg remux failed' }
}

async function performDownload(url: string, algorithmName?: string, targetDir?: string) {
  const downloadsDir = targetDir || selectedDownloadDir || path.join(process.cwd(), 'downloads')
  fs.mkdirSync(downloadsDir, { recursive: true })
  const safeName = url.replace(/[^a-z0-9]/gi, '_').slice(0, 60) || `video_${Date.now()}`

  BrowserWindow.getAllWindows()[0]?.webContents.send('download-progress', `执行算法并构建清单变体：${algorithmName || '(未指定)'}`)
  const out = await runHumanAcceptanceFlowWithStore({ algorithmName, pageUrl: url })
  if (!out?.filePath) throw new Error(out?.notes || '下载失败（无文件输出）')

  // 若人类验证为否，则删除临时文件并中断，不拷贝到目标文件夹
  if (out?.isCorrect === false) {
    try {
      if (fs.existsSync(out.filePath)) fs.unlinkSync(out.filePath)
    } catch {}
    BrowserWindow.getAllWindows()[0]?.webContents.send('download-progress', '用户拒绝：已删除临时文件')
    throw new Error('用户拒绝：已删除临时文件')
  }

  const probe = probeMedia(out.filePath)
  BrowserWindow.getAllWindows()[0]?.webContents.send('download-progress', `验收下载完成：${probe.size} bytes (${probe.ext || '?'})`)

  const mp4Res = ensureMp4(out.filePath, downloadsDir, safeName)
  if (!mp4Res.ok || !mp4Res.outPath) throw new Error(mp4Res.notes || '无法生成 MP4')
  return mp4Res.outPath
}

app.whenReady().then(async () => {
  createWindow()

  ipcMain.handle('choose-save-dir', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择保存目录',
        properties: ['openDirectory', 'createDirectory']
      })
      let dir: string | null = null
      if (!result.canceled && result.filePaths?.[0]) {
        selectedDownloadDir = result.filePaths[0]
        dir = selectedDownloadDir
      }
      if (mainWindow) {
        // 关闭对话框后恢复主窗口焦点，避免出现黑屏/未重绘的情况
        mainWindow.focus()
      }
      return dir
    } catch (e) {
      console.error('choose-save-dir failed:', e)
      return null
    }
  })

  ipcMain.on('start-download', async (_evt: import('electron').IpcMainEvent, payload: { url: string; algorithm?: string; algo?: string; saveDir?: string }) => {
    const { url, algorithm, algo, saveDir } = payload
    BrowserWindow.getAllWindows()[0]?.webContents.send('download-progress', `已接收：${algorithm} | ${url}`)
    try {
      const filePath = await performDownload(url, algorithm || algo, saveDir)
      BrowserWindow.getAllWindows()[0]?.webContents.send('download-complete', filePath)
    } catch (e: any) {
      BrowserWindow.getAllWindows()[0]?.webContents.send('download-progress', `错误：${e?.message ?? e}`)
      // 显式错误事件：通知渲染进程重置按钮与状态
      try { BrowserWindow.getAllWindows()[0]?.webContents.send('download-error', e?.message ?? String(e)) } catch {}
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 在应用退出前清理缓存（保留 agents_raw.md 并重命名加系统时间）
app.on('before-quit', () => {
  try { cleanupAlgorithmMakingCaches() } catch {}
  // 退出时清理一次性日志：debug 与 uploads
  try { cleanupLogsTransientDirs() } catch {}
})

app.whenReady().then(async () => {
  // 迁移为“统一算法文件夹”管理：启动时确保目录存在并在为空时写入占位示例
  ensureSampleSeed()

  ipcMain.handle('alg:list', async () => {
    return listAlgoFiles()
  })

  ipcMain.handle('alg:get', async (_evt: IpcMainInvokeEvent, name: string) => {
    const code = readAlgorithmCode(name)
    if (code == null) return null
    const meta = listAlgoFiles().find((x) => x.name === name)
    return { name, code, createdAt: meta?.createdAt || Date.now() }
  })

  ipcMain.handle('alg:delete', async (_evt: IpcMainInvokeEvent, name: string) => {
    const res = deleteAlgorithmFile(name)
    if (!res.ok || res.removed.length === 0) return { success: false, message: 'Algorithm not found' }
    return { success: true }
  })

  // ========= API 管理（LLM Agents）存储与 .env 同步 =========
  const agentsStoreFile = path.join(app.getPath('userData'), 'agents.json')
  type AgentConfig = { name: string; apiKey: string; modelId: string }
  let agents: AgentConfig[] = []

  function loadAgents() {
    try {
      if (fs.existsSync(agentsStoreFile)) {
        const raw = fs.readFileSync(agentsStoreFile, 'utf-8')
        const data = JSON.parse(raw)
        agents = Array.isArray(data?.agents) ? data.agents : []
      } else {
        agents = []
      }
    } catch (e) {
      console.error('Failed to load agents store:', e)
      agents = []
    }
  }
  function saveAgents() {
    try {
      fs.writeFileSync(agentsStoreFile, JSON.stringify({ agents }, null, 2), 'utf-8')
    } catch (e) {
      console.error('Failed to save agents store:', e)
    }
  }
  function envKeysFor(name: string): { apiKey: string; modelId: string } {
    const n = (name || '').toLowerCase()
    if (n === 'doubao' || n === 'ark') {
      return { apiKey: 'ARK_API_KEY', modelId: 'ARK_MODEL_ID' }
    }
    const upper = (name || '').replace(/[^a-z0-9_]/gi, '').toUpperCase() || 'LLM'
    return { apiKey: `${upper}_API_KEY`, modelId: `${upper}_MODEL_ID` }
  }
  function updateEnvFile(vars: Record<string, string>) {
    try {
      const envPath = path.join(process.cwd(), '.env')
      let existingLines: string[] = []
      const kv: Map<string, string> = new Map()
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8')
        existingLines = content.split(/\r?\n/)
        for (const line of existingLines) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
          if (m) {
            kv.set(m[1], m[2])
          }
        }
      }
      for (const [k, v] of Object.entries(vars)) {
        kv.set(k, v)
        // 同步到当前进程环境，便于无需重启即可生效
        process.env[k] = v
      }
      const output = Array.from(kv.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
      fs.writeFileSync(envPath, output, 'utf-8')
    } catch (e) {
      console.error('Failed to update .env file:', e)
    }
  }

  // 移除不再需要的环境变量键（模块精简：移除历史压缩与 RAG）
  function purgeEnvKeys(keys: string[]) {
    try {
      const envPath = path.join(process.cwd(), '.env')
      if (!fs.existsSync(envPath)) return
      const content = fs.readFileSync(envPath, 'utf-8')
      const lines = content.split(/\r?\n/)
      const keepLines = lines.filter((line) => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (!m) return true
        const k = m[1]
        return !keys.includes(k)
      })
      fs.writeFileSync(envPath, keepLines.join('\n'), 'utf-8')
    } catch (e) {
      console.error('Failed to purge .env keys:', e)
    }
  }

  loadAgents()
  // 迁移：移除历史压缩与 RAG 相关环境变量
  purgeEnvKeys(['HISTORY_COMPRESSOR_API_KEY','HISTORY_COMPRESSOR_MODEL_ID','ARK_EMBED_MODEL_ID','RAG_EMBEDDING_API_KEY','RAG_EMBEDDING_MODEL_ID'])
  // 如果 agents 为空且环境变量中已有 Doubao 配置，则以此作为初始条目，便于后续在界面中编辑
  if (!agents.length && (process.env.ARK_API_KEY || process.env.ARK_MODEL_ID)) {
    agents = [
      {
        name: 'doubao',
        apiKey: process.env.ARK_API_KEY || '',
        modelId: process.env.ARK_MODEL_ID || '',
      },
    ]
    saveAgents()
  }

  ipcMain.handle('agent:list', async () => {
    return agents
  })

  ipcMain.handle('agent:get', async (_evt: IpcMainInvokeEvent, name: string) => {
    const found = agents.find((a) => a.name === name)
    return found || null
  })

  ipcMain.handle('agent:upsert', async (_evt: IpcMainInvokeEvent, agent: AgentConfig) => {
    if (!agent || !agent.name) return { success: false, message: '无效的代理配置：缺少名称' }
    const idx = agents.findIndex((a) => a.name === agent.name)
    if (idx >= 0) agents[idx] = agent
    else agents.push(agent)
    saveAgents()
    const envKeys = envKeysFor(agent.name)
    updateEnvFile({ [envKeys.apiKey]: agent.apiKey, [envKeys.modelId]: agent.modelId })
    return { success: true }
  })

  ipcMain.handle('agent:delete', async (_evt: IpcMainInvokeEvent, name: string) => {
    const idx = agents.findIndex((a) => a.name === name)
    if (idx === -1) return { success: false, message: 'Agent not found' }
    agents.splice(idx, 1)
    saveAgents()
    return { success: true }
  })

  ipcMain.handle('ark:chat', async (_evt: import('electron').IpcMainInvokeEvent, payload: { messages: { role: 'system' | 'user' | 'assistant'; content: string }[]; modelId?: string }) => {
    try {
      const client = createDoubaoClientFromEnv()
      const res = await client.chat(payload.messages, payload.modelId)
      return res
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  })

  // ========= Coordinator（总协调员） =========
  ipcMain.handle('coordinator:start', async (_evt: IpcMainInvokeEvent, input: { url?: string; exampleUrl?: string; html?: string; algoName?: string; notes?: string; harPath?: string; prefer?: 'static' | 'dynamic' | 'auto' }) => {
    try {
      const res = await startCoordinator(input)
      return res
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  })
  ipcMain.handle('coordinator:status', async (_evt: IpcMainInvokeEvent, runId: string) => {
    try {
      const run = getCoordinatorStatus(runId)
      return run
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  })

  // ========= Coordinator LLM =========
  ipcMain.handle('coordinatorLLM:start', async (_evt: IpcMainInvokeEvent, input: { url?: string; exampleUrl?: string; html?: string; algoName?: string; notes?: string; harPath?: string; prefer?: 'static' | 'dynamic' | 'auto' }) => {
    try {
      // 提交前进行算法名冲突预检查，避免覆盖已有算法
      const name = String(input?.algoName || '').trim()
      if (name) {
        const exists = listAlgoFiles().some((x: any) => x.name === name)
        if (exists) {
          return { error: `算法名已存在：${name}。请修改后再提交。` }
        }
      }
      const res = await startCoordinatorLLM(input)
      return res
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  })
  ipcMain.handle('coordinatorLLM:status', async (_evt: IpcMainInvokeEvent, runId: string) => {
    try {
      const run = getCoordinatorLLMStatus(runId)
      return run
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  })

  // 第二轮开始前的缓存清理：重置 agents.md / 算法MD，清除 RAG 索引，并重命名 agents_raw.md
  ipcMain.handle('coordinatorLLM:cleanupCaches', async () => {
    try {
      const out = cleanupAlgorithmMakingCaches()
      return out
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
 })