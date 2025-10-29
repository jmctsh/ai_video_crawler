import { createDoubaoClientFromEnv, createDoubaoClientFor } from './doubaoClient'
import { BrowserWindow } from 'electron'
import { COORDINATOR_SYSTEM_PROMPT, buildUserInputMessage } from './coordinatorPrompt'
import { buildStaticParserAgentPrompt, buildNetworkCaptureAgentPrompt, buildHistoryCompressorAgentPrompt } from './agentsPrompts'
import { writeMdMessage, writePromptMessage, writeRawMessage, getAgentsMdPath, getLogsDir } from './tools/agentsMd'
import fs from 'fs'
import path from 'path'
import { extractHtmlCandidates } from './tools/staticParser'
import { preprocessHtmlLong } from './tools/htmlPreprocessor'
import { parseManifest, pickBestVariant, buildDownloadPlan } from './tools/manifest'
import { downloadAndMerge, probeMedia } from './tools/downloader'
import { captureNetwork } from './tools/networkCapture'
import { readMdMessages, markCritical as markCriticalTool, measureMdFile, estimateTokens, cropHistory as cropHistoryTool, compressHistory as compressHistoryTool } from './tools/contextTools'
import { ragSearchRawMd, buildOrUpdateRagIndex } from './tools/rag'
import { classifyError, proposeFix, detectInputLimit } from './tools/errorDiagnosis'
import { CoordinatorInput } from './coordinator'
import { writeAlgorithmCode, writeAlgorithmCodeTo, finalizeAlgorithmIntoStore, finalizeAlgorithmIntoStorePick, getAlgorithmStaticPath, getAlgorithmDynamicPath, extractLastCodeBlock } from './tools/codeMaintainer'
import { runHumanAcceptanceFlow } from './tools/humanAcceptanceFlow'

type RunStatus = 'pending' | 'running' | 'done' | 'error'

export interface CoordinatorLLMRun {
  id: string
  status: RunStatus
  startedAt: number
  updatedAt: number
  input: CoordinatorInput
  result?: { manifestUrl?: string; filePath?: string; notes?: string }
  error?: string
  steps: number
}

const runs: Map<string, CoordinatorLLMRun> = new Map()

function genId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function extractJson(text: string): any | null {
  // 1) 优先解析 ```json 围栏
  const jsonFence = text.match(/```json[\s\S]*?```/i)
  if (jsonFence) {
    const raw = jsonFence[0].replace(/```json/i, '').replace(/```/g, '')
    try {
      const obj = JSON.parse(raw)
      if (obj && (obj.tool || obj.result || obj.final)) return obj
      // 兼容：直接输出结果对象（含 manifestUrl/directUrl/headers）
      if (obj && (obj.manifestUrl || obj.directUrl || obj.headers)) return { result: obj }
    } catch {}
  }

  // 2) 回退解析通用代码围栏 ```...```
  const anyFences = text.match(/```[\s\S]*?```/g) || []
  for (const fence of anyFences) {
    const raw = fence.replace(/```/g, '')
    try {
      const obj = JSON.parse(raw)
      if (obj && (obj.tool || obj.result || obj.final)) return obj
      if (obj && (obj.manifestUrl || obj.directUrl || obj.headers)) return { result: obj }
    } catch {}
  }

  // 3) 最后回退：基于括号平衡寻找首个顶层 JSON 对象
  const s = text
  let startIdx = -1
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{') {
      if (depth === 0) startIdx = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && startIdx >= 0) {
        const slice = s.slice(startIdx, i + 1)
        try {
          const obj = JSON.parse(slice)
          if (obj && (obj.tool || obj.result || obj.final)) return obj
          if (obj && (obj.manifestUrl || obj.directUrl || obj.headers)) return { result: obj }
        } catch {}
        // 找到一个顶层闭合后继续寻找下一个
        startIdx = -1
      }
    }
  }
  return null
}

// (moved) findManifestLinks is provided by tools/staticParser

export async function startCoordinatorLLM(input: CoordinatorInput): Promise<{ runId: string }> {
  const id = genId()
  const run: CoordinatorLLMRun = { id, status: 'running', startedAt: Date.now(), updatedAt: Date.now(), input, steps: 0 }
  runs.set(id, run)

  // 最近一次网络抓包的上下文（用于验收流程兜底传递）
  let lastNetworkHeaders: Record<string, string> | undefined
  let lastManifestUrl: string | undefined

  // Debug 目录（按 runId 分隔存放）：用于记录初始输入、每步 LLM 输入与输出
  const debugDir = path.join(getLogsDir(), 'debug', id)
  try { if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true }) } catch {}

  writeMdMessage({ agent: '总协调员(LLM)', type: 'start', text: '开始 LLM 协调流程', flags: ['DECISION', 'KEEP'] })

  // 将用户提交的初始信息改为单独存放到 debug，不再写入 agents 日志
  try {
    const userText = buildUserInputMessage(input).content
    let htmlFile: string | undefined
    if (input.html && input.html.length) {
      try {
        const uploadsDir = path.join(getLogsDir(), 'uploads')
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
        htmlFile = path.join(uploadsDir, `user_html_${id}.html`)
        fs.writeFileSync(htmlFile, input.html, 'utf-8')
      } catch {}
    }
    const initialMd = [
      `# Initial Input`,
      `- runId: ${id}`,
      `- url: ${input.url || input.exampleUrl || ''}`,
      `- exampleUrl: ${input.exampleUrl || ''}`,
      `- algoName: ${input.algoName || ''}`,
      `- notes: ${(input.notes || '').replace(/\r/g,'')}`,
      `- harPath: ${input.harPath || ''}`,
      `- prefer: ${input.prefer || ''}`,
      `- htmlChars: ${input.html ? input.html.length : 0}`,
      htmlFile ? `- htmlPath: ${htmlFile}` : `- htmlPath: (none)`,
      ``,
      `## Summary`,
      userText,
      ``,
      input.html ? `## HTML\n\`\`\`html\n${input.html}\n\`\`\`` : ''
    ].join('\n')
    fs.writeFileSync(path.join(debugDir, 'initial_input.md'), initialMd, 'utf-8')
  } catch {}

  const client = createDoubaoClientFromEnv()
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: COORDINATOR_SYSTEM_PROMPT },
    buildUserInputMessage(input),
  ]
  // 注入共享提示上下文（来自提示MD：保留关键标记与最近窗口）
  try {
    const all = readMdMessages()
    const keepFlags = ['CRITICAL','DECISION','KEEP']
    const important = all.filter(m => Array.isArray(m.flags) && m.flags.some((f: string) => keepFlags.includes(f)))
    const recent = all.slice(Math.max(0, all.length - 50))
    const merged = [...important, ...recent]
    const dedup = new Map<string, any>()
    for (const m of merged) dedup.set(m.msgId || `${m.agent}_${m.type}_${m.ts}`, m)
    const lines = Array.from(dedup.values()).slice(-80).map((m: any) => `- ${m.agent} · ${m.type} · ${m.text}`)
    if (lines.length) messages.push({ role: 'assistant', content: `CONTEXT (agents.md):\n${lines.join('\n')}` })

    // 注入“上一次错误信息”块，供反思参考
    const errorMsgs = all.filter(m => Array.isArray(m.flags) && m.flags.includes('ERROR'))
    const lastErrors = errorMsgs.slice(-5)
    if (lastErrors.length) {
      const errLines = lastErrors.map((m: any) => `- ${m.agent} · ${m.type} · ${m.text}`)
      messages.push({ role: 'assistant', content: `PREVIOUS_ERROR:\n${errLines.join('\n')}\n请参考上述错误，避免重复错误，并先提出诊断或回退方案。` })
    }
  } catch {}

  // 注入子智能体独立提示词（统一维护）：静态解析员与网络抓包员（含结构化注入节点）
  try {
    const upstreamSummary = `AlgoName=${input.algoName || ''} | URL=${input.url || input.exampleUrl || ''} | HTML=${Boolean(input.html)} | HAR=${input.harPath || ''} | Prefer=${input.prefer || 'auto'} | Notes=${(input.notes || '').slice(0, 80)}`
    const decKeep = readMdMessages({ flags: ['DECISION','KEEP'] })
    const directivesText = decKeep.slice(-8).map((m: any) => `- ${m.agent} · ${m.type} · ${m.text}`).join('\n')
    const userUrl = input.url || input.exampleUrl || ''
    const userHarPath = input.harPath || ''
    const userHtmlSnippet = (input.html || '').slice(0, 2000)
    // 注入当前算法代码全文（默认代码或已提交）
    const staticMdPath = getAlgorithmStaticPath()
    const staticMdContent = fs.existsSync(staticMdPath) ? fs.readFileSync(staticMdPath, 'utf-8') : ''
    const staticCode = extractLastCodeBlock(staticMdContent)
    const dynamicMdPath = getAlgorithmDynamicPath()
    const dynamicMdContent = fs.existsSync(dynamicMdPath) ? fs.readFileSync(dynamicMdPath, 'utf-8') : ''
    const dynamicCode = extractLastCodeBlock(dynamicMdContent)
    const staticPrompt = buildStaticParserAgentPrompt({ upstreamSummary, responsibleMdPath: staticMdPath, userUrl, userHtmlSnippet, userHarPath, coordinatorDirectives: directivesText, responsibleMdContent: staticCode })
    messages.push({ role: 'assistant', content: `SUBAGENT_PROMPT(static_parser):\n${staticPrompt}` })
    const networkPrompt = buildNetworkCaptureAgentPrompt({ upstreamSummary, responsibleMdPath: dynamicMdPath, userUrl, userHtmlSnippet, userHarPath, coordinatorDirectives: directivesText, responsibleMdContent: dynamicCode })
    messages.push({ role: 'assistant', content: `SUBAGENT_PROMPT(network_capture):\n${networkPrompt}` })
  } catch {}

  // Simple tool registry (local handlers)
  const tools = {
    async static_extract_html_candidates(args: any) {
      const html = (args?.html ?? input.html ?? '') as string
      if (!html) return { candidates: [] }
      const { candidates } = extractHtmlCandidates(html)
      writeMdMessage({ agent: 'HTML 解析员', type: 'candidates', text: `LLM请求：静态解析 ${candidates.length} 个`, payload: { candidates }, flags: candidates.length ? ['CANDIDATE'] : [] })
      return { candidates }
    },
    async rag_search_raw_md(args: any) {
      const query: string = String(args?.query || '')
      const topK: number = Number(args?.topK ?? 6)
      const minScore: number = Number(args?.minScore ?? 0.08)
      const modelId: string | undefined = args?.modelId
      if (!query.trim()) return { hits: [] }
      // 确保索引最新
      await buildOrUpdateRagIndex(modelId)
      const res = await ragSearchRawMd(query, topK, minScore, modelId)
      writeMdMessage({ agent: 'RAG增强检索员', type: 'search', text: `raw检索 Top ${res.hits.length}（topK=${topK}, minScore=${minScore}）`, payload: { query, hits: res.hits }, flags: res.hits.length ? ['KEEP'] : [] })
      return res
    },
    async call_static_parser_agent(args: any) {
      // LLM 子智能体：静态解析员
      const agentClient = createDoubaoClientFor('STATIC_PARSER')
      const upstreamSummary = `AlgoName=${input.algoName || ''} | URL=${input.url || input.exampleUrl || ''} | HTML=${Boolean(input.html)} | HAR=${input.harPath || ''} | Prefer=${input.prefer || 'auto'} | Notes=${(input.notes || '').slice(0, 80)}`
      const decKeep = readMdMessages({ flags: ['DECISION','KEEP'] })
      const directivesText = decKeep.slice(-8).map((m: any) => `- ${m.agent} · ${m.type} · ${m.text}`).join('\n')
      const staticMdPath = getAlgorithmStaticPath()
      const staticMdContent = fs.existsSync(staticMdPath) ? fs.readFileSync(staticMdPath, 'utf-8') : ''
      const staticCode = extractLastCodeBlock(staticMdContent)
      const subPrompt = buildStaticParserAgentPrompt({
        upstreamSummary,
        responsibleMdPath: staticMdPath,
        userUrl: input.url || input.exampleUrl || '',
        userHtmlSnippet: (args?.html ?? input.html ?? ''),
        userHarPath: input.harPath || '',
        coordinatorDirectives: directivesText,
        responsibleMdContent: staticCode,
      })
      const subMessages: { role: 'system'|'user'|'assistant'; content: string }[] = [
        { role: 'system', content: subPrompt },
        { role: 'user', content: 'NEXT_ACTION_REQUEST: 严格输出下一步工具调用的 JSON，不要解释。' },
      ]
      // 本次会话必须完成：至少一次完整代码提交与一次报告写入
      let codeWritten = false
      let reportWritten = false
      const subDebugDir = path.join(getLogsDir(), 'debug', id, 'subagent_static')
      try { if (!fs.existsSync(subDebugDir)) fs.mkdirSync(subDebugDir, { recursive: true }) } catch {}
      const MAX_SUB_STEPS = 8
      let lastOutput: any = null
      for (let step = 0; step < MAX_SUB_STEPS; step++) {
        // 写入子智能体输入日志
        try {
          const inputMd = [
            `# Static SubAgent · Step ${step+1}`,
            `## Messages`,
            ...subMessages.map(m => `### ${m.role}\n\n${m.content}`),
          ].join('\n')
          fs.writeFileSync(path.join(subDebugDir, `input_${step+1}.md`), inputMd, 'utf-8')
        } catch {}
        const res = await agentClient.chat(subMessages)
        // 输出日志
        try {
          const outputMd = [
            `# Static SubAgent Output · Step ${step+1}`,
            `## content`,
            typeof (res as any)?.content === 'string' ? (res as any).content : '',
            ``,
            `## raw`,
            '```json',
            JSON.stringify(res, null, 2),
            '```',
          ].join('\n')
          fs.writeFileSync(path.join(subDebugDir, `output_${step+1}.md`), outputMd, 'utf-8')
        } catch {}
        const json = extractJson(res.content)
        if (!json) {
          writeMdMessage({ agent: '静态解析员(LLM)', type: 'error', text: '子智能体输出不可解析（非 JSON）', flags: ['CRITICAL','KEEP'] })
          // 强制重试：追加严格重试指令，仅输出 JSON 对象
          subMessages.push({ role: 'user', content: 'STRICT_RETRY: 上一步输出不可解析；仅输出单一 JSON 对象（无代码围栏、无解释）。示例：{"tool":"...","args":{...},"flags":[]} 或 {"result":{...},"flags":[]}。' })
          continue
        }
        if (json.result) {
          const candidates = Array.isArray(json.result?.candidates) ? json.result.candidates : []
          writeMdMessage({ agent: '静态解析员(LLM)', type: 'result', text: `候选 ${candidates.length} 个`, payload: json.result, flags: candidates.length ? ['CANDIDATE'] : [] })
          lastOutput = json.result
          // 完成条件未满足则继续：要求提交完整代码与报告
          if (codeWritten && reportWritten) {
            break
          } else {
            subMessages.push({ role: 'user', content: 'MANDATORY_CONTINUE: 已获取候选/结果；本次会话必须完成代码提交与报告。请立即输出 code_maintainer_agent_write（完整代码，不得为空）或 record_message（报告）。仅输出单一 JSON 对象。' })
            continue
          }
        }
        const toolName = String(json.tool || '')
        const args2 = json.args ?? {}
        let output: any = null
        switch (toolName) {
          case 'static_extract_html_candidates': {
            const html = (args2?.html ?? input.html ?? '') as string
            const { candidates } = extractHtmlCandidates(html)
            writeMdMessage({ agent: '静态解析员(LLM)', type: 'candidates', text: `静态提取 ${candidates.length} 个`, payload: { candidates }, flags: candidates.length ? ['CANDIDATE'] : [] })
            output = { candidates }
            break
          }
          case 'call_static_parser_agent': {
            const html = (args2?.html ?? input.html ?? '') as string
            const { candidates } = extractHtmlCandidates(html)
            writeMdMessage({ agent: '静态解析员(LLM)', type: 'candidates', text: `子智能体-静态解析 ${candidates.length} 个`, payload: { candidates }, flags: candidates.length ? ['CANDIDATE'] : [] })
            output = { candidates }
            break
          }
          case 'code_maintainer_agent_write': {
            const codeStr = String(args2?.code || '')
            const trimmed = codeStr.trim()
            if (!trimmed || trimmed.length < 50) {
              writeMdMessage({ agent: '静态解析员(LLM)', type: 'error', text: '拒绝覆盖：提交的静态算法代码为空或过短（<50 字符）', flags: ['CRITICAL','KEEP'] })
              subMessages.push({ role: 'user', content: 'STRICT_RETRY: 代码为空或过短；请提交完整的静态算法代码（不少于 50 字符），仅输出 JSON。' })
              output = { ok: false, error: 'code_too_short' }
            } else {
              const ret = await writeAlgorithmCodeTo('static', { title: args2?.title, code: codeStr, language: args2?.language, meta: args2?.meta })
              writeMdMessage({ agent: '静态解析员(LLM)', type: 'code_write', text: `覆盖写入静态算法代码`, payload: ret, flags: ['KEEP'] })
              codeWritten = true
              // 要求生成报告
              subMessages.push({ role: 'user', content: 'MANDATORY_REPORT: 代码已写入；请立即输出 record_message（简要报告，必须），如有候选可直接返回 result。仅输出 JSON。' })
              output = ret
            }
            break
          }
          case 'record_message': {
            writeMdMessage({ agent: '静态解析员(LLM)', type: 'note', text: String(args2?.text || ''), payload: args2?.payload, flags: Array.isArray(json.flags) ? json.flags : (Array.isArray(args2?.flags) ? args2.flags : []) })
            reportWritten = true
            output = { ok: true }
            break
          }
          default: {
            writeMdMessage({ agent: '静态解析员(LLM)', type: 'error', text: `未知工具：${toolName}`, flags: ['CRITICAL','KEEP'] })
            output = { ok: false, error: `unknown_tool:${toolName}` }
            break
          }
        }
        subMessages.push({ role: 'user', content: `TOOL_OUTPUT(${toolName}): ${JSON.stringify(output)}` })
        if (json.comment) subMessages.push({ role: 'assistant', content: `COMMENT: ${String(json.comment)}` })
      }
      return lastOutput || { candidates: [] }
    },
    async capture_network(args: any) {
      const res = await captureNetwork(args?.url ?? input.url, args?.headers ?? undefined)
      writeMdMessage({ agent: '动态抓包员', type: 'capture', text: `LLM请求：动态抓包`, payload: { url: args?.url ?? input.url, result: res }, flags: res.manifestUrl ? ['CANDIDATE'] : [] })
      if (res?.headers && Object.keys(res.headers).length) {
        writeMdMessage({ agent: '动态抓包员', type: 'headers', text: '关键请求头', payload: res.headers, flags: ['CRITICAL', 'KEEP'] })
      }
      // 记录上下文
      if (res?.headers) lastNetworkHeaders = res.headers
      if (res?.manifestUrl) lastManifestUrl = res.manifestUrl
      return res
    },
    async call_network_capture_agent(args: any) {
      // LLM 子智能体：网络抓包员
      const agentClient = createDoubaoClientFor('NETWORK_CAPTURE')
      const upstreamSummary = `AlgoName=${input.algoName || ''} | URL=${input.url || input.exampleUrl || ''} | HTML=${Boolean(input.html)} | HAR=${input.harPath || ''} | Prefer=${input.prefer || 'auto'} | Notes=${(input.notes || '').slice(0, 80)}`
      const decKeep = readMdMessages({ flags: ['DECISION','KEEP'] })
      const directivesText = decKeep.slice(-8).map((m: any) => `- ${m.agent} · ${m.type} · ${m.text}`).join('\n')
      const dynamicMdPath = getAlgorithmDynamicPath()
      const dynamicMdContent = fs.existsSync(dynamicMdPath) ? fs.readFileSync(dynamicMdPath, 'utf-8') : ''
      const dynamicCode = extractLastCodeBlock(dynamicMdContent)
      const subPrompt = buildNetworkCaptureAgentPrompt({
        upstreamSummary,
        responsibleMdPath: dynamicMdPath,
        userUrl: args?.url ?? input.url ?? input.exampleUrl ?? '',
        userHtmlSnippet: (args?.html ?? input.html ?? ''),
        userHarPath: input.harPath || '',
        coordinatorDirectives: directivesText,
        responsibleMdContent: dynamicCode,
      })
      const subMessages: { role: 'system'|'user'|'assistant'; content: string }[] = [
        { role: 'system', content: subPrompt },
        { role: 'user', content: 'NEXT_ACTION_REQUEST: 严格输出下一步工具调用的 JSON，不要解释。' },
      ]
      // 本次会话必须完成：至少一次完整代码提交与一次报告写入
      let codeWritten = false
      let reportWritten = false
      const subDebugDir = path.join(getLogsDir(), 'debug', id, 'subagent_network')
      try { if (!fs.existsSync(subDebugDir)) fs.mkdirSync(subDebugDir, { recursive: true }) } catch {}
      const MAX_SUB_STEPS = 8
      let lastOutput: any = null
      for (let step = 0; step < MAX_SUB_STEPS; step++) {
        try {
          const inputMd = [
            `# Network SubAgent · Step ${step+1}`,
            `## Messages`,
            ...subMessages.map(m => `### ${m.role}\n\n${m.content}`),
          ].join('\n')
          fs.writeFileSync(path.join(subDebugDir, `input_${step+1}.md`), inputMd, 'utf-8')
        } catch {}
        const res = await agentClient.chat(subMessages)
        try {
          const outputMd = [
            `# Network SubAgent Output · Step ${step+1}`,
            `## content`,
            typeof (res as any)?.content === 'string' ? (res as any).content : '',
            ``,
            `## raw`,
            '```json',
            JSON.stringify(res, null, 2),
            '```',
          ].join('\n')
          fs.writeFileSync(path.join(subDebugDir, `output_${step+1}.md`), outputMd, 'utf-8')
        } catch {}
        const json = extractJson(res.content)
        if (!json) {
          writeMdMessage({ agent: '网络抓包员(LLM)', type: 'error', text: '子智能体输出不可解析（非 JSON）', flags: ['CRITICAL','KEEP'] })
          // 强制重试：追加严格重试指令，仅输出 JSON 对象
          subMessages.push({ role: 'user', content: 'STRICT_RETRY: 上一步输出不可解析；仅输出单一 JSON 对象（无代码围栏、无解释）。示例：{"tool":"...","args":{...},"flags":[]} 或 {"result":{...},"flags":[]}。' })
          continue
        }
        if (json.result) {
          const mu = String(json.result?.manifestUrl || '')
          writeMdMessage({ agent: '网络抓包员(LLM)', type: 'result', text: mu ? `清单 ${mu}` : '无清单', payload: json.result, flags: mu ? ['CANDIDATE'] : [] })
          if (json.result?.headers && Object.keys(json.result.headers).length) {
            writeMdMessage({ agent: '网络抓包员(LLM)', type: 'headers', text: '关键请求头', payload: json.result.headers, flags: ['CRITICAL','KEEP'] })
          }
          // 记录上下文
          if (json.result?.headers) lastNetworkHeaders = json.result.headers
          if (json.result?.manifestUrl) lastManifestUrl = String(json.result.manifestUrl)
          lastOutput = json.result
          // 完成条件未满足则继续：要求提交完整代码与报告
          if (codeWritten && reportWritten) {
            break
          } else {
            subMessages.push({ role: 'user', content: 'MANDATORY_CONTINUE: 已获取清单/关键头；本次会话必须完成代码提交与报告。请立即输出 code_maintainer_agent_write（完整代码，不得为空）或 record_message（报告）。仅输出单一 JSON 对象。' })
            continue
          }
        }
        const toolName = String(json.tool || '')
        const args2 = json.args ?? {}
        let output: any = null
        switch (toolName) {
          case 'capture_network':
          case 'call_network_capture_agent': {
            const res2 = await captureNetwork(args2?.url ?? input.url, args2?.headers ?? undefined)
            writeMdMessage({ agent: '网络抓包员(LLM)', type: 'capture', text: `动态抓包`, payload: { url: args2?.url ?? input.url, result: res2 }, flags: res2.manifestUrl ? ['CANDIDATE'] : [] })
            if (res2?.headers && Object.keys(res2.headers).length) {
              writeMdMessage({ agent: '网络抓包员(LLM)', type: 'headers', text: '关键请求头', payload: res2.headers, flags: ['CRITICAL','KEEP'] })
            }
            // 记录上下文
            if (res2?.headers) lastNetworkHeaders = res2.headers
            if (res2?.manifestUrl) lastManifestUrl = res2.manifestUrl
            output = res2
            break
          }
          case 'call_html_preprocessor': {
            const out = await tools.call_html_preprocessor(args2)
            output = out
            break
          }
          case 'code_maintainer_agent_write': {
            const codeStr = String(args2?.code || '')
            const trimmed = codeStr.trim()
            if (!trimmed || trimmed.length < 50) {
              writeMdMessage({ agent: '网络抓包员(LLM)', type: 'error', text: '拒绝覆盖：提交的动态算法代码为空或过短（<50 字符）', flags: ['CRITICAL','KEEP'] })
              subMessages.push({ role: 'user', content: 'STRICT_RETRY: 代码为空或过短；请提交完整的动态算法代码（不少于 50 字符），仅输出 JSON。' })
              output = { ok: false, error: 'code_too_short' }
            } else {
              const ret = await writeAlgorithmCodeTo('dynamic', { title: args2?.title, code: codeStr, language: args2?.language, meta: args2?.meta })
              writeMdMessage({ agent: '网络抓包员(LLM)', type: 'code_write', text: `覆盖写入动态算法代码`, payload: ret, flags: ['KEEP'] })
              codeWritten = true
              // 要求生成报告
              subMessages.push({ role: 'user', content: 'MANDATORY_REPORT: 代码已写入；请立即输出 record_message（简要报告，必须），如有清单可直接返回 result。仅输出 JSON。' })
              output = ret
            }
            break
          }
          case 'record_message': {
            writeMdMessage({ agent: '网络抓包员(LLM)', type: 'note', text: String(args2?.text || ''), payload: args2?.payload, flags: Array.isArray(json.flags) ? json.flags : (Array.isArray(args2?.flags) ? args2.flags : []) })
            reportWritten = true
            output = { ok: true }
            break
          }
          default: {
            writeMdMessage({ agent: '网络抓包员(LLM)', type: 'error', text: `未知工具：${toolName}`, flags: ['CRITICAL','KEEP'] })
            output = { ok: false, error: `unknown_tool:${toolName}` }
            break
          }
        }
        subMessages.push({ role: 'user', content: `TOOL_OUTPUT(${toolName}): ${JSON.stringify(output)}` })
        if (json.comment) subMessages.push({ role: 'assistant', content: `COMMENT: ${String(json.comment)}` })
      }
      return lastOutput || { manifestUrl: undefined, headers: undefined }
    },
    async call_html_preprocessor(args: any) {
      // 用于输入超限场景：将处理后的 HTML 覆盖提示上下文使用，原始保留在原始日志
      const original = String(args?.html ?? input.html ?? '')
      if (!original) {
        writeMdMessage({ agent: '异常诊断员', type: 'html_preprocess_skip', text: '无 HTML 可处理', flags: ['KEEP'] })
        return { processed: '', originalChars: 0, processedChars: 0, removedBytes: 0, notes: 'no_html' }
      }
      const out = preprocessHtmlLong(original, { maxChars: Number(args?.maxChars ?? (process.env.HTML_MAX_CHARS || 120000)) })
      // 原始 HTML → 仅写入原始日志（agents_raw.md）
      try {
        writeRawMessage({ agent: 'HTML源', type: 'original_html', text: '保留原始 HTML（仅 raw）', payload: { length: out.originalChars, html: original }, flags: ['KEEP'] })
      } catch {}
      // 处理后 HTML → 覆盖提示MD（agents.md）并标记为关键保留
      try {
        writePromptMessage({ agent: 'HTML源', type: 'processed_html', text: `处理过长 HTML：${out.processedChars}/${out.originalChars} chars`, payload: { notes: out.notes, html: out.processed }, flags: ['DECISION', 'KEEP'] })
      } catch {}
      // 更新运行期输入，后续工具调用将使用处理后的 HTML
      try { (input as any).html = out.processed } catch {}
      return out
    },
    async parse_manifest(_args: any) {
      const res = parseManifest({ url: _args?.manifestUrl, content: _args?.content })
      writeMdMessage({ agent: '清单解析员', type: 'parse', text: `LLM请求：解析清单 变体 ${res.variants.length}`, payload: res, flags: res.variants.length ? ['KEEP'] : [] })
      return res
    },
    async call_manifest_parser_agent(args: any) {
      writeMdMessage({ agent: '总协调员(LLM)', type: 'deprecated', text: 'call_manifest_parser_agent 已禁用；请改用 human_acceptance_flow。', flags: ['KEEP'] })
      return { ok: false, notes: 'deprecated: use human_acceptance_flow' }
    },
    async pick_best_variant(args: any) {
      const selected = pickBestVariant(Array.isArray(args?.variants) ? args.variants : [])
      writeMdMessage({ agent: '清单解析员', type: 'pick_best', text: selected ? `选择最高分辨率` : `无可选变体`, payload: { selected }, flags: selected ? ['CRITICAL', 'KEEP'] : ['KEEP'] })
      return { selected }
    },
    async build_download_plan(args: any) {
      const res = await buildDownloadPlan({ url: String(args?.manifestUrl || args?.url || ''), headers: args?.headers })
      writeMdMessage({ agent: '清单解析员', type: res.ok ? 'plan' : 'plan_failed', text: res.ok ? `生成下载计划(${res.kind})` : `计划生成失败`, payload: res, flags: ['KEEP'] })
      return res
    },
    async download_merge(args: any) {
      const out = await downloadAndMerge({ manifestUrl: args?.manifestUrl, headers: args?.headers })
      writeMdMessage({ agent: '下载与验收员', type: out.ok ? 'download' : 'error', text: out.ok ? '下载完成' : '下载失败', payload: out, flags: out.ok ? ['KEEP'] : ['CRITICAL', 'KEEP'] })
      return out
    },
    async call_downloader_qa_agent(args: any) {
      writeMdMessage({ agent: '总协调员(LLM)', type: 'deprecated', text: 'call_downloader_qa_agent 已禁用；请改用 human_acceptance_flow。', flags: ['KEEP'] })
      return { ok: false, notes: 'deprecated: use human_acceptance_flow' }
    },
    async probe_media(args: any) {
      const out = probeMedia(args?.filePath)
      writeMdMessage({ agent: '下载与验收员', type: 'probe', text: out.ok ? '验收通过' : '验收失败', payload: out, flags: out.ok ? ['KEEP'] : ['CRITICAL', 'KEEP'] })
      return out
    },
    async record_message(args: any) {
      writeMdMessage({ agent: '总协调员(LLM)', type: 'note', text: String(args?.text || ''), payload: args?.payload, flags: Array.isArray(args?.flags) ? args.flags : [] })
      return { ok: true }
    },
    async recorder_agent_write_message(args: any) {
      writeMdMessage({ agent: '总协调员(LLM)', type: 'note', text: String(args?.text || ''), payload: args?.payload, flags: Array.isArray(args?.flags) ? args.flags : [] })
      return { ok: true }
    },
    async mark_critical(args: any) {
      return markCriticalTool(String(args?.msgId || ''), Array.isArray(args?.flags) ? args.flags : [])
    },
    async recorder_agent_mark_critical(args: any) {
      return markCriticalTool(String(args?.msgId || ''), Array.isArray(args?.flags) ? args.flags : [])
    },
    async measure_md_file(_args: any) {
      const m = measureMdFile()
      writeMdMessage({ agent: '对话记录员', type: 'measure', text: `agents.md 尺寸：${m.fileChars} chars, ${m.fileLines} lines`, flags: [] })
      return m
    },
    async context_manager_agent_measure_file(_args: any) {
      const m = measureMdFile()
      writeMdMessage({ agent: '对话记录员', type: 'measure', text: `agents.md 尺寸：${m.fileChars} chars, ${m.fileLines} lines`, flags: [] })
      return m
    },
    async crop_history(args: any) {
      const msgs = readMdMessages()
      const plan = cropHistoryTool(msgs, args?.windowSize ?? 200, Array.isArray(args?.keepFlags) ? args.keepFlags : [])
      writeMdMessage({ agent: '上下文裁剪员', type: 'crop', text: `裁剪计划：keep=${plan.keptCount} remove=${plan.removedCount}`, payload: plan, flags: ['CROP_LOG'] })
      return plan
    },
    async context_manager_agent_crop_history(args: any) {
      const msgs = readMdMessages()
      const plan = cropHistoryTool(msgs, args?.windowSize ?? 200, Array.isArray(args?.keepFlags) ? args.keepFlags : [])
      writeMdMessage({ agent: '上下文裁剪员', type: 'crop', text: `裁剪计划：keep=${plan.keptCount} remove=${plan.removedCount}`, payload: plan, flags: ['CROP_LOG'] })
      return plan
    },
    async compress_history(args: any) {
      // 改造为 LLM 子智能体：历史压缩员（返回完整 agents.md 文本并覆盖写入）
      const agentClient = createDoubaoClientFor('HISTORY_COMPRESSOR')
      const keepFlags: string[] = Array.isArray(args?.keepFlags) ? args.keepFlags : ['CRITICAL','DECISION','KEEP','ERROR']
      const budget = Number(args?.budget ?? (process.env.CTX_TARGET_TOKENS || 12000))
      const recentPrefer = Number(args?.recentPrefer ?? (process.env.CTX_RECENT_PREFER || 200))
      const prompt = buildHistoryCompressorAgentPrompt({ keepFlags, targetTokens: budget, recentPrefer })
      const agentsMdPath = getAgentsMdPath()
      const currentMd = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf-8') : '# Agents Prompt Log\n\n'
      const msgs2: { role: 'system'|'user'|'assistant'; content: string }[] = [
        { role: 'system', content: prompt },
        { role: 'user', content: `CURRENT_AGENTS_MD:\n\n${currentMd}` },
      ]
      const res = await agentClient.chat(msgs2)
      const newMd = (res.content || '').trim()
      if (!newMd || !newMd.startsWith('# Agents Prompt Log')) {
        // 回退到本地压缩工具以保证稳定性
        const msgsLocal = readMdMessages()
        const out = compressHistoryTool(msgsLocal, budget, keepFlags)
        return out
      }
      try {
        fs.writeFileSync(agentsMdPath, newMd, 'utf-8')
      } catch {}
      // 记录一次过程日志（仅摘要），避免与新文件内容重复标记
      writeMdMessage({ agent: '历史压缩员(LLM)', type: 'summary', text: `已用 LLM 历史压缩；目标 ${budget} tokens`, flags: ['COMPRESS_LOG'] })
      return { ok: true, replaced: true }
    },
    async context_manager_agent_compress_history(args: any) {
      return tools.compress_history(args)
    },
    async diagnose_error(args: any) {
      const type = classifyError(String(args?.logs || ''))
      const fix = proposeFix(type)
      writeMdMessage({ agent: '异常诊断员', type: 'diagnose', text: `诊断：${type}`, payload: fix, flags: type === 'drm_protected' ? ['ERROR', 'CRITICAL', 'KEEP'] : ['ERROR'] })
      return { type, fix }
    },
    async error_diagnoser_agent_diagnose(args: any) {
      const type = classifyError(String(args?.logs || ''))
      const fix = proposeFix(type)
      writeMdMessage({ agent: '异常诊断员', type: 'diagnose', text: `诊断：${type}`, payload: fix, flags: type === 'drm_protected' ? ['ERROR', 'CRITICAL', 'KEEP'] : ['ERROR'] })
      return { type, fix }
    },
    async detect_input_limit(args: any) {
      const out = detectInputLimit(String(args?.error || ''))
      writeMdMessage({ agent: '异常诊断员', type: 'detect_input_limit', text: out.isInputLimit ? '是输入超限' : '不是输入超限', payload: out, flags: out.isInputLimit ? ['ERROR'] : [] })
      return out
    },
    async error_diagnoser_agent_detect_input_limit(args: any) {
      const out = detectInputLimit(String(args?.error || ''))
      writeMdMessage({ agent: '异常诊断员', type: 'detect_input_limit', text: out.isInputLimit ? '是输入超限' : '不是输入超限', payload: out, flags: out.isInputLimit ? ['ERROR'] : [] })
      return out
    },
    async read_md_messages(args: any) {
      const msgs = readMdMessages({ flags: args?.flags, agent: args?.agent, type: args?.type, sinceMsgId: args?.sinceMsgId })
      return { messages: msgs }
    },
    async context_manager_agent_read_messages(args: any) {
      const msgs = readMdMessages({ flags: args?.flags, agent: args?.agent, type: args?.type, sinceMsgId: args?.sinceMsgId })
      return { messages: msgs }
    },
    async estimate_tokens(_args: any) {
      const msgs = readMdMessages()
      return estimateTokens(msgs)
    },
    async context_manager_agent_estimate_tokens(_args: any) {
      const msgs = readMdMessages()
      return estimateTokens(msgs)
    },
    async finalize(args: any) {
      return { final: { manifestUrl: args?.manifestUrl, filePath: args?.filePath, notes: args?.notes } }
    },
    // 新：人类验收流程（统一变体选择 → 下载合并 → 人类验证）
    async human_acceptance_flow(args: any) {
      const pickRaw = String(args?.algo_pick || '').toLowerCase()
      const pick: 'static' | 'dynamic' = pickRaw === 'static' ? 'static' : (pickRaw === 'dynamic' ? 'dynamic' : 'dynamic')
      const algoPath: string = String(args?.algorithmPath || (pick === 'dynamic' ? getAlgorithmDynamicPath() : getAlgorithmStaticPath()))
      const pageUrl: string | undefined = args?.url || args?.pageUrl || input.url || input.exampleUrl
      // 兜底使用最近一次网络抓包的关键请求头
      const headers: Record<string, string> | undefined = args?.headers || lastNetworkHeaders
      const manifestUrl: string | undefined = args?.manifestUrl || lastManifestUrl
      writeMdMessage({ agent: '总协调员(LLM)', type: 'start_human_acceptance', text: `提交至人类验收流程：${pick} @ ${path.basename(algoPath)}`, flags: ['DECISION','KEEP'] })
      const out = await runHumanAcceptanceFlow({ algorithmMdPath: algoPath, pageUrl, headers, manifestUrl })
      return out
    },
    // 代码维护工具（支持静态/动态两份MD）
    async code_maintainer_agent_write(args: any) {
      const code = String(args?.code || '')
      const title = args?.title
      const language = args?.language
      const meta = args?.meta
      if (args?.target === 'static' || args?.target === 'dynamic') {
        return writeAlgorithmCodeTo(args.target, { title, code, language, meta })
      }
      return writeAlgorithmCode({ title, code, language, meta })
    },
    // 取消 reset 功能：不再支持重置算法代码，仅支持子智能体完整覆盖写入
    async code_maintainer_agent_finalize(args: any) {
      const pick = args?.algo_pick
      const targetName = String(args?.targetName || input.algoName || '').trim() || undefined
      if (pick === 'static' || pick === 'dynamic') {
        return finalizeAlgorithmIntoStorePick({ pick, targetName })
      }
      // 未指定 pick 时仍允许使用 targetName（按默认静态回退策略）
      if (targetName) {
        return finalizeAlgorithmIntoStorePick({ pick: 'static', targetName })
      }
      return finalizeAlgorithmIntoStore()
    },
  }

  // 允许通过环境变量配置最大轮次（优先 COORDINATOR_MAX_STEPS，其次 LLM_MAX_STEPS），默认 6
  const MAX_STEPS = (() => {
    const raw = String(process.env.COORDINATOR_MAX_STEPS || process.env.LLM_MAX_STEPS || '').trim()
    const v = parseInt(raw, 10)
    return Number.isFinite(v) && v > 0 ? v : 100
  })()
  // 路径选择策略：不做硬性限制，允许根据上下文/代码自主决定先静态或先动态
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      run.steps = step + 1
      // 为兼容 Doubao Chat API 要求：当未启用思维链或为 minimal 时，最后一条必须为 user
      // 若当前最后一条为 assistant，则追加一条 user 指令以请求下一步 JSON 工具调用
      try {
        const last = messages[messages.length - 1]
        if (!last || last.role !== 'user') {
          messages.push({ role: 'user', content: 'NEXT_ACTION_REQUEST: 请基于上述上下文，严格返回下一步工具调用的 JSON（{"tool":...,"args":...,"comment":...}，可选 "flags":[]），不要输出解释。' })
        }
      } catch {}
      // 在调用 LLM 之前，将完整 messages 写入 debug（每步一个文件）
      try {
        const stepIdx = step + 1
        const inputMd = [
          `# LLM Input · Step ${stepIdx}`,
          `- runId: ${id}`,
          `- timestamp: ${new Date().toISOString()}`,
          ``,
          `## Messages`,
          ...messages.map(m => `### ${m.role}\n\n${m.content}`)
        ].join('\n')
        fs.writeFileSync(path.join(debugDir, `llm_input_step_${stepIdx}.md`), inputMd, 'utf-8')
      } catch {}

      const res = await client.chat(messages)
      // 将 LLM 原样输出写入 debug（每步一个文件）
      try {
        const stepIdx = step + 1
        const outputMd = [
          `# LLM Output · Step ${stepIdx}`,
          `- runId: ${id}`,
          `- timestamp: ${new Date().toISOString()}`,
          ``,
          `## content`,
          typeof (res as any)?.content === 'string' ? (res as any).content : '',
          ``,
          `## raw`,
          `\`\`\`json`,
          JSON.stringify(res, null, 2),
          `\`\`\``
        ].join('\n')
        fs.writeFileSync(path.join(debugDir, `llm_output_step_${stepIdx}.md`), outputMd, 'utf-8')
      } catch {}
      const json = extractJson(res.content)
      if (!json) {
        writeMdMessage({ agent: '总协调员(LLM)', type: 'error', text: 'LLM 输出非 JSON 或解析失败', flags: ['CRITICAL', 'KEEP'] })
        run.status = 'error'
        run.error = 'LLM 输出不可用'
        break
      }
      if (json.final) {
        const { manifestUrl, filePath, notes } = json.final
        run.result = { manifestUrl, filePath, notes }
        run.status = 'done'
        writeMdMessage({ agent: '总协调员(LLM)', type: 'final', text: `完成：manifest=${manifestUrl || 'null'} file=${filePath || 'null'}`, payload: run.result, flags: Array.isArray(json.flags) ? json.flags : [] })
        // 提交当前算法代码到主程序存储（允许选择静态/动态），并使用用户提供的算法名（如有）
        try {
          const pick = (json?.final && (json.final.algo_pick as any)) || (json?.algo_pick as any)
          const fin = (pick === 'static' || pick === 'dynamic')
            ? finalizeAlgorithmIntoStorePick({ pick, targetName: (input.algoName || undefined) })
            : (input.algoName ? finalizeAlgorithmIntoStorePick({ pick: 'static', targetName: input.algoName }) : finalizeAlgorithmIntoStore())
          messages.push({ role: 'user', content: `TOOL_OUTPUT(code_maintainer_agent_finalize): ${JSON.stringify(fin)}` })
          // 广播算法列表更新，便于前端刷新显示新算法
          try { BrowserWindow.getAllWindows()[0]?.webContents.send('algorithms:updated', { name: (fin as any).targetName }) } catch {}
        } catch {}
        break
      }
      const toolName = json.tool as keyof typeof tools
      const args = json.args ?? {}
      if (!toolName || typeof tools[toolName] !== 'function') {
        writeMdMessage({ agent: '总协调员(LLM)', type: 'error', text: `未知工具：${toolName}`, flags: ['CRITICAL', 'KEEP'] })
        run.status = 'error'
        run.error = `未知工具：${toolName}`
        break
      }

      // 路径选择不做硬限制；允许直接调用静态或动态子智能体。

      // Dispatch tool
      const output = await (tools[toolName] as any)(args)
      // Feed back to LLM
      messages.push({ role: 'user', content: `TOOL_OUTPUT(${toolName}): ${JSON.stringify(output)}` })
      if (json.comment) messages.push({ role: 'assistant', content: `COMMENT: ${String(json.comment)}` })

      // Early finalize if we got manifest candidates
      if ((toolName === 'static_extract_html_candidates' || toolName === 'call_static_parser_agent') && Array.isArray(output?.candidates) && output.candidates.length) {
        // Provide a hint to LLM to finalize or pick variant
        messages.push({ role: 'user', content: `HINT: Found ${output.candidates.length} manifest candidates. You may pick best or finalize.` })
      }
      // 软提示：若静态候选为空，可提示考虑动态抓包（非强制）
      if ((toolName === 'static_extract_html_candidates' || toolName === 'call_static_parser_agent') && Array.isArray(output?.candidates) && output.candidates.length === 0) {
        messages.push({ role: 'assistant', content: `COMMENT: 静态候选为空，可考虑尝试动态抓包。` })
      }
      run.updatedAt = Date.now()
    }
  } catch (e: any) {
    run.status = 'error'
    run.error = e?.message || String(e)
    writeMdMessage({ agent: '总协调员(LLM)', type: 'error', text: String(run.error), flags: ['CRITICAL', 'KEEP'] })
    // 自动调用本地异常诊断员，记录诊断与建议
    try {
      const type = classifyError(String(run.error))
      const fix = proposeFix(type)
      writeMdMessage({ agent: '异常诊断员', type: 'diagnose', text: `诊断：${type}`, payload: fix, flags: type === 'drm_protected' ? ['ERROR', 'CRITICAL', 'KEEP'] : ['ERROR'] })
    } catch {}
  }

  // 若达到最大轮次仍未生成最终结果或错误，则明确收束为错误，避免界面“卡住”
  if (run.status === 'running') {
    run.status = 'error'
    run.error = `达到最大轮次(${MAX_STEPS})但未完成，请检查提示词或增加最大轮次。`
    writeMdMessage({ agent: '总协调员(LLM)', type: 'error', text: `达到最大轮次(${MAX_STEPS})但未完成`, flags: ['CRITICAL', 'KEEP'] })
  }

  return { runId: id }
}

export function getCoordinatorLLMStatus(runId: string): CoordinatorLLMRun | null {
  return runs.get(runId) ?? null
}