/**
 * Nova-PI sidecar RPC 协议（与 app/src/services/hostBridge.ts 保持一致）。
 *
 * 传输：newline-delimited JSON over stdin/stdout。
 * - Rust → Node（stdin）：RpcCommand
 * - Node → Rust（stdout）：RpcResponse（同步响应，按 id 匹配）+ RpcEventEnvelope（异步事件流）
 */

// ─────────────────────────────────────────────────────────────────────────────
// 命令（Rust → Node，stdin）
// ─────────────────────────────────────────────────────────────────────────────

export type McpServerConfig = {
  serviceId: string;
  transport: "stdio" | "http";
  commandPath: string;
  commandArgs: string;
  env?: Record<string, string>;
  url: string;
  enabled: boolean;
  launchMode: "script" | "module";
  timeoutSecs?: number;
};

export type ConversationAttachments = {
  pcapSections?: string[];
  imageSections?: string[];
  alertFields?: Record<string, string>;
  files?: Array<{ name: string; path: string; ext: string }>;
};

export type RpcCommand =
  // 会话生命周期
  | { id?: string; type: "new_session"; humanId: string; conversationId: string; resumeMessages?: Array<{ role: string; content: string }> }
  | { id?: string; type: "dispose_session"; sessionId: string }
  // 对话
  | { id?: string; type: "prompt"; sessionId: string; message: string; images?: unknown[]; attachments?: ConversationAttachments }
  | { id?: string; type: "steer"; sessionId: string; message: string }
  | { id?: string; type: "abort"; sessionId: string }
  // 模型
  | { id?: string; type: "set_model"; provider: string; modelId: string; apiKey?: string; baseUrl?: string; temperature?: number; maxTokens?: number; proxyUrl?: string }
  | { id?: string; type: "test_model"; provider: string; modelId: string; apiKey?: string; baseUrl?: string }
  | { id?: string; type: "get_state"; sessionId: string }
  // MCP
  | { id?: string; type: "configure_mcp"; servers: McpServerConfig[] }
  | { id?: string; type: "list_mcp_tools"; serviceId: string }
  | { id?: string; type: "test_mcp"; serviceId: string }
  | { id?: string; type: "mcp_call"; serviceId: string; toolName: string; args: Record<string, unknown>; timeoutSecs?: number }
  // 技能
  | { id?: string; type: "list_skills" }
  | { id?: string; type: "resolve_skill"; request: string; sessionId?: string }
  // 风评（host 内部编排，避免前端轮询）
  | { id?: string; type: "risk_list_matrices" }
  | { id?: string; type: "risk_submit"; sessionId: string; materialId: string; matrixName: string }
  | { id?: string; type: "risk_status"; taskId: string }
  | { id?: string; type: "risk_cancel"; taskId: string }
  // 模型管理（读写 pi models.json + ModelRuntime）
  | { id?: string; type: "models_list_providers" }
  | { id?: string; type: "models_list_all" }
  | { id?: string; type: "models_get_default" }
  | { id?: string; type: "models_set_default"; provider: string; model: string }
  | { id?: string; type: "models_upsert_provider"; provider: { id: string; name?: string; baseUrl: string; api: string; apiKey?: string; models?: unknown[] } }
  | { id?: string; type: "models_remove_provider"; providerId: string }
  | { id?: string; type: "models_set_api_key"; providerId: string; apiKey: string }
  | { id?: string; type: "models_upsert_model"; providerId: string; model: { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number } }
  | { id?: string; type: "models_remove_model"; providerId: string; modelId: string }
  // 扩展管理（读写 settings.json extensions 数组）
  | { id?: string; type: "extensions_list" }
  | { id?: string; type: "extensions_add"; path: string }
  | { id?: string; type: "extensions_remove"; extensionId: string }
  | { id?: string; type: "extensions_set_enabled"; extensionId: string; enabled: boolean }
  | { id?: string; type: "extensions_read_content"; extensionId: string }
  | { id?: string; type: "extensions_create"; name: string; template?: string }
  // 生命周期
  | { id?: string; type: "shutdown" };

// ─────────────────────────────────────────────────────────────────────────────
// 响应（Node → Rust，stdout，同步）
// ─────────────────────────────────────────────────────────────────────────────

export type RpcResponse =
  | { id?: string; type: "response"; success: true; data?: unknown }
  | { id?: string; type: "response"; success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// 事件（Node → Rust，stdout，异步流；sessionId 关联回具体会话）
// ─────────────────────────────────────────────────────────────────────────────

export type RpcEvent =
  // pi 原生事件（透传 AgentSessionEvent 的核心子集）
  | { type: "agent_start"; sessionId: string }
  | { type: "agent_end"; sessionId: string; messages?: unknown[] }
  | { type: "turn_start"; sessionId: string }
  | { type: "turn_end"; sessionId: string }
  | { type: "message_start"; sessionId: string; message?: unknown }
  | { type: "message_update"; sessionId: string; assistantMessageEvent?: { type: string; delta?: string; text?: string } }
  | { type: "message_end"; sessionId: string; message?: unknown }
  | { type: "tool_execution_start"; sessionId: string; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; sessionId: string; toolCallId: string; toolName: string; partialResult?: unknown }
  | { type: "tool_execution_end"; sessionId: string; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
  // Nova-PI 扩展事件
  | { type: "usage"; sessionId?: string; promptTokens: number; completionTokens: number; totalTokens: number; cacheRead?: number; cacheWrite?: number; model: string; agentName?: string }
  | { type: "risk_job_update"; sessionId: string; job: unknown }
  | { type: "session_saved"; conversationId: string; title?: string }
  | { type: "error"; sessionId?: string; message: string; recoverable?: boolean };

export type RpcEventEnvelope = { type: "event"; event: RpcEvent };

// ─────────────────────────────────────────────────────────────────────────────
// stdout 写入帮助
// ─────────────────────────────────────────────────────────────────────────────

/** 写一条同步响应到 stdout（按 id 匹配 pending 请求）。 */
export function writeResponse(id: string | undefined, success: true, data?: unknown): void;
export function writeResponse(id: string | undefined, success: false, error: string): void;
export function writeResponse(id: string | undefined, success: boolean, payload?: unknown): void {
  const response: RpcResponse = success
    ? { id, type: "response", success: true, data: payload }
    : { id, type: "response", success: false, error: typeof payload === "string" ? payload : String(payload ?? "") };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/** 写一条异步事件到 stdout（Rust 以 emit("pi-event") 转发前端）。 */
export function writeEvent(event: RpcEvent): void {
  const envelope: RpcEventEnvelope = { type: "event", event };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
