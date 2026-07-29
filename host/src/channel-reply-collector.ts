import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type ChannelReplyCompletion = {
  reqId: string;
  text: string;
};

/**
 * 聚合一次消息渠道请求中的多轮 assistant 输出。
 *
 * pi 在工具调用场景会依次产生：
 * assistant message_end（调用前说明）→ tool events → assistant message_end（最终结果）
 * → agent_settled。消息渠道只能在 agent_settled 后发送最后一条完整回复，否则会把
 * “我先查询一下”这类中间说明当成最终答案，并提前释放回复路由。
 */
export class ChannelReplyCollector {
  private reqId: string | null = null;
  private streamingText = "";
  private latestAssistantText = "";

  begin(reqId: string): void {
    this.reqId = reqId;
    this.streamingText = "";
    this.latestAssistantText = "";
  }

  currentReqId(): string | null {
    return this.reqId;
  }

  reset(): void {
    this.reqId = null;
    this.streamingText = "";
    this.latestAssistantText = "";
  }

  accept(event: AgentSessionEvent): ChannelReplyCompletion | null {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && update.delta && this.reqId) {
        this.streamingText += update.delta;
      } else if (update.type === "text_end" && update.content && this.reqId && !this.streamingText) {
        this.streamingText = update.content;
      }
      return null;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const finalText = assistantMessageText(event.message.content);
      const messageText = finalText || this.streamingText;
      if (messageText.trim()) this.latestAssistantText = messageText;
      // 下一次 assistant 消息属于工具返回后的新一轮，不能与调用前说明拼接。
      this.streamingText = "";
      return null;
    }

    if (event.type !== "agent_settled") return null;
    const reqId = this.reqId;
    if (!reqId) return null;
    const completion = {
      reqId,
      text: this.latestAssistantText || this.streamingText,
    };
    this.reset();
    return completion;
  }
}

function assistantMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => (
      !!item && typeof item === "object" && item.type === "text" && typeof item.text === "string"
    ))
    .map((item) => item.text)
    .join("");
}
