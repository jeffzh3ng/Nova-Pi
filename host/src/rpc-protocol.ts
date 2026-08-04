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
  /** HTTP 连接的自定义请求头(如 Authorization、X-API-Key);stdio 连接不使用。 */
  httpHeaders?: Array<{ name: string; value: string }>;
};

export type ConversationAttachments = {
  files?: Array<{ name: string; path: string; ext: string; size?: number }>;
};

export type RpcCommand =
  // 会话生命周期
  | { id?: string; type: "new_session"; humanId: string; conversationId: string; mcpServiceId?: string; resumeMessages?: Array<{ role: string; content: string }>; resumeAttachments?: Array<{ name: string; path: string; ext: string; size?: number }> }
  | { id?: string; type: "dispose_session"; sessionId: string }
  // 对话
  | { id?: string; type: "prompt"; sessionId: string; message: string; images?: unknown[]; attachments?: ConversationAttachments }
  | { id?: string; type: "steer"; sessionId: string; message: string }
  | { id?: string; type: "abort"; sessionId: string }
  // 模型
  | { id?: string; type: "set_model"; provider: string; modelId: string; apiKey?: string; baseUrl?: string; temperature?: number; maxTokens?: number; proxyUrl?: string }
  | { id?: string; type: "test_model"; provider: string; modelId: string; apiKey?: string; baseUrl?: string }
  | { id?: string; type: "get_state"; sessionId: string }
  // 内置电脑智能员工：授权、Nova 运行态同步与任务管理
  | { id?: string; type: "configure_computer_agent"; settings: Record<string, unknown> }
  | { id?: string; type: "update_nova_context"; conversations: Array<Record<string, unknown>> }
  | { id?: string; type: "get_nova_status" }
  | { id?: string; type: "manage_nova_task"; conversationId: string; action: "abort" | "dispose" }
  // MCP
  | { id?: string; type: "configure_mcp"; servers: McpServerConfig[] }
  | { id?: string; type: "list_mcp_tools"; serviceId: string }
  | { id?: string; type: "test_mcp"; serviceId: string }
  | { id?: string; type: "reconnect_mcp"; serviceId: string }
  | { id?: string; type: "mcp_call"; serviceId: string; toolName: string; args: Record<string, unknown>; timeoutSecs?: number }
  | { id?: string; type: "cache_remote_images"; conversationId: string; urls: string[]; label?: string }
  | { id?: string; type: "cache_sandbox_images"; conversationId: string; references: string[] }
  // 技能
  | { id?: string; type: "list_skills" }
  | { id?: string; type: "reload_skills" }
  | { id?: string; type: "resolve_skill"; request: string; sessionId?: string }
  // 风评：完全走 mcp_call（pi 自主调用 data-security-risk-assessment-mcp 工具），
  // 前端 pollRiskAssessment 轮询进度。host 不再编排，故无独立 risk_* 命令。
  // 模型管理（读写 pi models.json + ModelRuntime）
  | { id?: string; type: "models_list_providers" }
  | { id?: string; type: "models_list_all" }
  | { id?: string; type: "models_get_default" }
  | { id?: string; type: "models_set_default"; provider: string; model: string }
  | { id?: string; type: "models_test_provider"; providerId: string; modelId: string }
  | { id?: string; type: "models_login_oauth"; providerId: string; modelId?: string }
  | { id?: string; type: "models_cancel_oauth"; loginId: string }
  | { id?: string; type: "models_upsert_provider"; provider: { id: string; name?: string; baseUrl: string; api: string; apiKey?: string; models?: unknown[] } }
  | { id?: string; type: "models_remove_provider"; providerId: string }
  | { id?: string; type: "models_set_api_key"; providerId: string; apiKey: string }
  | { id?: string; type: "models_upsert_model"; providerId: string; model: { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number } }
  | { id?: string; type: "models_remove_model"; providerId: string; modelId: string }
  // 任务名提炼：用用户配置的默认模型对一段对话文本提炼简短标题
  | { id?: string; type: "generate_title"; transcript: string }
  // 扩展管理（读写 settings.json extensions 数组）
  | { id?: string; type: "extensions_list" }
  | { id?: string; type: "extensions_add"; path: string }
  | { id?: string; type: "extensions_remove"; extensionId: string }
  | { id?: string; type: "extensions_set_enabled"; extensionId: string; enabled: boolean }
  | { id?: string; type: "extensions_read_content"; extensionId: string }
  | { id?: string; type: "extensions_create"; name: string; template?: string }
  // 微信机器人
  | { id?: string; type: "weixin_start"; humanId: string }
  | { id?: string; type: "weixin_stop" }
  | { id?: string; type: "weixin_login" }
  | { id?: string; type: "weixin_status" }
  | { id?: string; type: "weixin_switch_human"; humanId: string }
  | { id?: string; type: "weixin_logout" }
  // Telegram 机器人
  | { id?: string; type: "telegram_start"; humanId: string; config: Record<string, unknown> }
  | { id?: string; type: "telegram_stop" }
  | { id?: string; type: "telegram_dispose" }
  | { id?: string; type: "telegram_status" }
  | { id?: string; type: "telegram_update_config"; config: Record<string, unknown> }
  | { id?: string; type: "telegram_reset_pair" }
  // 飞书机器人（channelId 为具体实例，支持多个并行连接）
  | { id?: string; type: "feishu_start"; channelId: string; humanId: string; config: Record<string, unknown> }
  | { id?: string; type: "feishu_stop"; channelId: string }
  | { id?: string; type: "feishu_dispose"; channelId: string }
  | { id?: string; type: "feishu_status"; channelId: string }
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
  | { type: "agent_end"; sessionId: string; messages?: unknown[]; willRetry?: boolean }
  | { type: "agent_settled"; sessionId: string }
  | { type: "turn_start"; sessionId: string }
  | { type: "turn_end"; sessionId: string }
  | { type: "message_start"; sessionId: string; message?: unknown }
  | { type: "message_update"; sessionId: string; assistantMessageEvent?: { type: string; delta?: string; text?: string } }
  | { type: "message_end"; sessionId: string; message?: unknown }
  | { type: "tool_execution_start"; sessionId: string; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; sessionId: string; toolCallId: string; toolName: string; partialResult?: unknown }
  | { type: "tool_execution_end"; sessionId: string; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
  // Nova-PI 扩展事件
  | { type: "usage"; sessionId?: string; callId?: string; promptTokens: number; completionTokens: number; totalTokens: number; cacheRead?: number; cacheWrite?: number; model: string; agentName?: string }
  | { type: "computer_agent_blocked"; sessionId: string; reason: "permission_required" | "invalid_tool_call"; message: string; permissions: string[]; permissionLabels: string[]; invalidToolName?: string }
  | { type: "risk_job_update"; sessionId: string; job: unknown }
  | { type: "session_saved"; conversationId: string; title?: string }
  | {
      type: "model_auth";
      loginId: string;
      providerId: string;
      phase: "auth_url" | "device_code" | "progress" | "complete" | "error" | "cancelled";
      message?: string;
      url?: string;
      userCode?: string;
      defaultModel?: { provider: string; model: string } | null;
    }
  // 微信机器人事件（前端 MessageChannelsPanel 微信卡片订阅）
  | { type: "wechat_qrcode"; qrUrl: string }
  | { type: "wechat_status"; status: "offline" | "awaiting_scan" | "online" | "error"; account?: string; accountName?: string; detail?: string }
  | { type: "wechat_message"; role: "incoming" | "assistant"; reqId?: string; text: string; fromUser?: string }
  // Telegram 机器人事件（前端 telegram 卡片订阅）
  | { type: "telegram_status"; status: "offline" | "awaiting_pair" | "online" | "error"; botUsername?: string; allowedUserId?: string; detail?: string }
  | { type: "telegram_message"; role: "incoming" | "assistant"; reqId?: string; text: string; fromUser?: string }
  // 飞书机器人事件按 channelId 隔离，供多实例状态、实时消息和持久化记录使用
  | { type: "feishu_status"; channelId: string; status: "offline" | "connecting" | "online" | "error"; appName?: string; botOpenId?: string; detail?: string }
  | { type: "feishu_message"; channelId: string; role: "incoming" | "assistant"; reqId: string; eventKey: string; conversationKey: string; text: string; fromUser?: string; timestamp: number }
  | { type: "error"; sessionId?: string; message: string; recoverable?: boolean };

export type RpcEventEnvelope = { type: "event"; event: RpcEvent };

// ─────────────────────────────────────────────────────────────────────────────
// stdout 写入帮助（带背压处理）
// ─────────────────────────────────────────────────────────────────────────────
//
// Node 的 `process.stdout.write(buf)` 在内部写缓冲超过 highWaterMark 时返回 `false`，
// 调用方必须等 `'drain'` 事件再继续写，否则数据会被静默截断。流式 token 事件可达几十/秒，
// 若 Rust 端读取/解析/emitter 跟不上，写缓冲会持续增长，最终导致前端显示残缺甚至
// 行边界错乱（一行 JSON 被截成两半，Rust 端 from_str 失败丢弃整行）。
//
// 下面用一个串行化的 Promise 队列封装所有 stdout 写入：每次写都等待前一次完成，
// write 返回 false 时等 drain 再继续，保证每行 JSON 完整且有序。

let writeQueue: Promise<void> = Promise.resolve();

function writeJsonLine(text: string): Promise<void> {
  writeQueue = writeQueue.then(
    () =>
      new Promise<void>((resolve) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          process.stdout.off("drain", onDrain);
        };
        const canWriteWithoutDrain = process.stdout.write(text);
        if (canWriteWithoutDrain) {
          resolve();
        } else {
          process.stdout.once("drain", onDrain);
        }
      }),
  ).catch((error) => {
    // 单次写失败不应让整个队列永久 reject；记录后继续，避免后续事件全丢。
    console.error("[rpc] stdout 写入失败：", error);
  });
  return writeQueue;
}

/** 写一条同步响应到 stdout（按 id 匹配 pending 请求）。 */
export function writeResponse(id: string | undefined, success: true, data?: unknown): void;
export function writeResponse(id: string | undefined, success: false, error: string): void;
export function writeResponse(id: string | undefined, success: boolean, payload?: unknown): void {
  const response: RpcResponse = success
    ? { id, type: "response", success: true, data: payload }
    : { id, type: "response", success: false, error: typeof payload === "string" ? payload : String(payload ?? "") };
  void writeJsonLine(`${JSON.stringify(response)}\n`);
}

/** 写一条异步事件到 stdout（Rust 以 emit("pi-event") 转发前端）。 */
export function writeEvent(event: RpcEvent): void {
  const envelope: RpcEventEnvelope = { type: "event", event };
  void writeJsonLine(`${JSON.stringify(envelope)}\n`);
}
