/**
 * pi AgentSession 生命周期管理 + 事件转发。
 *
 * 每个 conversation 创建一个 AgentSession（noTools:"builtin" + MCP inline extension
 * + 该员工的 system prompt）。pi 的事件流订阅后转发为 RPC event，由 Rust emit 给前端。
 */

import {
  AgentSession,
  SessionManager,
  createAgentSession,
  type AgentSessionEvent,
  type InlineExtension,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { getDigitalHuman, makeGenericHuman } from "./digital-human.js";
import { getModelRuntime, resolveModel, applyApiKey, type HostModelSettings } from "./model-setup.js";
import { writeEvent, type ConversationAttachments } from "./rpc-protocol.js";
import { createSessionResourceLoader } from "./skills/loader.js";
import { AttachmentRuntime, type AgentAttachment } from "./attachments.js";
import { MCP_PROXY_TOOL_NAME } from "./mcp/extension.js";
import { DocumentRuntime } from "./document/document-runtime.js";
import { DOCUMENT_TOOL_NAME } from "./document/document-tool.js";
import { createOcrClient } from "./document/ocr-client.js";
import { SEND_FILE_TOOL_NAME } from "./channel-tools.js";
import { ImageArtifactStore, type PersistedImageResult } from "./mcp/image-artifacts.js";
import {
  builtInToolNamesForSettings,
  COMPUTER_AGENT_ID,
  computerAgentAuthorizationPrompt,
  createComputerAgentTools,
  customToolNamesForSettings,
  DEFAULT_COMPUTER_AGENT_SETTINGS,
  detectComputerAgentPermissionBlock,
  detectInvalidComputerToolCall,
  normalizeComputerAgentSettings,
  validateComputerAgentSettings,
  type ComputerAgentBlock,
  type ComputerAgentSettings,
  type NovaConversationContext,
  type NovaRuntimeSession,
  type NovaStatusSnapshot,
} from "./computer-agent.js";

type SessionEntry = {
  sessionId: string;
  conversationId: string;
  session: AgentSession;
  humanId: string;
  mcpServiceId?: string;
  attachments: AttachmentRuntime;
  documents: DocumentRuntime;
  /**
   * 后台会话标记。true 表示不写入 conversationToSession（前端主路由找不到），
   * 也不落 SQLite 历史索引。供微信机器人这类"非用户对话"场景使用。
   * 后台会话的事件由 backgroundListeners 单独订阅，不走 forwardEvent 的常规转发。
   */
  isBackground?: boolean;
  status: "idle" | "running";
  createdAt: number;
  lastActivityAt: number;
  activeTool?: string;
};

export class SessionPool {
  /** sessionId → entry */
  private sessions = new Map<string, SessionEntry>();
  /** conversationId → sessionId（前端按 conversationId 索引） */
  private conversationToSession = new Map<string, string>();
  private modelSettings: HostModelSettings | null = null;
  /** 智谱 OCR API Key（由 configure_ocr RPC 推送，null=未配置，内置 OCR 自动降级 vision）。 */
  private ocrApiKey: string | null = null;
  /**
   * usage 事件的自增序号，与 sessionId 组合形成全局唯一 callId（幂等键）。
   * Rust 端按 callId 去重落库，防止 host 重启/事件重放导致 token 统计重复累加。
   */
  private usageCallCounter = 0;
  /**
   * 后台会话事件监听器集合。
   * 后台会话不写 conversationToSession，常规 forwardEvent 会丢弃它的事件，
   * 因此单独维护一套监听器，让微信机器人等模块能拿到 message_end 等事件。
   */
  private backgroundListeners = new Set<(sessionId: string, event: AgentSessionEvent) => void>();
  private computerAgentSettings: ComputerAgentSettings = { ...DEFAULT_COMPUTER_AGENT_SETTINGS };
  private novaConversations: NovaConversationContext[] = [];

  constructor(
    private readonly attachmentRoot: string,
    private readonly generatedImageRoot: string,
  ) {}

  setResourceLoader(_loader: ResourceLoader): void {
    // base loader 在 skills/loader.ts 里全局缓存；这里保留接口供未来扩展。
    void _loader;
  }

  async cacheRemoteImages(
    conversationId: string,
    urls: string[],
    label = "assistant-image",
  ): Promise<PersistedImageResult> {
    const imageArtifacts = new ImageArtifactStore(
      join(this.generatedImageRoot, this.safeConversationSegment(conversationId)),
    );
    return imageArtifacts.persistFromMcpResult(
      { images: urls.map((url) => ({ url })) },
      label,
    );
  }

  async cacheSandboxImages(
    conversationId: string,
    references: string[],
  ): Promise<PersistedImageResult> {
    if (!this.computerAgentSettings.enabled || !this.computerAgentSettings.allowFileRead) {
      throw new Error("恢复本机生成图片需要启用 Nova 并授权读取文件。");
    }
    const imageArtifacts = new ImageArtifactStore(
      join(this.generatedImageRoot, this.safeConversationSegment(conversationId)),
    );
    return imageArtifacts.persistSandboxReferences(
      references,
      this.computerAgentSettings.workingDirectory,
    );
  }

  async setModelSettings(settings: HostModelSettings): Promise<void> {
    applyApiKey(settings);
    const model = resolveModel(settings);
    this.modelSettings = settings;
    await Promise.all(
      Array.from(this.sessions.values(), async (entry) => {
        try {
          await entry.session.setModel(model);
          entry.documents.setVisionSupported(model.input.includes("image"));
        } catch (error) {
          console.error(`[session-pool] 切换会话模型失败（sessionId=${entry.sessionId}）：`, error);
        }
      }),
    );
  }

  /** 接收 Rust 推送的智谱 OCR API Key；影响所有后续 document.ocr 调用。 */
  setOcrApiKey(apiKey: string | null): void {
    const trimmed = apiKey?.trim();
    this.ocrApiKey = trimmed && trimmed.length > 0 ? trimmed : null;
  }

  private ocrClient() {
    // 箭头闭包按引用读取 this.ocrApiKey，configure_ocr 后即时生效。
    return createOcrClient(() => this.ocrApiKey);
  }

  async configureComputerAgent(settings: unknown): Promise<ComputerAgentSettings> {
    const normalized = normalizeComputerAgentSettings(settings);
    await validateComputerAgentSettings(normalized);
    const changed = JSON.stringify(normalized) !== JSON.stringify(this.computerAgentSettings);
    this.computerAgentSettings = normalized;
    if (changed) {
      const computerSessions = [...this.sessions.values()]
        .filter((entry) => entry.humanId === COMPUTER_AGENT_ID)
        .map((entry) => entry.sessionId);
      for (const sessionId of computerSessions) {
        const entry = this.sessions.get(sessionId);
        if (entry?.status === "running") await entry.session.abort().catch(() => {});
        await this.dispose(sessionId);
      }
    }
    return { ...this.computerAgentSettings };
  }

  updateNovaContext(conversations: NovaConversationContext[]): void {
    this.novaConversations = conversations
      .filter((item) => item && typeof item.id === "string" && item.id.trim())
      .slice(0, 160)
      .map((item) => ({
        id: item.id,
        title: String(item.title || "未命名任务").slice(0, 120),
        agentId: item.agentId,
        agentName: item.agentName,
        status: (["done", "running", "paused", "canceled"].includes(item.status)
          ? item.status
          : "paused") as NovaConversationContext["status"],
        updatedAt: item.updatedAt,
        archived: item.archived === true,
        messageCount: Number.isFinite(item.messageCount) ? Math.max(0, Number(item.messageCount)) : undefined,
      }));
  }

  getNovaStatus(): NovaStatusSnapshot {
    const sessions: NovaRuntimeSession[] = [...this.sessions.values()].map((entry) => ({
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      humanId: entry.humanId,
      status: entry.status,
      background: entry.isBackground === true,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
      activeTool: entry.activeTool,
    }));
    const liveByConversation = new Map(sessions.map((entry) => [entry.conversationId, entry]));
    const conversations = this.novaConversations.map((item) => ({
      ...item,
      status: liveByConversation.get(item.id)?.status === "running" ? "running" as const : item.status,
    }));
    return {
      host: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
      },
      totals: {
        conversations: conversations.length,
        sessions: sessions.length,
        running: sessions.filter((entry) => entry.status === "running").length,
        background: sessions.filter((entry) => entry.background).length,
      },
      conversations,
      sessions,
    };
  }

  async manageNovaTask(
    conversationId: string,
    action: "abort" | "dispose",
    requesterConversationId = "",
  ): Promise<{ ok: boolean; message: string }> {
    if (!conversationId) return { ok: false, message: "conversationId 不能为空。" };
    if (conversationId === requesterConversationId) {
      return { ok: false, message: "不能从当前任务内部中止或释放自身会话，请使用界面的停止按钮。" };
    }
    const entry = [...this.sessions.values()].find((item) => item.conversationId === conversationId);
    if (!entry) return { ok: false, message: `未找到正在加载的会话：${conversationId}` };
    if (action === "abort") {
      if (entry.status !== "running") return { ok: false, message: "目标任务当前不在运行。" };
      await entry.session.abort();
      entry.status = "idle";
      entry.activeTool = undefined;
      entry.lastActivityAt = Date.now();
      return { ok: true, message: `已中止任务 ${conversationId}。` };
    }
    if (entry.status === "running") return { ok: false, message: "目标任务仍在运行，请先中止再释放会话。" };
    await this.dispose(entry.sessionId);
    return { ok: true, message: `已释放会话 ${conversationId}，下次对话会重新创建。` };
  }

  /** 创建新会话。返回 sessionId（供前端后续 prompt/abort 引用）。 */
  async createSession(params: {
    humanId: string;
    conversationId: string;
    mcpServiceId?: string;
    resumeMessages?: Array<{ role: string; content: string }>;
    resumeAttachments?: AgentAttachment[];
  }): Promise<string> {
    // 若该 conversation 已有 session：仅当员工与 MCP 绑定均一致时复用，否则销毁重建。
    // 否则切换数字员工后会沿用旧员工的 system prompt 和 MCP 白名单，角色错乱。
    const existingSessionId = this.conversationToSession.get(params.conversationId);
    if (existingSessionId) {
      const existingEntry = this.sessions.get(existingSessionId);
      if (
        existingEntry
        && existingEntry.humanId === params.humanId
        && existingEntry.mcpServiceId === params.mcpServiceId
      ) {
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
    const computerSetup = await this.computerAgentSetup(params.humanId, params.conversationId);
    const attachmentRuntime = new AttachmentRuntime(this.attachmentRoot, params.resumeAttachments);
    const imageArtifacts = new ImageArtifactStore(
      join(this.generatedImageRoot, this.safeConversationSegment(params.conversationId)),
    );
    const documentRuntime = new DocumentRuntime(attachmentRuntime, model.input.includes("image"), (artifactPath) => imageArtifacts.readArtifact(artifactPath), this.ocrClient());
    const systemPromptWithHistory = this.computerAgentSystemPrompt(
      this.injectHistory(human.systemPrompt, params.resumeMessages),
      computerSetup,
    );
    const sessionResourceLoader = await createSessionResourceLoader(
      systemPromptWithHistory,
      human.allowedMcpServices,
      computerSetup.cwd,
      computerSetup.allowSkills,
      attachmentRuntime,
      documentRuntime,
      imageArtifacts,
    );

    const sessionId = `pi-${params.conversationId}-${Date.now().toString(36)}`;
    const sessionManager = SessionManager.inMemory(computerSetup.cwd);

    const { session } = await createAgentSession({
      model,
      thinkingLevel: computerSetup.isComputerAgent ? "medium" : "off",
      modelRuntime: getModelRuntime(),
      // 仅禁用 pi 内置 read/bash/edit/write；MCP 作为 extensionFactories
      // 注入，因此必须保留扩展工具。这也是 pi SDK 对嵌入式扩展的标准配置。
      ...(computerSetup.isComputerAgent
        ? { tools: computerSetup.tools, customTools: computerSetup.customTools }
        : { noTools: "builtin" as const }),
      cwd: computerSetup.cwd,
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

    const now = Date.now();
    const entry: SessionEntry = {
      sessionId,
      conversationId: params.conversationId,
      session,
      humanId: params.humanId,
      mcpServiceId: params.mcpServiceId,
      attachments: attachmentRuntime,
      documents: documentRuntime,
      status: "idle",
      createdAt: now,
      lastActivityAt: now,
    };
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
   *   - 事件由 backgroundListeners 单独订阅，service 模块据此聚合到 agent_settled 后回复。
   * 复用：同一 conversationId 已有同 humanId 的后台会话则复用。
   */
  async createBackgroundSession(params: {
    humanId: string;
    conversationId: string;
    mcpServiceId?: string;
    resumeMessages?: Array<{ role: string; content: string }>;
    channelExtension?: InlineExtension;
  }): Promise<string> {
    // 后台会话也用 conversationId 做幂等键（service 内部维护），但不写 conversationToSession。
    for (const entry of this.sessions.values()) {
      if (
        entry.isBackground
        && entry.conversationId === params.conversationId
        && entry.humanId === params.humanId
        && entry.mcpServiceId === params.mcpServiceId
      ) {
        return entry.sessionId;
      }
    }

    const human = getDigitalHuman(params.humanId) ?? makeGenericHuman(params.humanId, params.mcpServiceId);
    const model = this.resolveCurrentModel();
    const computerSetup = await this.computerAgentSetup(params.humanId, params.conversationId);
    const attachmentRuntime = new AttachmentRuntime(this.attachmentRoot);
    const imageArtifacts = new ImageArtifactStore(
      join(this.generatedImageRoot, this.safeConversationSegment(params.conversationId)),
    );
    const documentRuntime = new DocumentRuntime(attachmentRuntime, model.input.includes("image"), (artifactPath) => imageArtifacts.readArtifact(artifactPath), this.ocrClient());
    const systemPromptWithHistory = this.computerAgentSystemPrompt(
      this.injectHistory(human.systemPrompt, params.resumeMessages),
      computerSetup,
    );
    const sessionResourceLoader = await createSessionResourceLoader(
      systemPromptWithHistory,
      human.allowedMcpServices,
      computerSetup.cwd,
      computerSetup.allowSkills,
      attachmentRuntime,
      documentRuntime,
      imageArtifacts,
      params.channelExtension,
    );

    const sessionId = `bg-${params.conversationId}-${Date.now().toString(36)}`;
    const sessionManager = SessionManager.inMemory(computerSetup.cwd);

    const { session } = await createAgentSession({
      model,
      thinkingLevel: computerSetup.isComputerAgent ? "medium" : "off",
      modelRuntime: getModelRuntime(),
      ...(computerSetup.isComputerAgent
        ? { tools: computerSetup.tools, customTools: computerSetup.customTools }
        : { noTools: "builtin" as const }),
      cwd: computerSetup.cwd,
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

    const now = Date.now();
    const entry: SessionEntry = {
      sessionId,
      conversationId: params.conversationId,
      session,
      humanId: params.humanId,
      mcpServiceId: params.mcpServiceId,
      attachments: attachmentRuntime,
      documents: documentRuntime,
      isBackground: true,
      status: "idle",
      createdAt: now,
      lastActivityAt: now,
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
    this.updateEntryRuntime(entry, event);
    const forwardedEvent = this.sanitizeBackgroundComputerAgentEvent(entry, event);
    for (const listener of this.backgroundListeners) {
      try {
        listener(sessionId, forwardedEvent);
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

    if (entry.humanId === COMPUTER_AGENT_ID) {
      const blocked = detectComputerAgentPermissionBlock(params.message, this.computerAgentSettings);
      if (blocked) {
        this.deliverComputerAgentBlock(entry, blocked);
        return;
      }
    }

    entry.status = "running";
    entry.lastActivityAt = Date.now();
    const message = await entry.attachments.buildPrompt(params.message, params.attachments);
    try {
      await entry.session.prompt(message);
    } catch (error) {
      entry.status = "idle";
      entry.activeTool = undefined;
      entry.lastActivityAt = Date.now();
      throw error;
    }
  }

  /**
   * 中止当前会话的 agent loop。
   *
   * 不再静默吞错：abort 失败（pi 内部状态机错误等）会向上抛出，由 main.ts 的 abort
   * case 接住并 emit error 事件。否则前端拿到 success:true 以为已中止，UI 退出 busy，
   * 但 agent loop 实际仍在跑，只能等 5min 安全超时兜底——状态机不一致。
   */
  async abort(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return; // 会话不存在视为已中止，不算错误。
    await entry.session.abort();
    entry.status = "idle";
    entry.activeTool = undefined;
    entry.lastActivityAt = Date.now();
  }

  async reloadSkillSessions(): Promise<void> {
    const sessionIds = [...this.sessions.values()]
      .filter((entry) => entry.humanId === COMPUTER_AGENT_ID)
      .map((entry) => entry.sessionId);
    for (const sessionId of sessionIds) {
      const entry = this.sessions.get(sessionId);
      if (entry?.status === "running") await entry.session.abort().catch(() => {});
      await this.dispose(sessionId);
    }
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

  private async computerAgentSetup(humanId: string, conversationId: string): Promise<{
    isComputerAgent: boolean;
    cwd: string;
    allowSkills: boolean;
    tools?: string[];
    customTools?: ToolDefinition[];
    authorizationPrompt?: string;
  }> {
    if (humanId !== COMPUTER_AGENT_ID) {
      return { isComputerAgent: false, cwd: process.cwd(), allowSkills: false };
    }
    const settings = this.computerAgentSettings;
    if (!settings.enabled) {
      throw new Error("Nova 尚未启用，请在设置 > 智能员工中开启并授权。");
    }
    await validateComputerAgentSettings(settings);
    const customTools = createComputerAgentTools(settings, {
      currentConversationId: conversationId,
      getNovaStatus: () => this.getNovaStatus(),
      manageNovaTask: (targetId, action, requesterId) => this.manageNovaTask(targetId, action, requesterId),
    });
    return {
      isComputerAgent: true,
      cwd: settings.workingDirectory,
      allowSkills: settings.allowSkills,
      // The computer agent uses an explicit pi tool allowlist for host-enforced
      // native permissions. Extension tools are filtered by that same list, so
      // the MCP proxy must be named explicitly as Nova's always-available base
      // capability; the extension still limits it to enabled MCP configs.
      tools: [
        ...builtInToolNamesForSettings(settings),
        ...customToolNamesForSettings(settings),
        MCP_PROXY_TOOL_NAME,
        DOCUMENT_TOOL_NAME,
        // 消息渠道后台会话注入的 send_file_to_channel 工具也需显式列入白名单，
        // 否则 computer-agent 的 tools 白名单会把它过滤掉。
        SEND_FILE_TOOL_NAME,
      ],
      customTools,
      authorizationPrompt: computerAgentAuthorizationPrompt(settings),
    };
  }

  private safeConversationSegment(conversationId: string): string {
    const safe = conversationId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
    return safe || "conversation";
  }

  private computerAgentSystemPrompt(
    basePrompt: string,
    setup: { isComputerAgent: boolean; authorizationPrompt?: string },
  ): string {
    if (!setup.isComputerAgent || !setup.authorizationPrompt) return basePrompt;
    return `${basePrompt}\n\n${setup.authorizationPrompt}`;
  }

  private assistantText(event: AgentSessionEvent): string {
    if (event.type !== "message_end" || event.message?.role !== "assistant") return "";
    const content = event.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((item): item is { type: "text"; text: string } => (
        !!item && typeof item === "object" && item.type === "text" && typeof item.text === "string"
      ))
      .map((item) => item.text)
      .join("");
  }

  private syntheticAssistantMessageEnd(text: string): AgentSessionEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "nova-pi",
        model: "computer-agent-guard",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    } as AgentSessionEvent;
  }

  private notifyBackgroundListeners(sessionId: string, event: AgentSessionEvent): void {
    for (const listener of this.backgroundListeners) {
      try {
        listener(sessionId, event);
      } catch (error) {
        console.error(`[session-pool] backgroundListener 抛错（sessionId=${sessionId}）：`, error);
      }
    }
  }

  private deliverComputerAgentBlock(entry: SessionEntry, blocked: ComputerAgentBlock): void {
    entry.status = "idle";
    entry.activeTool = undefined;
    entry.lastActivityAt = Date.now();
    if (entry.isBackground) {
      this.notifyBackgroundListeners(entry.sessionId, this.syntheticAssistantMessageEnd(blocked.message));
      // 正常 pi prompt 会在整轮处理结束后发 agent_settled；权限预检在模型调用前返回，
      // 因此需要补发 settled，让消息渠道释放回复并推进队列。
      this.notifyBackgroundListeners(entry.sessionId, { type: "agent_settled" });
      return;
    }
    writeEvent({
      type: "computer_agent_blocked",
      sessionId: entry.sessionId,
      reason: blocked.reason,
      message: blocked.message,
      permissions: blocked.permissions,
      permissionLabels: blocked.permissionLabels,
      invalidToolName: blocked.invalidToolName,
    });
  }

  private sanitizeBackgroundComputerAgentEvent(
    entry: SessionEntry,
    event: AgentSessionEvent,
  ): AgentSessionEvent {
    if (entry.humanId !== COMPUTER_AGENT_ID || event.type !== "message_end") return event;
    const blocked = detectInvalidComputerToolCall(this.assistantText(event), this.computerAgentSettings);
    return blocked ? this.syntheticAssistantMessageEnd(blocked.message) : event;
  }

  private updateEntryRuntime(entry: SessionEntry, event: AgentSessionEvent): void {
    entry.lastActivityAt = Date.now();
    if (event.type === "agent_start" || event.type === "turn_start") entry.status = "running";
    if (event.type === "agent_settled") {
      entry.status = "idle";
      entry.activeTool = undefined;
    }
    if (event.type === "tool_execution_start") entry.activeTool = event.toolName;
    if (event.type === "tool_execution_end" && entry.activeTool === event.toolName) entry.activeTool = undefined;
  }

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

  private forwardEvent(sessionId: string, event: AgentSessionEvent): void {
    const entry = this.sessions.get(sessionId);
    // dispose 后残留的队列事件直接丢弃，避免发出无 conversationId 的孤儿事件。
    if (!entry) return;
    this.updateEntryRuntime(entry, event);
    const conversationId = entry.conversationId;
    if (entry.humanId === COMPUTER_AGENT_ID && event.type === "message_end") {
      const blocked = detectInvalidComputerToolCall(this.assistantText(event), this.computerAgentSettings);
      if (blocked) {
        this.deliverComputerAgentBlock(entry, blocked);
        return;
      }
    }
    // 透传 pi 事件的核心子集；前端按 sessionId→conversationId 映射后更新 ChatMessage。
    // 不同事件类型携带的字段不同，这里统一加 sessionId 后转发。
    const sanitizedEvent = this.sanitizeSensitiveToolEvent(event);
    const payload = { ...sanitizedEvent, sessionId } as Record<string, unknown>;
    // agent_end 时聚合 usage 上报（token 统计）
    if (event.type === "agent_end" && conversationId) {
      this.emitUsageFromAgentEnd(sessionId, event, entry.humanId);
    }
    writeEvent(payload as Parameters<typeof writeEvent>[0]);
  }

  private sanitizeSensitiveToolEvent(event: AgentSessionEvent): AgentSessionEvent {
    if (event.type !== "tool_execution_start" || event.toolName !== "skill_configure_environment") {
      return event;
    }
    const args = event.args && typeof event.args === "object"
      ? { ...(event.args as Record<string, unknown>), value: "[REDACTED]" }
      : event.args;
    return { ...event, args } as AgentSessionEvent;
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
    // 附带 callId 作为幂等键：host 重启或事件重放时，Rust 端按 callId 去重，
    // 避免 list_token_usage 重复累加。sessionId 本身每次 createSession 都新生成
    // （pi-{conversationId}-{timestamp}），但同一 session 的多次 agent_end 仍会
    // 产生多个 usage 事件，所以用 sessionId + 自增序号组成全局唯一 callId。
    this.usageCallCounter += 1;
    writeEvent({
      type: "usage",
      sessionId,
      callId: `${sessionId}#${this.usageCallCounter}`,
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
