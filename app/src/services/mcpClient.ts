import { sendRpc } from "./hostBridge";
import { unwrapMcpToolResult } from "./mcpPayload";

/**
 * 通过 Node sidecar 调用 MCP 工具。
 *
 * 与原 Nova 的差异：原 Nova 直接走 Rust `call_mcp_tool` 命令（Rust 实现 MCP 传输）；
 * 新版走 sidecar RPC `mcp_call`，由 Node 层的 @modelcontextprotocol/client v2 连接外部 MCP 服务。
 *
 * 注意：常规对话流程中，pi 的 agent loop 会自主调用 MCP 工具（每个 MCP 工具已注册为
 * pi customTool），前端无需手动调用。本函数仅供风评等需要显式编排 MCP 调用的场景使用。
 */
export async function callMcpTool<T>(
  serviceId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: { timeoutSecs?: number },
): Promise<T> {
  const raw = await sendRpc<unknown>({
    type: "mcp_call",
    serviceId,
    toolName,
    args,
    timeoutSecs: options?.timeoutSecs,
  });
  return unwrapMcpToolResult(raw) as T;
}
