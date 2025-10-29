export type ErrorType = 'input_limit' | 'network_403' | 'drm_protected' | 'manifest_parse_error' | 'variants_empty' | 'unknown'

export function classifyError(logs: string): ErrorType {
  const s = logs.toLowerCase()
  if (s.includes('input limit') || s.includes('context length')) return 'input_limit'
  if (s.includes('403')) return 'network_403'
  if (s.includes('drm')) return 'drm_protected'
  if (s.includes('parse') && s.includes('manifest')) return 'manifest_parse_error'
  if (s.includes('variants') && s.includes('empty')) return 'variants_empty'
  return 'unknown'
}

export function proposeFix(errorType: ErrorType) {
  switch (errorType) {
    case 'input_limit':
      return { action: 'crop_or_compress', notes: '裁剪窗口后再压缩非关键消息，或改为检索关键标记' }
    case 'network_403':
      return { action: 'add_headers_or_retry', notes: '尝试追加必要请求头或 Cookie，并指数退避重试' }
    case 'drm_protected':
      return { action: 'stop', notes: '检测到 DRM，终止下载并记录合规提示' }
    case 'manifest_parse_error':
      return { action: 'fallback_capture', notes: '更换解析器或采用动态抓包结果回退' }
    case 'variants_empty':
      return { action: 'fallback_capture', notes: '降级至抓包员独立结果或提示站点适配需求' }
    default:
      return { action: 'inspect', notes: '需要进一步检查日志并提出手动修复建议' }
  }
}

export function detectInputLimit(error: string | undefined) {
  if (!error) return { isInputLimit: false }
  const s = error.toLowerCase()
  const isInputLimit = s.includes('input limit') || s.includes('context length') || s.includes('too many tokens')
  return { isInputLimit }
}