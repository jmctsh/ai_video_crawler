import fs from 'fs'
import { createDoubaoClientFromEnv } from '../doubaoClient'
import { getPromptMdPath } from './agentsMd'

function parseJsonBlocks(content: string): any[] {
  const records: any[] = []
  const regex = /```json[\s\S]*?```/g
  const matches = content.match(regex) || []
  for (const block of matches) {
    const raw = block.replace(/```json/i, '').replace(/```/g, '')
    try {
      const obj = JSON.parse(raw)
      if (obj && obj.msgId) records.push(obj)
    } catch {}
  }
  return records
}

function estimateTokensByRecords(records: any[]): number {
  const totalChars = records.reduce((acc, m) => acc + JSON.stringify(m).length, 0)
  return Math.ceil(totalChars / 4)
}

function ensureHeader(text: string): string {
  const header = `# Agents Prompt Log\n\n`
  return text.startsWith('# Agents Prompt Log') ? text : (header + text)
}

function writeCompressionLog(afterChars: number, beforeTokens: number, afterTokens: number, replacedCount: number, targetTokens: number) {
  const file = getPromptMdPath()
  const ts = new Date().toISOString()
  const msgId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const entry = {
    agent: '系统日志员',
    ts,
    type: 'history_compress',
    text: `历史压缩完成：tokens ${beforeTokens} → ${afterTokens}，替换 ${replacedCount}，目标 ${targetTokens}`,
    payload: { beforeTokens, afterTokens, replacedCount, afterChars, targetTokens },
    flags: ['COMPRESS_LOG'],
    parentMsgId: null,
    msgId,
  }
  const block = [
    `### [msg:${ts}] 系统日志员 → history_compress`,
    '!COMPRESS_LOG',
    entry.text,
    '',
    '```json',
    JSON.stringify(entry, null, 2),
    '```',
    '',
  ].join('\n')
  fs.appendFileSync(file, block, 'utf-8')
}

function buildHistoryCompressorPrompt(params: { keepFlags: string[]; targetTokens: number; recentPrefer?: number }) {
  const keep = params.keepFlags.join(', ')
  const target = params.targetTokens
  const recentPrefer = params.recentPrefer ?? 200
  return `你是“历史压缩员（History Compressor Agent）”。
职责：在完整理解 agents.md 内容的基础上，对更早的、无关的内容进行高度概括和总结；尽可能完整保留近期的、未完成的任务；带有特殊标记的内容不得删除。

硬性约束：
- 不得删除或修改带有以下标记的内容：${keep}。
- 输出必须是完整的 agents.md 文件文本；不得输出解释或任何无关内容。
- 保留文件头“# Agents Prompt Log”。
- 尽量保留最近 ${recentPrefer} 条非关键记录（如容量允许）。
- 优先保留未完成任务相关记录（如 in_progress、pending 等）。
 - 对被压缩的早期非关键记录，生成高度概括的“历史压缩员·summary”块，包含替换条数与要点摘要，并使用 COMPRESS_LOG 独立标记，不与其他标记混用。

压缩目标：将 agents.md 总体内容压缩至不超过 ${target} tokens（估算）。

输出格式：直接返回压缩后的 agents.md 完整文本，保持每条消息的结构（标题行、可选标记行、原文本、JSON围栏块）。`
}

export async function autoCompressPromptMd(): Promise<{ compressed: boolean; beforeTokens: number; afterTokens?: number; replacedCount?: number }> {
  const file = getPromptMdPath()
  const content = fs.readFileSync(file, 'utf-8')
  const records = parseJsonBlocks(content)
  const beforeTokens = estimateTokensByRecords(records)
  const MAX_TOKENS = Number(process.env.AGENTS_PROMPT_COMPRESS_MAX_TOKENS || 50000)
  const TARGET_TOKENS = Number(process.env.AGENTS_PROMPT_COMPRESS_TARGET_TOKENS || 20000)
  const KEEP_FLAGS = (process.env.AGENTS_PROMPT_KEEP_FLAGS || 'CRITICAL,DECISION,KEEP,ERROR').split(',').map(s => s.trim()).filter(Boolean)
  if (beforeTokens <= MAX_TOKENS) return { compressed: false, beforeTokens }

  const client = createDoubaoClientFromEnv()
  const compressModel = process.env.ARK_COMPRESS_MODEL_ID || undefined
  const system = buildHistoryCompressorPrompt({ keepFlags: KEEP_FLAGS, targetTokens: TARGET_TOKENS })
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: content },
  ]
  let out: string = ''
  try {
    const { content: resultText } = await client.chat(messages as any, compressModel)
    out = ensureHeader(resultText || '')
  } catch (e) {
    // 失败则放弃压缩
    return { compressed: false, beforeTokens }
  }

  // 强制保留关键标记消息：若新文本缺失某些关键 msgId，则追加到尾部
  const newRecords = parseJsonBlocks(out)
  const newIds = new Set(newRecords.map(r => r.msgId))
  const criticalRecords = records.filter(r => Array.isArray(r.flags) && r.flags.some((f: string) => KEEP_FLAGS.includes(f)))
  const missing = criticalRecords.filter(r => !newIds.has(r.msgId))
  if (missing.length) {
    const appendBlocks = missing.map(r => {
      const flagsLine = (r.flags && r.flags.length) ? `!${r.flags.join(' !')}` : ''
      return [
        `### [msg:${r.ts}] ${r.agent} → ${r.type}`,
        flagsLine,
        r.text || '',
        '',
        '```json',
        JSON.stringify(r, null, 2),
        '```',
        '',
      ].join('\n')
    }).join('')
    out = ensureHeader(out) + appendBlocks
  }

  // 覆盖写入压缩后的 agents.md
  fs.writeFileSync(file, out, 'utf-8')
  const afterRecords = parseJsonBlocks(out)
  const afterTokens = estimateTokensByRecords(afterRecords)
  const replacedCount = Math.max(0, records.length - afterRecords.length)
  writeCompressionLog(out.length, beforeTokens, afterTokens, replacedCount, TARGET_TOKENS)
  return { compressed: true, beforeTokens, afterTokens, replacedCount }
}