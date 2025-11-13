import fs from 'fs'
import path from 'path'

// 统一算法代码管理目录：项目根目录下的 'algorithms'
export function getAlgorithmDir(): string {
  const dir = path.join(process.cwd(), 'algorithms')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function stripExt(filename: string): string {
  const idx = filename.lastIndexOf('.')
  return idx > 0 ? filename.slice(0, idx) : filename
}

function resolveAlgoPath(name: string): string | null {
  const dir = getAlgorithmDir()
  const candidates = [path.join(dir, `${name}.js`), path.join(dir, `${name}.ts`), path.join(dir, `${name}.md`)]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return null
}

export type AlgoInfo = { name: string; createdAt: number }

export function listAlgorithms(): AlgoInfo[] {
  const dir = getAlgorithmDir()
  const files = fs.readdirSync(dir)
  const out: AlgoInfo[] = []
  for (const f of files) {
    if (f.startsWith('.')) continue
    if (!/\.(js|ts|md)$/i.test(f)) continue
    const full = path.join(dir, f)
    const st = fs.statSync(full)
    out.push({ name: stripExt(f), createdAt: st.mtimeMs })
  }
  // 新的在前（按创建/修改时间降序），便于最近算法优先显示
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export function readAlgorithmCode(name: string): string | null {
  const p = resolveAlgoPath(name)
  if (!p) return null
  const content = fs.readFileSync(p, 'utf-8')
  if (p.endsWith('.md')) {
    // 简单提取最后一个代码块；若无代码块则返回完整文本（由上游自行处理）
    const blocks = [...content.matchAll(/```(js|ts)?[\s\S]*?```/g)]
    if (blocks.length) {
      const last = blocks[blocks.length - 1][0]
      const code = last.replace(/^```(js|ts)?/i, '').replace(/```$/i, '')
      return code
    }
    return content
  }
  return content
}

export function writeAlgorithmCode(name: string, code: string, ext: 'js' | 'ts' | 'md' = 'js'): { ok: boolean; filePath: string } {
  const dir = getAlgorithmDir()
  const file = path.join(dir, `${name}.${ext}`)
  fs.writeFileSync(file, code, 'utf-8')
  return { ok: true, filePath: file }
}

export function deleteAlgorithm(name: string): { ok: boolean; removed: string[] } {
  const dir = getAlgorithmDir()
  const removed: string[] = []
  for (const ext of ['js', 'ts', 'md']) {
    const p = path.join(dir, `${name}.${ext}`)
    if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p) }
  }
  return { ok: true, removed }
}

export function ensureSampleSeed(): { ok: boolean; created?: string | null } {
  const dir = getAlgorithmDir()
  const files = fs.readdirSync(dir).filter((f) => /\.(js|ts|md)$/i.test(f))
  if (files.length) return { ok: true, created: null }
  // 当算法目录为空时自动写入当前版本的 xvideos 解析算法，确保下一次启动可直接运行
  const content = String.raw`// XVIDEOS 解析算法（真实可用）
// 接口契合主程序：导出 parse(url, helpers, headers) 并返回 { manifestUrl? , directUrl? , headers }
// - 优先提取 html5player.setVideoHLS(...) 的 HLS 清单；若不存在则回退到 setVideoUrlHigh/Low 的 mp4 直链；
// - headers 中至少携带 Referer，必要时可追加 User-Agent；
// - 后续流程将进行人类验收、可选合并/转码，并最终生成 mp4。

export async function parse(pageUrl, helpers, headers) {
  const h = { ...(headers || {}) }
  if (!h['Referer']) h['Referer'] = pageUrl

  // 可选设置 UA（若上游未提供关键头）
  if (!h['User-Agent']) {
    h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  }

  const html = await helpers.getText(pageUrl, h)

  // 直接从页面脚本钩子中提取
  const hlsMatch = html.match(/html5player\.setVideoHLS\('([^']+)'\)/i)
  const highMatch = html.match(/html5player\.setVideoUrlHigh\('([^']+)'\)/i)
  const lowMatch = html.match(/html5player\.setVideoUrlLow\('([^']+)'\)/i)

  let manifestUrl = hlsMatch ? hlsMatch[1] : null
  let directUrl = highMatch ? highMatch[1] : (lowMatch ? lowMatch[1] : null)

  // 兜底：在页面中正则搜索 m3u8（有时存在其他脚本片段）
  if (!manifestUrl) {
    const m3u8Guess = html.match(/https?:\/\/[^"']+\/hls[^"']+\.m3u8/gi)
    if (m3u8Guess && m3u8Guess.length) manifestUrl = m3u8Guess[0]
  }

  // 兜底：从 JSON 片段里拿 video_hls
  if (!manifestUrl) {
    const jsonHls = html.match(/"video_hls"\s*:\s*"([^"]+\.m3u8[^"]*)"/i)
    if (jsonHls) manifestUrl = jsonHls[1].replace(/\\\//g, '/')
  }

  // 输出供后续流程消费（人类验收流程会自动选择更优方案并下载/合并）
  const out = {}
  if (manifestUrl) out.manifestUrl = manifestUrl
  if (directUrl) out.directUrl = directUrl
  out.headers = h

  return out
}

// 兼容：如果主程序寻找 resolve(...)，则复用同逻辑
export const resolve = parse
`
  const { filePath } = writeAlgorithmCode('xvideos', content, 'js')
  return { ok: true, created: filePath }
}
