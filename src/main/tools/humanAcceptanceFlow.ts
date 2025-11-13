import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { BrowserWindow, ipcMain } from 'electron'
import { fetchManifestContent, parseManifest, parseHlsMediaPlaylist, parseHlsManifest, Variant } from './manifest'
import { extractHtmlCandidates } from './staticParser'
import { appendDebug } from './debugMonitor'
import { downloadAndMerge, runStoredAlgorithm } from './downloader'
import { writeMdMessage } from './agentsMd'

export type AcceptanceVariant = {
  id: string
  kind: 'hls' | 'dash' | 'direct'
  url?: string
  name?: string
  res?: { width: number; height: number }
  br?: number
  sizeApproxBytes?: number
  notes?: string
}

function readLatestAlgorithmCodeFromMd(mdPath: string): string | null {
  try {
    const content = fs.readFileSync(mdPath, 'utf-8')
    // Grab the last fenced code block (``` ... ```), prefer ts/js
    const blocks = Array.from(content.matchAll(/```(ts|typescript|js|javascript)?\n([\s\S]*?)\n```/gi))
    if (!blocks.length) return null
    const last = blocks[blocks.length - 1]
    return last[2] || null
  } catch {
    return null
  }
}

async function runAlgorithmCode(code: string, pageUrl?: string, headers?: Record<string, string>): Promise<{ manifestUrl?: string; directUrl?: string; headers?: Record<string, string> } | null> {
  try {
    const sandbox: any = {
      console,
      headers: headers || {},
      helpers: {
        fetch: async (url: string, init?: any): Promise<{ text: () => Promise<string>; status: number; headers: Record<string, string> } | null> => {
          try {
            const res = await fetch(url, init)
            return { status: (res as any).status || 200, headers: {}, text: () => (res as any).text() }
          } catch {
            return null
          }
        },
        sleep: async (ms: number) => new Promise((r) => setTimeout(r, ms)),
      },
      __algoFn: null,
    }
    const context = vm.createContext(sandbox)
    const script = new vm.Script(code + '\n; this.__algoFn = (typeof parse === "function" ? parse : (typeof resolve === "function" ? resolve : null));')
    script.runInContext(context)
    const fn = sandbox.__algoFn
    if (typeof fn !== 'function') return null
    const out = await Promise.resolve(fn(pageUrl, sandbox.helpers, sandbox.headers))
    if (!out || typeof out !== 'object') return null
    const manifestUrl = out.manifestUrl || out.m3u8 || out.hls || out.url
    const directUrl = out.directUrl || out.mp4 || out.file || out.mediaUrl
    const resHeaders = out.headers && typeof out.headers === 'object' ? out.headers : headers
    return { manifestUrl, directUrl, headers: resHeaders || undefined }
  } catch (e) {
    return null
  }
}

export async function buildVariantsFromAlgorithmMd(args: {
  algorithmMdPath: string
  pageUrl?: string
  headers?: Record<string, string>
  manifestUrlOverride?: string
}): Promise<{ variants: AcceptanceVariant[]; manifestUrl?: string; kind?: 'hls' | 'dash' | 'direct'; notes?: string }> {
  const variants: AcceptanceVariant[] = []
  const dbg = null
  appendDebug(dbg, 'input_md', `pageUrl=${args.pageUrl || ''}`, { headers: args.headers })
  let manifestUrl: string | undefined
  let directUrl: string | undefined
  let usedHeaders: Record<string, string> | undefined
  if (args.manifestUrlOverride) {
    manifestUrl = args.manifestUrlOverride
    directUrl = undefined
    usedHeaders = args.headers
    appendDebug(dbg, 'algorithm_override', 'use manifest override', { manifestUrl })
  } else {
    const code = readLatestAlgorithmCodeFromMd(args.algorithmMdPath)
    if (!code) return { variants, notes: 'no algorithm code in md' }
    const res = await runAlgorithmCode(code, args.pageUrl, args.headers)
    manifestUrl = res?.manifestUrl
    directUrl = res?.directUrl
    usedHeaders = res?.headers || args.headers
  }
  const headerNote = usedHeaders ? `headers: ${Object.keys(usedHeaders).join(',')}` : 'no headers'
  appendDebug(dbg, 'algorithm_result', '', { manifestUrl, directUrl, headers: usedHeaders })

  if (directUrl) {
  }
  if (!manifestUrl) {
    // Fallback: try static HTML extraction if pageUrl provided
    if (args.pageUrl) {
      try {
        const resHtml = await fetch(args.pageUrl, { headers: usedHeaders })
        const html = await (resHtml as any).text()
        const { candidates } = extractHtmlCandidates(html)
        const headerNote = usedHeaders ? `headers: ${Object.keys(usedHeaders).join(',')}` : 'no headers'
        const unwrap = (u: string): string => {
          try { const ur = new URL(u); const inner = ur.searchParams.get('url') || ur.searchParams.get('u') || ur.searchParams.get('v'); if (inner && /^https?:/i.test(inner)) return inner } catch {} ; return u
        }
        for (let i = 0; i < Math.min(candidates.length, 5); i++) {
          const raw = candidates[i]
          const u = unwrap(raw)
          const isHls = /\.m3u8(\?|$)/i.test(u)
          const isDash = /\.mpd(\?|$)/i.test(u)
          let vItem: AcceptanceVariant = { id: `cand_${i}`, kind: (isDash ? 'dash' : (isHls ? 'hls' : 'direct')), url: u, name: isHls ? 'HLS Playlist' : (isDash ? 'DASH Manifest' : 'Direct Media'), notes: headerNote }
          try {
            const fetched = await fetchManifestContent(u, usedHeaders)
            if (fetched.ok && fetched.content) {
              if ((isHls || fetched.kind === 'hls')) {
                if (/EXT-X-STREAM-INF/.test(fetched.content)) {
                  const { variants: hvars } = parseHlsManifest(fetched.content)
                  if (hvars.length) {
                    const h0 = hvars[0]
                    vItem.res = h0.res
                    vItem.br = h0.br
                    vItem.name = `${h0.res ? `${h0.res.width}x${h0.res.height}` : 'HLS'} @ ${h0.br ? `${h0.br.toFixed(2)}Mbps` : '?'}`
                  }
                } else {
                  const media = parseHlsMediaPlaylist(fetched.content, u)
                  const segmentsCount = media.segments.length
                  const tgt = media.targetDuration || 4
                  const totalDurationSec = Math.max(segmentsCount * tgt, tgt)
                  const brMbps = 2
                  vItem.sizeApproxBytes = Math.floor(brMbps * 1024 * 1024 * totalDurationSec)
                  vItem.name = `HLS Playlist (~${(totalDurationSec/60).toFixed(0)}min)`
                }
              } else if ((isDash || fetched.kind === 'dash')) {
                const parsedDash = parseManifest({ content: fetched.content })
                if (parsedDash.variants.length) {
                  const d0 = parsedDash.variants[0]
                  vItem.res = d0.res
                  vItem.br = d0.br
                  vItem.name = `${d0.res ? `${d0.res.width}x${d0.res.height}` : 'DASH'} @ ${d0.br ? `${d0.br.toFixed(2)}Mbps` : '?'}`
                }
              }
            }
          } catch {}
          variants.push(vItem)
        }
        appendDebug(dbg, 'static_fallback_candidates', `count=${candidates.length}`, { sample: candidates.slice(0, 3) })
        if (variants.length) return { variants, notes: 'fallback from static html candidates' }
      } catch {}
    }
    appendDebug(dbg, 'algorithm_exec_failed', 'md produced no manifest/direct')
    return { variants, notes: directUrl ? 'direct only' : 'algorithm produced no manifest/direct' }
  }
  const unwrap = (u: string): string => {
    try {
      const ur = new URL(u)
      const inner = ur.searchParams.get('url') || ur.searchParams.get('u') || ur.searchParams.get('v')
      if (inner && /^https?:/i.test(inner)) return inner
    } catch {}
    return u
  }
  const baseUrl = unwrap(manifestUrl)
  const fetched = await fetchManifestContent(baseUrl, usedHeaders)
  if (!fetched.ok || !fetched.content) {
    if (directUrl) return { variants, manifestUrl, kind: 'direct', notes: fetched.notes || 'fetch manifest failed; fallback to direct' }
    return { variants, manifestUrl, notes: fetched.notes || 'fetch manifest failed' }
  }
  appendDebug(dbg, 'manifest_fetch', '', { ok: fetched.ok, kind: fetched.kind, status: fetched.status, notes: fetched.notes, contentHead: fetched.content?.slice(0, 400) })
  const parsed = parseManifest({ content: fetched.content })
  const kind: 'hls' | 'dash' | undefined = parsed.kind || (
    manifestUrl && /\.m3u8(\?|$)/i.test(manifestUrl) ? 'hls' : (
      manifestUrl && /\.mpd(\?|$)/i.test(manifestUrl) ? 'dash' : undefined
    )
  )
  appendDebug(dbg, 'manifest_kind', String(kind || 'unknown'))
  if (kind === 'hls') {
    // Build variants and estimate size by fetching each media playlist
    const { variants: hlsVars } = parseHlsManifest(fetched.content)
    appendDebug(dbg, 'hls_master_variants', `count=${hlsVars.length}`)
    if (!hlsVars.length) {
      // Fallback: master 清单中无变体，视为媒体播放清单（单一路径）
      try {
        const media = parseHlsMediaPlaylist(fetched.content, manifestUrl)
        const segmentsCount = media.segments.length
        const tgt = media.targetDuration || 4
        const totalDurationSec = Math.max(segmentsCount * tgt, tgt)
        const sizeApproxBytes = Math.floor((2 /*估算码率Mbps*/ ) * 1024 * 1024 * totalDurationSec)
        variants.push({ id: 'hls_playlist', kind: 'hls', url: manifestUrl, name: 'HLS Playlist', sizeApproxBytes, notes: headerNote })
        appendDebug(dbg, 'hls_fallback_media_playlist', `segments=${segmentsCount}, target=${tgt}`, { url: manifestUrl })
      } catch {
        variants.push({ id: 'hls_playlist', kind: 'hls', url: manifestUrl, name: 'HLS Playlist', notes: headerNote })
        appendDebug(dbg, 'hls_fallback_media_playlist_parse_failed', '', { url: manifestUrl })
      }
    } else {
      for (let i = 0; i < hlsVars.length; i++) {
        const v: Variant = hlsVars[i]
        const playlistUrl = v.uri ? new URL(v.uri, baseUrl).toString() : baseUrl
        let sizeApproxBytes: number | undefined
        try {
          const pl = await fetchManifestContent(playlistUrl, usedHeaders)
          if (pl.ok && pl.content) {
            const media = parseHlsMediaPlaylist(pl.content, playlistUrl)
            const segmentsCount = media.segments.length
            const tgt = media.targetDuration || 4
            const totalDurationSec = Math.max(segmentsCount * tgt, tgt)
            const brMbps = v.br || 2
            sizeApproxBytes = Math.floor(brMbps * 1024 * 1024 * totalDurationSec)
            appendDebug(dbg, 'hls_variant_playlist', `id=${v.id}`, { url: playlistUrl, res: v.res, br: v.br, segments: segmentsCount, target: tgt })
          }
        } catch {}
        variants.push({
          id: v.id,
          kind: 'hls',
          url: playlistUrl,
          res: v.res,
          br: v.br,
          sizeApproxBytes,
          name: `${v.res ? `${v.res.width}x${v.res.height}` : 'HLS'} @ ${v.br ? `${v.br.toFixed(2)}Mbps` : '?'}`,
          notes: headerNote,
        })
      }
    }
  } else if (kind === 'dash') {
    // For DASH, we list representations with bitrate and resolution (no size estimate)
    const parsedDash = parseManifest({ content: fetched.content })
    if (!parsedDash.variants.length) {
      // Fallback: MPD 解析不到 Representation，也给一个可选项避免阻塞
      variants.push({ id: 'dash_manifest', kind: 'dash', url: manifestUrl, name: 'DASH Manifest', notes: headerNote })
      appendDebug(dbg, 'dash_fallback_manifest', '', { url: manifestUrl })
    } else {
      for (const v of parsedDash.variants) {
        variants.push({
          id: v.id,
          kind: 'dash',
          url: manifestUrl,
          res: v.res,
          br: v.br,
          name: `${v.res ? `${v.res.width}x${v.res.height}` : 'DASH'} @ ${v.br ? `${v.br.toFixed(2)}Mbps` : '?'}`,
          notes: headerNote,
        })
        appendDebug(dbg, 'dash_variant', `id=${v.id}`, { res: v.res, br: v.br })
      }
    }
  } else if (!kind) {
    // Unknown kind but URL后缀指向清单类型不明确时，按扩展兜底，避免 no variants
    if (/\.m3u8(\?|$)/i.test(manifestUrl)) {
      variants.push({ id: 'hls_playlist', kind: 'hls', url: manifestUrl, name: 'HLS Playlist', notes: headerNote })
      appendDebug(dbg, 'unknown_kind_hls_fallback', '', { url: manifestUrl })
    } else if (/\.mpd(\?|$)/i.test(manifestUrl)) {
      variants.push({ id: 'dash_manifest', kind: 'dash', url: manifestUrl, name: 'DASH Manifest', notes: headerNote })
      appendDebug(dbg, 'unknown_kind_dash_fallback', '', { url: manifestUrl })
    }
  }
  if (directUrl) {
    variants.push({ id: 'direct_0', kind: 'direct', url: directUrl, name: 'Direct Media', notes: headerNote })
  }
  appendDebug(dbg, 'variants_built', `count=${variants.length}`, { variants })
  return { variants, manifestUrl, kind, notes: `built ${variants.length} variants` }
}

// 复用主界面选择的算法（来自 algorithms.json），构建人类验收的变体列表
export async function buildVariantsFromStoredAlgorithm(args: {
  algorithmName?: string
  pageUrl?: string
  headers?: Record<string, string>
}): Promise<{ variants: AcceptanceVariant[]; manifestUrl?: string; kind?: 'hls' | 'dash' | 'direct'; notes?: string }> {
  const variants: AcceptanceVariant[] = []
  const dbg = null
  appendDebug(dbg, 'input_store', `algorithm=${args.algorithmName || ''} pageUrl=${args.pageUrl || ''}`, { headers: args.headers })
  const res = await runStoredAlgorithm(args.pageUrl || '', args.headers, args.algorithmName)
  if (!res) {
    appendDebug(dbg, 'algorithm_exec_failed', 'store missing or exec failed')
    return { variants, notes: 'no algorithm in store or exec failed' }
  }

  const manifestUrl = res.manifestUrl
  const directUrl = res.directUrl
  const usedHeaders = res.headers || args.headers
  const headerNote = usedHeaders ? `headers: ${Object.keys(usedHeaders).join(',')}` : 'no headers'
  appendDebug(dbg, 'algorithm_result', '', { manifestUrl, directUrl, headers: usedHeaders })
  if (directUrl) {
  }
  if (!manifestUrl) return { variants, notes: directUrl ? 'direct only' : 'algorithm produced no manifest/direct' }

  const baseUrl = ((): string => {
    try {
      const ur = new URL(manifestUrl)
      const inner = ur.searchParams.get('url') || ur.searchParams.get('u') || ur.searchParams.get('v')
      if (inner && /^https?:/i.test(inner)) return inner
    } catch {}
    return manifestUrl
  })()
  const fetched = await fetchManifestContent(baseUrl, usedHeaders)
  if (!fetched.ok || !fetched.content) {
    if (directUrl) return { variants, manifestUrl, kind: 'direct', notes: fetched.notes || 'fetch manifest failed; fallback to direct' }
    return { variants, manifestUrl, notes: fetched.notes || 'fetch manifest failed' }
  }
  appendDebug(dbg, 'manifest_fetch', '', { ok: fetched.ok, kind: fetched.kind, status: fetched.status, notes: fetched.notes, contentHead: fetched.content?.slice(0, 400) })

  const parsed = parseManifest({ content: fetched.content })
  const kind: 'hls' | 'dash' | undefined = parsed.kind || (
    manifestUrl && /\.m3u8(\?|$)/i.test(manifestUrl) ? 'hls' : (
      manifestUrl && /\.mpd(\?|$)/i.test(manifestUrl) ? 'dash' : undefined
    )
  )
  appendDebug(dbg, 'manifest_kind', String(kind || 'unknown'))
  if (kind === 'hls') {
    const { variants: hlsVars } = parseHlsManifest(fetched.content)
    appendDebug(dbg, 'hls_master_variants', `count=${hlsVars.length}`)
    if (!hlsVars.length) {
      // Fallback: master 清单中无变体，视为媒体播放清单（单一路径）
      try {
        const media = parseHlsMediaPlaylist(fetched.content, manifestUrl)
        const segmentsCount = media.segments.length
        const tgt = media.targetDuration || 4
        const totalDurationSec = Math.max(segmentsCount * tgt, tgt)
        const sizeApproxBytes = Math.floor((2 /*估算码率Mbps*/ ) * 1024 * 1024 * totalDurationSec)
        variants.push({ id: 'hls_playlist', kind: 'hls', url: manifestUrl, name: 'HLS Playlist', sizeApproxBytes, notes: headerNote })
        appendDebug(dbg, 'hls_fallback_media_playlist', `segments=${segmentsCount}, target=${tgt}`, { url: manifestUrl })
      } catch {
        variants.push({ id: 'hls_playlist', kind: 'hls', url: manifestUrl, name: 'HLS Playlist', notes: headerNote })
        appendDebug(dbg, 'hls_fallback_media_playlist_parse_failed', '', { url: manifestUrl })
      }
    } else {
      for (let i = 0; i < hlsVars.length; i++) {
        const v: Variant = hlsVars[i]
        const playlistUrl = v.uri ? new URL(v.uri, baseUrl).toString() : baseUrl
        let sizeApproxBytes: number | undefined
        try {
          const pl = await fetchManifestContent(playlistUrl, usedHeaders)
          if (pl.ok && pl.content) {
            const media = parseHlsMediaPlaylist(pl.content, playlistUrl)
            const segmentsCount = media.segments.length
            const tgt = media.targetDuration || 4
            const totalDurationSec = Math.max(segmentsCount * tgt, tgt)
            const brMbps = v.br || 2
            sizeApproxBytes = Math.floor(brMbps * 1024 * 1024 * totalDurationSec)
            appendDebug(dbg, 'hls_variant_playlist', `id=${v.id}`, { url: playlistUrl, res: v.res, br: v.br, segments: segmentsCount, target: tgt })
          }
        } catch {}
        variants.push({
          id: v.id,
          kind: 'hls',
          url: playlistUrl,
          res: v.res,
          br: v.br,
          sizeApproxBytes,
          name: `${v.res ? `${v.res.width}x${v.res.height}` : 'HLS'} @ ${v.br ? `${v.br.toFixed(2)}Mbps` : '?'}`,
          notes: headerNote,
        })
      }
    }
  } else if (kind === 'dash') {
    const parsedDash = parseManifest({ content: fetched.content })
    if (!parsedDash.variants.length) {
      variants.push({ id: 'dash_manifest', kind: 'dash', url: manifestUrl, name: 'DASH Manifest', notes: headerNote })
      appendDebug(dbg, 'dash_fallback_manifest', '', { url: manifestUrl })
    } else {
      for (const v of parsedDash.variants) {
        variants.push({
          id: v.id,
          kind: 'dash',
          url: manifestUrl,
          res: v.res,
          br: v.br,
          name: `${v.res ? `${v.res.width}x${v.res.height}` : 'DASH'} @ ${v.br ? `${v.br.toFixed(2)}Mbps` : '?'}`,
          notes: headerNote,
        })
        appendDebug(dbg, 'dash_variant', `id=${v.id}`, { res: v.res, br: v.br })
      }
    }
  } else if (!kind) {
    if (/\.m3u8(\?|$)/i.test(manifestUrl)) {
      variants.push({ id: 'hls_playlist', kind: 'hls', url: manifestUrl, name: 'HLS Playlist', notes: headerNote })
      appendDebug(dbg, 'unknown_kind_hls_fallback', '', { url: manifestUrl })
    } else if (/\.mpd(\?|$)/i.test(manifestUrl)) {
      variants.push({ id: 'dash_manifest', kind: 'dash', url: manifestUrl, name: 'DASH Manifest', notes: headerNote })
      appendDebug(dbg, 'unknown_kind_dash_fallback', '', { url: manifestUrl })
    }
  }
  if (directUrl) {
    variants.push({ id: 'direct_0', kind: 'direct', url: directUrl, name: 'Direct Media', notes: headerNote })
  }
  appendDebug(dbg, 'variants_built', `count=${variants.length}`, { variants })
  return { variants, manifestUrl, kind, notes: `built ${variants.length} variants` }
}

export async function requestHumanAcceptanceSelection(args: {
  prompt?: string
  variants: AcceptanceVariant[]
}): Promise<{ variant?: AcceptanceVariant } | null> {
  try {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const requestId = String(Date.now())
    const channel = 'human_acceptance:request'
    const respondChannel = `human_acceptance:respond:${requestId}`
    return await new Promise((resolve) => {
      const handler = (_e: any, payload: any) => {
        ipcMain.removeListener(respondChannel, handler)
        resolve(payload || null)
      }
      ipcMain.on(respondChannel, handler)
      win.webContents.send(channel, { requestId, prompt: args.prompt || '请选择清单变体进行下载', variants: args.variants })
    })
  } catch {
    return null
  }
}

export async function runHumanAcceptanceFlow(args: {
  algorithmMdPath: string
  pageUrl?: string
  headers?: Record<string, string>
  manifestUrl?: string
}): Promise<{ filePath?: string | null; isCorrect?: boolean; notes?: string }> {
  // Build variant list
  const { variants, manifestUrl, kind, notes } = await buildVariantsFromAlgorithmMd({
    algorithmMdPath: args.algorithmMdPath,
    pageUrl: args.pageUrl,
    headers: args.headers,
    manifestUrlOverride: args.manifestUrl,
  })
  writeMdMessage({ agent: '人类验收流程', type: 'variants_built', text: `候选 ${variants.length}，${notes || ''}` })
  if (!variants.length) return { filePath: null, isCorrect: false, notes: 'no variants' }

  // Ask human to select
  const selected = await requestHumanAcceptanceSelection({ variants })
  const pick = selected?.variant
  if (!pick) return { filePath: null, isCorrect: false, notes: 'no selection' }
  writeMdMessage({ agent: '人类验收流程', type: 'variant_selected', text: pick.name || pick.id, payload: pick })

  // Download & merge based on selection
  const targetUrl = pick.kind === 'direct' ? pick.url : (pick.url || manifestUrl || '')
  const dl = await downloadAndMerge({ manifestUrl: targetUrl, headers: args.headers })
  writeMdMessage({ agent: '人类验收流程', type: 'download_done', text: dl.ok ? 'ok' : (dl.notes || 'failed'), payload: dl })

  // After download, trigger the original human validator window via existing tool
  try {
    const { requestHumanValidation } = await import('./humanValidation')
    const hv = await requestHumanValidation({ prompt: '这是否是正确的视频？', videoPath: dl.filePath || undefined })
    return { filePath: dl.filePath, isCorrect: hv?.isCorrect, notes: hv?.notes || dl.notes }
  } catch (e: any) {
    return { filePath: dl.filePath, isCorrect: false, notes: e?.message || 'human validation failed' }
  }
}

// 主界面使用：基于算法存储项（algorithms.json）的人类验收流程
export async function runHumanAcceptanceFlowWithStore(args: {
  algorithmName?: string
  pageUrl?: string
  headers?: Record<string, string>
}): Promise<{ filePath?: string | null; isCorrect?: boolean; notes?: string }> {
  const { variants, manifestUrl, kind, notes } = await buildVariantsFromStoredAlgorithm({
    algorithmName: args.algorithmName,
    pageUrl: args.pageUrl,
    headers: args.headers,
  })
  writeMdMessage({ agent: '人类验收流程', type: 'variants_built', text: `候选 ${variants.length}，${notes || ''}` })
  if (!variants.length) return { filePath: null, isCorrect: false, notes: 'no variants' }

  const selected = await requestHumanAcceptanceSelection({ variants })
  const pick = selected?.variant
  if (!pick) return { filePath: null, isCorrect: false, notes: 'no selection' }
  writeMdMessage({ agent: '人类验收流程', type: 'variant_selected', text: pick.name || pick.id, payload: pick })

  const targetUrl = pick.kind === 'direct' ? pick.url : (pick.url || manifestUrl || '')
  const dl = await downloadAndMerge({ manifestUrl: targetUrl, headers: args.headers })
  writeMdMessage({ agent: '人类验收流程', type: 'download_done', text: dl.ok ? 'ok' : (dl.notes || 'failed'), payload: dl })

  try {
    const { requestHumanValidation } = await import('./humanValidation')
    const hv = await requestHumanValidation({ prompt: '这是否是正确的视频？', videoPath: dl.filePath || undefined })
    return { filePath: dl.filePath, isCorrect: hv?.isCorrect, notes: hv?.notes || dl.notes }
  } catch (e: any) {
    return { filePath: dl.filePath, isCorrect: false, notes: e?.message || 'human validation failed' }
  }
}
