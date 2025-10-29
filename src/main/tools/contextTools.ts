import fs from 'fs'
import { getAgentsMdPath, writeMdMessage } from './agentsMd'

export interface MdMessageRecord {
  agent: string
  ts: string
  type: string
  text?: string
  payload?: any
  flags?: string[]
  parentMsgId?: string | null
  msgId: string
}

function parseJsonBlocks(content: string): MdMessageRecord[] {
  const records: MdMessageRecord[] = []
  const regex = /```json[\s\S]*?```/g
  const matches = content.match(regex) || []
  for (const block of matches) {
    const raw = block.replace(/```json/i, '').replace(/```/g, '')
    try {
      const obj = JSON.parse(raw)
      if (obj && obj.msgId) records.push(obj as MdMessageRecord)
    } catch {}
  }
  return records
}

export function readMdMessages(filter?: { flags?: string[]; agent?: string[]; type?: string[]; sinceMsgId?: string }) {
  const file = getAgentsMdPath()
  const content = fs.readFileSync(file, 'utf-8')
  let records = parseJsonBlocks(content)
  if (filter?.sinceMsgId) {
    const idx = records.findIndex(r => r.msgId === filter!.sinceMsgId)
    if (idx >= 0) records = records.slice(idx + 1)
  }
  if (filter?.agent?.length) records = records.filter(r => filter!.agent!.includes(r.agent))
  if (filter?.type?.length) records = records.filter(r => filter!.type!.includes(r.type))
  if (filter?.flags?.length) records = records.filter(r => (r.flags || []).some(f => filter!.flags!.includes(f)))
  return records
}

export function markCritical(msgId: string, flags: string[]) {
  writeMdMessage({ agent: '对话记录员', type: 'mark', text: `标记 ${msgId} → ${flags.join(',')}`, payload: { msgId, flags }, flags })
  return { ok: true }
}

export function measureMdFile() {
  const file = getAgentsMdPath()
  const content = fs.readFileSync(file, 'utf-8')
  return { fileChars: content.length, fileLines: content.split('\n').length }
}

export function estimateTokens(messages: MdMessageRecord[]): { tokens: number } {
  // crude heuristic: ~4 chars per token
  const totalChars = messages.reduce((acc, m) => acc + JSON.stringify(m).length, 0)
  return { tokens: Math.ceil(totalChars / 4) }
}

export function cropHistory(messages: MdMessageRecord[], windowSize: number, keepFlags: string[]) {
  const critical = new Set<string>(keepFlags)
  const kept: MdMessageRecord[] = []
  const nonCritical: MdMessageRecord[] = []
  for (const m of messages) {
    if ((m.flags || []).some(f => critical.has(f))) kept.push(m)
    else nonCritical.push(m)
  }
  const tail = nonCritical.slice(-windowSize)
  const final = [...kept, ...tail]
  const removed = messages.filter(m => !final.includes(m))
  return { keptCount: final.length, removedCount: removed.length, windowSize, keepFlags, plan: { keepIds: final.map(m => m.msgId), removeIds: removed.map(m => m.msgId) } }
}

export function compressHistory(messages: MdMessageRecord[], budgetTokens: number, keepFlags: string[]) {
  const critical = new Set<string>(keepFlags)
  const toCompress = messages.filter(m => !(m.flags || []).some(f => critical.has(f)))
  const summary = toCompress.map(m => `${m.agent}:${m.type}`).join(' | ').slice(0, Math.max(80, budgetTokens))
  const entry = { agent: '历史压缩员', type: 'summary', text: `压缩摘要：${summary}`, payload: { budgetTokens, replacedCount: toCompress.length }, flags: ['COMPRESS_LOG'] }
  const { msgId } = writeMdMessage(entry)
  return { msgId, replacedCount: toCompress.length }
}