import http from 'http'
import https from 'https'
import { extractHtmlCandidates } from './staticParser'
import { writeMdMessage } from './agentsMd'

export interface NetworkCaptureResult {
  manifestUrl?: string | null
  headers?: Record<string, string> | null
  notes?: string
}

function fetchHtml(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; html: string; status?: number; notes?: string }> {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location
        res.resume()
        const next = loc.startsWith('http') ? loc : new URL(loc, url).toString()
        fetchHtml(next, headers).then(resolve)
        return
      }
      if ((res.statusCode || 0) >= 400) {
        res.resume()
        resolve({ ok: false, html: '', status: res.statusCode, notes: `http ${res.statusCode}` })
        return
      }
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => resolve({ ok: true, html: data }))
    })
    req.on('error', (err) => resolve({ ok: false, html: '', notes: err?.message || String(err) }))
  })
}

/**
 * Lightweight dynamic capture fallback: fetch page HTML and extract manifest candidates.
 * For full dynamic session capture, integrate Playwright/Chromium in future iteration.
 */
export async function captureNetwork(url: string, headers?: Record<string, string>): Promise<NetworkCaptureResult> {
  if (!url) return { manifestUrl: null, headers: null, notes: 'no url provided' }
  try {
  writeMdMessage({ agent: '动态抓包引擎', type: 'start', text: `开始抓包：${url}`, payload: { headerKeys: Object.keys(headers || {}) } })
  } catch {}
  // Prefer Playwright-based capture when available
  try {
    const mod: any = await import('./playwrightCapture')
    if (mod && typeof mod.captureNetworkWithPlaywright === 'function') {
      // Read environment-driven options for robustness
      const headlessEnv = (process.env.PLAYWRIGHT_HEADLESS || '').toLowerCase()
      const timeoutEnv = Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 0)
      const channelEnv = (process.env.PLAYWRIGHT_CHANNEL || '').trim()
      const execEnv = (process.env.PLAYWRIGHT_EXECUTABLE_PATH || '').trim()
      const useLocal = Boolean(channelEnv || execEnv)
      const baseOpts = {
        headers,
        headless: headlessEnv ? headlessEnv !== 'false' && headlessEnv !== '0' : true,
        timeoutMs: timeoutEnv > 0 ? timeoutEnv : 15000,
        useLocalBrowser: useLocal,
        channel: (channelEnv || undefined) as any,
        executablePath: execEnv || undefined,
        autoPlay: (process.env.PLAYWRIGHT_AUTO_PLAY || '0') === '1',
      }
      let res: NetworkCaptureResult = await mod.captureNetworkWithPlaywright(url, baseOpts)
  try { writeMdMessage({ agent: '动态抓包引擎', type: 'playwright_attempt', text: '尝试 headless 捕获', payload: { headless: baseOpts.headless, timeoutMs: baseOpts.timeoutMs, autoPlay: baseOpts.autoPlay, channel: baseOpts.channel || null } }) } catch {}
      // Fallback attempt: if no manifest, try headful + autoPlay + local channel if available
      if (!res?.manifestUrl) {
        const fallbackOpts = {
          ...baseOpts,
          headless: false,
          autoPlay: true,
          timeoutMs: Math.max(baseOpts.timeoutMs, 25000),
          useLocalBrowser: true,
          channel: (channelEnv || 'chrome') as any,
        }
        try {
  try { writeMdMessage({ agent: '动态抓包引擎', type: 'playwright_attempt', text: '回退 headful + autoPlay', payload: { headless: false, autoPlay: true, channel: fallbackOpts.channel } }) } catch {}
          res = await mod.captureNetworkWithPlaywright(url, fallbackOpts)
        } catch {}
      }
      if (res && (res.manifestUrl || (typeof res.notes === 'string' && res.notes.includes('playwright')))) {
  try { writeMdMessage({ agent: '动态抓包引擎', type: 'playwright_result', text: res.manifestUrl ? '捕获到清单' : '未捕获清单', payload: { manifestUrl: res.manifestUrl || null, headerKeys: Object.keys(res.headers || {}), notes: res.notes } }) } catch {}
        return { manifestUrl: res.manifestUrl ?? null, headers: res.headers ?? (headers ?? null), notes: res.notes || 'playwright capture' }
      }
    }
  } catch {}
  // Fallback: fetch HTML and extract candidates statically
  const page = await fetchHtml(url, headers)
  if (!page.ok) {
  try { writeMdMessage({ agent: '动态抓包引擎', type: 'fallback_fetch_error', text: '抓取页面失败', payload: { status: page.status || 0, notes: page.notes } }) } catch {}
    return { manifestUrl: null, headers: headers ?? null, notes: page.notes || 'fetch failed' }
  }
  try { writeMdMessage({ agent: '动态抓包引擎', type: 'fallback_fetch_ok', text: '抓取页面成功', payload: { htmlLength: page.html.length } }) } catch {}
  const { candidates } = extractHtmlCandidates(page.html)
  try { writeMdMessage({ agent: '动态抓包引擎', type: 'fallback_candidates', text: `静态回退候选：${candidates.length} 个`, payload: { sample: candidates.slice(0, 6) } }) } catch {}
  return { manifestUrl: candidates[0] || null, headers: headers ?? null, notes: `fallback network capture via HTML; candidates=${candidates.length}` }
}