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
  const isLLM = (agent: string) => agent.includes('(LLM)') || /生成式AI/i.test(agent)
  const isCriticalType = (type: string) => {
    const t = String(type || '').toLowerCase()
    return (
      t === 'final' ||
      t === 'error' ||
      t === 'diagnose' ||
      t === 'start_human_acceptance' ||
      t === 'headers' ||
      t === 'capture' ||
      t === 'plan' ||
      t === 'merge' ||
      t === 'probe'
    )
  }

  const tokenBudgetEnv = Number(process.env.TOKEN_BUDGET || process.env.COORDINATOR_TOKEN_BUDGET || 8000)
  const reserveRatio = Number(process.env.CONTEXT_RESERVE_RATIO || 0.25) // 预留给后续消息
  const targetTokens = Math.max(1000, Math.floor(tokenBudgetEnv * (1 - reserveRatio)))

  let llmWindow = Math.max(3, Number(process.env.LLM_WINDOW || 8))
  let otherWindow = Math.max(3, Number(process.env.OTHER_WINDOW || 10))

  const critical = messages.filter(m => isCriticalType(m.type))
  const llmMessages = messages.filter(m => isLLM(m.agent))
  const nonLlmMessages = messages.filter(m => !isLLM(m.agent))

  const pickTail = <T>(arr: T[], n: number): T[] => (n <= 0 ? [] : arr.slice(-n))

  const assemble = () => {
    const keepSet = new Set<string>()
    for (const m of critical) keepSet.add(m.msgId)
    for (const m of pickTail(llmMessages, llmWindow)) keepSet.add(m.msgId)
    for (const m of pickTail(nonLlmMessages, otherWindow)) keepSet.add(m.msgId)
    const final = messages.filter(m => keepSet.has(m.msgId))
    return final
  }

  let final = assemble()
  let est = estimateTokens(final).tokens
  // 若超过目标预算，逐步缩小窗口，优先缩小非LLM，再缩小LLM，但不移除关键消息
  while (est > targetTokens && (llmWindow > 3 || otherWindow > 3)) {
    if (otherWindow > 3) otherWindow = Math.max(3, Math.floor(otherWindow * 0.7))
    else if (llmWindow > 3) llmWindow = Math.max(3, Math.floor(llmWindow * 0.7))
    final = assemble()
    est = estimateTokens(final).tokens
  }

  const keepIds = new Set<string>(final.map(m => m.msgId))
  const removed = messages.filter(m => !keepIds.has(m.msgId))
  return {
    keptCount: final.length,
    removedCount: removed.length,
    windowSize: { llmWindow, otherWindow, targetTokens },
    plan: { keepIds: final.map(m => m.msgId), removeIds: removed.map(m => m.msgId) }
  }
}
