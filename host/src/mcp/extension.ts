/** Token-efficient MCP adapter for embedded pi sessions. */

import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AttachmentRuntime, AgentAttachment } from "../attachments.js";
import {
  extractMcpError,
  extractMcpModelContent,
  extractMcpPayload,
  isMcpCallError,
} from "./payload.js";
import { mcpRegistry, type RegisteredMcpTool } from "./registry.js";

const DATA_RISK_MCP = "data-security-risk-assessment-mcp";
const DEFAULT_RISK_UPLOAD_TIMEOUT_SECS = 30 * 60;
export const MCP_PROXY_TOOL_NAME = "mcp";

type ProxyArguments = {
  search?: string;
  tool?: string;
  args?: Record<string, unknown> | string;
  attachment?: string;
};

export type McpServiceScope = readonly string[] | "all";

type McpProxyDetails = {
  tools?: Record<string, unknown>[];
  connectionErrors?: Array<{ serviceId: string; error: string }>;
  attachments?: Array<{ name: string; ext: string; size?: number }>;
  serviceId?: string;
  toolName?: string;
  result?: unknown;
};

function stringifyForModel(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function qualifiedName(entry: RegisteredMcpTool): string {
  return `${entry.serviceId}/${entry.tool.name}`;
}

function compactTool(entry: RegisteredMcpTool): Record<string, unknown> {
  return {
    tool: qualifiedName(entry),
    service: entry.serviceId,
    name: entry.tool.name,
    description: (entry.tool.description || entry.tool.title || "").slice(0, 240),
    inputSchema: entry.tool.inputSchema,
  };
}

function parseToolArgs(value: ProxyArguments["args"]): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("mcp.args 必须是 JSON 对象。");
    }
    return parsed as Record<string, unknown>;
  }
  return { ...value };
}

function schemaProperties(entry: RegisteredMcpTool): Record<string, unknown> {
  const schema = entry.tool.inputSchema as { properties?: unknown } | undefined;
  return schema?.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
}

function firstProperty(properties: Record<string, unknown>, candidates: string[]): string | undefined {
  return candidates.find((key) => Object.prototype.hasOwnProperty.call(properties, key));
}

async function addAttachmentToArgs(
  entry: RegisteredMcpTool,
  args: Record<string, unknown>,
  file: AgentAttachment,
): Promise<Record<string, unknown>> {
  const next = { ...args };
  const properties = schemaProperties(entry);
  const pathKey = firstProperty(properties, [
    "zip_path", "file_path", "filepath", "path", "pcapFilePath", "pcap_path", "image_path",
  ]);
  if (pathKey && next[pathKey] == null) {
    next[pathKey] = file.path;
    return next;
  }

  const contentKey = firstProperty(properties, [
    "content", "file_content", "fileContent", "base64", "base64_content", "data",
  ]);
  if (contentKey && next[contentKey] == null) {
    next[contentKey] = (await readFile(file.path)).toString("base64");
    const nameKey = firstProperty(properties, ["filename", "file_name", "name"]);
    if (nameKey && next[nameKey] == null) next[nameKey] = file.name;
    return next;
  }

  throw new Error(
    `MCP 工具 ${qualifiedName(entry)} 没有声明文件路径或文件内容参数，无法安全传入附件 ${file.name}。`,
  );
}

function riskMaterialsEndpoint(rawUrl: string): string {
  const url = new URL(rawUrl);
  const segments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const mcpIndex = segments.lastIndexOf("mcp");
  if (mcpIndex >= 0) {
    const replacement = segments[mcpIndex - 1] === "api" ? ["materials"] : ["api", "materials"];
    segments.splice(mcpIndex, segments.length - mcpIndex, ...replacement);
  }
  else segments.push("api", "materials");
  url.pathname = `/${segments.join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function uploadRiskMaterials(file: AgentAttachment, signal?: AbortSignal): Promise<unknown> {
  const config = mcpRegistry.getConfig(DATA_RISK_MCP);
  if (!config?.url) throw new Error("数安风评 MCP 未配置 HTTP 地址。");
  const form = new FormData();
  form.append("file", await openAsBlob(file.path), file.name);
  const headers = Object.fromEntries(
    (config.httpHeaders ?? [])
      .filter(({ name }) => !/^(content-type|content-length|host)$/i.test(name))
      .map(({ name, value }) => [name, value]),
  );
  const timeoutSecs = Math.max(1, config.timeoutSecs ?? DEFAULT_RISK_UPLOAD_TIMEOUT_SECS);
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSecs * 1_000);

  let response: Response;
  let text: string;
  try {
    response = await fetch(riskMaterialsEndpoint(config.url), {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (timedOut) throw new Error(`上传评估材料超时（${timeoutSecs} 秒）。`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Preserve a non-JSON server response for diagnostics.
  }
  if (!response.ok) throw new Error(`上传评估材料失败（HTTP ${response.status}）：${stringifyForModel(data)}`);
  return {
    content: [{ type: "text", text: stringifyForModel(data) }],
    structuredContent: data,
  };
}

async function discover(scope: McpServiceScope, search?: string): Promise<{
  matches: RegisteredMcpTool[];
  errors: Array<{ serviceId: string; error: string }>;
}> {
  // Resolve "all" for every discovery/call rather than when the pi session is
  // created. An existing Nova session can therefore use MCP services enabled
  // later without being rebuilt, while professional employees retain a fixed
  // per-session whitelist.
  const allowedMcpServices = scope === "all"
    ? mcpRegistry.listConfiguredServiceIds()
    : [...scope];
  const result = await mcpRegistry.discoverTools(allowedMcpServices);
  const terms = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = terms.length === 0
    ? result.tools
    : result.tools.filter((entry) => {
        const haystack = `${entry.serviceId} ${entry.tool.name} ${entry.tool.title ?? ""} ${entry.tool.description ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
  return { matches, errors: result.errors };
}

function allowedServiceIds(scope: McpServiceScope): string[] {
  return scope === "all" ? mcpRegistry.listConfiguredServiceIds() : [...scope];
}

async function resolveRequestedTool(
  scope: McpServiceScope,
  requested: string,
): Promise<RegisteredMcpTool> {
  const serviceIds = allowedServiceIds(scope);
  // A discovered service/tool name is authoritative. Connect only its service
  // so an unrelated offline MCP cannot delay every subsequent tool call.
  const serviceId = serviceIds
    .filter((candidate) => requested.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (serviceId) {
    await mcpRegistry.getOrConnect(serviceId);
    const entry = mcpRegistry
      .listToolsForServices([serviceId])
      .find((candidate) => qualifiedName(candidate) === requested);
    if (entry) return entry;
    throw new Error(`当前 MCP 未提供工具 ${requested}。请先调用 mcp({ search: "关键词" }) 重新发现。`);
  }

  if (requested.includes("/")) {
    throw new Error(`当前数字员工无权访问 MCP 工具 ${requested}，或对应服务尚未启用。`);
  }
  throw new Error(
    `请使用 mcp 搜索结果中的完整 service/tool 名称；不能直接调用未限定服务的工具 ${requested}。`,
  );
}

export function createMcpExtension(
  scope: McpServiceScope,
  attachments?: AttachmentRuntime,
): InlineExtension {
  return {
    name: "nova-mcp",
    hidden: true,
    factory(pi) {
      pi.registerTool({
        name: MCP_PROXY_TOOL_NAME,
        label: "MCP 能力",
        description:
          "发现并调用当前数字员工绑定的 MCP 服务。首次处理外部查询或附件时先用 search 查找工具；" +
          "再把返回的 service/tool 作为 tool 调用。不要在未执行发现前声称 MCP 不可用。附件只传文件名给 attachment。",
        parameters: Type.Object({
          search: Type.Optional(Type.String({ description: "按需求搜索 MCP 工具；省略 tool 时返回匹配工具及参数。" })),
          tool: Type.Optional(Type.String({ description: "发现结果中的完整工具名，例如 anysearch-mcp/search。" })),
          args: Type.Optional(Type.Union([
            Type.Record(Type.String(), Type.Unknown()),
            Type.String({ description: "JSON 对象字符串，仅用于模型无法直接传对象时。" }),
          ])),
          attachment: Type.Optional(Type.String({ description: "当前会话附件的文件名；Nova 会安全传递内容或路径。" })),
        }),
        async execute(_toolCallId, rawArgs, signal) {
          const input = rawArgs as ProxyArguments;
          if (!input.tool) {
            const { matches, errors } = await discover(scope, input.search);
            const data = {
              tools: matches.map(compactTool),
              connectionErrors: errors,
              attachments: attachments?.list().map((file) => ({ name: file.name, ext: file.ext, size: file.size })) ?? [],
            };
            const text = matches.length > 0
              ? `已发现 ${matches.length} 个 MCP 工具。请选择完整 tool 名称调用。\n${stringifyForModel(data)}`
              : `未找到匹配的 MCP 工具。\n${stringifyForModel(data)}`;
            return { content: [{ type: "text", text }], details: data as McpProxyDetails };
          }

          const requested = input.tool.trim();
          const entry = await resolveRequestedTool(scope, requested);
          let args = parseToolArgs(input.args);
          // Never infer an attachment from a broad tool-name/schema heuristic.
          // The model must explicitly reference the user-visible file name so a
          // screenshot cannot silently become a PCAP path or generic data value.
          const file = input.attachment ? await attachments?.resolve(input.attachment) : undefined;
          let raw: unknown;
          if (
            file
            && entry.serviceId === DATA_RISK_MCP
            && entry.tool.name === "upload_materials"
            && mcpRegistry.getConfig(entry.serviceId)?.transport === "http"
          ) {
            raw = await uploadRiskMaterials(file, signal);
          } else {
            if (input.attachment && !file) throw new Error(`找不到附件：${input.attachment}`);
            if (file) args = await addAttachmentToArgs(entry, args, file);
            raw = await mcpRegistry.callTool(entry.serviceId, entry.tool.name, args, undefined, signal);
          }

          const { data, text } = extractMcpPayload(raw);
          const domainError = extractMcpError(data);
          if (isMcpCallError(raw) || domainError) {
            throw new Error(domainError || text || `MCP 工具 ${qualifiedName(entry)} 返回失败`);
          }
          const modelText = text || stringifyForModel(data);
          const provenance = `[MCP 服务 ${entry.serviceId} / 工具 ${entry.tool.name}]`;
          const modelContent = extractMcpModelContent(raw, modelText);
          return {
            content: [{ type: "text", text: provenance }, ...modelContent],
            details: { serviceId: entry.serviceId, toolName: entry.tool.name, result: data } as McpProxyDetails,
          };
        },
      });
    },
  };
}
