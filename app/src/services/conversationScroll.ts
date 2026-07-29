export const CONVERSATION_BOTTOM_THRESHOLD_PX = 48;

type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

/**
 * Treat a small gap as still following the conversation tail. This avoids
 * disabling auto-scroll because of fractional layout/rounding differences.
 */
export function isConversationNearBottom(
  { clientHeight, scrollHeight, scrollTop }: ScrollMetrics,
  threshold = CONVERSATION_BOTTOM_THRESHOLD_PX,
) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
