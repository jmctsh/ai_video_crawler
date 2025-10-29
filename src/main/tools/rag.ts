import fs from 'fs'
import path from 'path'
import { getRawMdPath, getLogsDir } from './agentsMd'
import { createDoubaoClientFromEnv } from '../doubaoClient'

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

export interface RagIndexEntry {
  id: string
  agent: string
  type: string
  ts: string
  flags: string[]
  text: string
  embedding: number[]
  norm: number
}

export interface RagIndex {
  version: number
  modelId: string
  createdAt: number
  updatedAt: number
  entries: RagIndexEntry[]
}

function getIndexPath(): string {
  const file = path.join(getLogsDir(), 'agents_rag_index.json')
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return file
}

function loadIndex(): RagIndex | null {
  try {
    const file = getIndexPath()
    if (!fs.existsSync(file)) return null
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return json as RagIndex
  } catch { return null }
}

function saveIndex(idx: RagIndex) {
  const file = getIndexPath()
  fs.writeFileSync(file, JSON.stringify(idx, null, 2), 'utf-8')
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

function readRawRecords(): MdMessageRecord[] {
  const file = getRawMdPath()
  const content = fs.readFileSync(file, 'utf-8')
  return parseJsonBlocks(content)
}

function textForRecord(m: MdMessageRecord, maxLen = 2000): string {
  const meta = `${m.agent} · ${m.type} · ${m.ts}`
  const t = (m.text || '').replace(/\s+/g, ' ').slice(0, maxLen)
  return `${meta}\n${t}`
}

function l2norm(v: number[]): number {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}

function cosine(a: number[], b: number[], na?: number, nb?: number): number {
  let dot = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i]
  const da = na ?? l2norm(a)
  const db = nb ?? l2norm(b)
  if (!da || !db) return 0
  return dot / (da * db)
}

export async function buildOrUpdateRagIndex(modelId?: string): Promise<{ indexedNew: number; total: number }> {
  const client = createDoubaoClientFromEnv()
  const idx = loadIndex() || { version: 1, modelId: modelId || (process.env.ARK_EMBED_MODEL_ID || 'doubao-embedding-large-text-240915'), createdAt: Date.now(), updatedAt: Date.now(), entries: [] }
  if (modelId && idx.modelId !== modelId) {
    // model changed, rebuild from scratch
    idx.entries = []
  }
  const map = new Map(idx.entries.map(e => [e.id, e]))
  const records = readRawRecords()
  const missing: MdMessageRecord[] = []
  for (const r of records) {
    if (!map.has(r.msgId)) missing.push(r)
  }
  let indexedNew = 0
  const BATCH = 16
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const texts = batch.map((m) => textForRecord(m))
    const { embeddings } = await client.embeddings(texts, modelId || idx.modelId, 'float')
    for (let j = 0; j < batch.length; j++) {
      const m = batch[j]
      const emb = embeddings[j] || []
      const entry: RagIndexEntry = {
        id: m.msgId,
        agent: m.agent,
        type: m.type,
        ts: m.ts,
        flags: Array.isArray(m.flags) ? m.flags : [],
        text: textForRecord(m),
        embedding: emb,
        norm: l2norm(emb),
      }
      idx.entries.push(entry)
      indexedNew++
    }
    idx.updatedAt = Date.now()
    saveIndex(idx)
  }
  return { indexedNew, total: idx.entries.length }
}

export async function ragSearchRawMd(query: string, topK = 6, minScore = 0.08, modelId?: string): Promise<{ hits: Array<{ id: string; agent: string; type: string; ts: string; flags: string[]; score: number; text: string }> }> {
  const client = createDoubaoClientFromEnv()
  await buildOrUpdateRagIndex(modelId)
  const idx = loadIndex()
  if (!idx || !idx.entries.length) return { hits: [] }
  const { embeddings } = await client.embeddings([query], modelId || idx.modelId, 'float')
  const q = embeddings[0] || []
  const nq = l2norm(q)
  const scored = idx.entries.map(e => ({
    id: e.id,
    agent: e.agent,
    type: e.type,
    ts: e.ts,
    flags: e.flags,
    score: cosine(q, e.embedding, nq, e.norm),
    text: e.text,
  }))
  scored.sort((a, b) => b.score - a.score)
  const hits = scored.filter(s => s.score >= minScore).slice(0, topK)
  return { hits }
}

export function clearRagIndex() {
  const file = getIndexPath()
  if (fs.existsSync(file)) fs.unlinkSync(file)
}