import { writeMdMessage } from './agentsMd'

export function findManifestLinks(html: string): string[] {
  const urls: string[] = []
  const regex = /(https?:[^\s"']+\.(?:m3u8|mpd))(?:\?[^\s"']*)?/gi
  let m: RegExpExecArray | null
  while ((m = regex.exec(html))) urls.push(m[1])
  // also collect from src/href attributes
  const attrRegex = /(src|href)=["']([^"']+\.(?:m3u8|mpd))(?:\?[^"']*)?["']/gi
  while ((m = attrRegex.exec(html))) urls.push(m[2])
  return Array.from(new Set(urls))
}

export function extractHtmlCandidates(html: string): { candidates: string[]; playerParams?: any } {
  const decode = (s: string) => s.replace(/\\/g, '/').replace(/\u002F/gi, '/')
  const decoded = decode(html)
  const candidates = findManifestLinks(decoded)
  try {
    const m = decoded.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})/i)
    if (m) {
      const json = m[1]
      const cfg = JSON.parse(json)
      if (cfg && typeof cfg.url === 'string') {
        const u = decode(cfg.url)
        if (/\.m3u8(\?|$)/i.test(u) || /\.mpd(\?|$)/i.test(u)) candidates.push(u)
      }
    }
  } catch {}
  // naive player params extraction (placeholder)
  const playerParams: any = undefined
  try {
    writeMdMessage({
      agent: '静态解析引擎',
      type: 'scan',
      text: `HTML 候选提取完成：${candidates.length} 个`,
      payload: { sample: candidates.slice(0, 6) }
    })
  } catch {}
  return { candidates, playerParams }
}
