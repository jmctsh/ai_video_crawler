// XVIDEOS 解析算法（真实可用）
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
