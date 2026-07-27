/**
 * Pi 扩展管理服务：封装 host 的 extensions_* RPC，供 ExtensionsPanel 调用。
 *
 * pi 扩展是 TypeScript 文件（导出 default 工厂函数），可注册 tool/command/provider/hook。
 * 发现路径：settings.json 的 extensions 数组 + 全局扩展目录扫描。
 */

import { sendRpc } from "./hostBridge";
import type { ExtensionSummary } from "./hostBridge";

/** 列出全部扩展（settings.json 声明的 + 全局目录扫描的）。 */
export async function listExtensions(): Promise<{ extensions: ExtensionSummary[]; errors: string[] }> {
  return await sendRpc<{ extensions: ExtensionSummary[]; errors: string[] }>({ type: "extensions_list" });
}

/** 新增一个扩展路径（本地 .ts 文件或目录）。 */
export async function addExtension(path: string): Promise<void> {
  await sendRpc({ type: "extensions_add", path });
}

/** 从 settings.json 移除一个扩展（不删磁盘文件）。 */
export async function removeExtension(extensionId: string): Promise<void> {
  await sendRpc({ type: "extensions_remove", extensionId });
}

/** 启用/禁用扩展（加入/移出 settings.json extensions 数组）。 */
export async function setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
  await sendRpc({ type: "extensions_set_enabled", extensionId, enabled });
}

/** 读取扩展文件内容（前端详情面板展示源码）。 */
export async function readExtensionContent(extensionId: string): Promise<string> {
  return await sendRpc<string>({ type: "extensions_read_content", extensionId });
}

/** 创建新扩展文件（带模板代码），并自动加入 settings.json。 */
export async function createExtension(name: string, template?: string): Promise<ExtensionSummary> {
  return await sendRpc<ExtensionSummary>({ type: "extensions_create", name, template });
}

/** 默认扩展模板（前端"新建"时预填，与 host 端 DEFAULT_EXTENSION_TEMPLATE 一致）。 */
export const DEFAULT_EXTENSION_TEMPLATE = `/**
 * Pi 扩展：<描述你的扩展功能>
 * 文档：https://pi.dev/docs/latest/extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 监听 agent 生命周期事件
  pi.on("agent_start", () => {
    console.log("[扩展] agent 启动");
  });

  // 注册一个自定义工具（LLM 可按需调用）
  pi.registerTool({
    name: "my_tool",
    label: "我的工具",
    description: "在这里描述工具的用途，LLM 会据此决定是否调用。",
    parameters: Type.Object({
      input: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      return {
        content: [{ type: "text", text: \`处理了：\${params.input}\` }],
        details: {},
      };
    },
  });

  // 注册一个斜杠命令
  pi.registerCommand("mycommand", {
    description: "我的命令",
    handler: async (args, ctx) => {
      ctx.ui.notify(\`执行了 mycommand：\${args}\`, "info");
    },
  });
}
`;
