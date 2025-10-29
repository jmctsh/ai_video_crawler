import * as https from 'https'
import { URL } from 'url'
import { maskSensitiveText, unmaskSensitiveText, SENSITIVE_FILTER_ENABLED } from './tools/sensitiveFilter'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface DoubaoConfig {
  apiKey: string
  modelId: string
  endpoint?: string // default: https://ark.cn-beijing.volces.com/api/v3/chat/completions
  embedEndpoint?: string // default: https://ark.cn-beijing.volces.com/api/v3/embeddings
}

function postJson(endpoint: string, body: any, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(endpoint)
      const data = Buffer.from(JSON.stringify(body))
      const req = https.request(
        {
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname + url.search,
          protocol: url.protocol,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(data.length),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8')
            try {
              const json = JSON.parse(text)
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve(json)
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${text}`))
              }
            } catch (e) {
              reject(new Error(`Invalid JSON response: ${text}`))
            }
          })
        }
      )
      req.on('error', reject)
      req.write(data)
      req.end()
    } catch (err) {
      reject(err)
    }
  })
}

export class DoubaoClient {
  constructor(private config: DoubaoConfig) {}

  async chat(messages: ChatMessage[], modelId?: string): Promise<{ content: string; raw: any }> {
    const endpoint = this.config.endpoint ?? 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
    const apiKey = this.config.apiKey
    const model = modelId ?? this.config.modelId
    if (!apiKey) throw new Error('Missing ARK_API_KEY')
    if (!model) throw new Error('Missing Doubao model ID')

    // 在出站的最后一刻屏蔽敏感词（仅影响发往 LLM 的内容）
    const maskedMessages = SENSITIVE_FILTER_ENABLED
      ? messages.map((m) => ({ ...m, content: maskSensitiveText(m.content) }))
      : messages

    // 尝试启用 JSON-only 模式与简化推理，以提高可解析性并满足“最后一条为 user”的约束
    const body = {
      model,
      messages: maskedMessages,
      // OpenAI 风格兼容：强制 JSON 输出；若服务端不支持该字段将被忽略
      response_format: { type: 'json_object' },
      // 兼容 Doubao 的推理约束：minimal 可避免要求 assistant 收尾
      reasoning_effort: 'minimal',
      // 降低创造性，提升结构化稳定性（可由服务端忽略）
      temperature: 0.2,
    }
    const headers = { Authorization: `Bearer ${apiKey}` }
    const result = await postJson(endpoint, body, headers)
    const contentRaw = result?.choices?.[0]?.message?.content ?? ''
    // 在入站的第一时间恢复敏感词（仅影响返回给上游的内容）
    const content = SENSITIVE_FILTER_ENABLED ? unmaskSensitiveText(contentRaw) : contentRaw
    // 尽可能同步恢复 raw 内的主 content 字段，方便调试与查看
    try {
      if (SENSITIVE_FILTER_ENABLED && result?.choices?.[0]?.message) {
        result.choices[0].message.content = content
      }
    } catch {}
    return { content, raw: result }
  }

  async embeddings(inputs: string[], modelId?: string, encoding_format: 'float' | 'base64' = 'float'): Promise<{ embeddings: number[][]; raw: any }> {
    const endpoint = this.config.embedEndpoint ?? 'https://ark.cn-beijing.volces.com/api/v3/embeddings'
    const apiKey = this.config.apiKey
    const model = modelId ?? (process.env.ARK_EMBED_MODEL_ID || 'doubao-embedding-large-text-240915')
    if (!apiKey) throw new Error('Missing ARK_API_KEY')
    if (!model) throw new Error('Missing Doubao embedding model ID')

    // embeddings 请求的出站文本也进行敏感词屏蔽（无入站文本需恢复）
    const maskedInputs = SENSITIVE_FILTER_ENABLED ? inputs.map((t) => maskSensitiveText(t)) : inputs
    const body = { model, input: maskedInputs, encoding_format }
    const headers = { Authorization: `Bearer ${apiKey}` }
    const result = await postJson(endpoint, body, headers)
    const data = Array.isArray(result?.data) ? result.data : (Array.isArray(result?.output?.data) ? result.output.data : [])
    const embeddings: number[][] = data.map((d: any) => Array.isArray(d?.embedding) ? d.embedding : [])
    return { embeddings, raw: result }
  }
}

export function createDoubaoClientFromEnv() {
  return new DoubaoClient({
    apiKey: process.env.ARK_API_KEY || '',
    modelId: process.env.ARK_MODEL_ID || 'doubao-1-5-pro-32k-250115',
    embedEndpoint: process.env.ARK_EMBED_ENDPOINT || undefined,
  })
}

// Create per-agent Doubao client using dedicated env keys
// Agent name mapping: STATIC_PARSER / NETWORK_CAPTURE / HISTORY_COMPRESSOR
function envKeysForAgent(agentName: string): { apiKeyKey: string; modelIdKey: string } {
  const n = (agentName || '').trim().toUpperCase()
  if (n === 'ARK' || n === 'DOUBAO' || n === 'GLOBAL') {
    return { apiKeyKey: 'ARK_API_KEY', modelIdKey: 'ARK_MODEL_ID' }
  }
  // Normalize common aliases
  const map: Record<string, { apiKeyKey: string; modelIdKey: string }> = {
    'STATIC_PARSER': { apiKeyKey: 'STATIC_PARSER_API_KEY', modelIdKey: 'STATIC_PARSER_MODEL_ID' },
    'NETWORK_CAPTURE': { apiKeyKey: 'NETWORK_CAPTURE_API_KEY', modelIdKey: 'NETWORK_CAPTURE_MODEL_ID' },
    'HISTORY_COMPRESSOR': { apiKeyKey: 'HISTORY_COMPRESSOR_API_KEY', modelIdKey: 'HISTORY_COMPRESSOR_MODEL_ID' },
  }
  return map[n] || { apiKeyKey: `${n}_API_KEY`, modelIdKey: `${n}_MODEL_ID` }
}

export function createDoubaoClientFor(agentName: string) {
  const { apiKeyKey, modelIdKey } = envKeysForAgent(agentName)
  const apiKey = process.env[apiKeyKey] || process.env.ARK_API_KEY || ''
  const modelId = process.env[modelIdKey] || process.env.ARK_MODEL_ID || 'doubao-1-5-pro-32k-250115'
  return new DoubaoClient({
    apiKey,
    modelId,
    embedEndpoint: process.env.ARK_EMBED_ENDPOINT || undefined,
  })
}