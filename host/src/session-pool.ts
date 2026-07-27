/**
 * pi AgentSession 生命周期管理 + 事件转发。
 *
 * 每个 conversation 创建一个 AgentSession（noTools:"builtin" + MCP inline extension
 * + 该员工的 system prompt）。pi 的事件流订阅后转发为 RPC event，由 Rust emit 给前端。
 */

import { readFileSync } from "node:fs";
import {
  AgentSession,
  SessionManager,
  createAgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getDigitalHuman, makeGenericHuman } from "./digital-human.js";
import { getModelRuntime, resolveModel, applyApiKey, type HostModelSettings } from "./model-setup.js";
import { writeEvent, type ConversationAttachments } from "./rpc-protocol.js";
import { createSessionResourceLoader } from "./skills/loader.js";

type SessionEntry = {
  sessionId: string;
  conversationId: string;
  session: AgentSession;
  humanId: string;
  /**
   * 后台会话标记。true 表示不写入 conversationToSession（前端主路由找不到），
   * 也不落 SQLite 历史索引。供微信机器人这类"非用户对话"场景使用。
   * 后台会话的事件由 backgroundListeners 单独订阅，不走 forwardEvent 的常规转发。
   */
  isBackground?: boolean;
};

export class SessionPool {
  /** sessionId → entry */
  private sessions = new Map<string, SessionEntry>();
  /** conversationId → sessionId（前端按 conversationId 索引） */
  private conversationToSession = new Map<string, string>();
  private modelSettings: HostModelSettings | null = null;
  /**
   * 后台会话事件监听器集合。
   * 后台会话不写 conversationToSession，常规 forwardEvent 会丢弃它的事件，
   * 因此单独维护一套监听器，让微信机器人等模块能拿到 message_end 等事件。
   */
  private backgroundListeners = new Set<(sessionId: string, event: AgentSessionEvent) => void>();

  constructor() {}

  setResourceLoader(_loader: ResourceLoader): void {
    // base loader 在 skills/loader.ts 里全局缓存；这里保留接口供未来扩展。
    void _loader;
  }

  async setModelSettings(settings: HostModelSettings): Promise<void> {
    applyApiKey(settings);
    const model = resolveModel(settings);
    this.modelSettings = settings;
    await Promise.all(
      Array.from(this.sessions.values(), async (entry) => {
        try {
          await entry.session.setModel(model);
        } catch (error) {
          console.error(`[session-pool] 切换会话模型失败（sessionId=${entry.sessionId}）：`, error);
        }
      }),
    );
  }

  /** 创建新会话。返回 sessionId（供前端后续 prompt/abort 引用）。 */
  async createSession(params: {
    humanId: string;
    conversationId: string;
    mcpServiceId?: string;
    resumeMessages?: Array<{ role: string; content: string }>;
  }): Promise<string> {
    // 若该 conversation 已有 session：仅当 humanId 一致时复用，否则销毁重建。
    // 否则切换数字员工后会沿用旧员工的 system prompt 和 MCP 白名单，角色错乱。
    const existingSessionId = this.conversationToSession.get(params.conversationId);
    if (existingSessionId) {
      const existingEntry = this.sessions.get(existingSessionId);
      if (existingEntry && existingEntry.humanId === params.humanId) {
        return existingSessionId;
      }
      // humanId 变了（用户切换员工）：销毁旧 session，下面重建。
      if (existingEntry) {
        await this.dispose(existingSessionId);
      }
    }

    const human = getDigitalHuman(params.humanId) ?? makeGenericHuman(params.humanId, params.mcpServiceId);
    const model = this.resolveCurrentModel();
    // 把历史对话作为 system prompt 附录灌入，让 pi 在创建时就拥有完整上下文。
    // pi 无"静默灌入 assistant 回复"的公开 API（sendUserMessage 会触发 turn），
    // 因此用 system prompt 承载历史文本，避免协议层撒谎（resumeMessages 之前收到后直接 break）。
    const systemPromptWithHistory = this.injectHistory(human.systemPrompt, params.resumeMessages);
    const sessionResourceLoader = await createSessionResourceLoader(
      systemPromptWithHistory,
      human.allowedMcpServices,
    );

    const sessionId = `pi-${params.conversationId}-${Date.now().toString(36)}`;
    const sessionManager = SessionManager.inMemory();

    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      modelRuntime: getModelRuntime(),
      // 仅禁用 pi 内置 read/bash/edit/write；MCP 作为 extensionFactories
      // 注入，因此必须保留扩展工具。这也是 pi SDK 对嵌入式扩展的标准配置。
      noTools: "builtin",
      resourceLoader: sessionResourceLoader,
      sessionManager,
    });

    // 订阅事件流，转发为 RPC event（sessionId 关联回 conversationId）
    // 包 try/catch：pi 内部抛错不应冒泡到 unhandledRejection 导致进程级问题。
    session.subscribe((event: AgentSessionEvent) => {
      try {
        this.forwardEvent(sessionId, event);
      } catch (error) {
        console.error(`[session-pool] forwardEvent 抛错（sessionId=${sessionId}）：`, error);
      }
    });

    const entry: SessionEntry = { sessionId, conversationId: params.conversationId, session, humanId: params.humanId };
    this.sessions.set(sessionId, entry);
    this.conversationToSession.set(params.conversationId, sessionId);

    return sessionId;
  }

  /**
   * 创建后台会话（如微信机器人专用）。
   * 与 createSession 区别：
   *   - 不写 conversationToSession，前端主路由（按 conversationId 找 sessionId）找不到它，
   *     避免污染用户当前对话视图的事件流。
   *   - 不落 SQLite 历史索引（host 不发 session_saved 类事件）。
   *   - 事件由 backgroundListeners 单独订阅，service 模块据此拿到 message_end 回复。
   * 复用：同一 conversationId 已有同 humanId 的后台会话则复用。
   */
  async createBackgroundSession(params: {
    humanId: string;
    conversationId: string;
    mcpServiceId?: string;
    resumeMessages?: Array<{ role: string; content: string }>;
  }): Promise<string> {
    // 后台会话也用 conversationId 做幂等键（service 内部维护），但不写 conversationToSession。
    for (const entry of this.sessions.values()) {
      if (entry.isBackground && entry.conversationId === params.conversationId && entry.humanId === params.humanId) {
        return entry.sessionId;
      }
    }

    const human = getDigitalHuman(params.humanId) ?? makeGenericHuman(params.humanId, params.mcpServiceId);
    const model = this.resolveCurrentModel();
    const systemPromptWithHistory = this.injectHistory(human.systemPrompt, params.resumeMessages);
    const sessionResourceLoader = await createSessionResourceLoader(
      systemPromptWithHistory,
      human.allowedMcpServices,
    );

    const sessionId = `bg-${params.conversationId}-${Date.now().toString(36)}`;
    const sessionManager = SessionManager.inMemory();

    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      modelRuntime: getModelRuntime(),
      noTools: "builtin",
      resourceLoader: sessionResourceLoader,
      sessionManager,
    });

    session.subscribe((event: AgentSessionEvent) => {
      try {
        this.forwardBackgroundEvent(sessionId, event);
      } catch (error) {
        console.error(`[session-pool] forwardBackgroundEvent 抛错（sessionId=${sessionId}）：`, error);
      }
    });

    const entry: SessionEntry = {
      sessionId,
      conversationId: params.conversationId,
      session,
      humanId: params.humanId,
      isBackground: true,
    };
    this.sessions.set(sessionId, entry);
    return sessionId;
  }

  /** 订阅后台会话事件。返回取消订阅函数。 */
  subscribeBackgroundEvents(listener: (sessionId: string, event: AgentSessionEvent) => void): () => void {
    this.backgroundListeners.add(listener);
    return () => {
      this.backgroundListeners.delete(listener);
    };
  }

  /** 后台会话事件分发：不走 writeEvent（不发给前端），只通知 backgroundListeners。 */
  private forwardBackgroundEvent(sessionId: string, event: AgentSessionEvent): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.isBackground) return;
    for (const listener of this.backgroundListeners) {
      try {
        listener(sessionId, event);
      } catch (error) {
        console.error(`[session-pool] backgroundListener 抛错（sessionId=${sessionId}）：`, error);
      }
    }
  }

  /** 判断 session 是否存在（供 main.ts 的 prompt 命令预校验，避免响应成功后又发 error）。 */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
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

  /** 把历史对话作为附录拼到 system prompt 末尾，让 pi 创建时即拥有上下文。 */
  private injectHistory(
    basePrompt: string,
    resumeMessages?: Array<{ role: string; content: string }>,
  ): string {
    if (!resumeMessages?.length) return basePrompt;
    // 过滤空消息，截取 content 文本（assistant 消息可能是复杂结构，这里取文本即可）。
    const turns = resumeMessages
      .filter((msg) => msg && msg.content && typeof msg.content === "string")
      .slice(-20) // 最多 20 轮，避免 system prompt 过长
      .map((msg) => {
        const role = msg.role === "assistant" ? "助手" : "用户";
        return `${role}：${msg.content}`;
      });
    if (turns.length === 0) return basePrompt;
    return `${basePrompt}\n\n--- 以下是之前的历史对话，作为上下文参考（请基于此继续，不要重复已回答的内容）---\n${turns.join("\n")}`;
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
    if (attachments.files?.length) {
      // 读取每个文件的临时盘路径内容，拼成哨兵段注入。单个文件截断到 50k 字符
      // 避免超大文件撑爆 prompt；读取失败时附错误说明而非整段中断。
      const FILE_CHAR_LIMIT = 50_000;
      const fileSections = attachments.files.map((file) => {
        try {
          const raw = readFileSync(file.path, { encoding: "utf-8" });
          const clipped = raw.length > FILE_CHAR_LIMIT
            ? `${raw.slice(0, FILE_CHAR_LIMIT)}\n...(已截断，原始 ${raw.length} 字符)`
            : raw;
          return `=== 附件文件：${file.name} ===\n${clipped}`;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return `=== 附件文件：${file.name}（读取失败）===\n${reason}`;
        }
      });
      parts.push(fileSections.join("\n\n"));
    }
    if (parts.length === 0) return message;
    return `${parts.join("\n\n")}\n\n用户请求：${message}`;
  }

  private forwardEvent(sessionId: string, event: AgentSessionEvent): void {
    const entry = this.sessions.get(sessionId);
    // dispose 后残留的队列事件直接丢弃，避免发出无 conversationId 的孤儿事件。
    if (!entry) return;
    const conversationId = entry.conversationId;
    // 透传 pi 事件的核心子集；前端按 sessionId→conversationId 映射后更新 ChatMessage。
    // 不同事件类型携带的字段不同，这里统一加 sessionId 后转发。
    const payload = { ...event, sessionId } as Record<string, unknown>;
    // agent_end 时聚合 usage 上报（token 统计）
    if (event.type === "agent_end" && conversationId) {
      this.emitUsageFromAgentEnd(sessionId, event, entry.humanId);
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
