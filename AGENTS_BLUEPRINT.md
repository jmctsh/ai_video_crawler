# AI 视频爬虫多智能体架构蓝图（裁剪优先，无压缩与 RAG）

> 目标：仅抓取“主视频”，默认选择最高分辨率；不做文本抓取。采用共享一篇 Markdown（`agents.md`）作为智能体间通信与状态轨迹的唯一事实来源（Single Source of Truth）。本蓝图定义角色、消息规范、上下文管理策略（裁剪保留关键信息）、工具接口与实施计划。

## 1. 架构总览
- 核心理念：
  - 能力工具化（解析、抓包、清单处理、下载合并、裁剪等），LLM 负责编排与出补丁。
  - 对话文件分为三份（含两篇算法代码）：
    1) 提示MD（`agents.md`）：注入到 LLM 的共享上下文，可执行裁剪/压缩；保留关键标记。
    2) 原始日志MD（`agents_raw.md`）：完整保留原始对话，不做裁剪/压缩，供人类审阅。
    3) 算法代码MD（静态/动态）：`algorithm_static.md` 与 `algorithm_dynamic.md`，分别用于静态解析路径与动态抓包路径生成的算法代码；兼容保留聚合版 `algorithm.md`（回退/汇总）。
- 上下文过长时，仅裁剪（滑动窗口+保留关键消息）；不再执行压缩。
- 主要流程：
  1) 入口：用户提供页面源代码或网址。
  2) 路径选择与交错：协调员可根据上下文与已提交/正在编写的算法代码，自主决定先静态或先动态，并允许在同一流程中交错调用两类工具。交错时需在 `agents.md` 记录依据与切换原因，并将算法代码分别写入 `algorithm_static.md` 或 `algorithm_dynamic.md`。
  3) 人类验收流程：合并“清单解析 + 变体优选 + 下载合并 + 人类确认”，确保最终产出为正确的主视频文件。
  4) 记录与上下文管理：记录员写入 `agents.md` 的标准消息；裁剪员按策略维护上下文体积。

## 2. 智能体与职责（LLM / 本地算法 / 人类工具分工）
- 总协调员（Coordinator）
  - 职责：接收用户输入，分派任务，整合结果，决策回退与容错，最终确认产出。
  - 实现类型：LLM 主导（函数/工具调用编排）+ 少量本地规则（失败回退/速率限制）。
  - 输入：用户提供的 URL、HTML 源或抓包导入（HAR）。
  - 输出：决策消息、里程碑、最终产物路径、失败/回退说明。
- 静态解析员（HTML 解析员）
  - 职责：从页面源中提取候选视频 URL、播放器初始化参数、清单链接（`.m3u8`, `.mpd` 等）。
  - 实现类型：本地算法优先（正则/DOM/AST/启发式）；可选 LLM 辅助处理混淆脚本。
  - 工具：`extractHtmlCandidates(html)`、`findManifestLinks(html)`。
  - 输出：候选 URL 列表、可信度评分、需要的附加请求头。
  - 子智能体提示词统一维护：位置 `src/main/agentsPrompts.ts`；包含“静态解析员”的职责、可调用工具、输出 JSON 规范；由协调员在会话启动时注入，并携带“上游命令摘要”与“负责的算法代码MD（static）”。
- 网络抓包员（动态抓包员）
  - 职责：在可执行环境中加载页面，捕获网络请求，识别媒体清单与分片。
  - 实现类型：本地工具（自动化浏览器/代理/HAR）；不依赖 LLM。优先采用 Playwright/Chromium（无头）注入，捕获 fetch/XHR 与所有请求；自动提取关键请求头（Referer/User-Agent/Cookie）。
  - 工具：`captureNetwork(url, headers?)`、`importHar(file)`。
  - 输出：主清单 URL、关键请求头（在 `agents.md` 以 `CRITICAL` 记录）、可能的 License/DRM 端点指示。
  - 子智能体提示词统一维护：位置 `src/main/agentsPrompts.ts`；包含“网络抓包员”的职责、可调用工具、输出 JSON 规范；由协调员在会话启动时注入，并携带“上游命令摘要”与“负责的算法代码MD（dynamic）”。
 - 人类验收流程（Human Acceptance Flow）
  - 职责：将“清单解析 + 变体优选 + 下载合并 + 人类确认”整合为单一流程，确保最终产出为正确的“主视频”。
  - 实现类型：本地流程（解析器、下载器、合并器、媒体探测）+ 人类工具（UI 弹窗）；由总协调员统一调度。
  - 工具（对外）：`runHumanAcceptanceFlow({algorithmName|algorithmMdPath, pageUrl, headers?})`、`runHumanAcceptanceFlowWithStore({algorithmName, pageUrl, headers?})`。
  - 工具（内部）：`parseManifest(...)`、`pickBestVariant(...)`、`buildDownloadPlan(...)`、`downloadAndMerge(...)`、`probeMedia(...)`、`requestHumanValidation(...)`。
  - 输出：`{filePath, selectedVariant?, notes?, ok}`；必要时带 `DECISION/CRITICAL` 标记写入 `agents.md`。
- 对话记录员（记录员）
  - 职责：将每次行动或结果写入 `agents.md`，识别并标注关键内容（特殊标记）。
  - 实现类型：本地工具（写文件/锁/关键标记启发式）；可选 LLM 辅助关键性判定。
  - 工具：`writeMdMessage(entry)`、`markCritical(entryId, tags)`。
  - 输出：标准化消息块（含 JSON 负载）、关键标记。
 
- 上下文裁剪员（裁剪员）
  - 职责：采用滑动窗口策略裁剪历史；绝不裁剪带关键标记的消息；对冗余日志进行窗口化保留。
  - 实现类型：本地算法（窗口/索引/标记保留）。
  - 工具：`cropHistory(messages, windowSize, keepFlags)`。
  - 输出：裁剪日志、窗口边界、保留索引。
- 异常诊断员（诊断员，可选）
  - 职责：识别常见错误类型（`input_limit`, `network_403`, `drm_protected`, `manifest_parse_error` 等），生成修复提案或回退路径。
  - 实现类型：混合（本地分类器 + LLM 生成修复提案）。
  - 工具：`classifyError(logs)`、`proposeFix(errorType)`。
  - 输出：错误报告、修复建议与优先级。

## 3. agents.md 共享文档规范
- 文件位置：默认写入项目根目录 `logs/`（例如 `logs/agents.md`，`logs/agents_raw.md`，`logs/algorithm.md`）；可通过环境变量 `AGENTS_LOG_DIR` 覆盖。
- 结构原则：人类可读 + 机器可解析。每个消息块由“可读说明”+“JSON 负载”构成。
- 消息块格式示例：
```
### [msg:2025-10-27T12:03:15Z] 清单解析员 → 选定最高分辨率
解析到 6 个变体，最高分辨率为 1920x1080，码率 8Mbps。

```json
{
  "agent": "清单解析员",
  "ts": "2025-10-27T12:03:15Z",
  "type": "variant_selection",
  "input": {
    "manifestUrl": "https://example.com/master.m3u8",
    "variants": [
      {"id": "v1", "res": "426x240", "br": 0.4},
      {"id": "v2", "res": "640x360", "br": 0.8},
      {"id": "v3", "res": "854x480", "br": 1.2},
      {"id": "v4", "res": "1280x720", "br": 3.2},
      {"id": "v5", "res": "1920x1080", "br": 8.0}
    ]
  },
  "decision": {
    "selected": {"id": "v5", "res": "1920x1080", "br": 8.0},
    "policy": "prefer_max_resolution_then_bitrate"
  },
  "status": "ok"
}
```
```
- 关键消息保留：裁剪保留最近里程碑与决策消息；错误与最终结论必须保留原文。
- 写入策略：
  - 使用 `writeMdMessage()` 将消息同时写入提示MD与原始日志MD（双写）；提示MD参与裁剪，原始日志MD完整保留。
  - 每条消息必须含 `msgId`（可用 `ts + rand`）用于引用与标记。

## 4. 上下文管理策略（仅裁剪）
- 全局预算：
  - `TOKEN_BUDGET`（LLM 上下文预算，默认 8k~16k tokens），`FILE_BUDGET`（`agents.md` 文件大小）。
- 触发器：
  - 调用 LLM 前检测 `est_tokens(messages) > TOKEN_BUDGET` → 触发裁剪员。
  - 文件大小超过 `FILE_BUDGET` → 异步裁剪历史非关键片段。
- 裁剪（优先）：
  - 滑动窗口：保留最近 `N` 条普通消息 + 所有关键标记消息（`CRITICAL/KEEP/DECISION/FINAL/ERROR`）。
  - 边界策略：按“步骤”而不是“字符数”裁剪；保留每个阶段的里程碑消息。


## 5. 工具接口（主进程/可调用）
- `writeMdMessage(entry)`
  - 入参：`{agent, type, text, payload(json), flags[], parentMsgId?}`
  - 出参：`{msgId}`，并保证落盘。
- `writeAlgorithmCodeTo(target, {title?, code, language?, meta?})`
  - 入参：`target in ["static","dynamic"]`；写入对应算法代码 MD。
  - 出参：`{ok}`；并记录消息。
- `writeAlgorithmCode({title?, code, language?, meta?})`
  - 兼容聚合版写入；写入 `algorithm.md`。
- `resetAlgorithmMdTarget(target, reason?)`
  - 入参：`target in ["static","dynamic"]`；重置对应算法代码 MD，并归档旧版。
  - 出参：`{ok}`；同时写入记录消息（DECISION/KEEP）。
- `resetAlgorithmMd(reason?)`
  - 兼容聚合版重置；归档至 `algorithm_archive.md`。
- `finalizeAlgorithmIntoStorePick({pick})`
  - 入参：`{pick in ["static","dynamic"], targetName?}`；提交所选算法代码至主程序存储（项目根 `algorithms/` 文件夹）。当提供 `targetName`/`algoName` 时作为算法名保存。
  - 保护：若目标算法名已存在则报错，防止重名覆盖（前端与主进程亦有预检）。
  - 出参：`{ok, targetName, pick}`；并写入记录消息（FINAL/CRITICAL/KEEP）。
- `finalizeAlgorithmIntoStore()`
  - 兼容旧接口：按静态→动态→聚合顺序回退提交；落盘至 `algorithms/` 文件夹，遵守命名冲突保护。
- `readMdMessages(filter)`
  - 入参：`{flags?[], agent?[], type?[], sinceMsgId?}`
  - 出参：消息数组。
- `markCritical(msgId, flags)`
  - 入参：`{msgId, flags:["CRITICAL","KEEP",...]}`
  - 出参：更新结果。
- `cropHistory(messages, windowSize)`
  - 入参：窗口大小（条数或时间）。
  - 出参：裁剪后的消息列表、移除清单。
- `extractHtmlCandidates(html)` / `findManifestLinks(html)`
  - 输出：候选清单 URL、播放器参数、可信度评分。
- `captureNetwork(url, headers?)` / `importHar(file)`
  - 输出：主清单 URL、关键请求头、分片模式。`captureNetwork` 优先使用 Playwright/Chromium 抓取网络请求并返回关键请求头；协调员需将关键头以 `CRITICAL` 标记写入 `agents.md`。
- `parseManifest(url|content)` / `pickBestVariant(variants)`
  - 输出：选中变体与分片序列。
- `downloadAndMerge(manifest, headers)` / `probeMedia(file)`
  - 输出：最终文件、校验结果、失败轨迹（由“人类验收流程”内部调用，不再直接暴露为独立对外步骤）。
- `detectInputLimit(error)`
  - 输出：是否为输入超限、建议触发裁剪。
 - `runHumanAcceptanceFlow(input)` / `runHumanAcceptanceFlowWithStore(input)`
  - 入参：`{algorithmName|algorithmMdPath, pageUrl, headers?}` 或 `{algorithmName, pageUrl, headers?}`（使用存储算法）。
  - 出参：`{filePath, selectedVariant?, notes?, ok}`；内部可能触发 `requestHumanValidation(...)` 并将决策写入 `agents.md`。

## 6. 决策工作流（伪代码）
```
Coordinator(input):
  writeMdMessage({agent:"总协调员", type:"start", text:"开始抓取"})

  // 路径选择：由协调员自主决定顺序，可直接动态或静态
  if prefer_dynamic_or_code_suggests_dynamic:
    N = 动态抓包员.capture(input.url)
    S = HTML解析员.extract(input.html)  // 可选，对照或补充
  else:
    S = HTML解析员.extract(input.html)
    N = 动态抓包员.capture(input.url)  // 若静态不适用或需验证

  // 人类验收流程：合并解析、优选、下载、媒体探测与人类确认
  HAF = 人类验收流程.run({algorithmNameOrMd, pageUrl: input.url, headers: N.headers})
  if HAF.ok:
    writeMdMessage({agent:"总协调员", type:"final", text:`输出 ${HAF.filePath}`,
      payload:{file:HAF.filePath, variant:HAF.selectedVariant}})
  else:
    诊断员.proposeFix(HAF.notes)
    fallback or retry

  // 上下文管理
  msgs = readMdMessages(all)
  if est_tokens(msgs) > TOKEN_BUDGET:
    msgs = 裁剪员.crop(msgs, windowSize=N)
```

## 7. 错误模型与回退策略
- `input_limit`：在 LLM 调用层面捕获并记录；触发裁剪。
- `network_403/401`：尝试追加必要请求头或 Cookie；重试策略指数退避；必要时停。
- `drm_protected`：标记 `!CRITICAL !ERROR DRM`；终止下载流程并输出合规提示。
- `manifest_parse_error`：更换解析器或采用动态抓包结果回退；记录员标注 `!ERROR`。
- `variants_empty`：降级至抓包员独立结果或提示站点适配需求。

## 8. 保留规则
- 保留决策与依据、最终产出、错误诊断原文。
- 保留候选清单的代表样本与汇总。
- 非关键日志按窗口裁剪。

## 9. 安全与合规
- 明确禁止绕过 DRM/付费保护；检测到后立即终止并记录。
- 遵守站点的 robots 与服务条款；设置速率限制与并发上限。
- 对用户输入隐私进行最小化保留（敏感字段脱敏）。

## 10. 实施计划（里程碑）
- M1：落地 `agents.md` 写入/读取工具；定义消息与关键标记；在 Make 界面提供“写入/查看轨迹”。
- M2：实现静态解析工具与动态抓包工具的 IPC；将结果写入 `agents.md`。
- M3：人类验收流程管线（清单解析+优选+下载合并+人类确认）。
- M4：上下文裁剪员与压缩员；接入 LLM 压缩（保留关键标记原文）。
- M5：错误诊断员与回退策略；HAR 导入与站点适配接口。
- M6：验收与打包；稳定性与速率策略；文档完善。

## 11. 命名对照（便于沟通）
- 总协调员（Coordinator）
- 对话记录员（Recorder）
- 上下文裁剪员（Cropper）
- HTML 解析员（Static Parser）
- 动态抓包员（Network Capture）
- 人类验收流程（Human Acceptance Flow）
- 异常诊断员（Error Diagnoser）

---

附注：本蓝图假设 `agents.md` 作为唯一共享语境文件，并通过保留关键消息实现“裁剪但不丢失关键事实”。后续实现中可将 `agents.md` 与 `trace.json` 并用：前者高可读，后者高可检索/编程。

```md
// 代码维护（在有明确算法实现时写入；不可用时重置）
代码维护员.writeAlgorithmCode(code)
if code_unusable:
  代码维护员.resetAlgorithmMd("不可使用或需重试")
// finalize：提交算法代码至主程序算法存储（文件夹 `algorithms/`）
// 保护：同名算法禁止覆盖（前端/主进程/最终保存三层防护）
代码维护员.finalizeAlgorithmIntoStorePick({pick, targetName})
```