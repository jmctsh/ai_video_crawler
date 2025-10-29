import fs from 'fs'
import path from 'path'

export type AgentConfig = { name: string; apiKey: string; modelId: string }

export function envKeysFor(name: string): { apiKey: string; modelId: string } {
  const n = (name || '').toLowerCase()
  if (n === 'doubao' || n === 'ark') {
    return { apiKey: 'ARK_API_KEY', modelId: 'ARK_MODEL_ID' }
  }
  const upper = (name || '').replace(/[^a-z0-9_]/gi, '').toUpperCase() || 'LLM'
  return { apiKey: `${upper}_API_KEY`, modelId: `${upper}_MODEL_ID` }
}

export function updateEnvFile(vars: Record<string, string>, envPath?: string) {
  try {
    const file = envPath || path.join(process.cwd(), '.env')
    let lines: string[] = []
    const kv: Map<string, string> = new Map()
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf-8')
      lines = content.split(/\r?\n/)
      for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (m) kv.set(m[1], m[2])
      }
    }
    for (const [k, v] of Object.entries(vars)) {
      kv.set(k, v)
      process.env[k] = v
    }
    const output = Array.from(kv.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
    fs.writeFileSync(file, output, 'utf-8')
  } catch (e) {
    console.error('updateEnvFile failed:', e)
  }
}

export function loadAgents(storeFile: string): AgentConfig[] {
  try {
    if (fs.existsSync(storeFile)) {
      const raw = fs.readFileSync(storeFile, 'utf-8')
      const data = JSON.parse(raw)
      return Array.isArray(data?.agents) ? data.agents : []
    }
  } catch (e) {
    console.error('loadAgents failed:', e)
  }
  return []
}

export function saveAgents(storeFile: string, agents: AgentConfig[]) {
  try {
    fs.writeFileSync(storeFile, JSON.stringify({ agents }, null, 2), 'utf-8')
  } catch (e) {
    console.error('saveAgents failed:', e)
  }
}

export function upsertAgent(storeFile: string, agent: AgentConfig): AgentConfig[] {
  const agents = loadAgents(storeFile)
  const idx = agents.findIndex((a) => a.name === agent.name)
  if (idx >= 0) agents[idx] = agent
  else agents.push(agent)
  saveAgents(storeFile, agents)
  const keys = envKeysFor(agent.name)
  updateEnvFile({ [keys.apiKey]: agent.apiKey, [keys.modelId]: agent.modelId })
  return agents
}

export const exampleAgent: AgentConfig = {
  name: 'doubao',
  apiKey: 'YOUR_API_KEY',
  modelId: 'doubao-1-5-pro-32k-250115',
}