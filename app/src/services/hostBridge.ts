import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * hostBridge —— 前端 ↔ Rust ↔ Node sidecar(pi 内核) 的统一桥接层。
 *
 * 前端通过 `sendRpc(command)` 把命令交给 Rust，Rust 转发给 Node sidecar，
 * Node 处理完后通过 Tauri event `pi-event` 把 pi 的 AgentSessionEvent 流式回传。
 *
 * 与原 Nova 的差异：原 Nova 的 LLM/MCP 调用直接走 Rust 命令（run_agent_chat /
 * call_mcp_tool）；新版统一走 sidecar RPC，由 pi 的 agent loop 驱动。
 */

// ─────────────────────────────────────────────────────────────────────────────
// RPC 命令/响应/事件类型（与 host/src/rpc-protocol.ts 保持一致）
// ─────────────────────────────────────────────────────────────────────────────

export type RpcCommand =
  // 会话生命周期
  | { id?: string; type: "new_session"; humanId: string; conversationId: string; resumeMessages?: unknown[] }
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
  // 风评
  | { id?: string; type: "risk_list_matrices" }
  | { id?: string; type: "risk_submit"; sessionId: string; materialId: string; matrixName: string }
  | { id?: string; type: "risk_status"; taskId: string }
  | { id?: string; type: "risk_cancel"; taskId: string }
  // 模型管理（pi models.json + ModelRuntime）
  | { id?: string; type: "models_list_providers" }
  | { id?: string; type: "models_list_all" }
  | { id?: string; type: "models_get_default" }
  | { id?: string; type: "models_set_default"; provider: string; model: string }
  | { id?: string; type: "models_upsert_provider"; provider: ModelsProviderInput }
  | { id?: string; type: "models_remove_provider"; providerId: string }
  | { id?: string; type: "models_set_api_key"; providerId: string; apiKey: string }
  | { id?: string; type: "models_upsert_model"; providerId: string; model: ModelsModelInput }
  | { id?: string; type: "models_remove_model"; providerId: string; modelId: string }
  // 扩展管理（pi settings.json extensions）
  | { id?: string; type: "extensions_list" }
  | { id?: string; type: "extensions_add"; path: string }
  | { id?: string; type: "extensions_remove"; extensionId: string }
  | { id?: string; type: "extensions_set_enabled"; extensionId: string; enabled: boolean }
  | { id?: string; type: "extensions_read_content"; extensionId: string }
  | { id?: string; type: "extensions_create"; name: string; template?: string }
  // 公文
  | { id?: string; type: "shutdown" };

/** 模型管理：provider 新增/编辑入参（与 host ModelsJsonProvider 对齐）。 */
export type ModelsProviderInput = {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models?: ModelsModelInput[];
};

export type ModelsModelInput = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
};

/** 模型管理：provider 摘要（list_providers 返回）。 */
export type ProviderSummary = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  modelCount: number;
  available: boolean;
  models: ModelSummary[];
};

export type ModelSummary = {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  available: boolean;
};

export type DefaultModelInfo = {
  provider: string;
  model: string;
};

/** 扩展管理：扩展摘要（extensions_list 返回）。 */
export type ExtensionSummary = {
  id: string;
  name: string;
  path: string;
  source: "user-managed" | "global-dir";
  enabled: boolean;
  exists: boolean;
  description: string;
  isDirectory: boolean;
};

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

export type RpcResponse =
  | { id?: string; type: "response"; success: true; data?: unknown }
  | { id?: string; type: "response"; success: false; error: string };

export type PiEvent =
  // pi 原生事件（透传）
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

// ─────────────────────────────────────────────────────────────────────────────
// 发送 RPC 命令并等待响应
// ─────────────────────────────────────────────────────────────────────────────

let requestIdCounter = 0;
const pendingRequests = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
let eventUnlisten: Promise<UnlistenFn> | null = null;

const ensureEventListener = () => {
  if (eventUnlisten) return eventUnlisten;
  eventUnlisten = listen<RiEventEnvelope>("pi-event", (event) => {
    const payload = event.payload;
    if (!payload) return;
    // 同步响应：按 id 匹配 pending 请求
    if (payload.kind === "response" && payload.id) {
      const pending = pendingRequests.get(payload.id);
      if (!pending) return;
      pendingRequests.delete(payload.id);
      if (payload.success) pending.resolve(payload.data);
      else pending.reject(new Error(payload.error || "RPC 调用失败"));
      return;
    }
    // 异步事件流：分发给订阅者
    if (payload.kind === "event" && payload.event) {
      notifyEventListeners(payload.event as PiEvent);
    }
  });
  return eventUnlisten;
};

type RiEventEnvelope =
  | { kind: "response"; id?: string; success: true; data?: unknown }
  | { kind: "response"; id?: string; success: false; error: string }
  | { kind: "event"; event: unknown };

const eventListeners = new Set<(event: PiEvent) => void>();

function notifyEventListeners(event: PiEvent) {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("pi-event listener threw", error);
    }
  }
}

/**
 * 发送一条 RPC 命令到 Node sidecar（经 Rust 转发），并等待同步响应。
 * 异步事件（流式 token、工具执行、风评进度等）通过 `subscribePiEvents` 订阅。
 *
 * 用泛型分发保留联合类型推断：传入某个具体命令变体时，TS 能正确匹配到
 * `RpcCommand` 的对应分支，避免「Object literal may only specify known properties」。
 *
 * 用法：
 *   - `sendRpc({ type: "prompt", ... })` → Promise<unknown>
 *   - `sendRpc<string>({ type: "new_session", ... })` → Promise<string>（显式指定响应类型）
 */
export async function sendRpc<TResult = unknown, TCommand extends RpcCommand = RpcCommand>(
  command: TCommand extends { id?: string } ? Omit<TCommand, "id"> : TCommand,
): Promise<TResult> {
  await ensureEventListener();
  const id = `req-${Date.now()}-${requestIdCounter++}`;
  const fullCommand = { ...command, id } as RpcCommand;
  return new Promise<TResult>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: (data) => resolve(data as TResult),
      reject,
    });
    invoke<boolean>("send_rpc", { command: fullCommand }).catch((error) => {
      pendingRequests.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * 订阅 pi 事件流（message_update / tool_execution_* / agent_end / usage / risk_job_update / error）。
 * 返回取消订阅函数。
 */
export function subscribePiEvents(listener: (event: PiEvent) => void): () => void {
  void ensureEventListener();
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/**
 * 发送 RPC 但不等响应（fire-and-forget），用于 shutdown 等场景。
 */
export async function sendRpcFireAndForget<TCommand extends RpcCommand>(
  command: TCommand extends { id?: string } ? Omit<TCommand, "id"> : TCommand,
): Promise<void> {
  await invoke<boolean>("send_rpc", { command }).catch(() => {});
}
