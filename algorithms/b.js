// Bilibili 视频解析算法
// 提取页面内嵌的 __playinfo__ 中的 MPD 流信息
async function parse(pageUrl: string, helpers: any, headers: Record<string, string> = {}): Promise<{ manifestUrl?: string; headers?: Record<string, string>; directUrl?: string }> {
  const nextHeaders = { ...headers };
  // 设置基础请求头
  if (!nextHeaders['User-Agent']) nextHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  if (!nextHeaders['Referer']) nextHeaders['Referer'] = pageUrl;
  if (!nextHeaders['Accept']) nextHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  if (!nextHeaders['Accept-Language']) nextHeaders['Accept-Language'] = 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2';

  // 发送请求获取页面内容
  const res = await helpers.fetch(pageUrl, { headers: nextHeaders });
  if (!res || res.status >= 400) return { headers: nextHeaders };
  const html = await res.text();

  // 提取 __playinfo__ 中的 MPD 信息
  const playinfoMatch = html.match(/window\.__playinfo__\s*=\s*({[\s\S]*?});/);
  if (playinfoMatch) {
    try {
      const playinfo = JSON.parse(playinfoMatch[1]);
      if (playinfo.data?.dash) {
        // 生成 MPD 清单（Bilibili 采用 DASH 格式，需构造 MPD 结构）
        const dash = playinfo.data.dash;
        const mpdContent = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT${dash.minBufferTime}S" type="static" mediaPresentationDuration="PT${dash.duration}S">
  <Period>
    ${dash.video.map(video => `
    <AdaptationSet mimeType="${video.mimeType}" codecs="${video.codecs}" width="${video.width}" height="${video.height}" frameRate="${video.frameRate}">
      <Representation id="${video.id}" bandwidth="${video.bandwidth}">
        <BaseURL>${video.baseUrl}</BaseURL>
        <SegmentBase indexRange="${video.segment_base.index_range}">
          <Initialization range="${video.segment_base.initialization}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>`).join('')}
    ${dash.audio.map(audio => `
    <AdaptationSet mimeType="${audio.mimeType}" codecs="${audio.codecs}">
      <Representation id="${audio.id}" bandwidth="${audio.bandwidth}">
        <BaseURL>${audio.baseUrl}</BaseURL>
        <SegmentBase indexRange="${audio.segment_base.index_range}">
          <Initialization range="${audio.segment_base.initialization}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>`).join('')}
  </Period>
</MPD>`;
        // 使用 helpers 临时存储 MPD 内容并获取 URL
        const manifestUrl = await helpers.storeTemporaryFile(mpdContent, 'application/dash+xml');
        return { manifestUrl, headers: nextHeaders };
      }
    } catch (e) {
      console.error('解析 __playinfo__ 失败:', e);
    }
  }

  // 兜底：提取页面中的 m3u8/mpd 链接
  const m3u8Match = html.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
  const mpdMatch = html.match(/(https?:\/\/[^"'\s]+\.mpd[^"'\s]*)/i);
  if (m3u8Match) return { manifestUrl: m3u8Match[1], headers: nextHeaders };
  if (mpdMatch) return { manifestUrl: mpdMatch[1], headers: nextHeaders };

  return { headers: nextHeaders };
}