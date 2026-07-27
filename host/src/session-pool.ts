/**
 * pi AgentSession 生命周期管理 + 事件转发。
 *
 * 每个 conversation 创建一个 AgentSession（noTools:"all" + customTools 来自 MCP 注册中心
 * + 该员工的 system prompt）。pi 的事件流订阅后转发为 RPC event，由 Rust emit 给前端。
 */

import {
  AgentSession,
  SessionManager,
  createAgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { mcpRegistry } from "./mcp/registry.js";
import { getDigitalHuman, makeGenericHuman } from "./digital-human.js";
import { getModelRuntime, resolveModel, applyApiKey, type HostModelSettings } from "./model-setup.js";
import { writeEvent, type ConversationAttachments } from "./rpc-protocol.js";
import { createSessionResourceLoader } from "./skills/loader.js";

type SessionEntry = {
  sessionId: string;
  conversationId: string;
  session: AgentSession;
  humanId: string;
};

export class SessionPool {
  /** sessionId → entry */
  private sessions = new Map<string, SessionEntry>();
  /** conversationId → sessionId（前端按 conversationId 索引） */
  private conversationToSession = new Map<string, string>();
  private modelSettings: HostModelSettings | null = null;

  constructor() {}

  setResourceLoader(_loader: ResourceLoader): void {
    // base loader 在 skills/loader.ts 里全局缓存；这里保留接口供未来扩展。
    void _loader;
  }

  setModelSettings(settings: HostModelSettings): void {
    this.modelSettings = settings;
  }

  /** 创建新会话。返回 sessionId（供前端后续 prompt/abort 引用）。 */
  async createSession(params: {
    humanId: string;
    conversationId: string;
    mcpServiceId?: string;
    resumeMessages?: Array<{ role: string; content: string }>;
  }): Promise<string> {
    // 若该 conversation 已有 session，先复用（避免重复创建）
    const existing = this.conversationToSession.get(params.conversationId);
    if (existing) return existing;

    const human = getDigitalHuman(params.humanId) ?? makeGenericHuman(params.humanId, params.mcpServiceId);
    const model = this.resolveCurrentModel();
    const customTools = mcpRegistry.buildCustomTools(human.allowedMcpServices);
    // 每个会话构造一个带员工 systemPromptOverride 的 ResourceLoader
    const sessionResourceLoader = createSessionResourceLoader(human.systemPrompt);

    const sessionId = `pi-${params.conversationId}-${Date.now().toString(36)}`;
    const sessionManager = SessionManager.inMemory();

    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      modelRuntime: getModelRuntime(),
      // noTools:"all" 禁用 pi 内置 read/bash/edit/write（桌面工作台不需要文件操作 agent），
      // 所有能力通过 customTools 注入：MCP 工具 + 内置工具（风评/告警/公文）。
      noTools: "all",
      customTools,
      resourceLoader: sessionResourceLoader,
      sessionManager,
    });

    // 订阅事件流，转发为 RPC event（sessionId 关联回 conversationId）
    session.subscribe((event: AgentSessionEvent) => {
      this.forwardEvent(sessionId, event);
    });

    const entry: SessionEntry = { sessionId, conversationId: params.conversationId, session, humanId: params.humanId };
    this.sessions.set(sessionId, entry);
    this.conversationToSession.set(params.conversationId, sessionId);

    // 恢复历史消息（把 resumeMessages 灌入 pi 的上下文，但不重新生成回复）
    if (params.resumeMessages?.length) {
      for (const msg of params.resumeMessages) {
        if (msg.role === "user") {
          // pi 的 session 不直接支持「静默灌入历史」，这里通过 sendUserMessage 把历史
          // 作为上下文累加。MVP 简化：只在无历史时创建干净 session；有历史时仍创建新 session，
          // 让前端发送的 prompt 自带必要上下文（前端已在 submitPrompt 里传 resumeMessages）。
          break;
        }
      }
    }

    return sessionId;
  }

  /** 发送 prompt 到指定会话。流式事件通过 forwardEvent 回流。 */
  async prompt(params: {
    sessionId: string;
    message: string;
    attachments?: ConversationAttachments;
  }): Promise<void> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) throw new Error(`会话不存在：${params.sessionId}`);

    // 附件上下文拼到消息前（PCAP/OCR 哨兵格式，与原 Nova 一致）
    const message = this.injectAttachments(params.message, params.attachments);
    await entry.session.prompt(message);
  }

  /** 中止当前会话的 agent loop。 */
  async abort(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    await entry.session.abort().catch(() => {});
  }

  /** 销毁会话（切换/删除 conversation 时调用）。 */
  async dispose(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    this.conversationToSession.delete(entry.conversationId);
    entry.session.dispose();
  }

  /** 销毁所有会话（shutdown 时调用）。 */
  async disposeAll(): Promise<void> {
    for (const entry of this.sessions.values()) {
      entry.session.dispose();
    }
    this.sessions.clear();
    this.conversationToSession.clear();
  }

  /** 配置变更后，对现有会话重注册工具（新增/移除 MCP 服务）。 */
  refreshTools(): void {
    for (const entry of this.sessions.values()) {
      const human = getDigitalHuman(entry.humanId);
      if (!human) continue;
      // AgentSession 的 customTools 在创建时固定；MVP 不支持运行时动态增删工具，
      // 配置变更后用户需重新发起会话。下次 createSession 会自动带上最新工具集。
      void human;
    }
  }

  // ── 内部 ──

  private resolveCurrentModel(): Model<any> {
    if (this.modelSettings) {
      applyApiKey(this.modelSettings);
      return resolveModel(this.modelSettings);
    }
    // 无配置时回退：尝试 runtime 第一个可用模型，否则抛错
    const runtime = getModelRuntime();
    const models = runtime.getModels();
    const first = models[0];
    if (first) return first as Model<any>;
    throw new Error("未配置大模型，请在设置面板配置 API Key 和模型。");
  }

  private injectAttachments(message: string, attachments?: ConversationAttachments): string {
    if (!attachments) return message;
    const parts: string[] = [];
    if (attachments.pcapSections?.length) {
      parts.push(attachments.pcapSections.join("\n\n"));
    }
    if (attachments.imageSections?.length) {
      parts.push(attachments.imageSections.join("\n\n"));
    }
    if (attachments.alertFields && Object.keys(attachments.alertFields).length) {
      const fieldLines = Object.entries(attachments.alertFields)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`);
      if (fieldLines.length) {
        parts.push(`结构化告警字段：\n${fieldLines.join("\n")}`);
      }
    }
    if (parts.length === 0) return message;
    return `${parts.join("\n\n")}\n\n用户请求：${message}`;
  }

  private forwardEvent(sessionId: string, event: AgentSessionEvent): void {
    const entry = this.sessions.get(sessionId);
    const conversationId = entry?.conversationId;
    // 透传 pi 事件的核心子集；前端按 sessionId→conversationId 映射后更新 ChatMessage。
    // 不同事件类型携带的字段不同，这里统一加 sessionId 后转发。
    const payload = { ...event, sessionId } as Record<string, unknown>;
    // agent_end 时聚合 usage 上报（token 统计）
    if (event.type === "agent_end" && conversationId) {
      this.emitUsageFromAgentEnd(sessionId, event, entry?.humanId);
    }
    writeEvent(payload as Parameters<typeof writeEvent>[0]);
  }

  private emitUsageFromAgentEnd(sessionId: string, event: AgentSessionEvent, humanId?: string): void {
    if (event.type !== "agent_end") return;
    const messages = (event as { messages?: Array<{ role?: string; usage?: Record<string, number> }> }).messages ?? [];
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let model = "unknown";
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.usage) continue;
      promptTokens += msg.usage.input ?? 0;
      completionTokens += msg.usage.output ?? 0;
      totalTokens += msg.usage.totalTokens ?? 0;
      cacheRead += msg.usage.cacheRead ?? 0;
      cacheWrite += msg.usage.cacheWrite ?? 0;
    }
    if (totalTokens === 0 && promptTokens === 0 && completionTokens === 0) return;
    const entry = this.sessions.get(sessionId);
    const settings = entry ? this.modelSettings : null;
    model = settings?.model ?? model;
    writeEvent({
      type: "usage",
      sessionId,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheRead,
      cacheWrite,
      model,
      agentName: humanId,
    });
  }
}
