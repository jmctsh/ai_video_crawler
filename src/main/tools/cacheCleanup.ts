import fs from 'fs'
import path from 'path'
import { getLogsDir } from './agentsMd'

function safeTs() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const HH = pad(d.getHours())
  const MM = pad(d.getMinutes())
  const SS = pad(d.getSeconds())
  return `${yyyy}${mm}${dd}_${HH}${MM}${SS}`
}

function resetFile(filePath: string, header: string) {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, header, 'utf-8')
    return true
  } catch {
    return false
  }
}

export function cleanupAlgorithmMakingCaches(): { ok: boolean; renamedRaw?: string; reset: string[]; removed: string[] } {
  const logDir = getLogsDir()
  const promptMd = path.join(logDir, 'agents.md')
  const rawMd = path.join(logDir, 'agents_raw.md')
  const ragIdx = path.join(logDir, 'agents_rag_index.json')
  const algoAgg = path.join(logDir, 'algorithm.md')
  const algoStatic = path.join(logDir, 'algorithm_static.md')
  const algoDynamic = path.join(logDir, 'algorithm_dynamic.md')

  const reset: string[] = []
  const removed: string[] = []
  let renamedRaw: string | undefined

  // 1) 重置提示用对话日志
  if (resetFile(promptMd, '# Agents Prompt Log\n\n')) reset.push(promptMd)

  // 2) 重置算法代码过程文件（制作过程中的缓存）
  // 说明：静态/动态算法代码文件采用“初始化默认可运行代码”而非清空，便于第二轮直接运行。
  const defaultStatic = [
    '# Static Algorithm Code',
    '',
    '```js',
    '// 强化版静态解析示例：更稳健提取 mp4/m3u8/mpd',
    '// 入口：async function parse(pageUrl, helpers, headers)',
    '',
    'async function parse(pageUrl, helpers, headers) {',
    '  // 构造更合理的请求头',
    '  const nextHeaders = { ...headers }',
    '  try {',
    '    const u = new URL(pageUrl)',
    "    if (!nextHeaders['Origin']) nextHeaders['Origin'] = u.origin",
    "    if (!nextHeaders['Referer']) nextHeaders['Referer'] = u.origin + '/'",
    '  } catch {}',
    "  if (!nextHeaders['User-Agent']) nextHeaders['User-Agent'] =",
    "    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'",
    "  if (!nextHeaders['Accept']) nextHeaders['Accept'] = 'text/html,*/*;q=0.8'",
    "  if (!nextHeaders['Accept-Language']) nextHeaders['Accept-Language'] = 'en-US,en;q=0.9'",
    '',
    '  const res = await helpers.fetch(pageUrl, { headers: nextHeaders })',
    '  if (!res || res.status >= 400) return { headers: nextHeaders }',
    '',
    '  const html = await res.text()',
    '',
    '  const decode = (s) => s',
    "    ? s.replace(/\\\\\//g, '/').replace(/\\u002F/g, '/').replace(/&amp;/g, '&')",
    '    : s',
    '',
    '  const makeAbs = (u) => {',
    '    if (!u) return undefined',
    '    try { return new URL(u, pageUrl).toString() } catch { return u }',
    '  }',
    '',
    '  const candidates = { manifest: [], direct: [] }',
    '',
    '  // xvideos 风格播放器初始化',
    '  {',
    "    const m1 = html.match(/html5player\\.setVideoHLS\(['\"]([^'\"]+)['\"]\)/i)",
    '    if (m1) candidates.manifest.push(makeAbs(decode(m1[1])))',
    "    const m2 = html.match(/html5player\\.setVideoUrl(?:High|Hd)\(['\"]([^'\"]+)['\"]\)/i)",
    '    if (m2) candidates.direct.push(makeAbs(decode(m2[1])))',
    "    const m3 = html.match(/html5player\\.setVideoUrlLow\(['\"]([^'\"]+)['\"]\)/i)",
    '    if (m3) candidates.direct.push(makeAbs(decode(m3[1])))',
    '  }',
    '',
    '  // 通用 source 标签与直链/清单',
    '  {',
    "    const s1 = html.match(/<source[^>]+src=['\"]([^'\"]+)['\"][^>]*>/i)",
    '    if (s1) {',
    '      const abs = makeAbs(decode(s1[1]))',
    "      if (abs && \\\\.m3u8(\\\\?|$)/i.test(abs)) candidates.manifest.push(abs)",
    "      else if (abs && \\\\.mpd(\\\\?|$)/i.test(abs)) candidates.manifest.push(abs)",
    "      else if (abs && \\\\.(mp4|webm|mkv|mov)(\\\\?|$)/i.test(abs)) candidates.direct.push(abs)",
    '    }',
    '  }',
    '',
    '  // 兜底正则',
    '  {',
    "    const m3u8 = html.match(/(https?:[^\\s\"\'<>]+\\.m3u8[^\\s\"\'<>]*)/i)",
    "    const mpd   = html.match(/(https?:[^\\s\"\'<>]+\\.mpd[^\\s\"\'<>]*)/i)",
    "    const mp4   = html.match(/(https?:[^\\s\"\'<>]+\\.mp4[^\\s\"\'<>]*)/i)",
    '    if (m3u8) candidates.manifest.push(makeAbs(decode(m3u8[1])))',
    '    if (mpd)  candidates.manifest.push(makeAbs(decode(mpd[1])))',
    '    if (mp4)  candidates.direct.push(makeAbs(decode(mp4[1])))',
    '  }',
    '',
    '  // 选择优先：清单优先，其次直链',
    '  const manifestUrl = candidates.manifest.find(Boolean)',
    '  const directUrl = candidates.direct.find(Boolean)',
    '  if (manifestUrl) return { manifestUrl, headers: nextHeaders }',
    '  if (directUrl) return { directUrl, headers: nextHeaders }',
    '  return { headers: nextHeaders }',
    '}',
    '```',
    '',
  ].join('\n')
  const defaultDynamic = [
    '# Dynamic Algorithm Code',
    '',
    '```js',
    '// 强化版动态解析示例：提取内嵌配置与脚本生成的媒体链接',
    '// 入口：async function parse(pageUrl, helpers, headers)',
    '',
    'async function parse(pageUrl, helpers, headers) {',
    '  const nextHeaders = { ...headers }',
    '  try {',
    '    const u = new URL(pageUrl)',
    "    if (!nextHeaders['Origin']) nextHeaders['Origin'] = u.origin",
    "    if (!nextHeaders['Referer']) nextHeaders['Referer'] = u.origin + '/'",
    '  } catch {}',
    "  if (!nextHeaders['User-Agent']) nextHeaders['User-Agent'] =",
    "    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'",
    "  if (!nextHeaders['Accept']) nextHeaders['Accept'] = 'text/html,*/*;q=0.8'",
    "  if (!nextHeaders['Accept-Language']) nextHeaders['Accept-Language'] = 'en-US,en;q=0.9'",
    '',
    '  const res = await helpers.fetch(pageUrl, { headers: nextHeaders })',
    '  if (!res || res.status >= 400) return { headers: nextHeaders }',
    '',
    '  const html = await res.text()',
    '',
    '  const decode = (s) => s',
    "    ? s.replace(/\\\\\//g, '/').replace(/\\u002F/g, '/').replace(/&amp;/g, '&')",
    '    : s',
    '  const makeAbs = (u) => {',
    '    if (!u) return undefined',
    '    try { return new URL(u, pageUrl).toString() } catch { return u }',
    '  }',
    '',
    '  const candidates = { manifest: [], direct: [] }',
    '',
    '  // 1) 内嵌 JSON 配置（常见播放器）',
    '  {',
    "    const jsonMatch = html.match(/(__PLAYER_CONFIG__|playerConfig|window\\.(?:PLAYER|player)Config)\\s*=\\s*(\\{[\\s\\S]*?\\})/i)",
    '    if (jsonMatch) {',
    '      try {',
    '        const cfg = JSON.parse(jsonMatch[2])',
    "        const direct = cfg.mp4Url || cfg.file || cfg.mediaUrl || cfg.videoUrl || (cfg.sources && (cfg.sources.mp4 || cfg.sources.file))",
    "        const hls = cfg.hlsUrl || cfg.m3u8 || cfg.manifest || cfg.url || (cfg.sources && (cfg.sources.hls || cfg.sources.m3u8))",
    "        const dash = cfg.dashUrl || cfg.mpd || (cfg.sources && cfg.sources.mpd)",
    '        const d = makeAbs(decode(direct))',
    '        const m = makeAbs(decode(hls || dash))',
    '        if (m) candidates.manifest.push(m)',
    '        if (d) candidates.direct.push(d)',
    '      } catch {}',
    '    }',
    '  }',
    '',
    '  // 2) 脚本生成样式（xvideos 等）',
    '  {',
    "    const m1 = html.match(/html5player\\.setVideoHLS\(['\"]([^'\"]+)['\"]\)/i)",
    '    if (m1) candidates.manifest.push(makeAbs(decode(m1[1])))',
    "    const m2 = html.match(/html5player\\.setVideoUrl(?:High|Hd)\(['\"]([^'\"]+)['\"]\)/i)",
    '    if (m2) candidates.direct.push(makeAbs(decode(m2[1])))',
    "    const m3 = html.match(/html5player\\.setVideoUrlLow\(['\"]([^'\"]+)['\"]\)/i)",
    '    if (m3) candidates.direct.push(makeAbs(decode(m3[1])))',
    '  }',
    '',
    '  // 3) 兜底匹配',
    '  {',
    "    const m3u8 = html.match(/(https?:[^\\s\"\'<>]+\\.m3u8[^\\s\"\'<>]*)/i)",
    "    const mpd   = html.match(/(https?:[^\\s\"\'<>]+\\.mpd[^\\s\"\'<>]*)/i)",
    "    const mp4   = html.match(/(https?:[^\\s\"\'<>]+\\.mp4[^\\s\"\'<>]*)/i)",
    '    if (m3u8) candidates.manifest.push(makeAbs(decode(m3u8[1])))',
    '    if (mpd)  candidates.manifest.push(makeAbs(decode(mpd[1])))',
    '    if (mp4)  candidates.direct.push(makeAbs(decode(mp4[1])))',
    '  }',
    '',
    '  const manifestUrl = candidates.manifest.find(Boolean)',
    '  const directUrl = candidates.direct.find(Boolean)',
    '  if (manifestUrl) return { manifestUrl, headers: nextHeaders }',
    '  if (directUrl) return { directUrl, headers: nextHeaders }',
    '  return { headers: nextHeaders }',
    '}',
    '```',
    '',
  ].join('\n')

  if (resetFile(algoAgg, '# Current Algorithm Code (Aggregate)\n\n')) reset.push(algoAgg)
  if (resetFile(algoStatic, defaultStatic)) reset.push(algoStatic)
  if (resetFile(algoDynamic, defaultDynamic)) reset.push(algoDynamic)

  // 3) 清除历史 RAG 索引缓存（已移除模块，保留文件级清理）
  try {
    if (fs.existsSync(ragIdx)) {
      fs.unlinkSync(ragIdx)
      removed.push(ragIdx)
    } else {
      // 模块已移除，无需额外清理
    }
  } catch {}

  // 4) 保留 agents_raw.md 原始文件，但为避免冲突，重命名加系统时间
  try {
    if (fs.existsSync(rawMd)) {
      const ts = safeTs()
      let target = path.join(logDir, `agents_raw-${ts}.md`)
      // 如存在同名，添加随机后缀确保唯一
      if (fs.existsSync(target)) {
        target = path.join(logDir, `agents_raw-${ts}-${Math.random().toString(36).slice(2, 6)}.md`)
      }
      fs.renameSync(rawMd, target)
      renamedRaw = target
    }
  } catch {}

  return { ok: true, renamedRaw, reset, removed }
}

// 清理一次性日志目录内容（保留目录本身）：logs/debug 与 logs/uploads
function removeRecursiveContents(dir: string, removed: string[]) {
  try {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir)
    for (const name of entries) {
      const full = path.join(dir, name)
      try {
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          // 递归清空子目录并删除子目录本身
          removeRecursiveContents(full, removed)
          try { fs.rmdirSync(full) } catch {}
          removed.push(full)
        } else {
          fs.unlinkSync(full)
          removed.push(full)
        }
      } catch {}
    }
  } catch {}
}

export function cleanupLogsTransientDirs(): { ok: boolean; removed: string[] } {
  const logDir = getLogsDir()
  const debugDir = path.join(logDir, 'debug')
  const uploadsDir = path.join(logDir, 'uploads')
  const removed: string[] = []
  removeRecursiveContents(debugDir, removed)
  removeRecursiveContents(uploadsDir, removed)
  return { ok: true, removed }
}