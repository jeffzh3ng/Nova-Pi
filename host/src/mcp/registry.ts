/**
 * Process-wide MCP capability registry.
 *
 * Connections are shared by pi extension tools and explicit RPC calls. The
 * registry keeps configuration separate from live transports, reconnects on
 * demand, and notifies active pi sessions when the available tool set changes.
 */

import {
  callMcpToolWithTimeout,
  connectMcpServer,
  disconnectMcpServer,
  type ConnectedMcpServer,
  type McpToolInfo,
} from "./client.js";
import type { McpServerConfig } from "../rpc-protocol.js";

const ALERT_ANALYSIS_MCP = "alert-analysis-mcp";
const ALERT_ANALYSIS_TOOLS = new Set([
  "analyze_security_alert",
  "analyze_attack_ip",
  "parse_pcap_file",
  "extract_alert_image",
]);

export type RegisteredMcpTool = {
  serviceId: string;
  server: ConnectedMcpServer;
  tool: McpToolInfo;
};

type RegistryListener = () => void;

function defaultRequestTimeoutSecs(serviceId: string): number {
  if (serviceId === ALERT_ANALYSIS_MCP) return 600;
  const fromEnv = Number(process.env.NOVA_MCP_REQUEST_TIMEOUT_SECS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 14_400;
}

function isAllowedTool(serviceId: string, toolName: string): boolean {
  return serviceId !== ALERT_ANALYSIS_MCP || ALERT_ANALYSIS_TOOLS.has(toolName);
}

export class McpRegistry {
  private configs = new Map<string, McpServerConfig>();
  private servers = new Map<string, ConnectedMcpServer>();
  private connecting = new Map<string, Promise<ConnectedMcpServer>>();
  private listeners = new Set<RegistryListener>();

  list(): ConnectedMcpServer[] {
    return [...this.servers.values()];
  }

  get(serviceId: string): ConnectedMcpServer | undefined {
    return this.servers.get(serviceId);
  }

  getConfig(serviceId: string): McpServerConfig | undefined {
    return this.configs.get(serviceId);
  }

  /** IDs of every currently enabled service. Config sync keeps this list current. */
  listConfiguredServiceIds(): string[] {
    return [...this.configs.keys()];
  }

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listToolsForServices(allowedMcpServices: string[]): RegisteredMcpTool[] {
    const result: RegisteredMcpTool[] = [];
    for (const serviceId of allowedMcpServices) {
      const server = this.servers.get(serviceId);
      if (!server) continue;
      for (const tool of server.tools) {
        if (isAllowedTool(serviceId, tool.name)) {
          result.push({ serviceId, server, tool });
        }
      }
    }
    return result;
  }

  /** Replace enabled configuration. Connections are created only when a session discovers or calls a tool. */
  async configure(servers: McpServerConfig[]): Promise<Array<{
    serviceId: string;
    ok: boolean;
    error?: string;
    toolCount?: number;
  }>> {
    const nextConfigs = new Map<string, McpServerConfig>();
    for (const config of servers) {
      if (config.enabled) nextConfigs.set(config.serviceId, config);
    }

    for (const [serviceId, server] of this.servers) {
      const next = nextConfigs.get(serviceId);
      if (!next || !this.configEquals(server.config, next)) {
        this.servers.delete(serviceId);
        await disconnectMcpServer(server);
      }
    }
    this.configs = nextConfigs;

    this.notifyChanged();
    return [...nextConfigs.keys()].map((serviceId) => ({
      serviceId,
      ok: true as const,
      toolCount: this.servers.get(serviceId)?.tools.length,
    }));
  }

  async discoverTools(allowedMcpServices: string[]): Promise<{
    tools: RegisteredMcpTool[];
    errors: Array<{ serviceId: string; error: string }>;
  }> {
    // Nova can see every enabled MCP. Discover in parallel so one unavailable
    // service does not make the user wait for every preceding handshake timeout.
    const services = [...new Set(allowedMcpServices)];
    const results = await Promise.all(services.map(async (serviceId) => {
      try {
        const server = await this.getOrConnect(serviceId);
        return {
          tools: server.tools
            .filter((tool) => isAllowedTool(serviceId, tool.name))
            .map((tool) => ({ serviceId, server, tool })),
          errors: [] as Array<{ serviceId: string; error: string }>,
        };
      } catch (error) {
        return {
          tools: [] as RegisteredMcpTool[],
          errors: [{ serviceId, error: error instanceof Error ? error.message : String(error) }],
        };
      }
    }));
    return {
      tools: results.flatMap((result) => result.tools),
      errors: results.flatMap((result) => result.errors),
    };
  }

  async getOrConnect(serviceId: string): Promise<ConnectedMcpServer> {
    const existing = this.servers.get(serviceId);
    if (existing) return existing;

    const pending = this.connecting.get(serviceId);
    if (pending) return await pending;

    const config = this.configs.get(serviceId);
    if (!config) throw new Error(`MCP 服务未启用或尚未同步配置：${serviceId}`);

    const connection = connectMcpServer(config).then(async (server) => {
      const current = this.configs.get(serviceId);
      if (!current || !this.configEquals(config, current)) {
        await disconnectMcpServer(server);
        throw new Error(`MCP 服务配置已变化，请重试：${serviceId}`);
      }
      this.servers.set(serviceId, server);
      server.onToolsChanged = () => {
        if (this.servers.get(serviceId) === server) this.notifyChanged();
      };
      this.notifyChanged();
      return server;
    }).finally(() => {
      if (this.connecting.get(serviceId) === connection) {
        this.connecting.delete(serviceId);
      }
    });
    this.connecting.set(serviceId, connection);
    return await connection;
  }

  /**
   * 强制断开某 MCP 服务的现有连接并重新建立（kill 旧子进程后重新 spawn）。
   *
   * 与 {@link getOrConnect} 不同，这里无条件丢弃缓存连接。用于在 Python 侧
   * ``config.local.json`` 等进程内配置变化、但 host 侧 ``McpServerConfig`` 未变
   * （因此 ``configure`` 不会触发重连）时，让用户手动强制重启子进程。
   *
   * 注意：``this.configs`` 不能清空——``getOrConnect`` 重建时仍需要这份配置来 spawn。
   */
  async reconnect(serviceId: string): Promise<ConnectedMcpServer> {
    const existing = this.servers.get(serviceId);
    if (existing) {
      this.servers.delete(serviceId);
      await disconnectMcpServer(existing).catch(() => undefined);
      this.notifyChanged();
    }
    return await this.getOrConnect(serviceId);
  }

  async callTool(
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutSecs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!isAllowedTool(serviceId, toolName)) {
      throw new Error(`MCP 工具不在允许列表中：${serviceId}/${toolName}`);
    }
    const server = await this.getOrConnect(serviceId);
    if (!server.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP 服务未提供工具：${serviceId}/${toolName}`);
    }

    const configuredTimeout = server.config.timeoutSecs;
    try {
      return await callMcpToolWithTimeout(
        server,
        toolName,
        args,
        timeoutSecs ?? configuredTimeout ?? defaultRequestTimeoutSecs(serviceId),
        signal,
      );
    } catch (error) {
      // A timed-out, aborted, or closed transport must not remain cached. The
      // next call reconnects cleanly instead of reusing a poisoned client.
      if (this.servers.get(serviceId) === server) {
        this.servers.delete(serviceId);
        await disconnectMcpServer(server);
        this.notifyChanged();
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const active = [...this.servers.values()];
    this.configs.clear();
    this.servers.clear();
    this.connecting.clear();
    this.notifyChanged();
    await Promise.all(active.map((server) => disconnectMcpServer(server)));
    this.listeners.clear();
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[mcp-registry] 工具刷新监听器执行失败：", error);
      }
    }
  }

  private configEquals(a: McpServerConfig, b: McpServerConfig): boolean {
    return (
      a.transport === b.transport &&
      a.commandPath === b.commandPath &&
      a.commandArgs === b.commandArgs &&
      a.url === b.url &&
      a.launchMode === b.launchMode &&
      a.timeoutSecs === b.timeoutSecs &&
      this.envEquals(a.env, b.env) &&
      this.headersEquals(a.httpHeaders, b.httpHeaders)
    );
  }

  private envEquals(a?: Record<string, string>, b?: Record<string, string>): boolean {
    const left = a ? Object.keys(a).sort() : [];
    const right = b ? Object.keys(b).sort() : [];
    return left.length === right.length && left.every((key, index) => key === right[index] && a?.[key] === b?.[key]);
  }

  /** 比较两组请求头(顺序敏感):改名或改值都应触发重连,让新 token 生效。 */
  private headersEquals(
    a?: Array<{ name: string; value: string }>,
    b?: Array<{ name: string; value: string }>,
  ): boolean {
    const left = a ?? [];
    const right = b ?? [];
    return (
      left.length === right.length &&
      left.every((item, index) => item.name === right[index].name && item.value === right[index].value)
    );
  }
}

export const mcpRegistry = new McpRegistry();
