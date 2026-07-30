# Nova-PI

Nova —— AI 数字员工桌面工作台，基于 [pi](https://github.com/earendil-works/pi) agent 底座。

## 架构

Tauri 2 薄壳 + Node sidecar（pi 内核）+ Node 层 MCP 桥接。

- **pi**（`@earendil-works/pi-coding-agent`）作为 agent 运行时，以 sidecar 子进程嵌入。
- **MCP 工具** 通过 `@modelcontextprotocol/client` v2 在 Node 层连接；自动协商 MCP 2026/2025 协议，支持 stdio、Streamable HTTP 与旧 SSE 回退，并由 pi inline extension 动态注册供 LLM 原生调用。
- **Rust 薄壳** 负责窗口、文件对话框、sidecar 管理、RPC 编排、SQLite 会话索引、大文件 HTTP。

详见 [AGENTS.md](./AGENTS.md)。

## 开发

```bash
npm install
npm run tauri:dev
```

要求：Node.js 22.19+、Rust stable、macOS 或 Windows。
