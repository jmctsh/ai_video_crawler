import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { writeMdMessage, getLogsDir } from './agentsMd'
import { writeAlgorithmCode as writeAlgorithmFile, listAlgorithms as listAlgoFiles } from './algStore'

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function getAlgorithmMdPath(): string {
  const file = path.join(getLogsDir(), 'algorithm.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Current Algorithm Code (Aggregate)\n\n`, 'utf-8')
  }
  return file
}

export function getAlgorithmStaticPath(): string {
  const file = path.join(getLogsDir(), 'algorithm_static.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    const content = [
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
      "    ? s.replace(/\\\//g, '/').replace(/\\u002F/g, '/').replace(/&amp;/g, '&')",
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
      "      if (abs && \\.m3u8(\\?|$)/i.test(abs)) candidates.manifest.push(abs)",
      "      else if (abs && \\.mpd(\\?|$)/i.test(abs)) candidates.manifest.push(abs)",
      "      else if (abs && \\.(mp4|webm|mkv|mov)(\\?|$)/i.test(abs)) candidates.direct.push(abs)",
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
    fs.writeFileSync(file, content, 'utf-8')
  }
  return file
}

export function getAlgorithmDynamicPath(): string {
  const file = path.join(getLogsDir(), 'algorithm_dynamic.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    const content = [
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
      "    ? s.replace(/\\\//g, '/').replace(/\\u002F/g, '/').replace(/&amp;/g, '&')",
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
    fs.writeFileSync(file, content, 'utf-8')
  }
  return file
}

export function getAlgorithmArchivePath(): string {
  const file = path.join(getLogsDir(), 'algorithm_archive.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Algorithm Code Archive (Aggregate)\n\n`, 'utf-8')
  }
  return file
}

export function getAlgorithmStaticArchivePath(): string {
  const file = path.join(getLogsDir(), 'algorithm_static_archive.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Static Algorithm Code Archive\n\n`, 'utf-8')
  }
  return file
}

export function getAlgorithmDynamicArchivePath(): string {
  const file = path.join(getLogsDir(), 'algorithm_dynamic_archive.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Dynamic Algorithm Code Archive\n\n`, 'utf-8')
  }
  return file
}

function makeCodeBlock(title: string | undefined, code: string, language: string | undefined, meta: any | undefined): string {
  const ts = new Date().toISOString()
  const lang = (language || 'ts').replace(/[^a-z0-9]/gi, '') || 'ts'
  const metaJson = meta ? JSON.stringify({ ts, ...(typeof meta === 'object' ? meta : { meta }) }, null, 2) : JSON.stringify({ ts }, null, 2)
  return [
    `### [code:${ts}] ${title || ''}`.trim(),
    '```' + lang,
    code,
    '```',
    '',
    '```json',
    metaJson,
    '```',
    '',
  ].join('\n')
}

export function writeAlgorithmCode(args: { title?: string; code: string; language?: string; meta?: any }): { ok: boolean } {
  // 兼容旧接口：聚合文件
  const file = getAlgorithmMdPath()
  const block = makeCodeBlock(args.title, args.code, args.language, args.meta)
  fs.appendFileSync(file, block, 'utf-8')
  writeMdMessage({ agent: '代码维护员', type: 'write_code', text: `写入算法代码段(aggregate)：${(args.title || '').slice(0, 40)}`, payload: { language: args.language || 'ts' }, flags: ['KEEP'] })
  return { ok: true }
}

export function writeAlgorithmCodeTo(target: 'static' | 'dynamic', args: { title?: string; code: string; language?: string; meta?: any }): { ok: boolean } {
  const file = target === 'static' ? getAlgorithmStaticPath() : getAlgorithmDynamicPath()
  const block = makeCodeBlock(args.title, args.code, args.language, args.meta)
  fs.appendFileSync(file, block, 'utf-8')
  writeMdMessage({ agent: '代码维护员', type: `write_code_${target}`, text: `写入${target === 'static' ? '静态' : '动态'}算法代码段：${(args.title || '').slice(0, 40)}`, payload: { language: args.language || 'ts' }, flags: ['KEEP'] })
  return { ok: true }
}

export function resetAlgorithmMd(reason?: string): { ok: boolean } {
  const file = getAlgorithmMdPath()
  const archive = getAlgorithmArchivePath()
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8')
    const header = `\n\n---\n# Archived at ${new Date().toISOString()}\nReason: ${reason || 'unspecified'}\n---\n\n`
    fs.appendFileSync(archive, header + content, 'utf-8')
  }
  fs.writeFileSync(file, `# Current Algorithm Code (Aggregate)\n\n`, 'utf-8')
  writeMdMessage({ agent: '代码维护员', type: 'reset_code_md', text: '重置聚合算法代码MD，旧内容已归档', payload: { reason }, flags: ['DECISION', 'KEEP'] })
  return { ok: true }
}

export function resetAlgorithmMdTarget(target: 'static' | 'dynamic', reason?: string): { ok: boolean } {
  const file = target === 'static' ? getAlgorithmStaticPath() : getAlgorithmDynamicPath()
  const archive = target === 'static' ? getAlgorithmStaticArchivePath() : getAlgorithmDynamicArchivePath()
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8')
    const header = `\n\n---\n# Archived at ${new Date().toISOString()}\nReason: ${reason || 'unspecified'}\n---\n\n`
    fs.appendFileSync(archive, header + content, 'utf-8')
  }
  // 初始化为默认可运行代码，而非空白，便于重置后直接运行
  if (target === 'static') {
    const content = [
      '# Static Algorithm Code',
      '',
      '```js',
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
      '  const res = await helpers.fetch(pageUrl, { headers: nextHeaders })',
      '  if (!res || res.status >= 400) {',
      '    return { headers: nextHeaders }',
      '  }',
      '  const html = await res.text()',
      '  const decode = (s) => s ? s.replace(/\\\//g, \'/\').replace(/\\u002F/g, \'/\').replace(/&amp;/g, \'&\') : s',
      '  function makeAbs(u) { try { return new URL(u, pageUrl).toString() } catch (e) { return u } }',
      "  const m1 = html.match(/html5player\\.setVideoHLS\(['\"]([^'\"]+)['\"]\)/i)",
      '  const manifestFromPlayer = m1 ? makeAbs(decode(m1[1])) : undefined',
      '  const mp4Match = html.match(/(https?:[^\\s\"\'<>]+\\.mp4[^\\s\"\'<>]*)/i)',
      '  const hlsMatch = html.match(/(https?:[^\\s\"\'<>]+\\.m3u8[^\\s\"\'<>]*)/i)',
      '  const dashMatch = html.match(/(https?:[^\\s\"\'<>]+\\.mpd[^\\s\"\'<>]*)/i)',
      '  const directUrl = makeAbs(mp4Match && mp4Match[1])',
      '  const manifestUrl = manifestFromPlayer || makeAbs((hlsMatch && hlsMatch[1]) || (dashMatch && dashMatch[1]))',
      '  if (manifestUrl) return { manifestUrl, headers: nextHeaders }',
      '  if (directUrl) return { directUrl, headers: nextHeaders }',
      '  return { headers: nextHeaders }',
      '}',
      '```',
      '',
    ].join('\n')
    fs.writeFileSync(file, content, 'utf-8')
  } else {
    const content = [
      '# Dynamic Algorithm Code',
      '',
      '```js',
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
      '  const res = await helpers.fetch(pageUrl, { headers: nextHeaders })',
      '  if (!res || res.status >= 400) {',
      '    return { headers: nextHeaders }',
      '  }',
      '  const html = await res.text()',
      '  const decode = (s) => s ? s.replace(/\\\//g, \'/\').replace(/\\u002F/g, \'/\').replace(/&amp;/g, \'&\') : s',
      '  function makeAbs(u) { try { return new URL(u, pageUrl).toString() } catch (e) { return u } }',
      "  const jsonMatch = html.match(/(__PLAYER_CONFIG__|playerConfig|window\\.(?:PLAYER|player)Config)\\s*=\\s*(\\{[\\s\\S]*?\\})/i)",
      '  if (jsonMatch) {',
      '    try {',
      '      const cfg = JSON.parse(jsonMatch[2])',
      "      const direct = cfg.mp4Url || cfg.file || cfg.mediaUrl || cfg.videoUrl || (cfg.sources && (cfg.sources.mp4 || cfg.sources.file))",
      "      const hls = cfg.hlsUrl || cfg.m3u8 || cfg.manifest || cfg.url || (cfg.sources && (cfg.sources.hls || cfg.sources.m3u8))",
      "      const dash = cfg.dashUrl || cfg.mpd || (cfg.sources && cfg.sources.mpd)",
      '      const directUrl = makeAbs(decode(direct))',
      '      const manifestUrl = makeAbs(decode(hls || dash))',
      '      if (manifestUrl) return { manifestUrl, headers: nextHeaders }',
      '      if (directUrl) return { directUrl, headers: nextHeaders }',
      '    } catch (e) {}',
      '  }',
      "  const m1 = html.match(/html5player\\.setVideoHLS\(['\"]([^'\"]+)['\"]\)/i)",
      '  const manifestFromPlayer = m1 ? makeAbs(decode(m1[1])) : undefined',
      '  const mp4Match = html.match(/(https?:[^\\s\"\'<>]+\\.mp4[^\\s\"\'<>]*)/i)',
      '  const hlsMatch = html.match(/(https?:[^\\s\"\'<>]+\\.m3u8[^\\s\"\'<>]*)/i)',
      '  const dashMatch = html.match(/(https?:[^\\s\"\'<>]+\\.mpd[^\\s\"\'<>]*)/i)',
      '  const directUrl = makeAbs(mp4Match && mp4Match[1])',
      '  const manifestUrl = manifestFromPlayer || makeAbs((hlsMatch && hlsMatch[1]) || (dashMatch && dashMatch[1]))',
      '  if (manifestUrl) return { manifestUrl, headers: nextHeaders }',
      '  if (directUrl) return { directUrl, headers: nextHeaders }',
      '  return { headers: nextHeaders }',
      '}',
      '```',
      '',
    ].join('\n')
    fs.writeFileSync(file, content, 'utf-8')
  }
  writeMdMessage({ agent: '代码维护员', type: `reset_code_md_${target}`, text: `重置${target === 'static' ? '静态' : '动态'}算法代码MD，旧内容已归档`, payload: { reason }, flags: ['DECISION', 'KEEP'] })
  return { ok: true }
}

// 将当前算法代码写入主程序算法存储（随机挑选或新增）
export function extractLastCodeBlock(md: string): string {
  const blocks = Array.from(md.matchAll(/### \[code:[^\]]+\][\s\S]*?```[a-z]*[\s\S]*?```/g))
  const last = blocks.length ? blocks[blocks.length - 1][0] : ''
  let code = ''
  const fence = Array.from(last.matchAll(/```[a-z]*\n([\s\S]*?)\n```/g))
  if (fence.length) code = fence[0][1]
  else code = md
  return code
}

export function finalizeAlgorithmIntoStorePick(args?: { pick?: 'static' | 'dynamic'; targetName?: string }): { ok: boolean; targetName: string; pick: 'static' | 'dynamic' } {
  const pick = args?.pick || 'static'
  const mdPath = pick === 'static' ? getAlgorithmStaticPath() : getAlgorithmDynamicPath()
  const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf-8') : ''
  const code = extractLastCodeBlock(content)
  // 统一写入算法管理文件夹：随机覆盖已有文件或新建
  const existing = listAlgoFiles()
  let targetName = args?.targetName
  if (targetName && existing.some((x) => x.name === targetName)) {
    throw new Error(`Algorithm name conflict: ${targetName}`)
  }
  if (!targetName) {
    targetName = existing.length ? existing[Math.floor(Math.random() * existing.length)].name : `algo_${Math.random().toString(36).slice(2, 8)}`
  }
  writeAlgorithmFile(targetName, code, 'js')
  writeMdMessage({ agent: '代码维护员', type: 'finalize', text: `提交最终${pick === 'static' ? '静态' : '动态'}算法代码到主程序：${targetName}`, payload: { name: targetName, pick }, flags: ['FINAL', 'CRITICAL', 'KEEP'] })
  return { ok: true, targetName, pick }
}

// 兼容旧接口：默认以静态为主，缺失时回退动态，再回退聚合
export function finalizeAlgorithmIntoStore(): { ok: boolean; targetName: string } {
  try {
    const fin = finalizeAlgorithmIntoStorePick({ pick: 'static' })
    return { ok: fin.ok, targetName: fin.targetName }
  } catch {
    try {
      const fin = finalizeAlgorithmIntoStorePick({ pick: 'dynamic' })
      return { ok: fin.ok, targetName: fin.targetName }
    } catch {
      // 最后回退到聚合文件
      const content = fs.existsSync(getAlgorithmMdPath()) ? fs.readFileSync(getAlgorithmMdPath(), 'utf-8') : ''
      const code = extractLastCodeBlock(content)
      const existing = listAlgoFiles()
      const targetName = existing.length ? existing[Math.floor(Math.random() * existing.length)].name : `algo_${Math.random().toString(36).slice(2, 8)}`
      writeAlgorithmFile(targetName, code, 'js')
      writeMdMessage({ agent: '代码维护员', type: 'finalize_fallback', text: `提交聚合算法代码到主程序：${targetName}`, payload: { name: targetName }, flags: ['FINAL', 'KEEP'] })
      return { ok: true, targetName }
    }
  }
}