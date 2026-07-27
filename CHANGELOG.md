# 变更记录

本项目（Nova-PI）是基于 [earendil-works/pi](https://github.com/earendil-works/pi) 重新架构的迪普科技 AI 数字员工桌面工作台，与原 [Nova](https://github.com/jeffzh3ng/Nova)（Rust 全栈）完全独立。

所有里程碑按时间倒序排列。

---

## [0.2.0] - 2026-07-27：pi 原生模型管理 + 扩展管理

### 新增

#### 模型管理（按 pi Providers/Models 配置改写）
抛弃原 Nova 的 Rust `ModelSettings` 单例表，改用 pi 原生的 `~/.pi/agent/models.json` + `ModelRuntime` 作为单一事实源。配置直接写入 pi 读取的文件，pi 每次 `/model` 或启动时自动重载，无需重启 sidecar。

- **host/src/models-manager.ts**：直接读写 pi `models.json`（支持 JSON 注释剥离、原子写、环境变量 `$ENV`/`${ENV}` 解析、API key 脱敏），通过 `ModelRuntime.setRuntimeApiKey`/`hasConfiguredAuth` 让变更即时生效
- **app/src/services/modelsService.ts**：前端服务封装
- **重写 app/src/components/SettingsPanel.tsx** → 卡片式模型管理面板：
  - Provider 卡片网格（ID / Base URL / API 类型 / API Key 脱敏 / 模型数 / 可用性）
  - 新增/编辑供应商对话框（6 种 API 类型：openai-completions / openai-responses / anthropic-messages / google-generative-ai / bedrock-converse-stream / mistral）
  - API Key 快速更新（卡片内联，脱敏展示 `sk-t****t123`）
  - 默认模型下拉（含 pi 内置全部模型目录 + 自定义，标注「缺 API Key」）
- **App.tsx**：模型名显示改为读 pi 默认模型（`models_get_default` RPC），不再读 Rust `ModelSettings` 表

**新增 RPC**：`models_list_providers` / `models_list_all` / `models_get_default` / `models_set_default` / `models_upsert_provider` / `models_remove_provider` / `models_set_api_key` / `models_upsert_model` / `models_remove_model`

#### Pi 扩展管理（卡片式，兼容 pi 扩展系统）
新增侧栏「Pi 扩展」导航项（Blocks 图标），卡片式 UI 管理 pi 扩展，完全兼容 [pi 扩展规范](https://pi.dev/docs/latest/extensions)。

- **host/src/extensions-manager.ts**：读写 pi `settings.json` 的 `extensions` 数组，扫描全局扩展目录（`~/.pi/agent/extensions/`），JSDoc 描述提取，模板创建
- **app/src/services/extensionsService.ts**：前端服务封装
- **app/src/components/ExtensionsPanel.tsx**：卡片式扩展管理面板（仿 McpSquarePanel 风格）：
  - 扩展卡片网格（名称 / JSDoc 描述 / 来源 settings.json 或全局目录 / 路径 / 启用状态）
  - 添加本地 `.ts` 文件路径（写入 `settings.json` extensions 数组）
  - 新建扩展（带 TypeScript 模板，含 `registerTool` / `registerCommand` 示例）
  - 启用/禁用、移除（保留磁盘文件）、查看源码
- **app/src/types.ts**：`SidebarNavId` 新增 `"extensions"`
- **app/src/components/Sidebar.tsx**：新增「Pi 扩展」导航按钮（Blocks 图标，在数字员工管理与用量之间）
- **App.tsx**：新增 `extensions` 路由

**新增 RPC**：`extensions_list` / `extensions_add` / `extensions_remove` / `extensions_set_enabled` / `extensions_read_content` / `extensions_create`

### 修复
- `tauri.conf.json` 的 `beforeDevCommand`/`beforeBuildCommand` 改为 `cd .. && npm run build --workspace host && ...`（原命令在 `app/` 子目录执行，找不到根 workspace 的 host）
- `.gitignore` 补充 `.cacert-merged.pem` / `*.sqlite3` / `.pi/` / `auth.json`

---

## [0.1.0] - 2026-07-27：基于 pi 重新架构（全功能迁移）

以 [`earendil-works/pi`](https://github.com/earendil-works/pi)（MIT，纯 Node.js SDK）为 agent 底座，完整复刻原 Nova 全部功能。**与原 Nova 项目完全独立，不引用原项目代码。**

### 架构

```
React UI ──invoke──► Rust 薄壳 ──spawn──► Node sidecar (nova-pi-host)
   ▲                   │                       │
   └─ Tauri events ────┘   stdin/stdout RPC    pi SDK (createAgentSession, noTools:"all")
                                                 + MCP 工具动态注册为 pi customTool
                                                 + Skills (pi ResourceLoader)
                                                 + Session JSONL
                                                          │
                                                          ▼
                                               外部 MCP 服务（services/）
```

### 核心设计决策（基于对 pi 源码的调研）
- **pi 是纯 Node SDK**（依赖 `node:fs` / `jiti`），不能跑在 webview → 用 Tauri sidecar 子进程嵌入
- **pi 无原生 MCP 支持** → 用 `@modelcontextprotocol/sdk` JS 自建桥接，每个 MCP 工具动态注册为 pi 的 `customTool`，让 LLM 原生按需调用（取代原 Nova 的 `agentRuntime` 路由）
- **pi 内置 DeepSeek provider**（`api.deepseek.com`），与原 Nova 默认 LLM 一致
- **pi 每条 AssistantMessage 带 usage** → `agent_end` 聚合做 token 统计
- **pi 自带 session JSONL / context compaction / skills(SKILL.md) / 流式事件**
- **Rust 退化为薄壳**：窗口、文件对话框、sidecar 进程管理、RPC 编排、SQLite 会话索引、大文件 HTTP（风评 zip/xlsx）
- **保留原 Nova 混合传输**：风评大文件走 Rust 直连 HTTP（`/mcp`→`/api` 推导），其余走 MCP

### 目录结构
```
Nova-PI/
├── package.json (workspaces: app, host)
├── app/                    # Tauri 2 + React 19 桌面壳
│   ├── src/                # React 前端（事件驱动）
│   │   ├── components/     # 14 个组件（Sidebar/Hero/TaskConversation/AlertAnalysisCard/...）
│   │   ├── services/       # hostBridge + CRUD 封装
│   │   ├── config/appContent.ts (9 数字员工)
│   │   └── styles/         # tokens/base/app/index.css
│   └── src-tauri/src/      # Rust 薄壳（sidecar/rpc/conversation_store/llm_settings/files/...）
├── host/                   # Node sidecar (pi 内核)
│   └── src/
│       ├── main.ts (RPC 派发) / rpc-protocol.ts / session-pool.ts
│       ├── model-setup.ts / digital-human.ts (9 员工 system prompt)
│       ├── mcp/ (registry/client/schema-convert/payload)
│       └── skills/loader.ts
├── services/               # 外部 MCP 服务（Python FastMCP，从 Nova 复制）
└── skills/                 # 内置技能包
```

### 全功能迁移清单（一次性，无裁剪）
- ✅ **9 个数字员工**：host/digital-human.ts 为每员工配 systemPrompt + allowedMcpServices，`new_session` 按 humanId 建 pi session
- ✅ **威胁研判**：复制 alert-analysis-mcp；保留 600s 超时 + 工具白名单；AlertAnalysisCard 原样迁移（severity 配色/findings/actions/notes/导出报告）；trivial 判定保留；PCAP/OCR 走 Rust→注入 prompt；路由简化为 pi LLM 决策
- ✅ **数安风评**：混合传输（MCP 工具走 host Node 客户端，大文件走 Rust risk_http.rs 照搬）；轮询上移到 host（3s，退避 3→15s，poll token 取消）；job 卡片 + 持久化恢复 + `评估：` 正则触发全保留
- ✅ **技能系统**：pi ResourceLoader 加载三源（user/project/resource）；指令型注入 system prompt；脚本型 customTool 调 Rust `execute_skill_plan`（gongwen 单脚本限制照搬）；SkillCenterPanel + 命中测试 + zip 安装校验全保留
- ✅ **会话持久化**：SQLite schema 照搬（含所有 `*_json` 列）；双轨（pi JSONL + Rust SQLite 索引）；title 条件 UPDATE（`title_source` 三态）+ 3 轮/45s debounce；归档独立 + ReadOnly + 导航清除 + 重命名/删除全保留；auto-save fingerprint + per-conv 串行队列保留
- ✅ **token 统计**：pi `agent_end` 事件聚合 `event.messages` 的 `assistant.usage`，通过 `usage` 事件上报，Rust 写 `token_usage` 表；TokenUsagePanel 30s 轮询 + 7 天趋势原样
- ✅ **MCP 广场**：McpSquarePanel 原样迁移，配置/连接/工具列表/启用禁用/自定义员工全保留
- ✅ **UI 外壳**：Sidebar(7 导航 + 右键 + 拖拽宽) / Hero / DigitalHumanPicker / PromptComposer / ConfirmModal / ErrorBoundary 原样；styles 全量复制；localStorage keys + window 事件总线保留
- ✅ **安全守卫全保留**：MCP 命令 blocklist、HTTP URL scheme 校验、文件路径守卫、扩展名白名单、size cap、zip 校验（symlink/zip-slip/累计 size）、gongwen 单脚本

### RPC 协议（Rust ↔ Node，JSON-line over stdin/stdout）
- **Rust → Node**：`new_session` / `dispose_session` / `prompt` / `steer` / `abort` / `set_model` / `test_model` / `configure_mcp` / `list_mcp_tools` / `test_mcp` / `mcp_call` / `list_skills` / `resolve_skill` / `risk_*` / `shutdown`
- **Node → Rust**：`response{id}` 同步响应 + `event` 异步事件流（`message_update` / `tool_execution_*` / `agent_end` / `usage` / `risk_job_update` / `session_saved` / `error`），Rust 以 `emit("pi-event")` 转发前端

### 关键文件
| 文件 | 职责 |
|---|---|
| `host/src/main.ts` | sidecar 入口，stdin 行读取→命令派发→stdout 行写入 |
| `host/src/session-pool.ts` | pi `AgentSession` 生命周期 + 事件转发为 RPC event |
| `host/src/mcp/registry.ts` | MCP 服务连接 + 每个工具注册为 pi customTool（核心创新） |
| `host/src/digital-human.ts` | 9 员工 system prompt + 允许的 MCP 服务集 |
| `app/src/services/hostBridge.ts` | 前端↔Rust↔Node 统一桥接（`sendRpc` + `subscribePiEvents`） |
| `app/src/App.tsx` | 事件驱动对话（pi event → ChatMessage 增量） |
| `app/src-tauri/src/sidecar.rs` | Node sidecar 进程管理（spawn/stdin/stdout/stderr） |
| `app/src-tauri/src/rpc.rs` | JSON-line 帧解析 + 请求响应匹配 + 事件 emit |

### 与原 Nova 的差异
| 维度 | Nova | Nova-PI |
|---|---|---|
| Agent 内核 | Rust 手写编排（agentRuntime/workbenchAgent） | pi SDK（createAgentSession + agent loop） |
| MCP 客户端 | Rust（external_mcp_client.rs） | Node（@modelcontextprotocol/sdk） |
| 工具调用决策 | 前端路由 + LLM 决策 | pi LLM 原生 tool calling |
| LLM 网关 | Rust（llm.rs call_llm） | pi（pi-ai ModelRuntime） |
| 会话存储 | Rust SQLite（消息快照） | pi JSONL + Rust SQLite 索引 |
| 技能 | Rust（skill_registry.rs）+ 前端 skillRuntime | pi ResourceLoader + customTool |
| 后端语言 | Rust（重） | Rust 薄壳 + Node（重） |

---

## 技术栈

| Layer | Technology |
|---|---|
| Desktop Shell | Tauri 2.x（macOS/Windows，WebView2/WebKit） |
| Frontend | React 19, TypeScript 5, Vite 8 |
| Agent Core | Node.js sidecar + `@earendil-works/pi-coding-agent` |
| MCP Client | `@modelcontextprotocol/sdk`（Node 层，stdio + Streamable HTTP） |
| Rust Backend | Tauri 2 + reqwest + rusqlite（薄壳） |
| Database | SQLite `nova.sqlite3`（会话索引 + token 统计） |
| Icons | lucide-react |
