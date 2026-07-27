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

/** MCP 握手超时（毫秒）。子进程卡死或 HTTP 慢时避免永久阻塞（registry 串行连接会让后续全部饿死）。 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** 连接一个 MCP 服务，完成 initialize + tools/list 握手（带超时）。 */
export async function connectMcpServer(config: McpServerConfig): Promise<ConnectedMcpServer> {
  // 整个握手包一层超时：子进程卡死或 HTTP 慢时避免永久阻塞。
  const handshakePromise = connectMcpServerNoTimeout(config);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`MCP 服务握手超时（${HANDSHAKE_TIMEOUT_MS / 1000}s）：${config.serviceId}`)),
      HANDSHAKE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([handshakePromise, timeoutPromise]);
  } catch (error) {
    // 握手失败：尽力清理半连接的 client，避免子进程残留。
    try {
      const result = await handshakePromise.catch(() => null);
      if (result) await disconnectMcpServer(result);
    } catch {
      // ignore
    }
    throw error;
  }
}

async function connectMcpServerNoTimeout(config: McpServerConfig): Promise<ConnectedMcpServer> {
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
  // 安全：不继承全部 process.env。Node sidecar 持有所有 LLM API key，
  // 若把 ...process.env 透传给 MCP 子进程（含第三方 Python server），密钥会泄漏。
  // 仅传显式声明的 env + 必要的 PATH/系统变量，让子进程能找到可执行文件。
  const safeEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(env ?? {}),
  };
  const transport = new StdioClientTransport({ command, args, env: safeEnv });
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

/** 带超时地调用一个 MCP 工具。超时后关闭连接（牺牲连接换取取消，避免子进程持续占用）。 */
export async function callMcpToolWithTimeout(
  server: ConnectedMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  timeoutSecs?: number,
): Promise<unknown> {
  const callPromise = server.client.callTool({ name: toolName, arguments: args });
  if (!timeoutSecs) return await callPromise;
  const timeoutMs = timeoutSecs * 1000;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP 工具调用超时（${timeoutSecs}s）：${toolName}`)), timeoutMs);
  });
  try {
    return await Promise.race([callPromise, timeoutPromise]);
  } catch (error) {
    // MCP SDK 的 callTool 不支持 abort signal，超时后底层调用仍在跑。
    // 关闭连接以终止子进程/HTTP，避免长任务（如分类分级 4h）持续烧资源。
    // 下次调用时 registry 会按需重连。
    await disconnectMcpServer(server).catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 关闭连接（stdio 会终止子进程）。 */
export async function disconnectMcpServer(server: ConnectedMcpServer): Promise<void> {
  try {
    await server.client.close();
  } catch {
    // 关闭失败忽略
  }
}
