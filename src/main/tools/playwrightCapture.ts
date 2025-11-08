// Playwright-based dynamic network capture
// Uses headless Chromium to load the page, captures fetch/XHR/requests,
// extracts manifest candidates (.m3u8/.mpd) and critical headers (User-Agent/Referer/Cookie).
import { writeMdMessage } from './agentsMd'

export interface PlaywrightCaptureOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  userAgent?: string
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
  headless?: boolean
  // Prefer launching installed local browser channel (chrome/msedge) or a specific executable
  useLocalBrowser?: boolean
  channel?: 'chrome' | 'msedge' | 'chromium'
  executablePath?: string
  // Attempt to trigger playback to surface media requests
  autoPlay?: boolean
}

export interface NetworkCaptureResult {
  manifestUrl?: string | null
  headers?: Record<string, string> | null
  notes?: string
}

function isManifest(url: string): boolean {
  return /\.(m3u8|mpd)(\?|$)/i.test(url)
}

export async function captureNetworkWithPlaywright(url: string, options?: PlaywrightCaptureOptions): Promise<NetworkCaptureResult> {
  if (!url) return { manifestUrl: null, headers: null, notes: 'no url provided' }

  let chromium: any
  try {
    const mod: any = await import('playwright')
    chromium = mod.chromium
  } catch {
try { writeMdMessage({ agent: '动态抓包引擎', type: 'playwright_unavailable', text: 'Playwright 未安装' }) } catch {}
    return { manifestUrl: null, headers: options?.headers ?? null, notes: 'playwright not installed' }
  }

  const headless = options?.headless !== false
  const timeoutMs = options?.timeoutMs ?? 15000
  const criticalHeaders: Record<string, string> = {}
  const candidates = new Set<string>()
  const notes: string[] = []

  // Launch options: allow using local installed browser channel or executable
  const launchOpts: any = { headless }
  try {
    const envChannel = (process.env.PLAYWRIGHT_CHANNEL || '').trim()
    const envExec = (process.env.PLAYWRIGHT_EXECUTABLE_PATH || '').trim()
    const useLocal = options?.useLocalBrowser || Boolean(envChannel || envExec)
    if (useLocal) {
      if (options?.channel || envChannel) {
        launchOpts.channel = options?.channel || (envChannel as any)
        notes.push(`channel=${String(launchOpts.channel)}`)
      } else if (options?.executablePath || envExec) {
        launchOpts.executablePath = options?.executablePath || envExec
        notes.push(`exec=${String(launchOpts.executablePath)}`)
      }
    }
    const proxyServer = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
    if (proxyServer) {
      launchOpts.proxy = { server: proxyServer }
      notes.push(`proxy=${proxyServer}`)
    }
  } catch {}

  const browser = await chromium.launch(launchOpts)
  try {
try { writeMdMessage({ agent: '动态抓包引擎', type: 'playwright_launch', text: '浏览器启动', payload: { headless: launchOpts.headless, channel: launchOpts.channel || null, proxy: !!launchOpts.proxy } }) } catch {}
    const context = await browser.newContext({
      userAgent: options?.userAgent,
      extraHTTPHeaders: options?.headers,
    })
    if (Array.isArray(options?.cookies) && options!.cookies!.length) {
      try { await context.addCookies(options!.cookies!) } catch {}
    }
    const page = await context.newPage()

    // Capture requests to detect manifests and collect headers
    page.on('request', (req: any) => {
      const u = String(req.url() || '')
      if (isManifest(u)) {
        candidates.add(u)
        const h = req.headers() || {}
        const keys = ['user-agent', 'referer', 'cookie']
        for (const k of keys) {
          const v = h[k]
          if (v && !criticalHeaders[k]) criticalHeaders[k] = v
        }
      }
    })
    page.on('response', async (res: any) => {
      try {
        const ct = String(res.headers()['content-type'] || '')
        const urlStr = String(res.url() || '')
        if (/mpegurl|mpd/i.test(ct) || isManifest(urlStr)) {
          candidates.add(urlStr)
          const req = res.request?.()
          const h = (req && typeof req.headers === 'function') ? req.headers() : {}
          const keys = ['user-agent', 'referer', 'cookie']
          for (const k of keys) {
            const v = h?.[k]
            if (v && !criticalHeaders[k]) criticalHeaders[k] = v
          }
        }
      } catch {}
    })

    // Navigate and wait
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    try { await page.waitForLoadState('networkidle', { timeout: Math.max(3000, Math.floor(timeoutMs / 3)) }) } catch {}

    // Optional: try to trigger playback to surface manifest requests
    if (options?.autoPlay) {
      notes.push('autoPlay=on')
      try {
        // common play buttons
        const selectors = [
          'button[aria-label*="Play" i]',
          'button[aria-label*="播放" i]',
          '.vjs-play-control',
          '[class*="play" i]',
          '#play',
        ]
        for (const sel of selectors) {
          try { await page.click(sel, { timeout: 800 }) } catch {}
        }
        try { await page.keyboard.press('Space') } catch {}
        try {
          await page.evaluate(() => {
            const v: any = (globalThis as any).document?.querySelector?.('video') || null
            if (v) { v.muted = true; v.play?.() }
          })
        } catch {}
        try {
          // wait for any manifest request shortly after auto actions
          const req = await page.waitForEvent('request', {
            timeout: Math.max(2000, Math.floor(timeoutMs / 4)),
            predicate: (r: any) => {
              try { return /\.(m3u8|mpd)(\?|$)/i.test(String(r.url() || '')) } catch { return false }
            }
          })
          if (req) {
            const u = String(req.url() || '')
            candidates.add(u)
            const h = req.headers() || {}
            const keys = ['user-agent', 'referer', 'cookie']
            for (const k of keys) {
              const v = h[k]
              if (v && !criticalHeaders[k]) criticalHeaders[k] = v
            }
          }
        } catch {}
      } catch {}
    }

    // Also scan HTML for manifest links
    try {
      const html: string = await page.content()
      const regex = /(https?:[^\s"']+\.(?:m3u8|mpd))(?:\?[^\s"']*)?/gi
      let m: RegExpExecArray | null
      while ((m = regex.exec(html))) candidates.add(m[1])
      const attrRegex = /(src|href)=["']([^"']+\.(?:m3u8|mpd))(?:\?[^"']*)?["']/gi
      while ((m = attrRegex.exec(html))) candidates.add(m[2])
    } catch {}

    // Collect cookies to build Cookie header if not present
    try {
      const cookiesArr: Array<{ name: string; value: string }> = await context.cookies()
      if (cookiesArr && cookiesArr.length && !criticalHeaders['cookie']) {
        const cookieStr = cookiesArr.map(c => `${c.name}=${c.value}`).join('; ')
        if (cookieStr) criticalHeaders['cookie'] = cookieStr
      }
    } catch {}

    // User-Agent from navigator if missing
    try {
      if (!criticalHeaders['user-agent']) {
        const ua = await page.evaluate(() => navigator.userAgent)
        if (ua) criticalHeaders['user-agent'] = String(ua)
      }
    } catch {}

    const list = Array.from(candidates)
    const manifestUrl = list[0] || null
    const headers = Object.keys(criticalHeaders).length ? criticalHeaders : (options?.headers ?? null)
    notes.push(`candidates=${list.length}`)
try { writeMdMessage({ agent: '动态抓包引擎', type: 'playwright_candidates', text: `候选 ${list.length} 个`, payload: { sample: list.slice(0, 6), headerKeys: Object.keys(headers || {}) } }) } catch {}
    return { manifestUrl, headers, notes: `playwright capture; ${notes.join(' | ')}` }
  } catch (e: any) {
try { writeMdMessage({ agent: '动态抓包引擎', type: 'playwright_error', text: '抓包异常', payload: { message: e?.message || String(e) } }) } catch {}
    return { manifestUrl: null, headers: options?.headers ?? null, notes: e?.message || 'playwright capture error' }
  } finally {
    try { await browser.close() } catch {}
  }
}