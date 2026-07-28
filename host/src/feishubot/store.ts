import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type HistoryEntry = {
  role: "incoming" | "assistant";
  content: string;
  timestamp: number;
};

type HistoryFile = {
  version: 1;
  conversations: Record<string, HistoryEntry[]>;
};

type DedupeFile = {
  version: 1;
  messages: Record<string, number>;
};

const DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 2_000;
const MAX_HISTORY_ENTRIES = 80;

/**
 * 飞书通道在 host 侧保留最小会话恢复信息和持久化去重键。
 * 完整、可展示的消息记录仍由 Rust 拦截 feishu_message 事件后写入本地存储。
 */
export class FeishuChannelStore {
  private readonly historyPath: string;
  private readonly dedupePath: string;

  constructor(agentDir: string, channelId: string) {
    const safeChannelId = channelId.replace(/[^A-Za-z0-9_-]/g, "_");
    const root = join(agentDir, "message-channels", "feishu", safeChannelId);
    mkdirSync(root, { recursive: true });
    this.historyPath = join(root, "history.json");
    this.dedupePath = join(root, "dedupe.json");
  }

  claimMessage(messageId: string): boolean {
    if (!messageId) return true;
    const now = Date.now();
    const store = this.read<DedupeFile>(this.dedupePath, { version: 1, messages: {} });
    for (const [key, seenAt] of Object.entries(store.messages)) {
      if (now - seenAt > DEDUPE_TTL_MS) delete store.messages[key];
    }
    if (store.messages[messageId]) {
      this.write(this.dedupePath, store);
      return false;
    }
    store.messages[messageId] = now;
    const entries = Object.entries(store.messages);
    if (entries.length > MAX_DEDUPE_ENTRIES) {
      entries
        .sort((a, b) => a[1] - b[1])
        .slice(0, entries.length - MAX_DEDUPE_ENTRIES)
        .forEach(([key]) => delete store.messages[key]);
    }
    this.write(this.dedupePath, store);
    return true;
  }

  append(conversationKey: string, role: HistoryEntry["role"], content: string): void {
    const text = content.trim();
    if (!text) return;
    const store = this.read<HistoryFile>(this.historyPath, { version: 1, conversations: {} });
    const history = store.conversations[conversationKey] ?? [];
    history.push({ role, content: text, timestamp: Date.now() });
    store.conversations[conversationKey] = history.slice(-MAX_HISTORY_ENTRIES);
    this.write(this.historyPath, store);
  }

  resumeMessages(conversationKey: string): Array<{ role: string; content: string }> {
    const store = this.read<HistoryFile>(this.historyPath, { version: 1, conversations: {} });
    return (store.conversations[conversationKey] ?? []).slice(-40).map((entry) => ({
      role: entry.role === "incoming" ? "user" : "assistant",
      content: entry.content,
    }));
  }

  private read<T>(path: string, fallback: T): T {
    try {
      if (!existsSync(path)) return fallback;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
      console.warn(`[feishu-store] 读取失败：${path}`, error);
      return fallback;
    }
  }

  private write(path: string, value: unknown): void {
    try {
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn(`[feishu-store] 写入失败：${path}`, error);
    }
  }
}
