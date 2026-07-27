/**
 * MCP 服务注册中心：管理已连接的 MCP 服务，并把每个工具注册为 pi 的 customTool。
 *
 * 这是新架构的核心：pi 的 LLM 通过工具 description 自主决定调用哪个 MCP 工具，
 * 取代原 Nova 的 agentRuntime 路由逻辑。
 *
 * per-service 超时：alert-analysis 600s，其他默认 4h（与原 Nova 对齐），
 * NOVA_MCP_REQUEST_TIMEOUT_SECS 环境变量可覆盖。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { connectMcpServer, callMcpToolWithTimeout, disconnectMcpServer, type ConnectedMcpServer } from "./client.js";
import { jsonSchemaToTypebox } from "./schema-convert.js";
import { extractMcpPayload, extractMcpError } from "./payload.js";
import type { McpServerConfig } from "../rpc-protocol.js";

const ALERT_ANALYSIS_MCP = "alert-analysis-mcp";

/** 默认请求超时（秒）。原 Nova external_mcp_client 用 4h 容纳大型数据分类任务。 */
function defaultRequestTimeoutSecs(serviceId: string): number {
  if (serviceId === ALERT_ANALYSIS_MCP) return 600;
  const fromEnv = Number(process.env.NOVA_MCP_REQUEST_TIMEOUT_SECS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 14_400; // 4 小时
}

export class McpRegistry {
  /** serviceId → 已连接的服务 */
  private servers = new Map<string, ConnectedMcpServer>();
  /** serviceId → 该服务暴露的工具名白名单（alert-analysis 限定 4 个工具） */
  private toolWhitelists = new Map<string, Set<string>>();

  /** 全部已连接服务。 */
  list(): ConnectedMcpServer[] {
    return [...this.servers.values()];
  }

  get(serviceId: string): ConnectedMcpServer | undefined {
    return this.servers.get(serviceId);
  }

  /** 重载所有 MCP 连接（配置变更时调用）。返回每个服务的连接结果。 */
  async configure(servers: McpServerConfig[]): Promise<Array<{ serviceId: string; ok: boolean; error?: string; toolCount?: number }>> {
    // 关闭不再启用、或配置已变更的旧连接（后者需要重连）
    const newConfigById = new Map<string, McpServerConfig>();
    for (const s of servers) {
      if (s.enabled) newConfigById.set(s.serviceId, s);
    }
    for (const [serviceId, server] of this.servers) {
      const newCfg = newConfigById.get(serviceId);
      if (!newCfg || !this.configEquals(server.config, newCfg)) {
        await disconnectMcpServer(server);
        this.servers.delete(serviceId);
        this.toolWhitelists.delete(serviceId);
      }
    }

    // 并发连接所有需要（重新）建立的服务：串行连接时单个卡死会拖死全部（即便有握手超时也要等 30s）。
    const toConnect = servers.filter((s) => s.enabled && !this.servers.has(s.serviceId));
    const connectResults = await Promise.allSettled(
      toConnect.map(async (config) => {
        const server = await connectMcpServer(config);
        this.servers.set(config.serviceId, server);
        // alert-analysis 限定 4 个工具（与原 Nova alert_analysis_mcp.rs 白名单一致）
        if (config.serviceId === ALERT_ANALYSIS_MCP) {
          this.toolWhitelists.set(config.serviceId, new Set([
            "analyze_security_alert",
            "analyze_attack_ip",
            "parse_pcap_file",
            "extract_alert_image",
          ]));
        }
        return { serviceId: config.serviceId, ok: true, toolCount: server.tools.length };
      }),
    );

    const results: Array<{ serviceId: string; ok: boolean; error?: string; toolCount?: number }> = [];
    // 保留连接（配置未变）的服务
    for (const [serviceId, server] of this.servers) {
      if (!toConnect.some((c) => c.serviceId === serviceId)) {
        results.push({ serviceId, ok: true, toolCount: server.tools.length });
      }
    }
    // 新连接结果（allSettled 保持输入顺序，用索引对齐 toConnect）
    connectResults.forEach((settled, idx) => {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        const config = toConnect[idx];
        results.push({
          serviceId: config.serviceId,
          ok: false,
          error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        });
      }
    });
    return results;
  }

  /** 浅比较配置字段，判断是否需要重连。 */
  private configEquals(a: McpServerConfig, b: McpServerConfig): boolean {
    return (
      a.transport === b.transport &&
      a.commandPath === b.commandPath &&
      a.commandArgs === b.commandArgs &&
      a.url === b.url &&
      a.launchMode === b.launchMode &&
      a.timeoutSecs === b.timeoutSecs &&
      this.envEquals(a.env, b.env)
    );
  }

  private envEquals(a?: Record<string, string>, b?: Record<string, string>): boolean {
    const ak = a ? Object.keys(a) : [];
    const bk = b ? Object.keys(b) : [];
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (a![k] !== b?.[k]) return false;
    }
    return true;
  }

  /** 把指定员工允许的 MCP 服务的工具，全部注册为 pi customTool。 */
  buildCustomTools(allowedMcpServices: string[]): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const seenToolNames = new Set<string>();
    for (const serviceId of allowedMcpServices) {
      const server = this.servers.get(serviceId);
      if (!server) continue;
      const whitelist = this.toolWhitelists.get(serviceId);
      for (const tool of server.tools) {
        if (whitelist && !whitelist.has(tool.name)) continue;
        // 工具名冲突时加 serviceId 前缀（保留原名优先）
        const toolName = seenToolNames.has(tool.name) ? `${serviceId}__${tool.name}` : tool.name;
        seenToolNames.add(tool.name);
        tools.push(this.buildCustomTool(server, tool, toolName));
      }
    }
    return tools;
  }

  private buildCustomTool(
    server: ConnectedMcpServer,
    tool: { name: string; description?: string; inputSchema: unknown },
    registeredName: string,
  ): ToolDefinition {
    const parameters = jsonSchemaToTypebox(tool.inputSchema) as TSchema;
    const originalName = tool.name;
    const description = tool.description || `${server.config.serviceId} 工具：${originalName}`;
    const timeoutSecs = defaultRequestTimeoutSecs(server.config.serviceId);

    return defineTool({
      name: registeredName,
      label: originalName,
      description,
      parameters,
      execute: async (_toolCallId, args) => {
        try {
          const raw = await callMcpToolWithTimeout(server, originalName, args as Record<string, unknown>, timeoutSecs);
          const { data, text } = extractMcpPayload(raw);
          const errorMessage = extractMcpError(data);
          if (errorMessage) {
            return {
              content: [{ type: "text", text: `工具 ${originalName} 返回错误：${errorMessage}` }],
              details: data,
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: text || stringifyForModel(data) }],
            details: data,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `工具 ${originalName} 调用失败：${message}` }],
            details: { error: message },
            isError: true,
          };
        }
      },
    });
  }

  /** 关闭所有连接（shutdown 时调用）。 */
  async dispose(): Promise<void> {
    for (const server of this.servers.values()) {
      await disconnectMcpServer(server);
    }
    this.servers.clear();
    this.toolWhitelists.clear();
  }
}

function stringifyForModel(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/** 单例：整个 sidecar 共享一个 MCP 注册中心。 */
export const mcpRegistry = new McpRegistry();
