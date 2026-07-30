# Nova-PI — AI 数字员工（pi 内核版）

## Overview

Nova-PI 是 Nova 的重构版，以 [earendil-works/pi](https://github.com/earendil-works/pi)（MIT，纯 Node.js SDK）为 agent 底座。桌面交互基于 Tauri 2 + React 19，核心能力通过外置 MCP 工具实现。**与原 Nova 项目完全独立**，不引用原项目代码。

## 架构

```
Tauri 薄壳(Rust) + Node sidecar(pi 内核) + Node 层 MCP
─────────────────────────────────────────────────────────
React UI ──invoke──► Rust ──spawn──► Node sidecar(nova-pi-host)
   ▲                   │                 │
   └─ Tauri events ────┘   stdin/stdout RPC (JSON-line)
                                     │
                          pi SDK (createAgentSession, noTools:"builtin")
                          + MCP 工具由 pi inline extension 动态注册
                          + Skills (pi ResourceLoader)
                          + Session JSONL 持久化
                                     │
                                     ▼
                          用户配置的外部 MCP 服务
```

### 关键设计

- **pi 是纯 Node SDK**（依赖 `node:fs`/`jiti`），不能跑在 webview → 用 Tauri sidecar 子进程嵌入。
- **pi 无原生 MCP 支持** → 用 `@modelcontextprotocol/client` v2 自建桥接，通过 `DefaultResourceLoader.extensionFactories` 把每个 MCP 工具注册为 pi 扩展工具，让 LLM 原生按需调用（取代原 Nova 的 `agentRuntime.ts` 路由）。客户端以 `versionNegotiation: auto` 兼容 MCP 2026 `server/discover` 与 2025 `initialize`，并兼容旧 HTTP+SSE 服务。
- **pi 内置 DeepSeek provider**（`api.deepseek.com`），与原 Nova 默认 LLM 一致。
- **Rust 退化为薄壳**：窗口、文件对话框、sidecar 进程管理、RPC 编排、SQLite 会话索引、大文件 HTTP（风评 zip/xlsx）。
- **混合传输**：风评大文件走 Rust 直连 HTTP（`/mcp`→`/api` 推导），其余走 MCP。

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Shell | Tauri 2.x（macOS/Windows，WebView2/WebKit） |
| Frontend | React 19, TypeScript 5, Vite 8 |
| Agent Core | Node.js sidecar + `@earendil-works/pi-coding-agent` |
| MCP Client | `@modelcontextprotocol/client` v2（Node 层，stdio + Streamable HTTP + 旧 SSE 回退） |
| Rust Backend | Tauri 2 + reqwest + rusqlite（薄壳：sidecar 管理、RPC、SQLite 索引、大文件 HTTP） |
| Database | SQLite `nova-pi.sqlite3`（会话索引 + token 统计 + LLM 设置） |
| Icons | lucide-react |

## Project Structure

```
Nova-PI/
├── package.json                 # 根 workspace (app, host)
├── AGENTS.md                    # 本文件
├── app/                         # Tauri + React 桌面壳
│   ├── package.json
│   ├── index.html / vite.config.ts / tsconfig.json
│   ├── src/                     # React 前端
│   │   ├── main.tsx / App.tsx
│   │   ├── types.ts
│   │   ├── config/appContent.ts # 内置数字员工展示定义（含 Nova 智能员工）
│   │   ├── components/          # UI 组件
│   │   ├── services/            # hostBridge + CRUD 封装
│   │   └── styles/              # tokens/base/app/index.css
│   └── src-tauri/               # Rust 薄壳
│       ├── Cargo.toml / tauri.conf.json / capabilities/
│       └── src/
│           ├── lib.rs           # 命令注册 + Tauri Builder
│           ├── sidecar.rs       # Node sidecar 进程管理（spawn/watchdog/孤儿防护）
│           ├── rpc.rs           # JSON-line RPC 编排 + usage 事件落库
│           ├── conversation_store.rs  # SQLite 会话索引
│           ├── llm_settings.rs  # ModelSettings CRUD + token 统计
│           ├── mcp_settings.rs  # MCP 连接配置 CRUD
│           ├── risk_http.rs     # 风评大文件上传/下载
│           ├── skill_registry.rs # 技能 zip 安装/脚本执行
│           ├── app_database.rs  # SQLite 连接帮助（WAL/busy_timeout）
│           └── files.rs         # 文件对话框/路径守卫/告警 MCP 转发
├── host/                        # Node sidecar（pi 内核）
│   ├── package.json / tsconfig.json / tsup.config.ts
│   └── src/
│       ├── main.ts              # RPC 入口派发
│       ├── rpc-protocol.ts      # 命令/响应/事件类型 + stdout 背压
│       ├── session-pool.ts      # pi AgentSession 生命周期 + usage 聚合
│       ├── model-setup.ts       # ModelRuntime 配置
│       ├── models-manager.ts    # pi models.json CRUD
│       ├── extensions-manager.ts # pi settings.json extensions CRUD
│       ├── digital-human.ts     # 9 员工 system prompt + MCP 白名单
│       ├── mcp/                 # MCP 桥接（extension/registry/client/payload）
│       └── skills/              # pi ResourceLoader 配置
└── skills/                      # 内置技能包
```

## RPC Protocol（Rust ↔ Node sidecar）

JSON-line over stdin/stdout。详见 `host/src/rpc-protocol.ts`。

- **Rust → Node（命令）**：`new_session`（含 `mcpServiceId`/`resumeMessages`）/ `dispose_session` / `prompt` / `steer` / `abort` / `set_model` / `test_model` / `get_state` / `configure_mcp` / `list_mcp_tools` / `test_mcp` / `mcp_call` / `list_skills` / `resolve_skill` / `reload_skills` / `models_*`（10 个）/ `extensions_*`（6 个）/ `shutdown`
- **Node → Rust（响应+事件）**：`response{id}` 同步响应；`event` 异步事件流（`message_start/update/end`/`tool_execution_start/update/end`/`agent_start/end`/`usage`/`error`），Rust 以 `emit("pi-event")` 透传 RpcEvent 本体给前端；`usage` 事件由 Rust 在 rpc.rs 拦截写入 token_usage 表。
- 注：风评（`risk_*`）命令已移除，风评流程完全走 `mcp_call`（pi 自主调用 data-security-risk-assessment-mcp 工具），进度由前端 3s 轮询。

## Main Tauri Commands（Rust 薄壳）

| Command | Module | Purpose |
|---|---|---|
| `start_sidecar` | sidecar | 启动 Node sidecar（`stop_sidecar` 是 Rust 内部函数，窗口销毁时自动调用，未注册为 command）|
| `send_rpc` | rpc | 前端 → sidecar 命令转发（带 5min 默认超时） |
| `test_mcp_connection` / `list_mcp_tools` | lib → sidecar | MCP 服务握手测试/工具枚举 |
| `list_conversations` / `load_conversation` / `save_conversation_snapshot` | conversation_store | 会话 CRUD |
| `archive_conversation` / `restore_conversation` / `delete_conversation` / `rename_conversation` | conversation_store | 归档/删除/重命名 |
| `list_archived_conversations` | conversation_store | 归档列表 |
| `generate_conversation_title` | conversation_store | LLM 标题生成 |
| `get_model_settings` / `save_model_settings` / `reset_model_settings` | llm_settings | LLM 配置 CRUD |
| `test_model_connection` | llm_settings | 模型连通性测试 |
| `list_token_usage` | llm_settings | token 统计（pi 的真实用量由 rpc.rs 拦截 usage 事件写入）|
| `upload_risk_assessment_material` / `download_risk_assessment_matrix_template` / `download_risk_assessment_result` | risk_http | 风评材料、空白矩阵和结果文件 |
| `open_file_path` / `show_file_in_folder` / `save_file_as` | files | 文件操作 |
| `write_temp_text_file` / `write_uploaded_blob` | files | 临时文件 |
| `parse_pcap_file_cmd` / `extract_alert_image_text_cmd` | files | PCAP/OCR 解析 |
| `list_mcp_connection_settings` / `save_mcp_connection_settings` / `delete_mcp_connection_settings` | mcp_settings | MCP 配置 CRUD |
| `list_skills` / `list_skill_catalog` / `get_skill` / `set_skill_enabled` | skill_registry | 技能管理 |
| `pick_and_install_skill` / `delete_user_skill` / `open_user_skill_dir` / `execute_skill_plan` | skill_registry | 技能安装/执行 |

注：`abort_task` / `reset_abort_flag` 命令已删除（pi agent loop 中止走 sidecar 的 `abort` RPC 命令）。
模型管理（`models_*`）和扩展管理（`extensions_*`）走 sidecar RPC，不经 Rust command。

**重要**：命令名为 snake_case（匹配 Rust 函数名）。Tauri v2 不做 camelCase 转换。

## 数字员工

| id | name | mcpService |
|---|---|---|
| `data-security-risk-assessment` | 数安风评数字员工 | `data-security-risk-assessment-mcp` |
| `alert-analysis` | 威胁研判数字员工 | `alert-analysis-mcp` |
| `nova-computer-agent` | Nova 智能员工 | 无（pi 原生工具，设置授权后启用） |

每个员工在 `host/src/digital-human.ts` 配置：system prompt + 允许的 MCP 服务集 + 内置工具。

## Key Design Decisions & Caveats

1. **专业员工用 `noTools: "builtin"` 起步**：只禁用 pi 内置的 read/bash/edit/write；MCP 作为 inline extension 注入并保持可用。禁止使用 `noTools: "all"`，它会同时屏蔽 MCP 扩展工具。唯一例外是 `nova-computer-agent`：它不挂 MCP，通过设置中的逐项授权生成显式 `tools` allowlist，可启用 read/bash/edit/write、Nova 状态管理工具及 Skill 工具；其他员工不得继承这些权限。Skill 工具还会按 Skill 中心启停状态二次过滤，未勾选“使用 Skill”时不会注册到 Nova 会话。
2. **路由简化**：原 Nova 的 `agentRuntime.ts` 三分支路由（skill/alert/workbench）被 pi 的 LLM 工具调用决策取代。system prompt 承载角色，扩展工具描述能力，LLM 自行决定。
3. **会话持久化双轨**：pi 的 `SessionManager` 写 JSONL（完整历史，host 内部）；Rust SQLite 存索引+消息快照（侧栏列表+重启恢复）。
4. **title 保护**：只在 INSERT 时设 title，UPDATE 不覆盖。`title_source` 三态（pending/manual/auto）。手动重命名设 `manual`，LLM 生成设 `auto`，条件 UPDATE（`WHERE title_source='pending' AND archived=0`）防竞态。
5. **归档独立**：`archived` 列隔离，归档会话不自动保存、不出现在历史、有独立列表。ReadOnly 守卫。点首页/任务/归档清空当前会话视图。
6. **风评轮询在前端**：风评进度由前端 `pollRiskAssessment` 每 3s 调 MCP `get_task_status`（网络失败退避 3→15s，poll token 取消）。`risk_job_update` 事件类型保留供未来 host 推送，但当前 host 不 emit。
7. **Rust rebuild required**：任何 `src-tauri/src/**/*.rs` 改动需重启 `npm run tauri:dev`。Vite 热重载不覆盖 Rust。
8. **DeepSeek 兼容**：pi 内置 DeepSeek provider，`thinking:disabled` 由 pi 处理。
9. **sidecar watchdog**：Node sidecar 意外退出（stdout EOF 且非主动 stop）由 Rust 自动重启并 emit `pi-sidecar-restarted`；重启失败 emit `pi-sidecar-fatal`。
10. **abort 走 sidecar**：pi agent loop 的中止通过 sidecar 的 `abort` RPC 命令（pi 的 `session.abort()`）。Rust 无中断标志，耗时 Rust 操作（风评上传等）目前不可中断。
11. **token 用量落库**：pi 的真实 token 用量由 host 在 agent_end 聚合后 emit `usage` 事件，Rust 在 rpc.rs 拦截写入 token_usage 表（`call_llm` 路径在新架构下几乎不被触达）。
12. **历史上下文**：pi 无"静默灌入 assistant 回复"的公开 API，切换会话继续对话时，历史作为 system prompt 附录注入（`session-pool.injectHistory`，最多 20 轮）。
13. **stdout 背压**：host 的所有 stdout 写入经串行化 Promise 队列，`process.stdout.write` 返回 false 时等 `drain`，避免流式事件高吞吐下数据截断。
14. **Skill 单一目录与运行权限**：用户 Skill 安装到 `<app_data>/.pi/agent/skills`（旧 `<app_data>/skills` 自动迁移），与 pi ResourceLoader 读取目录一致。标准 ZIP 安装使用受限解压、原子替换和路径穿越防护；Skill 环境变量由 Nova 调用 `skill_configure_environment` 配置，macOS 下使用钥匙串主密钥加密保存，工具事件不回显敏感值。

## UI Text Guidelines

### NEVER expose internal technical terms to users
- ❌ SQLite、数据库（指内部存储）
- ✅ 本地存储、会话记录、持久化保存

### Business terms that ARE acceptable
- 数据库名称、数据库实例（分类分级场景，指客户数据库）

## Build & Run

### GitHub 同步规则

- 每次向 GitHub 推送代码前，必须先更新 `app/src-tauri/tauri.conf.json` 中的应用版本号；默认按语义化版本递增，并确保版本号变更包含在同一次推送中。

```bash
# 安装依赖（根目录）
npm install

# 开发模式（前端热重载 + Rust + Node sidecar）
# 默认：sidecar 跑打包后的 host/dist/main.js（beforeDevCommand 会先 build host）
npm run tauri:dev

# 开发模式 + host 热重载（tsx watch，无需每次改 host 都 rebuild）
NOVA_PI_HOST_MODE=dev npm run tauri:dev
# （另开终端）npm run host:dev   # tsx watch src/main.ts

# 生产构建
npm run build        # 先 build host，再 build 前端
npm run tauri:build  # Tauri 打包（含 sidecar + skills）
```

### Prerequisites
- Node.js 22.19+（pi 要求；sidecar 通过 `node`/`npx` 启动，需在 PATH 中）
- Rust stable toolchain
- macOS / Windows（WebView2）
- Port 1420 must be free（Vite dev server）
- LLM API key（Settings 面板配置）

### Cargo 镜像（国内网络）
项目根 `.cargo/config.toml` 已配置 rsproxy 镜像加速首次构建。如遇 crates.io 下载超时，
确认该文件生效，或换用其他国内镜像（tuna/ustc）。

## 与原 Nova 的差异

| 维度 | Nova | Nova-PI |
|---|---|---|
| Agent 内核 | Rust 手写编排（agentRuntime/workbenchAgent） | pi SDK（createAgentSession + agent loop） |
| MCP 客户端 | Rust（external_mcp_client.rs） | Node（@modelcontextprotocol/client v2） |
| 工具调用决策 | 前端路由 + LLM 决策 | pi LLM 原生 tool calling |
| LLM 网关 | Rust（llm.rs call_llm） | pi（pi-ai ModelRuntime） |
| 会话存储 | Rust SQLite（消息快照） | pi JSONL + Rust SQLite 索引 |
| 技能 | Rust（skill_registry.rs）+ 前端 skillRuntime | pi ResourceLoader + customTool |
| 后端语言 | Rust（重） | Rust 薄壳 + Node（重） |
