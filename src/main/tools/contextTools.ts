import fs from 'fs'
import { getAgentsMdPath } from './agentsMd'

export interface MdMessageRecord {
  agent: string
  ts: string
  type: string
  text?: string
  payload?: any
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

export function readMdMessages(filter?: { agent?: string[]; type?: string[]; sinceMsgId?: string }) {
  const file = getAgentsMdPath()
  const content = fs.readFileSync(file, 'utf-8')
  let records = parseJsonBlocks(content)
  if (filter?.sinceMsgId) {
    const idx = records.findIndex(r => r.msgId === filter!.sinceMsgId)
    if (idx >= 0) records = records.slice(idx + 1)
  }
  if (filter?.agent?.length) records = records.filter(r => filter!.agent!.includes(r.agent))
  if (filter?.type?.length) records = records.filter(r => filter!.type!.includes(r.type))
  return records
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

// 新裁剪策略：固定仅保留最近 3 条由 LLM 提交的日志
export function cropHistory(messages: MdMessageRecord[], _windowSize: number) {
  const isLLM = (agent: string) => agent.includes('(LLM)') || agent.includes('生成式AI')
  const llmMessages = messages.filter(m => isLLM(m.agent))
  const tail = llmMessages.slice(-3)
  const keepIds = new Set<string>(tail.map(m => m.msgId))
  const final = messages.filter(m => keepIds.has(m.msgId))
  const removed = messages.filter(m => !keepIds.has(m.msgId))
  return {
    keptCount: final.length,
    removedCount: removed.length,
    windowSize: 3,
    plan: { keepIds: final.map(m => m.msgId), removeIds: removed.map(m => m.msgId) }
  }
}