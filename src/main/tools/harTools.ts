import fs from 'fs'

export interface HarImportResult {
  manifestUrl?: string
  headers?: Record<string, string>
  candidates: string[]
}

export function importHar(harPath: string): HarImportResult {
  const result: HarImportResult = { candidates: [] }
  if (!harPath) return result
  try {
    const raw = fs.readFileSync(harPath, 'utf-8')
    const har = JSON.parse(raw)
    const entries: any[] = har?.log?.entries || []
    for (const e of entries) {
      const url: string = e?.request?.url || ''
      if (/\.(m3u8|mpd)(\?|$)/i.test(url)) {
        result.candidates.push(url)
        if (!result.manifestUrl) result.manifestUrl = url
        // collect headers if present
        const reqHeaders: any[] = e?.request?.headers || []
        const headers: Record<string, string> = {}
        for (const h of reqHeaders) {
          if (h?.name && typeof h?.value === 'string') headers[h.name.toLowerCase()] = h.value
        }
        result.headers = headers
      }
      const mime: string | undefined = e?.response?.content?.mimeType
      if (mime && /mpegurl|mpd/i.test(mime) && !result.manifestUrl) {
        result.manifestUrl = url
      }
    }
    result.candidates = Array.from(new Set(result.candidates))
    return result
  } catch (e) {
    return result
  }
}