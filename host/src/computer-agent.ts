import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const COMPUTER_AGENT_ID = "nova-computer-agent";

export type ComputerAgentSettings = {
  enabled: boolean;
  displayName: string;
  workingDirectory: string;
  allowFileRead: boolean;
  allowFileWrite: boolean;
  allowCommandExecution: boolean;
  allowComputerInfo: boolean;
  allowNovaManagement: boolean;
};

export type ComputerAgentPermission =
  | "file_read"
  | "file_write"
  | "command_execution"
  | "computer_info"
  | "nova_management";

export type ComputerAgentBlock = {
  reason: "permission_required" | "invalid_tool_call";
  message: string;
  permissions: ComputerAgentPermission[];
  permissionLabels: string[];
  invalidToolName?: string;
};

export type NovaConversationContext = {
  id: string;
  title: string;
  agentId?: string;
  agentName?: string;
  status: "done" | "running" | "paused" | "canceled";
  updatedAt?: string;
  archived?: boolean;
  messageCount?: number;
};

export type NovaRuntimeSession = {
  sessionId: string;
  conversationId: string;
  humanId: string;
  status: "idle" | "running";
  background: boolean;
  createdAt: number;
  lastActivityAt: number;
  activeTool?: string;
};

export type NovaStatusSnapshot = {
  host: {
    pid: number;
    uptimeSeconds: number;
    nodeVersion: string;
    platform: string;
  };
  totals: {
    conversations: number;
    sessions: number;
    running: number;
    background: number;
  };
  conversations: NovaConversationContext[];
  sessions: NovaRuntimeSession[];
};

export type ComputerAgentToolContext = {
  currentConversationId: string;
  getNovaStatus(): NovaStatusSnapshot;
  manageNovaTask(
    conversationId: string,
    action: "abort" | "dispose",
    requesterConversationId: string,
  ): Promise<{ ok: boolean; message: string }>;
};

export const DEFAULT_COMPUTER_AGENT_SETTINGS: ComputerAgentSettings = {
  enabled: false,
  displayName: "Nova",
  workingDirectory: os.homedir(),
  allowFileRead: false,
  allowFileWrite: false,
  allowCommandExecution: false,
  allowComputerInfo: false,
  allowNovaManagement: false,
};

export function normalizeComputerAgentSettings(value: unknown): ComputerAgentSettings {
  const input = (value && typeof value === "object" ? value : {}) as Partial<ComputerAgentSettings>;
  return {
    enabled: input.enabled === true,
    displayName: String(input.displayName || DEFAULT_COMPUTER_AGENT_SETTINGS.displayName).trim().slice(0, 40),
    workingDirectory: path.resolve(String(input.workingDirectory || os.homedir()).trim()),
    allowFileRead: input.allowFileRead === true,
    allowFileWrite: input.allowFileWrite === true,
    allowCommandExecution: input.allowCommandExecution === true,
    allowComputerInfo: input.allowComputerInfo === true,
    allowNovaManagement: input.allowNovaManagement === true,
  };
}

export async function validateComputerAgentSettings(settings: ComputerAgentSettings): Promise<void> {
  if (!settings.displayName) throw new Error("智能员工名称不能为空。");
  if (!path.isAbsolute(settings.workingDirectory)) throw new Error("智能员工工作目录必须是绝对路径。");
  const metadata = await stat(settings.workingDirectory).catch(() => null);
  if (!metadata?.isDirectory()) throw new Error("智能员工工作目录不存在或不是文件夹。");
}

export function builtInToolNamesForSettings(settings: ComputerAgentSettings): string[] {
  const names: string[] = [];
  if (settings.allowFileRead) names.push("read", "grep", "find", "ls");
  if (settings.allowCommandExecution) names.push("bash");
  if (settings.allowFileWrite) names.push("edit", "write");
  return names;
}

const PERMISSION_LABELS: Record<ComputerAgentPermission, string> = {
  file_read: "读取文件",
  file_write: "修改文件与编程",
  command_execution: "执行命令",
  computer_info: "查看设备信息",
  nova_management: "管理 Nova",
};

const permissionEnabled = (
  settings: ComputerAgentSettings,
  permission: ComputerAgentPermission,
): boolean => {
  switch (permission) {
    case "file_read": return settings.allowFileRead;
    case "file_write": return settings.allowFileWrite;
    case "command_execution": return settings.allowCommandExecution;
    case "computer_info": return settings.allowComputerInfo;
    case "nova_management": return settings.allowNovaManagement;
  }
};

const uniquePermissions = (permissions: ComputerAgentPermission[]) => (
  [...new Set(permissions)]
);

const permissionLabels = (permissions: ComputerAgentPermission[]) => (
  permissions.map((permission) => PERMISSION_LABELS[permission])
);

/**
 * 对明显需要本机权限的请求做保守预检。
 *
 * 这不是自然语言路由器：只匹配“操作动作 + 本机对象”这类高置信度表达，避免阻断
 * 普通知识问答。真正的权限边界仍由会话中实际暴露的 pi 工具决定。
 */
export function detectComputerAgentPermissionBlock(
  message: string,
  settings: ComputerAgentSettings,
): ComputerAgentBlock | null {
  const text = message.trim().toLowerCase();
  if (!text) return null;

  const required: ComputerAgentPermission[] = [];
  const fileTarget = /(文件夹|文件|目录|桌面|下载|文档|源码|代码库|项目|日志|路径|folder|directory|desktop|file|source code|repository|repo|log\b|path\b)/i.test(text);
  const readAction = /(查看|看看|读取|读一下|列出|浏览|打开|检查|分析|查找|搜索|检索|统计|扫描|有哪些|内容|list|read|show|inspect|browse|open|search|find|scan)/i.test(text);
  const writeAction = /(创建|新建|写入|修改|编辑|删除|移除|移动|复制|重命名|整理|保存|生成|覆盖|create|write|modify|edit|delete|remove|move|copy|rename|save|generate)/i.test(text);
  const existingFileMutation = /(修改|编辑|删除|移除|移动|复制|重命名|整理|覆盖|modify|edit|delete|remove|move|copy|rename)/i.test(text);
  const commandAction = /(执行命令|运行命令|运行脚本|执行脚本|启动程序|停止程序|安装|卸载|编译|构建|打包|跑测试|运行测试|执行测试|powershell|cmd\b|bash\b|terminal|shell|npm\b|pnpm\b|yarn\b|cargo\b|git\b|python\b|node\b|run command|execute command|run script|build|compile|install|uninstall)/i.test(text);
  const computerTarget = /(电脑|本机|计算机|操作系统|系统信息|cpu|内存|磁盘|网卡|网络接口|主机名|ip地址|computer|system info|memory|disk|hostname|network interface)/i.test(text);
  const computerAction = /(查看|看看|获取|读取|显示|检查|查询|多少|配置|状态|show|get|inspect|check|status|configuration)/i.test(text);
  const novaTarget = /(nova-?pi|nova|任务|会话|对话|消息通道)/i.test(text);
  const novaAction = /(查看|看看|列出|查询|状态|运行中|中止|终止|停止|释放|管理|show|list|status|running|abort|stop|dispose|manage)/i.test(text);

  if (fileTarget && (readAction || existingFileMutation)) required.push("file_read");
  if (fileTarget && writeAction) required.push("file_write");
  if (commandAction) required.push("command_execution");
  if (computerTarget && computerAction) required.push("computer_info");
  if (novaTarget && novaAction) required.push("nova_management");

  const missing = uniquePermissions(required).filter((permission) => !permissionEnabled(settings, permission));
  if (missing.length === 0) return null;
  const labels = permissionLabels(missing);
  return {
    reason: "permission_required",
    permissions: missing,
    permissionLabels: labels,
    message: `这项操作需要“${labels.join("、")}”权限，当前尚未授权，因此没有执行。请前往“设置 > 智能员工”开启对应权限并保存，然后重试。`,
  };
}

/** 识别模型把工具调用协议当普通文本输出的情况，避免伪调用被当成成功结果。 */
export function detectInvalidComputerToolCall(
  text: string,
  settings: ComputerAgentSettings,
): ComputerAgentBlock | null {
  const hasFunctionEnvelope = /<function_calls\b/i.test(text) && /<invoke\s+name\s*=\s*["']/i.test(text);
  const hasToolEnvelope = /<tool_calls?\b/i.test(text) && /(?:name\s*=|"name"\s*:)/i.test(text);
  if (!hasFunctionEnvelope && !hasToolEnvelope) return null;

  const toolName = text.match(/<invoke\s+name\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? text.match(/<tool_calls?[^>]*\bname\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? text.match(/"name"\s*:\s*"([^"]+)"/i)?.[1];
  const requestedPermissions: ComputerAgentPermission[] = [];
  if (toolName && /^(?:list_files?|ls|find|grep|read(?:_file)?)$/i.test(toolName)) requestedPermissions.push("file_read");
  if (toolName && /^(?:write(?:_file)?|edit(?:_file)?|delete(?:_file)?|move(?:_file)?|copy(?:_file)?)$/i.test(toolName)) requestedPermissions.push("file_write");
  if (toolName && /^(?:bash|shell|exec|execute|run_command)$/i.test(toolName)) requestedPermissions.push("command_execution");
  if (toolName && /^(?:computer_info|system_info)$/i.test(toolName)) requestedPermissions.push("computer_info");
  if (toolName && /^nova_(?:status|list_tasks|manage_task)$/i.test(toolName)) requestedPermissions.push("nova_management");
  const missing = uniquePermissions(requestedPermissions)
    .filter((permission) => !permissionEnabled(settings, permission));
  const labels = permissionLabels(missing);
  const namedTool = toolName ? `“${toolName}”` : "未知工具";
  const permissionHint = labels.length > 0
    ? ` 当前还缺少“${labels.join("、")}”权限，请在“设置 > 智能员工”开启后重试。`
    : " 请重试；Nova 将改用当前会话中真实可用的系统工具。";
  return {
    reason: "invalid_tool_call",
    permissions: missing,
    permissionLabels: labels,
    invalidToolName: toolName,
    message: `模型输出了文本形式的伪工具调用 ${namedTool}，它没有通过系统工具通道执行，本次未执行任何本机操作。${permissionHint}`,
  };
}

/** 把本次授权和真实工具名写入 system prompt，降低模型臆造 list_files 等工具的概率。 */
export function computerAgentAuthorizationPrompt(settings: ComputerAgentSettings): string {
  const grants: Array<[string, boolean, string]> = [
    ["读取文件", settings.allowFileRead, "read、ls、find、grep"],
    ["修改文件与编程", settings.allowFileWrite, "edit、write"],
    ["执行命令", settings.allowCommandExecution, "bash"],
    ["查看设备信息", settings.allowComputerInfo, "computer_info"],
    ["管理 Nova", settings.allowNovaManagement, "nova_status、nova_list_tasks、nova_manage_task"],
  ];
  const lines = grants.map(([label, enabled, tools]) => (
    `- ${label}：${enabled ? `已授权（可用工具：${tools}）` : "未授权"}`
  ));
  return `【本次会话授权】\n${lines.join("\n")}\n\n` +
    "只能通过当前会话真实注册的结构化工具调用执行操作。列出目录使用 ls，不存在 list_files 工具。" +
    "绝不能输出 <function_calls>、<invoke> 或其他文本形式的伪工具调用；缺少权限时直接说明需要开启哪一项授权。" +
    "不得用 bash 绕过未授予的读取、修改或管理权限。";
}

const toolResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  details: data,
});

function computerInfo(): Record<string, unknown> {
  const cpus = os.cpus();
  const interfaces = Object.fromEntries(
    Object.entries(os.networkInterfaces()).map(([name, addresses]) => [
      name,
      (addresses ?? []).map((item) => ({
        address: item.address,
        family: item.family,
        internal: item.internal,
        mac: item.mac,
      })),
    ]),
  );
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    version: os.version(),
    architecture: os.arch(),
    username: os.userInfo().username,
    homeDirectory: os.homedir(),
    temporaryDirectory: os.tmpdir(),
    uptimeSeconds: Math.round(os.uptime()),
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      logicalCores: cpus.length,
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
    },
    networkInterfaces: interfaces,
  };
}

export function createComputerAgentTools(
  settings: ComputerAgentSettings,
  context: ComputerAgentToolContext,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (settings.allowComputerInfo) {
    tools.push({
      name: "computer_info",
      label: "查看设备信息",
      description: "读取当前设备的操作系统、CPU、内存、网络接口、用户目录和运行时间等本机信息。",
      parameters: Type.Object({}),
      async execute() {
        return toolResult(computerInfo());
      },
    });
  }

  if (settings.allowNovaManagement) {
    tools.push(
      {
        name: "nova_status",
        label: "查看 Nova 运行状态",
        description: "查看应用、会话数量、运行中任务以及后台消息渠道会话的实时状态。",
        parameters: Type.Object({}),
        async execute() {
          return toolResult(context.getNovaStatus());
        },
      },
      {
        name: "nova_list_tasks",
        label: "查看 Nova 对话和任务",
        description: "列出 Nova 最近对话、归档情况和当前运行中的会话，可按是否运行中筛选。",
        parameters: Type.Object({
          runningOnly: Type.Optional(Type.Boolean({ description: "只返回正在运行的任务" })),
          includeArchived: Type.Optional(Type.Boolean({ description: "是否包含已归档对话，默认 false" })),
        }),
        async execute(_toolCallId, args) {
          const input = args as { runningOnly?: boolean; includeArchived?: boolean };
          const snapshot = context.getNovaStatus();
          const conversations = snapshot.conversations.filter((item) => {
            if (!input.includeArchived && item.archived) return false;
            if (input.runningOnly && item.status !== "running") return false;
            return true;
          });
          const sessions = input.runningOnly
            ? snapshot.sessions.filter((item) => item.status === "running")
            : snapshot.sessions;
          return toolResult({ conversations, sessions });
        },
      },
      {
        name: "nova_manage_task",
        label: "管理 Nova 运行任务",
        description: "按对话 ID 中止运行中的 Nova 任务，或释放已经空闲的任务会话。不能中止当前正在调用此工具的会话。",
        parameters: Type.Object({
          conversationId: Type.String({ description: "目标对话 ID，可先用 nova_list_tasks 查询" }),
          action: Type.Union([
            Type.Literal("abort", { description: "中止正在运行的任务" }),
            Type.Literal("dispose", { description: "释放空闲会话，下次对话会重新创建" }),
          ]),
        }),
        async execute(_toolCallId, args) {
          const input = args as { conversationId: string; action: "abort" | "dispose" };
          const result = await context.manageNovaTask(
            input.conversationId.trim(),
            input.action,
            context.currentConversationId,
          );
          return toolResult(result);
        },
      },
    );
  }
  return tools;
}

export function customToolNamesForSettings(settings: ComputerAgentSettings): string[] {
  return createComputerAgentTools(settings, {
    currentConversationId: "test",
    getNovaStatus: () => ({
      host: { pid: 0, uptimeSeconds: 0, nodeVersion: "", platform: "" },
      totals: { conversations: 0, sessions: 0, running: 0, background: 0 },
      conversations: [],
      sessions: [],
    }),
    manageNovaTask: async () => ({ ok: true, message: "" }),
  }).map((tool) => tool.name);
}
