/**
 * MCP 客户端封装：基于 @modelcontextprotocol/sdk 连接外部 MCP 服务。
 *
 * 支持 stdio（spawn 子进程）和 Streamable HTTP 两种传输，与原 Nova 的
 * external_mcp_client.rs 行为对齐（initialize → tools/list → tools/call）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../rpc-protocol.js";

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

export type ConnectedMcpServer = {
  config: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
};

/** 解析 stdio 启动命令：script 模式直接跑脚本路径，module 模式 python -m <模块>。 */
function resolveStdioCommand(config: McpServerConfig): { command: string; args: string[]; env?: Record<string, string> } {
  if (config.launchMode === "module") {
    // module 模式：commandPath = 项目根目录，commandArgs = 模块名
    const moduleName = config.commandArgs.trim() || "server";
    return {
      command: process.platform === "win32" ? "python" : "python3",
      args: ["-m", moduleName],
      env: config.env,
    };
  }
  // script 模式：commandPath = server.py 路径，commandArgs = 额外参数
  const scriptPath = config.commandPath.trim();
  const extraArgs = config.commandArgs
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    command: scriptPath,
    args: extraArgs,
    env: config.env,
  };
}

/** 阻塞 shell 作为 MCP 命令（防 SSRF/提权），与原 Nova is_blocked_mcp_program 对齐。 */
const BLOCKED_PROGRAMS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "bash", "sh", "zsh", "ksh", "csh", "tcsh"]);
function isBlockedProgram(command: string): boolean {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? command.toLowerCase();
  return BLOCKED_PROGRAMS.has(base);
}

/** 校验 HTTP URL scheme（防 SSRF）。 */
function validateHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MCP HTTP 地址格式无效。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP HTTP 地址必须使用 http 或 https 协议。");
  }
  return parsed;
}

/** 连接一个 MCP 服务，完成 initialize + tools/list 握手。 */
export async function connectMcpServer(config: McpServerConfig): Promise<ConnectedMcpServer> {
  if (config.transport === "http") {
    const url = validateHttpUrl(config.url);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client(
      { name: "nova-pi-host", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const toolsList = await client.listTools();
    const tools: McpToolInfo[] = (toolsList.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
    return { config, client, tools };
  }

  // stdio
  const { command, args, env } = resolveStdioCommand(config);
  if (isBlockedProgram(command)) {
    throw new Error(`不允许使用 ${command} 作为 MCP 启动命令。`);
  }
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...(env ?? {}) } as Record<string, string> });
  const client = new Client(
    { name: "nova-pi-host", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const toolsList = await client.listTools();
  const tools: McpToolInfo[] = (toolsList.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
  }));
  return { config, client, tools };
}

/** 带超时地调用一个 MCP 工具。 */
export async function callMcpToolWithTimeout(
  server: ConnectedMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  timeoutSecs?: number,
): Promise<unknown> {
  const timeoutMs = timeoutSecs ? timeoutSecs * 1000 : undefined;
  const callPromise = server.client.callTool({ name: toolName, arguments: args });
  if (!timeoutMs) return await callPromise;
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`MCP 工具调用超时（${timeoutSecs}s）：${toolName}`)), timeoutMs);
  });
  return await Promise.race([callPromise, timeoutPromise]);
}

/** 关闭连接（stdio 会终止子进程）。 */
export async function disconnectMcpServer(server: ConnectedMcpServer): Promise<void> {
  try {
    await server.client.close();
  } catch {
    // 关闭失败忽略
  }
}
