import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ChannelReplyCollector } from "../channel-reply-collector.js";
import type { SessionPool } from "../session-pool.js";
import { writeEvent } from "../rpc-protocol.js";
import { FeishuChannelStore } from "./store.js";
import { FeishuTransport } from "./transport.js";
import type { FeishuConfig, FeishuIncomingMessage, FeishuStatus } from "./types.js";

type PendingReply = {
  collector: ChannelReplyCollector;
  resolve: () => void;
  done: Promise<void>;
};

type ConversationState = {
  conversationKey: string;
  sessionId: string;
  current?: PendingReply;
};

export class FeishuBotManager {
  private transport: FeishuTransport | null = null;
  private status: FeishuStatus = { kind: "offline" };
  private humanId = "general-chat";
  private unsubscribeBackground: (() => void) | null = null;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly sessionToConversation = new Map<string, ConversationState>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly store: FeishuChannelStore;

  constructor(
    private readonly channelId: string,
    private readonly pool: SessionPool,
    agentDir: string,
  ) {
    this.store = new FeishuChannelStore(agentDir, channelId);
  }

  async start(humanId: string, config: FeishuConfig): Promise<boolean> {
    if (this.transport?.isRunning()) return true;
    this.humanId = humanId;
    this.setStatus({ kind: "connecting" });
    this.unsubscribeBackground = this.pool.subscribeBackgroundEvents((sessionId, event) => {
      this.handleBackgroundEvent(sessionId, event);
    });
    this.transport = new FeishuTransport(config, async (message) => this.enqueue(message));
    try {
      const identity = await this.transport.start();
      this.setStatus({ kind: "online", ...identity });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.transport.stop().catch(() => {});
      this.transport = null;
      this.unsubscribeBackground?.();
      this.unsubscribeBackground = null;
      this.setStatus({ kind: "error", detail });
      return false;
    }
  }

  async stop(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    await transport?.stop().catch(() => {});
    this.unsubscribeBackground?.();
    this.unsubscribeBackground = null;
    const sessions = [...this.sessionToConversation.keys()];
    this.conversations.clear();
    this.sessionToConversation.clear();
    this.queues.clear();
    await Promise.all(sessions.map((sessionId) => this.pool.dispose(sessionId).catch(() => {})));
    this.setStatus({ kind: "offline" });
  }

  getStatus(): FeishuStatus {
    return this.status;
  }

  private enqueue(message: FeishuIncomingMessage): Promise<void> {
    if (!this.store.claimMessage(message.messageId)) return Promise.resolve();
    this.emitMessage("incoming", message, message.text, message.senderOpenId);
    const previous = this.queues.get(message.conversationKey) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.processMessage(message))
      .finally(() => {
        if (this.queues.get(message.conversationKey) === next) {
          this.queues.delete(message.conversationKey);
        }
      });
    this.queues.set(message.conversationKey, next);
    return next;
  }

  private async processMessage(message: FeishuIncomingMessage): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    this.store.append(message.conversationKey, "incoming", message.text);
    let state: ConversationState;
    try {
      state = await this.ensureConversation(message.conversationKey);
    } catch (error) {
      await this.finishReply(
        message.conversationKey,
        message.messageId,
        `数字员工不可用：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const collector = new ChannelReplyCollector();
    collector.begin(message.messageId);
    state.current = { collector, resolve: resolveDone, done };
    try {
      await this.pool.prompt({ sessionId: state.sessionId, message: message.text });
      await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
    } catch (error) {
      state.current = undefined;
      const reply = `数字员工处理失败：${error instanceof Error ? error.message : String(error)}`;
      await this.finishReply(message.conversationKey, message.messageId, reply);
      resolveDone();
    }
  }

  private async ensureConversation(conversationKey: string): Promise<ConversationState> {
    const existing = this.conversations.get(conversationKey);
    if (existing && this.pool.hasSession(existing.sessionId)) return existing;
    if (existing) {
      this.conversations.delete(conversationKey);
      this.sessionToConversation.delete(existing.sessionId);
    }
    const digest = createHash("sha256")
      .update(`${this.channelId}\0${conversationKey}`)
      .digest("hex")
      .slice(0, 24);
    const sessionId = await this.pool.createBackgroundSession({
      humanId: this.humanId,
      conversationId: `nova-feishu-${digest}`,
      resumeMessages: this.store.resumeMessages(conversationKey),
    });
    const state = { conversationKey, sessionId };
    this.conversations.set(conversationKey, state);
    this.sessionToConversation.set(sessionId, state);
    return state;
  }

  private handleBackgroundEvent(sessionId: string, event: AgentSessionEvent): void {
    const state = this.sessionToConversation.get(sessionId);
    const pending = state?.current;
    if (!state || !pending) return;
    const completion = pending.collector.accept(event);
    if (!completion) return;
    state.current = undefined;
    void this.finishReply(
      state.conversationKey,
      completion.reqId,
      completion.text || "数字员工未返回可发送的文本。",
    )
      .finally(pending.resolve);
  }

  private async finishReply(conversationKey: string, reqId: string, text: string): Promise<void> {
    const reply = text.trim();
    if (!reply) return;
    this.store.append(conversationKey, "assistant", reply);
    this.emitMessage("assistant", { messageId: reqId, conversationKey } as FeishuIncomingMessage, reply);
    try {
      await this.transport?.replyText(reqId, reply);
    } catch (error) {
      console.error(`[feishu-manager:${this.channelId}] 回复发送失败`, error);
    }
  }

  private emitMessage(
    role: "incoming" | "assistant",
    message: Pick<FeishuIncomingMessage, "messageId" | "conversationKey">,
    text: string,
    fromUser?: string,
  ): void {
    writeEvent({
      type: "feishu_message",
      channelId: this.channelId,
      role,
      reqId: message.messageId,
      eventKey: `${role}:${message.messageId}`,
      conversationKey: message.conversationKey,
      text,
      fromUser,
      timestamp: Date.now(),
    });
  }

  private setStatus(status: FeishuStatus): void {
    this.status = status;
    if (status.kind === "online") {
      writeEvent({
        type: "feishu_status",
        channelId: this.channelId,
        status: "online",
        appName: status.appName,
        botOpenId: status.botOpenId,
      });
    } else if (status.kind === "error") {
      writeEvent({ type: "feishu_status", channelId: this.channelId, status: "error", detail: status.detail });
    } else {
      writeEvent({ type: "feishu_status", channelId: this.channelId, status: status.kind });
    }
  }
}
