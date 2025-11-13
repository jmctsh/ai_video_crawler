# AI Video Crawler

一个基于 Electron + React 的视频抓取与算法制作演示项目。集成豆包（Doubao）API，支持“总协调员 + 子智能体（静态解析员、网络抓包员）”的协同流程，提供算法代码产出、下载合并与缓存清理等能力。
UI 组件使用的是Radix + Tailwind的本地组件集（位于 `src/components/ui/*`）。

## 架构概览

- 渲染进程（UI）：`React + Vite`
  - 入口：`src/renderer/main.tsx`
  - 主界面：`src/renderer/App.tsx`
  - API 管理页：`src/renderer/ApiManagePlaceholder.tsx`（三卡片配置与保存）
  - UI 组件：`src/components/ui/*`（按钮、输入框、对话框等）

- 主进程（Electron）：`src/main/*`
  - LLM 客户端：`doubaoClient.ts`（chat；从 `.env` 读取 `ARK_API_KEY`、`ARK_MODEL_ID`）
  - 协调员：
    - 非 LLM 协调员：`coordinator.ts`（静态候选提取、下载）
    - LLM 协调员：`coordinatorLLM.ts`（按系统提示驱动工具：静态解析、动态抓包、清单解析、下载验收、提交算法代码）
  - 子智能体提示词：`agentsPrompts.ts`、协调员系统提示词：`coordinatorPrompt.ts`
  - 工具集：`src/main/tools/*`（`agentsMd` 日志、`manifest` 清单解析、`downloader` 下载合并与 `ffmpeg` 复用、`networkCapture` 抓包占位、`codeMaintainer` 算法写入与提交、`htmlPreprocessor` 预处理、`cacheCleanup` 缓存清理等）
  - IPC 接口：`main.ts`（算法管理、API 管理 `.env` 同步、协调员与子流程状态、缓存清理触发）

- 运行与数据文件路径：
  - 日志类文件（默认写入项目根目录 `logs/`，可用 `AGENTS_LOG_DIR` 覆盖）：`agents.md`（提示用日志）、`agents_raw.md`（原始完整日志）、`algorithm.md`（聚合代码）、`algorithm_static.md`、`algorithm_dynamic.md`。
  - 算法代码（统一存储在项目根目录 `algorithms/`）：支持 `.js`/`.ts`/`.md`；目录为空时会自动生成占位示例 `xvideos.js`；当算法以 `.md` 存储时会提取最后一个代码块作为运行代码。旧版 `algorithms.json` 不再作为主存储，下载器保留兼容回退读取。
  - 缓存清理：应用退出或开启第二轮制作前执行，重置提示与算法过程文件，并保留 `agents_raw.md` 归档（添加时间戳重命名）。

## 功能模块
 
 - 算法管理：基于 `algorithms/` 文件夹列出/查看/删除算法；支持 `.md` 代码块提取。
  - 算法制作（LLM）：总协调员按系统提示驱动子智能体，产出静态或动态算法代码并提交主存储。
- 下载与合并：根据清单或直接地址并发下载，自动探测并复用 `ffmpeg` 生成 MP4。
- API 管理：三卡片维护 `api_key` 与 `model_id`，保存后同步到 `.env`（不存在自动创建）。
- 历史裁剪：当上下文超预算时，系统仅保留最近三条 LLM 提交日志作为上下文；完整历史保留在 `agents_raw.md`。
- 历史压缩与 RAG 检索模块已移除。
- 缓存清理：在第二轮制作前与应用退出前执行，重置提示与算法过程文件、归档原始日志。

## 安装与运行

- 环境要求：`Node.js 18+`、`npm`；Windows 环境内置 `ffmpeg`（仓库 `ffmpeg/`）。
- 安装依赖：
  - `npm install`
- 开发运行（Electron + Vite）：
  - `npm run dev`
  - Vite 默认端口 `5173`；脚本会等待 `http://localhost:5173/` 后启动 Electron 主进程。
  - 若你本地已有其它 Vite 进程占用 5173，请先关闭或修改端口以避免 Electron 加载失败。

## 使用指南

- API 管理
  - 打开“API 管理”页，三张卡片分别对应：总协调员、静态解析员、网络抓包员。
  - 默认模型：统一使用 `doubao-seed-1-6-251015`。
  - 点击“保存并同步到 .env”：会写入或创建 `.env`，并同步到当前进程环境。
  - `.env` 键映射：
    - `doubao`：`ARK_API_KEY`、`ARK_MODEL_ID`
    - 其他条目同时写入各自的大写键，如 `STATIC_PARSER_API_KEY`、`STATIC_PARSER_MODEL_ID`、`NETWORK_CAPTURE_MODEL_ID` 等（预留扩展）。

- 算法制作（LLM）
  - 在“算法制作”页填写算法名、示例网址、源代码/HTML、说明后“提交到智能体”。
  - 协调员会驱动工具（静态/动态/清单/下载/人类验证等），最终提交静态或动态算法代码到 `algorithms/` 文件夹（支持 `.js`/`.ts`/`.md`）。
  - 命名冲突防护：若算法名与现有文件重名，前端会提示并阻止提交；主进程也会进行预检并返回错误；最终保存阶段有强保护，绝不覆盖已有算法。
  - 第一轮完成（状态 `done` 或 `error`）后界面自动重置；开始第二轮前会触发缓存清理（重置 MD、归档 `agents_raw.md`）。

- 下载与合并
  - 在主界面选择算法并输入目标地址，点击开始。
  - 程序会自动并发下载分片并合并；存在 `ffmpeg` 时直接复用生成 MP4。
  - 成品保存在 `downloads/`（默认）或你选择的目录。

## 环境变量说明

- 必需：`ARK_API_KEY`（豆包 API Key）
- 生成式模型：`ARK_MODEL_ID`（如 `doubao-seed-1-6-251015`）
- 其他角色扩展键：保存时生成，如 `STATIC_PARSER_MODEL_ID`、`NETWORK_CAPTURE_API_KEY` 等，便于后续按角色定制。

## 目录结构（简要）

```
d:\ai_video_crawer
├── src
│   ├── main        # 主进程与工具集
│   └── renderer    # React UI
├── dist-main       # 主进程编译产物（CommonJS）
├── ffmpeg          # Windows ffmpeg 可执行文件
├── index.html      # Vite 入口
├── package.json    # 依赖与脚本
├── LICENSE.txt     # 许可证（AGPL-3.0）
└── README.md       # 本文件
```

## 近期优化（2025-11-13）

- 静态解析可用性
  - 新增页面抓取工具：当未提供 `html` 时，静态路径会调用 `fetch_page_html` 自动抓取（静态子智能体亦可调用）。
  - 解析增强：统一解码 `\/` 与 `\u002F`，并解析页面内的播放器配置对象（如 `var player_aaaa={...}`）中的 `url` 字段，直接命中 `.m3u8/.mpd`。
  - 解决问题：过去“静态候选始终为 0”“静态算法代码写入后验收不弹窗”的问题已消除。

- 动态抓包与清单解包
  - 对聚合器地址（如 `https://bfbf123.xyz/?url=...`，兼容 `u`/`v` 参数）统一解包为真实清单 URL，抓取与相对路径拼接均以真实源域为基准。
  - 解决问题：过去选择 `2000kb` 变体下载出现 `http 404` 的问题（因相对路径拼到聚合器域）已修复。

- 人类验收流程增强
  - 回退机制：算法 MD 未产出 `manifest/direct` 时自动回退到静态 HTML 候选，构造可选变体。
  - 细节填充：为 HLS/DASH 变体预填分辨率（`res`）、码率（`br`）、预计大小（`sizeApproxBytes`）与请求头摘要，提升选择信息质量。
  - 解决问题：过去弹窗中缺少分辨率、码率、大小等信息，难以判断最佳变体。

- 调试反馈闭环
  - 新增 `read_debug_recent` 工具，并在每次工具调用后自动注入最近调试摘要到 LLM 会话。
  - 解决问题：过去“卡住/重复错误”而模型缺少最新失败轨迹的情况。

- 上下文与成本平衡
  - 自适应裁剪：保留关键消息；按 `TOKEN_BUDGET` 与 `CONTEXT_RESERVE_RATIO` 动态调整 LLM/非 LLM 窗口，兼顾费用与效果。

- 算法管理与入库
  - 默认命名改为 `algo_<timestamp>`，避免随机覆盖/混淆；算法列表按时间降序显示最新条目，刷新更直观。

- 执行器兼容性
  - 在算法执行沙箱提供 `helpers.fetch` 包装，模板与子智能体输出的代码可直接使用 `fetch().text()` 获取页面内容。
  - 解决问题：过去模板使用 `fetch` 导致执行报错、算法不可运行。

### 关键改动文件

- 主流程
  - `src/main/coordinatorLLM.ts`：注册 `fetch_page_html`；在静态子会话与缺失 HTML 时自动抓取并解析；注入调试摘要。
  - `src/main/agentsPrompts.ts`：提示中加入调试工具与抓取工具的说明。
- 解析与下载
  - `src/main/tools/staticParser.ts`：HTML 解码与播放器配置解析，提升静态候选命中率。
  - `src/main/tools/manifest.ts`：清单解包与下载计划；相对路径统一以真实源域为基准。
  - `src/main/tools/humanAcceptanceFlow.ts`：验收回退与变体细节填充；统一解包与基准拼接，保证变体 URL 正确。
  - `src/main/tools/downloader.ts`：沙箱新增 `helpers.fetch` 包装。
- 管理与显示
  - `src/main/tools/algStore.ts`：算法列表按时间降序；默认入库命名改为时间戳。
- 上下文管理
  - `src/main/tools/contextTools.ts`：自适应裁剪策略，保留关键消息，按预算动态收缩窗口。

这些优化综合提升了可用性与稳定性：静态与动态路径都能产出可用清单，验收弹窗信息充分、下载路径正确，遇到失败也能通过调试闭环快速修正，整体流程最终稳定成功。

## 许可证

- 本项目使用 AGPL-3.0 许可证，详见 `LICENSE.txt`。