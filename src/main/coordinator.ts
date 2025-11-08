import { writeMdMessage, writeRawMessage, getLogsDir } from './tools/agentsMd'
import { buildUserInputMessage } from './coordinatorPrompt'
import fs from 'fs'
import path from 'path'

export type CoordinatorInput = {
  // 示例网址（可与 exampleUrl 同义，向后兼容）
  url?: string
  exampleUrl?: string
  // 该网址的源代码（HTML 原始文本）
  html?: string
  // 用户命名的算法名（用于最终提交到算法存储时的命名）
  algoName?: string
  // 其他说明/备注
  notes?: string
  // 可选：HAR 路径与偏好策略
  harPath?: string
  prefer?: 'static' | 'dynamic' | 'auto'
}

export type RunStatus = 'pending' | 'running' | 'done' | 'error'

export interface CoordinatorRun {
  id: string
  status: RunStatus
  startedAt: number
  updatedAt: number
  input: CoordinatorInput
  result?: {
    manifestUrl?: string
    filePath?: string
    notes?: string
  }
  error?: string
}

const runs: Map<string, CoordinatorRun> = new Map()

function genId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function findManifestLinks(html: string): string[] {
  const urls: string[] = []
  const regex = /(https?:[^\s"']+\.(?:m3u8|mpd))(?:\?[^\s"']*)?/gi
  let m: RegExpExecArray | null
  while ((m = regex.exec(html))) {
    urls.push(m[1])
  }
  return Array.from(new Set(urls))
}

export async function startCoordinator(input: CoordinatorInput): Promise<{ runId: string }> {
  const id = genId()
  const now = Date.now()
  const run: CoordinatorRun = { id, status: 'running', startedAt: now, updatedAt: now, input }
  runs.set(id, run)

  writeMdMessage({ agent: '总协调员', type: 'start', text: '开始抓取' })

  // 将用户提交的初始信息改为单独存放到 debug，不再写入 agents 日志
  try {
    const debugDir = path.join(getLogsDir(), 'debug', id)
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
    const userText = buildUserInputMessage(input).content
    let htmlFile: string | undefined
    if (input.html && input.html.length) {
      try {
        const uploadsDir = path.join(getLogsDir(), 'uploads')
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
        htmlFile = path.join(uploadsDir, `user_html_${id}.html`)
        fs.writeFileSync(htmlFile, input.html, 'utf-8')
      } catch {}
    }
    const initialMd = [
      `# Initial Input`,
      `- runId: ${id}`,
      `- url: ${input.url || input.exampleUrl || ''}`,
      `- exampleUrl: ${input.exampleUrl || ''}`,
      `- algoName: ${input.algoName || ''}`,
      `- notes: ${(input.notes || '').replace(/\r/g,'')}`,
      `- harPath: ${input.harPath || ''}`,
      `- prefer: ${input.prefer || ''}`,
      `- htmlChars: ${input.html ? input.html.length : 0}`,
      htmlFile ? `- htmlPath: ${htmlFile}` : `- htmlPath: (none)`,
      ``,
      `## Summary`,
      userText,
      ``,
      input.html ? `## HTML\n\`\`\`html\n${input.html}\n\`\`\`` : ''
    ].join('\n')
    fs.writeFileSync(path.join(debugDir, 'initial_input.md'), initialMd, 'utf-8')
  } catch {}

  try {
    // 静态解析（本地算法）
    let staticCandidates: string[] = []
    if (input.html) {
      staticCandidates = findManifestLinks(input.html)
      writeMdMessage({
        agent: 'HTML 解析员',
        type: 'candidates',
        text: `静态解析发现候选清单 ${staticCandidates.length} 个`,
        payload: { candidates: staticCandidates },
      })
    }

    // 动态抓包（占位）
    const dynamicManifest: string | undefined = undefined
    writeMdMessage({
      agent: '动态抓包员',
      type: 'capture',
      text: '动态抓包暂未实现（占位）',
    })

    const manifestUrl = dynamicManifest || staticCandidates[0]
    if (!manifestUrl) {
    writeMdMessage({ agent: '异常诊断员', type: 'variants_empty', text: '未找到清单' })
      run.status = 'error'
      run.error = '未找到清单 URL'
      run.updatedAt = Date.now()
      return { runId: id }
    }

    writeMdMessage({
      agent: '清单解析员',
      type: 'select_variant',
      text: '解析与选择最高分辨率暂未实现（占位）',
      payload: { manifestUrl },
    })

    // 下载与验收（占位）
  writeMdMessage({ agent: '下载与验收员', type: 'download', text: '下载管线未接入（占位）' })

    run.result = { manifestUrl, notes: '管线待接入，已完成协调与记录占位' }
    run.status = 'done'
    run.updatedAt = Date.now()

    writeMdMessage({
      agent: '总协调员',
      type: 'final',
      text: `完成占位流程，清单：${manifestUrl}`,
      payload: { runId: id, manifestUrl },
    })
  } catch (e: any) {
    run.status = 'error'
    run.error = e?.message || String(e)
    run.updatedAt = Date.now()
    writeMdMessage({ agent: '总协调员', type: 'error', text: String(run.error) })
  }

  return { runId: id }
}

export function getCoordinatorStatus(runId: string): CoordinatorRun | null {
  return runs.get(runId) ?? null
}