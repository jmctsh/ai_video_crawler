import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { app, net } from 'electron'
import { listAlgorithms as listAlgoFiles, readAlgorithmCode } from './algStore'
import { buildDownloadPlan } from './manifest'
import { writeMdMessage } from './agentsMd'
import { spawnSync } from 'child_process'
import vm from 'vm'
import { startDebugSession, appendDebug } from './debugMonitor'

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function getDownloadDir(): string {
  const dir = path.join(app.getPath('userData'), 'downloads')
  ensureDir(dir)
  return dir
}

function pickFileNameFromUrl(urlStr: string): { base: string; ext: string } {
  try {
    const u = new URL(urlStr)
    const pathname = u.pathname
    const base = path.basename(pathname)
    const ext = path.extname(base)
    if (base) return { base, ext }
  } catch {}
  return { base: `video_${Date.now()}.mp4`, ext: '.mp4' }
}

function isDirectMedia(urlStr: string): boolean {
  return /(\.(mp4|ts|mkv|webm|mov|avi))(\?|$)/i.test(urlStr)
}

function findFfmpegPath(): string | null {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(process.cwd(), 'ffmpeg', exe),
    process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg', exe) : null,
    path.join(process.cwd(), 'bin', exe),
    'ffmpeg',
  ].filter(Boolean) as string[]
  for (const fp of candidates) {
    try {
      const r = spawnSync(fp, ['-version'], { stdio: 'ignore' })
      if (r.status === 0) return fp
    } catch {}
  }
  return null
}

function downloadFile(urlStr: string, destPath: string, headers?: Record<string, string>): Promise<{ ok: boolean; size: number; notes?: string }> {
  return new Promise((resolve) => {
    const client = urlStr.startsWith('https') ? https : http
    const req = client.get(urlStr, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
        const loc = res.headers.location
        res.resume()
        downloadFile(loc.startsWith('http') ? loc : new URL(loc, urlStr).toString(), destPath, headers).then(resolve)
        return
      }
      if ((res.statusCode || 0) >= 400) {
        res.resume()
        resolve({ ok: false, size: 0, notes: `http ${res.statusCode}` })
        return
      }
      const ws = fs.createWriteStream(destPath)
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
      })
      res.pipe(ws)
      ws.on('finish', () => {
        ws.close(() => resolve({ ok: bytes > 0, size: bytes }))
      })
      ws.on('error', (err) => {
        resolve({ ok: false, size: 0, notes: err?.message || String(err) })
      })
    })
    req.on('error', (err) => resolve({ ok: false, size: 0, notes: err?.message || String(err) }))
  })
}

export async function downloadAndMerge(args: { manifestUrl?: string; headers?: Record<string, string> }) {
  const url = args?.manifestUrl || ''
  if (!url) return { filePath: null as string | null, ok: false, notes: 'no manifestUrl' }

  // Direct media download (mp4/ts/webm/etc.)
  if (isDirectMedia(url)) {
    const { base, ext } = pickFileNameFromUrl(url)
    const fileName = base || `video_${Date.now()}${ext || '.mp4'}`
    const dest = path.join(getDownloadDir(), fileName)
    const { ok, size, notes } = await downloadFile(url, dest, args?.headers)
    if (!ok) return { filePath: dest, ok, notes }
    return { filePath: dest, ok: true, notes: `downloaded ${size} bytes` }
  }

  // HLS/DASH pipeline
  try {
  writeMdMessage({ agent: '下载与验收员', type: 'start', text: `开始下载：${url}` })
    const planRes = await buildDownloadPlan({ url, headers: args?.headers })
    if (!planRes.ok || !planRes.plan) {
      // 若直接清单失败，回退尝试执行已存储算法（最小可用）以获得清单或直链
      const algOut = await runStoredAlgorithm(url, args?.headers)
      if (algOut?.manifestUrl) {
  writeMdMessage({ agent: '下载与验收员', type: 'plan_retry_with_algorithm', text: '通过算法获得清单', payload: algOut })
        const retry = await buildDownloadPlan({ url: algOut.manifestUrl, headers: args?.headers })
        if (!retry.ok || !retry.plan) {
  writeMdMessage({ agent: '下载与验收员', type: 'plan_failed', text: retry.notes || '算法清单也无法生成下载计划' })
          return { filePath: null as string | null, ok: false, notes: retry.notes || 'plan failed after algorithm' }
        }
        Object.assign(planRes, retry)
      } else if (algOut?.directUrl) {
  writeMdMessage({ agent: '下载与验收员', type: 'plan_retry_with_algorithm', text: '通过算法获得直链', payload: algOut })
        const { base, ext } = pickFileNameFromUrl(algOut.directUrl)
        const dest = path.join(getDownloadDir(), base || `video_${Date.now()}${ext || '.mp4'}`)
        const { ok, size, notes } = await downloadFile(algOut.directUrl, dest, args?.headers)
        return { filePath: dest, ok, notes: ok ? `downloaded ${size} bytes` : notes }
      } else {
  writeMdMessage({ agent: '下载与验收员', type: 'plan_failed', text: planRes.notes || '无法生成下载计划' })
        return { filePath: null as string | null, ok: false, notes: planRes.notes || 'plan failed' }
      }
    }

    // HLS（fMP4 或 TS）
    if (planRes.kind === 'hls' && planRes.plan && planRes.plan.kind === 'hls') {
      const plan = planRes.plan!
      const outDir = getDownloadDir()
      const outPath = path.join(outDir, `video_${Date.now()}.mp4`)

      if (plan.isFmp4) {
        // 顺序追加 init + segments 到单个 mp4 文件
        const appendUrl = (srcUrl: string): Promise<boolean> => {
          return new Promise((resolve) => {
            const client = srcUrl.startsWith('https') ? https : http
            const req = client.get(srcUrl, { headers: args?.headers }, (res) => {
              if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const loc = res.headers.location
                res.resume()
                const next = loc.startsWith('http') ? loc : new URL(loc, srcUrl).toString()
                appendUrl(next).then((ok) => resolve(ok))
                return
              }
              if ((res.statusCode || 0) >= 400) {
                res.resume()
                resolve(false)
                return
              }
              const ws = fs.createWriteStream(outPath, { flags: 'a' })
              res.pipe(ws)
              ws.on('finish', () => ws.close(() => resolve(true)))
              ws.on('error', () => resolve(false))
            })
            req.on('error', () => resolve(false))
          })
        }

        if (plan.initUrl) {
  writeMdMessage({ agent: '下载与验收员', type: 'init', text: '下载初始化段', payload: { initUrl: plan.initUrl } })
          const okInit = await appendUrl(plan.initUrl)
          if (!okInit) return { filePath: null as string | null, ok: false, notes: 'init download failed' }
        }
        let done = 0
        for (const seg of plan.segments) {
          const okSeg = await appendUrl(seg)
          done += 1
  writeMdMessage({ agent: '下载与验收员', type: 'progress', text: `已写入分片 ${done}/${plan.segments.length}` })
          if (!okSeg) return { filePath: outPath, ok: false, notes: `segment failed at ${done}` }
        }
  writeMdMessage({ agent: '下载与验收员', type: 'merge', text: 'fMP4 直接合并完成', payload: { filePath: outPath } })
        return { filePath: outPath, ok: true, notes: 'hls fmp4 merged' }
      }

      // TS 分片：下载到本地并用 ffmpeg concat 合并为 mp4（最佳），无 ffmpeg 则合并为 .ts
      const tmpDir = path.join(outDir, `hls_ts_${Date.now()}`)
      ensureDir(tmpDir)
      const segPaths: string[] = []
      const downloadSeg = (srcUrl: string, destPath: string): Promise<boolean> => {
        return new Promise((resolve) => {
          const client = srcUrl.startsWith('https') ? https : http
          const req = client.get(srcUrl, { headers: args?.headers }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              const loc = res.headers.location
              res.resume()
              const next = loc.startsWith('http') ? loc : new URL(loc, srcUrl).toString()
              downloadSeg(next, destPath).then(resolve)
              return
            }
            if ((res.statusCode || 0) >= 400) {
              res.resume()
              resolve(false)
              return
            }
            const ws = fs.createWriteStream(destPath)
            res.pipe(ws)
            ws.on('finish', () => ws.close(() => resolve(true)))
            ws.on('error', () => resolve(false))
          })
          req.on('error', () => resolve(false))
        })
      }
      let idx = 0
      for (const seg of plan.segments!) {
        const name = `seg_${String(idx).padStart(6, '0')}.ts`
        const dest = path.join(tmpDir, name)
        const ok = await downloadSeg(seg, dest)
        idx += 1
  writeMdMessage({ agent: '下载与验收员', type: 'progress', text: `分片下载 ${idx}/${plan.segments!.length}` })
        if (!ok) return { filePath: null as string | null, ok: false, notes: `segment download failed at ${idx}` }
        segPaths.push(dest)
      }

      const ffmpegPath = findFfmpegPath()
      const hasFfmpeg = !!ffmpegPath && spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' }).status === 0
      if (hasFfmpeg) {
        const listPath = path.join(tmpDir, 'list.txt')
        fs.writeFileSync(listPath, segPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))
        const out = path.join(outDir, `video_${Date.now()}.mp4`)
        const run = spawnSync(ffmpegPath as string, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out], { stdio: 'ignore' })
        if (run.status === 0 && fs.existsSync(out)) {
  writeMdMessage({ agent: '下载与验收员', type: 'merge', text: 'ffmpeg concat 合并完成', payload: { filePath: out } })
          return { filePath: out, ok: true, notes: 'hls ts merged via ffmpeg' }
        }
        return { filePath: null as string | null, ok: false, notes: 'ffmpeg concat failed' }
      } else {
        // 无 ffmpeg：退化为 .ts 拼接文件
        const outTs = path.join(outDir, `video_${Date.now()}.ts`)
        for (const p of segPaths) {
          const data = fs.readFileSync(p)
          fs.appendFileSync(outTs, data)
        }
  writeMdMessage({ agent: '下载与验收员', type: 'merge', text: '无 ffmpeg：输出 TS 拼接文件', payload: { filePath: outTs } })
        return { filePath: outTs, ok: true, notes: 'hls ts concatenated (no ffmpeg)' }
      }
    }

    // DASH（简化版：按 SegmentTemplate 顺序追加）
    if (planRes.kind === 'dash' && planRes.plan && planRes.plan.kind === 'dash') {
      const plan = planRes.plan!
      const outDir = getDownloadDir()
      const outPath = path.join(outDir, `video_${Date.now()}.mp4`)
      const appendUrl = (srcUrl: string): Promise<boolean> => {
        return new Promise((resolve) => {
          const client = srcUrl.startsWith('https') ? https : http
          const req = client.get(srcUrl, { headers: args?.headers }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              const loc = res.headers.location
              res.resume()
              const next = loc.startsWith('http') ? loc : new URL(loc, srcUrl).toString()
              appendUrl(next).then((ok) => resolve(ok))
              return
            }
            if ((res.statusCode || 0) >= 400) {
              res.resume()
              resolve(false)
              return
            }
            const ws = fs.createWriteStream(outPath, { flags: 'a' })
            res.pipe(ws)
            ws.on('finish', () => ws.close(() => resolve(true)))
            ws.on('error', () => resolve(false))
          })
          req.on('error', () => resolve(false))
        })
      }
      if (plan.initUrl) {
        const okInit = await appendUrl(plan.initUrl)
        if (!okInit) return { filePath: null as string | null, ok: false, notes: 'dash init failed' }
      }
      let done = 0
      for (const seg of plan.segments!) {
        const okSeg = await appendUrl(seg)
        done += 1
  writeMdMessage({ agent: '下载与验收员', type: 'progress', text: `DASH 分片 ${done}/${plan.segments!.length}` })
        if (!okSeg) return { filePath: outPath, ok: false, notes: `dash segment failed at ${done}` }
      }
  writeMdMessage({ agent: '下载与验收员', type: 'merge', text: 'DASH 直接合并完成', payload: { filePath: outPath } })
      return { filePath: outPath, ok: true, notes: 'dash merged' }
    }

    return { filePath: null as string | null, ok: false, notes: 'unsupported plan' }
  } catch (e: any) {
    return { filePath: null as string | null, ok: false, notes: e?.message || String(e) }
  }
}

// ====== 简易算法执行（最小可用）：从算法存储中取最后一条，执行 parse(url) 或 resolve(url)
export async function runStoredAlgorithm(pageUrl: string, headers?: Record<string, string>, algoName?: string): Promise<{ manifestUrl?: string; directUrl?: string; headers?: Record<string, string>; notes?: string } | null> {
  const dbg = startDebugSession(algoName || 'storedAlg')
  try {
    appendDebug(dbg, 'store_begin', '执行已存储算法', { algoName: algoName || '', pageUrl, headers: headers || {} })
    // 优先从统一算法文件夹读取
    let code: string | null = null
    if (algoName) code = readAlgorithmCode(algoName)
    if (!code || !code.trim()) {
      const list = listAlgoFiles()
      appendDebug(dbg, 'store_list', '算法文件列表', { count: list.length })
      const pickName = algoName || (list.length ? list[list.length - 1].name : null)
      if (pickName) code = readAlgorithmCode(pickName)
      appendDebug(dbg, 'store_pick', '选取算法文件', { pickName: pickName || '' })
    }
    // 回退旧版 JSON 存储（兼容历史版本）
    if (!code || !code.trim()) {
      const storeFile = path.join(app.getPath('userData'), 'algorithms.json')
      if (!fs.existsSync(storeFile)) {
        appendDebug(dbg, 'store_json_absent', '旧版 JSON 存储不存在')
        return null
      }
      const raw = fs.readFileSync(storeFile, 'utf-8')
      const data = JSON.parse(raw)
      const algorithms = Array.isArray(data?.algorithms) ? data.algorithms : []
      if (!algorithms.length) {
        appendDebug(dbg, 'store_json_empty', '旧版 JSON 存储无算法')
        return null
      }
      let entry = algorithms[algorithms.length - 1]
      if (algoName) {
        const found = algorithms.find((a: any) => a?.name === algoName)
        if (found) entry = found
      }
      code = String(entry?.code || '')
      if (!code.trim()) {
        appendDebug(dbg, 'store_json_code_empty', 'JSON 算法代码为空')
        return null
      }
    }
    // 兼容 export 语法（简单删除关键字）；不处理复杂 ESM/CJS 差异
    code = code.replace(/\bexport\s+/g, '')
    appendDebug(dbg, 'code_loaded', '算法代码加载完成', { length: (code || '').length })
    const sandbox: any = {
      console,
      Buffer,
      URL,
      require,
      headers: headers || {},
      helpers: {
        async getText(u: string, h?: Record<string, string>) {
          const maxAttempts = 2
          let attempt = 0
          const baseHeaders = headers || {}
          const makeHeaders = (): Record<string, string> => {
            const merged: Record<string, string> = Object.assign({}, baseHeaders, h || {})
            if (!merged['User-Agent']) merged['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            if (!merged['Accept-Language']) merged['Accept-Language'] = 'en-US,en;q=0.9'
            if (!merged['Accept']) merged['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            if (!merged['Accept-Encoding']) merged['Accept-Encoding'] = 'identity'
            if (!merged['Connection']) merged['Connection'] = 'keep-alive'
            if (!merged['Cache-Control']) merged['Cache-Control'] = 'no-cache'
            if (!merged['Pragma']) merged['Pragma'] = 'no-cache'
            if (!merged['Referer']) {
              try { merged['Referer'] = new URL(u).origin + '/' } catch {}
            }
            return merged
          }

          const tryOnce = (): Promise<string> => {
            return new Promise<string>((resolve, reject) => {
              try {
                const headersNow = makeHeaders()
                appendDebug(dbg, 'getText_request', '请求页面', { url: u, headers: headersNow, attempt: attempt + 1 })
                // 优先使用 Electron 的 net（遵循系统代理、VPN），失败则回退至 Node http/https
                let usedElectronNet = false
                try {
                  const req = net.request({ url: u, method: 'GET' })
                  usedElectronNet = true
                  for (const [k, v] of Object.entries(headersNow)) {
                    try { req.setHeader(k, v as any) } catch {}
                  }
                  const timer = setTimeout(() => {
                    appendDebug(dbg, 'getText_timeout', '请求超时', { url: u, attempt: attempt + 1 })
                    try { req.abort() } catch {}
                    reject(new Error('timeout 15s'))
                  }, 15000)
                  req.on('response', (res: any) => {
                    const statusCode = res?.statusCode || 0
                    const headersResp = res?.headers || {}
                    if (statusCode >= 300 && statusCode < 400 && headersResp && (headersResp.location || headersResp.Location)) {
                      const next = (headersResp.location || headersResp.Location) as string
                      const abs = next && next.startsWith('http') ? next : new URL(next || '', u).toString()
                      appendDebug(dbg, 'getText_redirect', '跟随重定向', { to: abs })
                      clearTimeout(timer)
                      res.resume?.()
                      sandbox.helpers.getText(abs, h).then(resolve).catch(reject)
                      return
                    }
                    if (statusCode >= 400) {
                      clearTimeout(timer)
                      appendDebug(dbg, 'getText_http_error', 'HTTP 错误', { code: statusCode })
                      reject(new Error(`http ${statusCode}`))
                      return
                    }
                    const chunks: Buffer[] = []
                    res.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
                    res.on('end', () => {
                      clearTimeout(timer)
                      const data = Buffer.concat(chunks).toString('utf-8')
                      appendDebug(dbg, 'getText_response', '响应完成', { code: statusCode, length: data.length })
                      resolve(data)
                    })
                  })
                  req.on('error', (err: any) => {
                    clearTimeout(15000 as any as NodeJS.Timeout)
                    appendDebug(dbg, 'getText_error', '请求错误', { message: err?.message || String(err), attempt: attempt + 1 })
                    reject(err)
                  })
                  req.end()
                } catch (e) {
                  appendDebug(dbg, 'getText_electron_net_error', 'Electron net 使用失败，回退 Node', { message: (e as any)?.message || String(e) })
                }

                if (!usedElectronNet) {
                  const client = u.startsWith('https') ? https : http
                  const req = client.get(u, { headers: headersNow }, (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                      const next = res.headers.location!
                      res.resume()
                      const abs = next.startsWith('http') ? next : new URL(next, u).toString()
                      appendDebug(dbg, 'getText_redirect', '跟随重定向', { to: abs })
                      sandbox.helpers.getText(abs, h).then(resolve).catch(reject)
                      return
                    }
                    if ((res.statusCode || 0) >= 400) {
                      res.resume()
                      const err = new Error(`http ${res.statusCode}`)
                      appendDebug(dbg, 'getText_http_error', 'HTTP 错误', { code: res.statusCode })
                      reject(err)
                      return
                    }
                    let data = ''
                    res.setEncoding('utf-8')
                    res.on('data', (chunk: any) => (data += chunk))
                    res.on('end', () => {
                      appendDebug(dbg, 'getText_response', '响应完成', { code: res.statusCode || 0, length: data.length })
                      resolve(data)
                    })
                  })
                  req.setTimeout(15000, () => {
                    appendDebug(dbg, 'getText_timeout', '请求超时', { url: u, attempt: attempt + 1 })
                    try { req.destroy(new Error('timeout 15s')) } catch {}
                  })
                  req.on('error', (err: any) => { appendDebug(dbg, 'getText_error', '请求错误', { message: err?.message || String(err), attempt: attempt + 1 }); reject(err) })
                }
              } catch (e) {
                appendDebug(dbg, 'getText_exception', '请求异常', { message: (e as any)?.message || String(e), attempt: attempt + 1 })
                reject(e as any)
              }
            })
          }

          while (attempt < maxAttempts) {
            try {
              const txt = await tryOnce()
              return txt
            } catch (e: any) {
              attempt += 1
              if (attempt >= maxAttempts) throw e
              appendDebug(dbg, 'getText_retry', '重试抓取', { url: u, nextAttempt: attempt + 1 })
              await new Promise((r) => setTimeout(r, 800))
            }
          }
          throw new Error('unreachable')
        },
      },
    }
    const context = vm.createContext(sandbox)
    const wrapper = new vm.Script(code + '\n; this.__algoFn = (typeof parse === "function" ? parse : (typeof resolve === "function" ? resolve : null));')
    wrapper.runInContext(context)
    const fn = sandbox.__algoFn
    appendDebug(dbg, 'algo_entry', '解析入口函数', { hasFunc: typeof fn === 'function' })
    if (typeof fn !== 'function') {
      appendDebug(dbg, 'algo_no_entry', '未找到入口函数(parse/resolve)')
      return null
    }
    appendDebug(dbg, 'algo_invoked', '执行解析函数', { pageUrl })
    const out = await Promise.resolve(fn(pageUrl, sandbox.helpers, sandbox.headers))
    if (!out || typeof out !== 'object') {
      appendDebug(dbg, 'algo_output_invalid', '算法输出非对象或为空')
      return null
    }
    const manifestUrl = out.manifestUrl || out.m3u8 || out.hls || out.url
    const directUrl = out.directUrl || out.mp4 || out.file || out.mediaUrl
    const resHeaders = out.headers && typeof out.headers === 'object' ? out.headers : headers
    appendDebug(dbg, 'algo_result', '解析结果', { manifestUrl, directUrl, headers: resHeaders || {} })
    return { manifestUrl, directUrl, headers: resHeaders || undefined, notes: 'algorithm executed' }
  } catch (e: any) {
    appendDebug(dbg, 'algo_exception', '算法执行异常', { message: e?.message || String(e) })
    return null
  }
}

export function probeMedia(filePath?: string) {
  try {
    if (!filePath) return { ok: false, size: 0, notes: 'no file' }
    const stat = fs.statSync(filePath)
    const ok = stat.size > 0
    return { ok, size: stat.size, ext: path.extname(filePath) || '', notes: ok ? 'file exists' : 'empty file' }
  } catch (e: any) {
    return { ok: false, size: 0, notes: e?.message || String(e) }
  }
}