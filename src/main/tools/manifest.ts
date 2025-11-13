export interface Variant {
  id: string
  uri?: string
  res?: { width: number; height: number }
  br?: number // Mbps
}

function parseNumber(v: string | undefined): number | undefined {
  if (!v) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function parseHlsManifest(content: string): { variants: Variant[] } {
  const lines = content.split(/\r?\n/)
  const variants: Variant[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = line.split(':')[1] || ''
      const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/i)
      const bwMatch = attrs.match(/BANDWIDTH=(\d+)/i)
      const next = lines[i + 1] || ''
      const uri = next && !next.startsWith('#') ? next.trim() : undefined
      const width = resMatch ? parseInt(resMatch[1], 10) : undefined
      const height = resMatch ? parseInt(resMatch[2], 10) : undefined
      const br = bwMatch ? parseInt(bwMatch[1], 10) / (1024 * 1024) : undefined // to Mbps
      variants.push({ id: `hls_${i}`, uri, res: width && height ? { width, height } : undefined, br })
    }
  }
  return { variants }
}

export function parseDashManifest(content: string): { variants: Variant[] } {
  const variants: Variant[] = []
  const regex = /<Representation[^>]*id="([^"]+)"[^>]*bandwidth="(\d+)"[^>]*width="(\d+)"[^>]*height="(\d+)"/gi
  let m: RegExpExecArray | null
  while ((m = regex.exec(content))) {
    const id = m[1]
    const bw = parseInt(m[2], 10) / (1024 * 1024)
    const width = parseInt(m[3], 10)
    const height = parseInt(m[4], 10)
    variants.push({ id: `dash_${id}`, res: { width, height }, br: bw })
  }
  return { variants }
}

export function parseManifest(args: { url?: string; content?: string }): { variants: Variant[]; kind?: 'hls' | 'dash' } {
  const { url, content } = args
  if (content) {
    // heuristic detect by signature
    if (/EXTM3U/.test(content)) {
      const { variants } = parseHlsManifest(content)
      return { variants, kind: 'hls' }
    }
    if (/<MPD/.test(content)) {
      const { variants } = parseDashManifest(content)
      return { variants, kind: 'dash' }
    }
  }
  // Without content, fallback by url extension (no fetch)
  if (url && /\.m3u8(\?|$)/i.test(url)) return { variants: [], kind: 'hls' }
  if (url && /\.mpd(\?|$)/i.test(url)) return { variants: [], kind: 'dash' }
  return { variants: [] }
}

export function pickBestVariant(variants: Variant[]): Variant | null {
  if (!variants || !variants.length) return null
  const sorted = variants.slice().sort((a, b) => {
    const ah = a.res?.height ?? 0
    const bh = b.res?.height ?? 0
    if (bh !== ah) return bh - ah
    const aw = a.res?.width ?? 0
    const bw = b.res?.width ?? 0
    if (bw !== aw) return bw - aw
    const abr = a.br ?? 0
    const bbr = b.br ?? 0
    return bbr - abr
  })
  return sorted[0] || null
}

import http from 'http'
import https from 'https'

export async function fetchManifestContent(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; content?: string; kind?: 'hls' | 'dash'; status?: number; notes?: string }> {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location
        res.resume()
        const next = loc.startsWith('http') ? loc : new URL(loc, url).toString()
        fetchManifestContent(next, headers).then(resolve)
        return
      }
      if ((res.statusCode || 0) >= 400) {
        res.resume()
        resolve({ ok: false, status: res.statusCode, notes: `http ${res.statusCode}` })
        return
      }
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        const kind = /EXTM3U/.test(data) ? 'hls' : (/<MPD/.test(data) ? 'dash' : undefined)
        resolve({ ok: true, content: data, kind })
      })
    })
    req.on('error', (err) => resolve({ ok: false, notes: err?.message || String(err) }))
  })
}

// ====== 扩展：枚举 HLS 媒体播放清单的分片 ======
export interface HlsPlan {
  kind: 'hls'
  variantUrl: string
  initUrl?: string
  segments: string[]
  isFmp4: boolean
  targetDuration?: number
}

function makeAbsolute(baseUrl: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, baseUrl).toString()
  } catch {
    return maybeRelative
  }
}

export function parseHlsMediaPlaylist(content: string, playlistUrl: string): HlsPlan {
  const lines = content.split(/\r?\n/)
  const segments: string[] = []
  let initUrl: string | undefined
  let isFmp4 = false
  let targetDuration: number | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('#EXT-X-MAP')) {
      const m = line.match(/URI="([^"]+)"/i)
      if (m) {
        initUrl = makeAbsolute(playlistUrl, m[1])
        isFmp4 = true
      }
    } else if (line.startsWith('#EXTINF')) {
      const next = (lines[i + 1] || '').trim()
      if (next && !next.startsWith('#')) segments.push(makeAbsolute(playlistUrl, next))
    } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
      const v = line.split(':')[1]
      const n = parseNumber(v)
      if (typeof n === 'number') targetDuration = n
    }
  }
  return { kind: 'hls', variantUrl: playlistUrl, initUrl, segments, isFmp4, targetDuration }
}

// 基于 master.m3u8 选择最佳变体并生成下载计划
export async function buildHlsDownloadPlan(masterUrlOrContent: { url?: string; content?: string; headers?: Record<string, string> }): Promise<{ ok: boolean; plan?: HlsPlan; variants?: Variant[]; selected?: Variant; notes?: string }> {
  let masterContent = masterUrlOrContent.content
  const url = masterUrlOrContent.url
  if (!masterContent && url) {
    const fetched = await fetchManifestContent(url, masterUrlOrContent.headers)
    if (!fetched.ok || !fetched.content) return { ok: false, notes: fetched.notes || 'fetch master failed' }
    masterContent = fetched.content
  }
  if (!masterContent) return { ok: false, notes: 'no master content' }
  const { variants } = parseHlsManifest(masterContent)
  if (!variants.length) {
    // 可能直接是媒体播放清单
    const playlistUrl = url || ''
    const plan = parseHlsMediaPlaylist(masterContent, playlistUrl)
    return { ok: true, plan }
  }
  const selected = pickBestVariant(variants) || variants[0]
  const playlistUrl = selected?.uri ? makeAbsolute(url || '', selected.uri) : url || ''
  if (!playlistUrl) return { ok: false, variants, selected, notes: 'no variant playlist url' }
  const fetched = await fetchManifestContent(playlistUrl, masterUrlOrContent.headers)
  if (!fetched.ok || !fetched.content) return { ok: false, variants, selected, notes: fetched.notes || 'fetch variant failed' }
  const plan = parseHlsMediaPlaylist(fetched.content, playlistUrl)
  return { ok: true, plan, variants, selected }
}

// ====== 简化版 DASH SegmentTemplate 解析为下载计划 ======
export interface DashPlan {
  kind: 'dash'
  mpdUrl: string
  initUrl?: string
  segments: string[]
}

export function buildDashDownloadPlan(mpdContent: string, mpdUrl: string): DashPlan {
  // 仅处理 SegmentTemplate + (Initialization|media with $Number$) 的常见情况
  // 不支持 DRM 与 SegmentBase/SegmentList（可后续扩展）
  const baseMatch = mpdContent.match(/<BaseURL>([^<]+)<\/BaseURL>/i)
  const baseUrl = baseMatch ? makeAbsolute(mpdUrl, baseMatch[1].trim()) : mpdUrl
  const initMatch = mpdContent.match(/Initialization\s+sourceURL="([^"]+)"/i)
  const templateMatch = mpdContent.match(/SegmentTemplate[^>]*media="([^"]+)"[^>]*startNumber="(\d+)"/i)
  const timeline = Array.from(mpdContent.matchAll(/<S\s+d="(\d+)"\s*(r="(-?\d+)")?\s*\/>/gi))
  let initUrl: string | undefined = undefined
  const segments: string[] = []
  if (initMatch) initUrl = makeAbsolute(baseUrl, initMatch[1])
  if (templateMatch) {
    const mediaPattern = templateMatch[1]
    let num = parseInt(templateMatch[2], 10)
    // 如果有 timeline，根据段数展开；否则至少展开前 120 段以形成最小可用
    const count = timeline.length ? timeline.reduce((acc, m) => {
      const d = parseInt(m[1], 10)
      const r = m[3] ? parseInt(m[3], 10) : 0
      return acc + 1 + (r > 0 ? r : 0)
    }, 0) : 120
    for (let i = 0; i < count; i++) {
      const replaced = mediaPattern.replace(/\$Number\$/gi, String(num))
      segments.push(makeAbsolute(baseUrl, replaced))
      num += 1
    }
  }
  return { kind: 'dash', mpdUrl, initUrl, segments }
}

export async function buildDownloadPlan(args: { url: string; headers?: Record<string, string> }): Promise<{ ok: boolean; plan?: HlsPlan | DashPlan; kind?: 'hls' | 'dash'; notes?: string }> {
  const { headers } = args
  const unwrap = (u: string): string => {
    try {
      const ur = new URL(u)
      const inner = ur.searchParams.get('url') || ur.searchParams.get('u') || ur.searchParams.get('v')
      if (inner && /^https?:/i.test(inner)) return inner
    } catch {}
    return u
  }
  const url = unwrap(args.url)
  const fetched = await fetchManifestContent(url, headers)
  if (!fetched.ok || !fetched.content) return { ok: false, notes: fetched.notes || 'fetch failed' }
  if (fetched.kind === 'hls') {
    const masterOrPlaylist = fetched.content
    if (/EXT-X-STREAM-INF/.test(masterOrPlaylist)) {
      const hls = await buildHlsDownloadPlan({ url, content: masterOrPlaylist, headers })
      return { ok: hls.ok, plan: hls.plan, kind: 'hls', notes: hls.notes }
    }
    // 已是媒体播放清单
    const plan = parseHlsMediaPlaylist(masterOrPlaylist, url)
    return { ok: true, plan, kind: 'hls' }
  }
  if (fetched.kind === 'dash') {
    const plan = buildDashDownloadPlan(fetched.content!, url)
    return { ok: true, plan, kind: 'dash' }
  }
  return { ok: false, notes: 'unknown manifest kind' }
}
