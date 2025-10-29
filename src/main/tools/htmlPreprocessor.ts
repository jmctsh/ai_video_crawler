import fs from 'fs'

export interface HtmlPreprocessOptions {
  maxChars?: number
  window?: number
}

export interface HtmlPreprocessResult {
  processed: string
  originalChars: number
  processedChars: number
  removedBytes: number
  notes?: string
}

function stripTags(html: string): string {
  // Remove script and style blocks to cut noise
  let out = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  out = out.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  return out
}

function collapseWhitespace(html: string): string {
  // Collapse excessive whitespace while preserving basic structure
  return html.replace(/\s+/g, ' ').trim()
}

function pickSnippets(html: string, window = 5000): string {
  const needles = [
    /\.m3u8/gi,
    /\.mpd/gi,
    /<video/gi,
    /<source/gi,
    /hls/gi,
    /dash/gi,
    /manifest/gi,
    /player/gi,
  ]
  const spans: Array<[number, number]> = []
  for (const re of needles) {
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) {
      const i = m.index
      const start = Math.max(0, i - window)
      const end = Math.min(html.length, i + window)
      spans.push([start, end])
    }
  }
  if (!spans.length) return html
  // Merge overlaps
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (!last || s[0] > last[1] + 1) merged.push([...s] as [number, number])
    else last[1] = Math.max(last[1], s[1])
  }
  let out = ''
  for (const [s, e] of merged) out += html.slice(s, e) + '\n'
  return out
}

export function preprocessHtmlLong(html: string, opts?: HtmlPreprocessOptions): HtmlPreprocessResult {
  const originalChars = html.length
  const maxChars = Math.max(20000, Math.min(500000, Number(opts?.maxChars ?? (process.env.HTML_MAX_CHARS || 120000))))
  const window = Number(opts?.window ?? 5000)
  let work = html
  let strategy: string[] = []
  // 1) Strip obvious noise
  work = stripTags(work)
  strategy.push('strip<script|style>')
  // 2) Collapse whitespace
  work = collapseWhitespace(work)
  strategy.push('collapse_whitespace')
  // 3) If still too long, pick relevant snippets around media candidates
  if (work.length > maxChars) {
    const picked = pickSnippets(work, window)
    if (picked && picked.length > 0) {
      work = picked
      strategy.push('pick_snippets_around_candidates')
    }
  }
  // 4) Truncate softly to maxChars while keeping tail note
  let notes: string | undefined
  if (work.length > maxChars) {
    work = work.slice(0, maxChars)
    notes = `truncated_to_${maxChars}`
    strategy.push('truncate_soft')
  }
  const processedChars = work.length
  const removedBytes = Math.max(0, originalChars - processedChars)
  return {
    processed: work,
    originalChars,
    processedChars,
    removedBytes,
    notes: `strategy=${strategy.join('+')}` + (notes ? `; ${notes}` : ''),
  }
}