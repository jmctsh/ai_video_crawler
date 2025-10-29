import fs from 'fs'
import path from 'path'

export interface MdEntry {
  agent: string
  type: string
  text: string
  payload?: any
  flags?: string[]
  parentMsgId?: string
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// 项目内日志根目录（可用环境变量 AGENTS_LOG_DIR 覆盖，默认 'logs'）
export function getLogsDir(): string {
  const base = process.cwd()
  const dirName = process.env.AGENTS_LOG_DIR || 'logs'
  const dir = path.join(base, dirName)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 提示注入用的对话MD（裁剪/压缩的对象）
export function getPromptMdPath(): string {
  const file = path.join(getLogsDir(), 'agents.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Agents Prompt Log\n\n`, 'utf-8')
  }
  return file
}

// 兼容旧名称（保持现有调用不改动）
export const getAgentsMdPath = getPromptMdPath

// 原始完整对话日志MD（不裁剪，不压缩）
export function getRawMdPath(): string {
  const file = path.join(getLogsDir(), 'agents_raw.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Agents Raw Log (Full, Uncropped)\n\n`, 'utf-8')
  }
  return file
}

// 当前算法代码MD
export function getCodeMdPath(): string {
  const file = path.join(getLogsDir(), 'algorithm.md')
  ensureDir(file)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Current Algorithm Code\n\n`, 'utf-8')
  }
  return file
}

function toBlock(entry: MdEntry, msgId: string): string {
  const ts = new Date().toISOString()
  const flagsLine = (entry.flags && entry.flags.length) ? `!${entry.flags.join(' !')}` : ''
  const json = {
    agent: entry.agent,
    ts,
    type: entry.type,
    text: entry.text,
    payload: entry.payload ?? null,
    flags: entry.flags ?? [],
    parentMsgId: entry.parentMsgId ?? null,
    msgId,
  }
  return [
    `### [msg:${ts}] ${entry.agent} → ${entry.type}`,
    flagsLine,
    entry.text || '',
    '',
    '```json',
    JSON.stringify(json, null, 2),
    '```',
    '',
  ].join('\n')
}

// ===== 自动裁剪员（滑动窗口，不裁剪关键标记） =====
interface MdMessageRecord {
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

function toBlockFromRecord(rec: MdMessageRecord): string {
  const flagsLine = (rec.flags && rec.flags.length) ? `!${rec.flags.join(' !')}` : ''
  return [
    `### [msg:${rec.ts}] ${rec.agent} → ${rec.type}`,
    flagsLine,
    rec.text || '',
    '',
    '```json',
    JSON.stringify(rec, null, 2),
    '```',
    '',
  ].join('\n')
}

function cropHistory(records: MdMessageRecord[], windowSize: number, keepFlags: string[]) {
  const critical = new Set<string>(keepFlags)
  const nonCritical: MdMessageRecord[] = []
  const isCritical = (m: MdMessageRecord) => (m.flags || []).some(f => critical.has(f))
  for (const m of records) {
    if (!isCritical(m)) nonCritical.push(m)
  }
  const tail = nonCritical.slice(-windowSize)
  const keepIds = new Set<string>([...records.filter(isCritical), ...tail].map(m => m.msgId))
  const final = records.filter(m => keepIds.has(m.msgId))
  const removed = records.filter(m => !keepIds.has(m.msgId))
  return { keptCount: final.length, removedCount: removed.length, final }
}

function autoPrunePromptMd() {
  const file = getPromptMdPath()
  const content = fs.readFileSync(file, 'utf-8')
  const records = parseJsonBlocks(content)
  const DEFAULT_WINDOW = Number(process.env.AGENTS_PROMPT_WINDOW || 30)
  const KEEP_FLAGS = (process.env.AGENTS_PROMPT_KEEP_FLAGS || 'CRITICAL,DECISION,KEEP,ERROR').split(',').map(s => s.trim()).filter(Boolean)
  const { final, removedCount } = cropHistory(records, DEFAULT_WINDOW, KEEP_FLAGS)
  if (removedCount > 0) {
    const header = `# Agents Prompt Log\n\n`
    const rebuilt = header + final.map(toBlockFromRecord).join('')
    fs.writeFileSync(file, rebuilt, 'utf-8')
  }
}

export function writePromptMessage(entry: MdEntry): { msgId: string } {
  const file = getPromptMdPath()
  const msgId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const block = toBlock(entry, msgId)
  fs.appendFileSync(file, block, 'utf-8')
  // 自动触发滑动窗口裁剪（保留关键标记）
  try { autoPrunePromptMd() } catch {}
  // 自动触发历史压缩员（LLM），在超阈值时执行压缩
  try {
    // 动态导入以避免循环依赖
    import('./historyCompressor').then(mod => mod.autoCompressPromptMd().catch(() => {})).catch(() => {})
  } catch {}
  return { msgId }
}

export function writeRawMessage(entry: MdEntry, msgId?: string): { msgId: string } {
  const file = getRawMdPath()
  const _msgId = msgId || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const block = toBlock(entry, _msgId)
  fs.appendFileSync(file, block, 'utf-8')
  return { msgId: _msgId }
}

// 兼容旧接口：写入提示MD，同时在原始日志MD保留一份完整副本
export function writeMdMessage(entry: MdEntry): { msgId: string } {
  const { msgId } = writePromptMessage(entry)
  // 原始日志不参与裁剪/压缩，完整保留
  writeRawMessage(entry, msgId)
  return { msgId }
}