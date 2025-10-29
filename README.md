# AI Video Crawler

一个基于 Electron + React 的视频抓取与算法制作演示项目。集成豆包（Doubao）API，支持“总协调员 + 子智能体（静态解析员、网络抓包员、历史压缩员、向量检索）”的协同流程，提供算法代码产出、下载合并、RAG 检索与缓存清理等能力。
UI 组件使用的是Radix + Tailwind的本地组件集（位于 `src/components/ui/*`）。

## 架构概览

- 渲染进程（UI）：`React + Vite`
  - 入口：`src/renderer/main.tsx`
  - 主界面：`src/renderer/App.tsx`
  - API 管理页：`src/renderer/ApiManagePlaceholder.tsx`（已实现为五卡片配置与保存）
  - UI 组件：`src/components/ui/*`（按钮、输入框、对话框等）

- 主进程（Electron）：`src/main/*`
  - LLM 客户端：`doubaoClient.ts`（chat 与 embeddings；从 `.env` 读取 `ARK_API_KEY`、`ARK_MODEL_ID`、`ARK_EMBED_MODEL_ID`）
  - 协调员：
    - 非 LLM 协调员：`coordinator.ts`（静态候选提取、下载）
    - LLM 协调员：`coordinatorLLM.ts`（按系统提示驱动工具：静态解析、动态抓包、清单解析、下载验收、提交算法代码）
  - 子智能体提示词：`agentsPrompts.ts`、协调员系统提示词：`coordinatorPrompt.ts`
  - 工具集：`src/main/tools/*`（`agentsMd` 日志、`manifest` 清单解析、`downloader` 下载合并与 `ffmpeg` 复用、`networkCapture` 抓包占位、`rag` 索引与检索、`codeMaintainer` 算法写入与提交、`historyCompressor` 压缩、`htmlPreprocessor` 预处理、`cacheCleanup` 缓存清理等）
  - IPC 接口：`main.ts`（算法管理、API 管理 `.env` 同步、协调员与子流程状态、缓存清理触发）

- 运行与数据文件路径：
  - 日志类文件（默认写入项目根目录 `logs/`，可用 `AGENTS_LOG_DIR` 覆盖）：`agents.md`（提示用日志）、`agents_raw.md`（原始完整日志）、`algorithm.md`（聚合代码）、`algorithm_static.md`、`algorithm_dynamic.md`、`agents_rag_index.json`（RAG 索引）。
  - 算法代码（统一存储在项目根目录 `algorithms/`）：支持 `.js`/`.ts`/`.md`；目录为空时会自动生成占位示例 `xvideos.js`；当算法以 `.md` 存储时会提取最后一个代码块作为运行代码。旧版 `algorithms.json` 不再作为主存储，下载器保留兼容回退读取。
  - 缓存清理：应用退出或开启第二轮制作前执行，重置提示与算法过程文件、清除 RAG 索引，并保留 `agents_raw.md` 归档（添加时间戳重命名）。

## 功能模块
 
 - 算法管理：基于 `algorithms/` 文件夹列出/查看/删除算法；支持 `.md` 代码块提取。
  - 算法制作（LLM）：总协调员按系统提示驱动子智能体，产出静态或动态算法代码并提交主存储。
- 下载与合并：根据清单或直接地址并发下载，自动探测并复用 `ffmpeg` 生成 MP4。
- API 管理：五卡片维护 `api_key` 与 `model_id`，保存后同步到 `.env`（不存在自动创建）。
- 历史裁剪与压缩：当上下文超预算时进行裁剪/压缩，并写入 `agents.md` 标记。
- RAG 检索：面向 `agents_raw.md` 的向量检索索引，便于找回裁剪历史的细节。
- 缓存清理：在第二轮制作前与应用退出前执行，重置提示与算法过程文件、清除 RAG 索引、归档原始日志。

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
  - 打开“API 管理”页，五张卡片分别对应：总协调员、静态解析员、网络抓包员、历史压缩员、向量处理。
  - 默认模型：生成式四项使用 `doubao-seed-1-6-251015`；向量处理使用 `doubao-embedding-large`。
  - 点击“保存并同步到 .env”：会写入或创建 `.env`，并同步到当前进程环境。
  - `.env` 键映射：
    - `doubao`：`ARK_API_KEY`、`ARK_MODEL_ID`
    - `rag_embedding`（向量）：`ARK_EMBED_MODEL_ID`
    - 其他条目同时写入各自的大写键，如 `STATIC_PARSER_API_KEY`、`STATIC_PARSER_MODEL_ID`、`NETWORK_CAPTURE_MODEL_ID` 等（预留扩展）。

- 算法制作（LLM）
  - 在“算法制作”页填写算法名、示例网址、源代码/HTML、说明后“提交到智能体”。
  - 协调员会驱动工具（静态/动态/清单/下载/人类验证等），最终提交静态或动态算法代码到 `algorithms/` 文件夹（支持 `.js`/`.ts`/`.md`）。
  - 命名冲突防护：若算法名与现有文件重名，前端会提示并阻止提交；主进程也会进行预检并返回错误；最终保存阶段有强保护，绝不覆盖已有算法。
  - 第一轮完成（状态 `done` 或 `error`）后界面自动重置；开始第二轮前会触发缓存清理（重置 MD、清除 RAG 索引、归档 `agents_raw.md`）。

- 下载与合并
  - 在主界面选择算法并输入目标地址，点击开始。
  - 程序会自动并发下载分片并合并；存在 `ffmpeg` 时直接复用生成 MP4。
  - 成品保存在 `downloads/`（默认）或你选择的目录。

## 环境变量说明

- 必需：`ARK_API_KEY`（豆包 API Key）
- 生成式模型：`ARK_MODEL_ID`（如 `doubao-seed-1-6-251015`）
- 向量模型：`ARK_EMBED_MODEL_ID`（如 `doubao-embedding-large`）
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

## 故障排查

- Electron 白屏或无法加载：确认 `http://localhost:5173/` 正常；避免端口被占用。
- LLM 报错“Missing ARK_API_KEY”：在“API 管理”页填写并保存，或手动在 `.env` 设置。
- Embeddings 使用了错误模型：确认 `.env` 的 `ARK_EMBED_MODEL_ID` 为 `doubao-embedding-large` 或你的目标模型。
- 下载后未生成 MP4：确认 `ffmpeg` 存在；程序会在不支持 `ffmpeg` 时退化为 TS 拼接（质量可能下降）。
 - 算法名重名：若提交时报“算法名已存在”，请在“算法制作”页更换唯一名称，或在 `algorithms/` 文件夹中手动清理/重命名冲突文件。

## 许可证

- 本项目使用 AGPL-3.0 许可证，详见 `LICENSE.txt`。