import fs from 'fs'
import path from 'path'
import { getLogsDir } from './agentsMd'

const DEBUG_DIR = path.join(getLogsDir(), 'debug')

function ensureDir() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })
  } catch {}
}

function ts(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function startDebugSession(name: string): string {
  ensureDir()
  const filePath = path.join(DEBUG_DIR, `${name}-${ts()}.log`)
  try {
    fs.writeFileSync(filePath, `# Debug session: ${name} @ ${new Date().toISOString()}\n`)
  } catch {}
  return filePath
}

export function appendDebug(filePath: string | null | undefined, label: string, text?: string, payload?: any): void {
  if (!filePath) return
  try {
    const time = new Date().toISOString()
    const safePayload = payload === undefined ? '' : JSON.stringify(payload, (k, v) => {
      if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + '...(truncated)'
      return v
    }, 2)
    const lines = [`\n[${time}] ${label}${text ? `: ${text}` : ''}`]
    if (safePayload) lines.push(safePayload)
    fs.appendFileSync(filePath, lines.join('\n') + '\n')
  } catch {}
}