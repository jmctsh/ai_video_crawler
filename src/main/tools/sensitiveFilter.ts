// 敏感词过滤模块：在向 LLM 发送前屏蔽敏感词；在接收后恢复原词
// 使用场景：主要用于 URL 或文本中的敏感字段，避免 LLM 拒绝

// 可通过环境变量控制开关：SENSITIVE_FILTER_ENABLED=true/false（默认 true）
// 使用说明：
// - 想临时控制：设置环境变量 `SENSITIVE_FILTER_ENABLED`（值为 "true" 或 "false"），无需改代码。
// - 想永久改变默认：仅将下方这一行的默认值改掉：`... : true` 改为 `... : false`。
// - 不要改正则 `^true$`，它只是用来判断环境变量是否为 "true"。
// 示例：
// - Windows PowerShell：`$env:SENSITIVE_FILTER_ENABLED = "false"; npm run dev`
// - .env 文件：`SENSITIVE_FILTER_ENABLED=false`
export const SENSITIVE_FILTER_ENABLED: boolean =
  process.env.SENSITIVE_FILTER_ENABLED !== undefined
    ? /^true$/i.test(String(process.env.SENSITIVE_FILTER_ENABLED))
    : true

// 映射表：敏感词 -> 非敏感占位词（示例，可按需扩展）
// 注意：保持双向映射唯一，避免循环替换
const SENSITIVE_TO_SAFE: Record<string, string> = {
  // 典型敏感词
  porn: 'born',
  xvideos: 'xv1deos',
  // 常见数字敏感：注意将导致所有文本中的 "91" 被替换为 "61"
  // 如需缩小影响范围，建议改为仅在 URL 片段或特定域名中替换
  '91': '61',
}

// 反向映射：非敏感占位词 -> 敏感词
const SAFE_TO_SENSITIVE: Record<string, string> = Object.fromEntries(
  Object.entries(SENSITIVE_TO_SAFE).map(([k, v]) => [v, k])
)

// 简单大小写保持：
// - 全大写 => 全大写
// - 首字母大写 => 首字母大写
// - 其他 => 全小写
function matchCaseLike(sample: string, template: string): string {
  const isUpper = sample.toUpperCase() === sample && sample.toLowerCase() !== sample
  const isCapitalized = /^[A-Z][a-z]+$/.test(sample)
  if (isUpper) return template.toUpperCase()
  if (isCapitalized) return template.charAt(0).toUpperCase() + template.slice(1).toLowerCase()
  return template.toLowerCase()
}

// 基础替换：根据映射进行不区分大小写的替换，并尽量保持匹配片段的大小写形态
function applyMap(text: string, map: Record<string, string>): string {
  if (!text) return text
  // 为避免子串相互影响，按 key 长度降序替换
  const keys = Object.keys(map).sort((a, b) => b.length - a.length)
  let out = text
  for (const key of keys) {
    const val = map[key]
    const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, (m) => matchCaseLike(m, val))
  }
  return out
}

export function maskSensitiveText(text: string): string {
  if (!SENSITIVE_FILTER_ENABLED) return text
  return applyMap(text, SENSITIVE_TO_SAFE)
}

export function unmaskSensitiveText(text: string): string {
  if (!SENSITIVE_FILTER_ENABLED) return text
  return applyMap(text, SAFE_TO_SENSITIVE)
}

// 如需在消息数组上批量处理，可使用以下辅助函数
import type { ChatMessage } from '../doubaoClient'

export function maskMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!SENSITIVE_FILTER_ENABLED) return messages
  return messages.map((m) => ({ ...m, content: maskSensitiveText(m.content) }))
}

export function unmaskContent(content: string): string {
  if (!SENSITIVE_FILTER_ENABLED) return content
  return unmaskSensitiveText(content)
}