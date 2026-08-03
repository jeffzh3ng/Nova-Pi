# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Nova-PI 是 AI 数字员工桌面工作台：**Tauri 2 薄壳(Rust) + Node sidecar(pi 内核) + Node 层 MCP 桥接**。基于 `@earendil-works/pi-coding-agent` agent 运行时。详细架构、RPC 协议、命令清单、设计决策见 [AGENTS.md](./AGENTS.md)（权威文档，本文档只做速查）。

## 常用命令

```bash
npm install              # 根 workspace 安装（含 app、host）

npm run tauri:dev        # 开发模式（React HMR + Rust + Node sidecar）
NOVA_PI_HOST_MODE=dev npm run tauri:dev   # host 热重载模式（配合另开终端 npm run host:dev）
npm run build            # 先 build host 再 build 前端
npm run tauri:build      # 生产打包（含 sidecar + skills）

# 测试（均为 node:test + tsx，串行执行）
npm run test --workspace host    # sidecar 单元/集成测试
npm run test --workspace app     # 前端 services 测试

# 类型检查（无独立 lint；TS 错误即构建失败）
npm run typecheck --workspace host
npm run build --workspace app    # app 的 build 内含 tsc --noEmit
```

## 架构要点（三进程模型）

```
React UI (webview) ──invoke──► Rust 薄壳 ──spawn──► Node sidecar (host)
      ▲                            │                    │
      └──── Tauri events ──────────┘   stdin/stdout     │
                                    JSON-line RPC       │
                                                        ▼
                                        pi SDK + MCP 桥接（stdio / Streamable HTTP / SSE）
```

- **React 前端**（`app/src`）只通过 `hostBridge.ts` invoke Rust command 通信，事件走 `pi-event`。
- **Rust 薄壳**（`app/src-tauri/src/`）：窗口、sidecar 进程管理（`sidecar.rs`）、RPC 编排（`rpc.rs`）、SQLite 会话索引/LLM 设置/MCP 配置、大文件 HTTP（`risk_http.rs`）、技能安装（`skill_registry.rs`）。
- **Node sidecar**（`host/src`）：`main.ts` 派发 RPC 命令；`session-pool.ts` 管理 pi AgentSession 生命周期；`mcp/` 是核心——用 `@modelcontextprotocol/client` v2 连接外部 MCP 服务，经 pi inline extension 注册为 `mcp` 代理工具（服务/工具按需发现，`service/tool` 全名调用）；`digital-human.ts` 配置 9 个数字员工的 system prompt + MCP 白名单。
- **会话持久化双轨**：pi `SessionManager` 写 JSONL（完整历史）；Rust SQLite 存索引+消息快照（侧栏+重启恢复）。
- **Tauri command 名是 snake_case**（Tauri v2 不做 camelCase 转换）。

## 关键约束（违反会导致 bug）

1. **推送 GitHub 前**必须递增版本号，且版本变更包含在同一次推送中。用 `npm run sync-version -- <新版本|patch|minor|major>` 一键同步全部 7 处（版本号散布位置：根 / `app` / `host` 三个 `package.json` + 对应 `package-lock.json`、`app/src-tauri/Cargo.toml` + `Cargo.lock`、`app/src-tauri/tauri.conf.json`；脚本支持 `--dry-run` 预览，参照 `git show b1bdb73` 的 sync 方式）。
2. 专业数字员工用 `noTools: "builtin"`（禁 read/bash/edit/write，保 MCP）；**禁止 `noTools: "all"`**（会连 MCP 扩展工具一起屏蔽）。
3. 改 `src-tauri/src/**/*.rs` 后必须重启 `npm run tauri:dev`（Vite HMR 不覆盖 Rust）。
4. UI 文案**不得出现** SQLite、数据库（指内部存储）等内部术语；"数据库名称/实例"仅在分类分级业务语境可用。
5. 新技能/新员工注册走 `host/src/digital-human.ts` 与 Skill 中心启停配置，前端不做工具路由决策（LLM 自主调用）。
6. 国内网络：Cargo 走项目根 `.cargo/config.toml` 的 rsproxy 镜像；sidecar 依赖 `node`/`npx` 在 PATH 中。
7. 需要 LLM API key（Settings 面板配置，默认 DeepSeek）。
