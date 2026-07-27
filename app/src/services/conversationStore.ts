import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, RecentTask } from "../types";

export type ConversationSummary = {
  id: string;
  title: string;
  titleSource: "pending" | "auto" | "manual";
  agentId: string;
  agentName: string;
  status: RecentTask["status"];
  lastMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationSnapshot = {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  status: RecentTask["status"];
  messages: ChatMessage[];
};

export type LoadedConversation = {
  summary: ConversationSummary;
  messages: ChatMessage[];
};

export async function listConversationSummaries() {
  const summaries = await invoke<ConversationSummary[]>("list_conversations");
  return summaries.map(summaryToRecentTask);
}

export async function loadConversation(conversationId: string) {
  return await invoke<LoadedConversation>("load_conversation", { conversationId });
}

export async function saveConversationSnapshot(snapshot: ConversationSnapshot) {
  return await invoke<ConversationSummary>("save_conversation_snapshot", { snapshot });
}

export async function archiveConversation(conversationId: string) {
  return await invoke<void>("archive_conversation", { conversationId });
}

export async function deleteConversation(conversationId: string) {
  return await invoke<void>("delete_conversation", { conversationId });
}

export async function renameConversation(conversationId: string, title: string) {
  return await invoke<void>("rename_conversation", { conversationId, title });
}

export type GeneratedTitleResult = {
  title: string;
  updated: boolean;
};

/** 让后端调用大模型提炼任务名。仅对 titleSource=pending 的活动会话生效。 */
export async function generateConversationTitle(
  conversationId: string,
): Promise<GeneratedTitleResult> {
  return await invoke<GeneratedTitleResult>("generate_conversation_title", { conversationId });
}

export async function restoreConversation(conversationId: string) {
  return await invoke<void>("restore_conversation", { conversationId });
}

export async function listArchivedConversations() {
  const summaries = await invoke<ConversationSummary[]>("list_archived_conversations");
  return summaries.map(summaryToRecentTask);
}

const knownAgentNames = [
  "安全监测数字员工",
  "威胁研判数字员工",
  "漏洞加固数字员工",
  "分类分级数字员工",
  "报告编写数字员工",
  "驻场安全服务数字员工",
  "网安风评数字员工",
  "数安风评数字员工",
  "上线安评数字员工",
  "双新安评数字员工",
  "应急响应数字员工",
  "应急演练数字员工",
  "安全培训数字员工",
  "安全通告数字员工",
];

const retiredAgentNames = new Set([
  "安全监测数字员工",
  "漏洞加固数字员工",
  "分类分级数字员工",
  "报告编写数字员工",
]);

const cleanTitle = (title: string) => {
  const trimmed = title.trim();
  if (knownAgentNames.includes(trimmed)) return "未命名任务";
  return trimmed;
};

export function summaryToRecentTask(summary: ConversationSummary): RecentTask {
  return {
    id: summary.id,
    title: cleanTitle(summary.title),
    status: summary.status,
    time: formatHistoryTime(summary.updatedAt),
    agentId: summary.agentId,
    agentName: retiredAgentNames.has(summary.agentName) ? "驻场安全服务数字员工" : summary.agentName,
    lastMessage: summary.lastMessage,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    titleSource: summary.titleSource,
  };
}

export function refreshRecentTaskTimes(tasks: RecentTask[]): RecentTask[] {
  return tasks.map((task) => ({
    ...task,
    time: task.updatedAt ? formatHistoryTime(task.updatedAt) : task.time,
  }));
}

export function formatHistoryTime(value: string) {
  if (!value) return "";
  // Handle both ISO (with T) and space-separated formats from backend
  const normalized = value.includes("T") ? value : value.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;

  const deltaMs = Math.max(0, Date.now() - date.getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (deltaMs < minute) return "刚刚";
  if (deltaMs < hour) return `${Math.max(1, Math.floor(deltaMs / minute))} 分钟前`;
  if (deltaMs < day) return `${Math.floor(deltaMs / hour)} 小时前`;
  if (deltaMs < 7 * day) return `${Math.floor(deltaMs / day)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}
