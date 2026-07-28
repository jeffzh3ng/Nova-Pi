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
  displayName: "Nova 智能员工",
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
  if (settings.allowFileRead) names.push("read");
  if (settings.allowCommandExecution) names.push("bash");
  if (settings.allowFileWrite) names.push("edit", "write");
  return names;
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
      label: "查看电脑信息",
      description: "读取当前电脑的操作系统、CPU、内存、网络接口、用户目录和运行时间等本机信息。",
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
        label: "查看 Nova-PI 状态",
        description: "查看 Nova-PI host、会话数量、运行中任务以及后台消息渠道会话的实时状态。",
        parameters: Type.Object({}),
        async execute() {
          return toolResult(context.getNovaStatus());
        },
      },
      {
        name: "nova_list_tasks",
        label: "查看 Nova-PI 对话和任务",
        description: "列出 Nova-PI 最近对话、归档情况和当前运行时会话，可按是否运行中筛选。",
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
        label: "管理 Nova-PI 运行任务",
        description: "按 conversationId 中止运行中的 Nova-PI 任务，或释放已经空闲的运行时会话。不能中止当前正在调用此工具的会话。",
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
