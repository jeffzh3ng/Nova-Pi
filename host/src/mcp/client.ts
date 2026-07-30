/**
 * MCP transport layer shared by pi extensions and imperative RPC calls.
 *
 * The implementation follows the official MCP TypeScript SDK v2 compatibility
 * model: negotiate the 2026 protocol automatically, fall back to the 2025
 * initialize handshake, and retain legacy HTTP+SSE as a transport fallback.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ProtocolEra,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "../rpc-protocol.js";

export type McpToolInfo = Tool;

export type ConnectedMcpServer = {
  config: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
  transportKind: "stdio" | "streamable-http" | "sse";
  protocolEra: ProtocolEra;
  protocolVersion?: string;
  onToolsChanged?: (tools: McpToolInfo[]) => void;
};

export type StdioCommandSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

const HANDSHAKE_TIMEOUT_MS = 30_000;
const MODERN_PROTOCOL_PROBE_TIMEOUT_MS = 10_000;
const BLOCKED_PROGRAMS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "sh",
  "zsh",
  "ksh",
  "csh",
  "tcsh",
]);

/** Parse a settings text field into argv without invoking a shell. */
export function splitCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && input[index + 1] === quote) {
        current += quote;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error("MCP 启动参数中的引号未闭合。");
  if (current) args.push(current);
  return args;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isDirectory(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function existingPythonCandidates(projectDir: string): Array<{ command: string; prefixArgs: string[] }> {
  const localCandidates = process.platform === "win32"
    ? [
        path.join(projectDir, ".venv", "Scripts", "python.exe"),
        path.join(projectDir, "venv", "Scripts", "python.exe"),
      ]
    : [
        path.join(projectDir, ".venv", "bin", "python"),
        path.join(projectDir, "venv", "bin", "python"),
      ];
  const candidates = localCandidates
    .filter((candidate) => existsSync(candidate))
    .map((command) => ({ command, prefixArgs: [] as string[] }));

  if (process.platform === "win32") {
    candidates.push(
      { command: "py.exe", prefixArgs: ["-3"] },
      { command: "python.exe", prefixArgs: [] },
      { command: "python", prefixArgs: [] },
    );
  } else {
    candidates.push(
      { command: "python3", prefixArgs: [] },
      { command: "python", prefixArgs: [] },
    );
  }
  return candidates;
}

function safeChildEnvironment(overrides?: Record<string, string>, pythonPath?: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(overrides ?? {}),
  };
  if (pythonPath) {
    const previous = env.PYTHONPATH?.trim();
    env.PYTHONPATH = previous ? `${pythonPath}${path.delimiter}${previous}` : pythonPath;
  }
  return env;
}

/**
 * Resolve legacy Nova settings into shell-free stdio spawn candidates.
 * Python scripts/modules prefer the service-local virtual environment, then
 * fall back to the platform Python launchers.
 */
export function resolveStdioCommandSpecs(config: McpServerConfig): StdioCommandSpec[] {
  const commandPath = stripOuterQuotes(config.commandPath);
  const configuredArgs = splitCommandArgs(config.commandArgs.trim());

  if (config.launchMode === "module") {
    if (!commandPath) throw new Error("MCP 模块模式缺少项目目录。");
    const projectDir = path.resolve(commandPath);
    if (!isDirectory(projectDir)) throw new Error(`MCP 项目目录不存在：${projectDir}`);
    const moduleName = configuredArgs[0] || "server";
    const extraArgs = configuredArgs.slice(1);
    return existingPythonCandidates(projectDir).map(({ command, prefixArgs }) => ({
      command,
      args: [...prefixArgs, "-m", moduleName, ...extraArgs],
      cwd: projectDir,
      env: safeChildEnvironment(config.env, [projectDir, path.join(projectDir, "src")].join(path.delimiter)),
    }));
  }

  if (!commandPath) throw new Error("MCP 脚本模式缺少启动文件。");
  const resolvedPath = path.resolve(commandPath);
  if (!existsSync(resolvedPath)) throw new Error(`MCP 启动文件不存在：${resolvedPath}`);
  const cwd = path.dirname(resolvedPath);

  if (path.extname(resolvedPath).toLowerCase() === ".py") {
    return existingPythonCandidates(cwd).map(({ command, prefixArgs }) => ({
      command,
      args: [...prefixArgs, resolvedPath, ...configuredArgs],
      cwd,
      env: safeChildEnvironment(config.env, [cwd, path.join(cwd, "src")].join(path.delimiter)),
    }));
  }

  return [{
    command: resolvedPath,
    args: configuredArgs,
    cwd,
    env: safeChildEnvironment(config.env),
  }];
}

function isBlockedProgram(command: string): boolean {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? command.toLowerCase();
  return BLOCKED_PROGRAMS.has(base);
}

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

function makeClient(
  transportKind: ConnectedMcpServer["transportKind"],
  onToolsChanged: (error: Error | null, tools: Tool[] | null) => void,
): Client {
  return new Client(
    { name: "nova-pi-host", version: "0.1.0" },
    {
      capabilities: {},
      // HTTP+SSE is a frozen pre-Streamable-HTTP transport and cannot speak
      // the 2026 era. stdio and Streamable HTTP probe modern discovery first,
      // then transparently retry the 2025 initialize handshake when needed.
      versionNegotiation: transportKind === "sse"
        ? { mode: "legacy" }
        : {
            mode: "auto",
            probe: { timeoutMs: MODERN_PROTOCOL_PROBE_TIMEOUT_MS, maxRetries: 0 },
          },
      // v2 maps this to legacy tools/list_changed notifications or the modern
      // subscriptions/listen stream and returns an already aggregated list.
      listChanged: {
        tools: {
          autoRefresh: true,
          debounceMs: 100,
          onChanged: onToolsChanged,
        },
      },
    },
  );
}

async function connectTransport(
  config: McpServerConfig,
  transport: Transport,
  transportKind: ConnectedMcpServer["transportKind"],
): Promise<ConnectedMcpServer> {
  let connected: ConnectedMcpServer | undefined;
  const client = makeClient(transportKind, (error, tools) => {
    if (error) {
      console.error(`[mcp-client] ${config.serviceId} 工具列表刷新失败：`, error);
      return;
    }
    if (!connected || !tools) return;
    connected.tools = tools;
    connected.onToolsChanged?.(tools);
  });
  try {
    await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS });
    const protocolEra = client.getProtocolEra();
    if (!protocolEra) throw new Error("MCP 协议协商完成后未返回协议时代。");
    // With no cursor, SDK v2 walks all tools/list pages and stores the complete
    // definition set for output-schema validation and x-mcp-header mirroring.
    const toolsList = await client.listTools(undefined, { timeout: HANDSHAKE_TIMEOUT_MS });
    connected = {
      config,
      client,
      tools: toolsList.tools,
      transportKind,
      protocolEra,
      protocolVersion: client.getNegotiatedProtocolVersion(),
    };
    return connected;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Connect and complete initialize + tools/list, with transport compatibility fallbacks. */
export async function connectMcpServer(config: McpServerConfig): Promise<ConnectedMcpServer> {
  if (config.transport === "http") {
    const url = validateHttpUrl(config.url);
    const streamableError = await connectTransport(
      config,
      new StreamableHTTPClientTransport(url),
      "streamable-http",
    ).then((server) => ({ server }), (error: unknown) => ({ error }));
    if ("server" in streamableError) return streamableError.server;

    try {
      return await connectTransport(config, new SSEClientTransport(url), "sse");
    } catch (sseError) {
      throw new Error(
        `MCP HTTP 连接失败（Streamable HTTP：${errorMessage(streamableError.error)}；SSE：${errorMessage(sseError)}）`,
      );
    }
  }

  const candidates = resolveStdioCommandSpecs(config);
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (isBlockedProgram(candidate.command)) {
      errors.push(`${candidate.command}: 不允许把命令解释器作为 MCP 启动程序`);
      continue;
    }

    const transport = new StdioClientTransport({
      command: candidate.command,
      args: candidate.args,
      cwd: candidate.cwd,
      env: candidate.env,
      stderr: "pipe",
    });
    let stderrTail = "";
    transport.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-4_000);
    });
    try {
      return await connectTransport(config, transport, "stdio");
    } catch (error) {
      const detail = stderrTail.trim();
      errors.push(`${candidate.command}: ${errorMessage(error)}${detail ? `；服务日志：${detail}` : ""}`);
    }
  }
  throw new Error(`MCP stdio 连接失败：${config.serviceId}\n${errors.join("\n")}`);
}

/** Invoke a tool using the SDK request timeout and abort support. */
export async function callMcpToolWithTimeout(
  server: ConnectedMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  timeoutSecs?: number,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const timeoutMs = Math.max(1, timeoutSecs ?? 14_400) * 1_000;
  const toolDefinition = server.tools.find((tool) => tool.name === toolName);
  return await server.client.callTool(
    { name: toolName, arguments: args },
    {
      signal,
      timeout: timeoutMs,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: timeoutMs,
      // Supplying the exact advertised definition keeps v2 output validation
      // and 2026 Streamable HTTP x-mcp-header mirroring deterministic even if
      // the response cache has just been invalidated by list_changed.
      toolDefinition,
    },
  );
}

/** Close a connection; stdio transports terminate their child process here. */
export async function disconnectMcpServer(server: ConnectedMcpServer): Promise<void> {
  await server.client.close().catch(() => {});
}
