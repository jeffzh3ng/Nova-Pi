import type { RecentTask } from "../types";

export type ConversationPersistenceState = {
  id: string;
  messageFingerprint: string;
  status: RecentTask["status"];
};

/** 消息内容相同但状态变化时仍必须保存，例如 running → done。 */
export function isConversationPersistenceStateCurrent(
  persisted: ConversationPersistenceState | null,
  next: ConversationPersistenceState,
): boolean {
  return persisted?.id === next.id
    && persisted.messageFingerprint === next.messageFingerprint
    && persisted.status === next.status;
}
