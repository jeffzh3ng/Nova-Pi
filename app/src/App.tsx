import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Archive } from "lucide-react";
import { ConfirmModal } from "./components/ConfirmModal";
import { DigitalHumanPicker } from "./components/DigitalHumanPicker";
import { LinkGuard } from "./components/LinkGuard";
import { Hero } from "./components/Hero";
import { McpSquarePanel } from "./components/McpSquarePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { SkillCenterPanel } from "./components/SkillCenterPanel";
import { TaskConversation } from "./components/TaskConversation";
import { TaskCenter } from "./components/TaskCenter";
import { TokenUsagePanel } from "./components/TokenUsagePanel";
import { digitalHumans, quickActions } from "./config/appContent";
import {
  archiveConversation,
  deleteConversation,
  generateConversationTitle,
  listArchivedConversations,
  listConversationSummaries,
  loadConversation,
  renameConversation,
  restoreConversation,
  saveConversationSnapshot,
  refreshRecentTaskTimes,
  summaryToRecentTask,
} from "./services/conversationStore";
import type { ConversationSnapshot, ConversationSummary } from "./services/conversationStore";
import { requiresNewPiSession } from "./services/conversationRouting";
import { executeSkillPlan } from "./services/skillExecution";
import { sendRpc, subscribePiEvents } from "./services/hostBridge";
import { listMessageChannels } from "./services/messageChannels";
import { startWeixinBot, loginWeixinBot } from "./services/wechatBot";
import type { ConversationAttachments, PiEvent } from "./services/hostBridge";
import {
  cancelRiskAssessment,
  contextFromMessages,
  downloadRiskAssessmentMatrixTemplate,
  downloadRiskAssessmentResult,
  getRiskAssessmentStatus,
  normalizeRiskAssessmentResult,
  submitRiskAssessment,
} from "./services/riskAssessment";
import type { RiskTaskStatus } from "./services/riskAssessment";
import type {
  AlertAnalysisResult,
  ChatMessage,
  ChatMessageAttachment,
  DigitalHuman,
  PendingSkillExecution,
  QuickAction,
  RecentTask,
  RiskAssessmentJob,
  RiskAssessmentResult,
  SidebarNavId,
  UsedSkill,
} from "./types";
import { listMcpConnectionSettings } from "./services/mcpSettings";
import type { McpConnectionSettings } from "./services/mcpSettings";
import {
  COMPUTER_AGENT_ID,
  configureComputerAgentHost,
  getComputerAgentSettings,
  syncComputerAgentSettingsToHost,
  updateNovaContext,
} from "./services/computerAgent";
import type { ComputerAgentSettings } from "./services/computerAgent";
import {
  DEFAULT_APP_PREFERENCES,
  getAppPreferences,
  type AppPreferences,
} from "./services/appPreferences";

const SIDEBAR_PANEL_WIDTH_KEY = "dp-agent-sidebar-panel-width";
const RECENTLY_USED_HUMAN_IDS_KEY = "dp-recently-used-human-ids";
const SIDEBAR_PANEL_MIN = 190;
const SIDEBAR_PANEL_MAX = 420;

type McpAvailability = {
  state: "checking" | "connected" | "disabled" | "unconfigured" | "error";
  badge?: "检测中" | "待配置" | "不可用";
  disabledReason?: string;
};

const DIGITAL_HUMAN_TEMPLATE_BY_MCP = new Map(
  digitalHumans.flatMap((human) => (human.mcpService ? [[human.mcpService, human] as const] : [])),
);

const QUICK_ACTION_TEMPLATE_BY_MCP = new Map(
  quickActions.flatMap((action) => (action.mcpService ? [[action.mcpService, action] as const] : [])),
);

const COMPUTER_AGENT_TEMPLATE = digitalHumans.find((human) => human.id === COMPUTER_AGENT_ID)!;

const CUSTOM_HUMAN_ACCENTS: DigitalHuman["accent"][] = [
  "blue",
  "emerald",
  "indigo",
  "teal",
  "amber",
  "primary",
];

const EMPTY_DIGITAL_HUMAN: DigitalHuman = {
  id: "",
  name: "数字员工",
  role: "正在读取 MCP 服务目录",
  description: "正在读取 MCP 服务目录",
  accent: "soft",
  status: "pending",
  disabledReason: "正在读取 MCP 服务目录",
};

/**
 * 通用对话员工的本地占位对象。后端 host 侧在 digital-human.ts 的 DIGITAL_HUMANS
 * 字典里有对应的 system prompt（GENERAL_CHAT_HUMAN_ID = "general-chat"），
 * 不挂任何 MCP 工具，用于首页默认对话的纯 LLM 问答。
 */
const GENERAL_CHAT_HUMAN_ID = "general-chat";
const GENERAL_CHAT_HUMAN: DigitalHuman = {
  id: GENERAL_CHAT_HUMAN_ID,
  name: "通用助手",
  role: "AI 助手",
  description: "通用对话助手，可回答日常问题；用 @ 可召唤专业数字员工。",
  accent: "primary",
  status: "ready",
};

const catalogHumanId = (settings: McpConnectionSettings) =>
  DIGITAL_HUMAN_TEMPLATE_BY_MCP.get(settings.serviceId)?.id ?? `mcp-service:${settings.serviceId}`;

const mcpSettingsToDigitalHuman = (
  settings: McpConnectionSettings,
  index: number,
): DigitalHuman => {
  const template = DIGITAL_HUMAN_TEMPLATE_BY_MCP.get(settings.serviceId);
  const employeeRole = settings.employeeRole.trim() || template?.role || "MCP 服务数字员工";
  return {
    id: template?.id ?? catalogHumanId(settings),
    name: settings.employeeName.trim() || template?.name || settings.serviceId,
    role: employeeRole,
    description: employeeRole,
    welcomeTitle: settings.welcomeTitle.trim(),
    welcomeMessage: settings.welcomeMessage.trim(),
    accent: template?.accent ?? CUSTOM_HUMAN_ACCENTS[index % CUSTOM_HUMAN_ACCENTS.length],
    mcpService: settings.serviceId,
    status: "pending",
  };
};

const digitalHumanToQuickAction = (human: DigitalHuman): QuickAction => {
  const template = human.mcpService ? QUICK_ACTION_TEMPLATE_BY_MCP.get(human.mcpService) : undefined;
  return {
    id: human.id,
    title: human.name,
    prompt: template?.prompt ?? "",
    tone: template?.tone ?? (human.accent === "cyan" ? "blue" : human.accent),
    mcpService: human.mcpService,
    status: human.status,
    disabledReason: human.disabledReason,
  };
};

const clampSidebarWidth = (value: number) =>
  Math.min(SIDEBAR_PANEL_MAX, Math.max(SIDEBAR_PANEL_MIN, value));

const getInitialSidebarWidth = () => {
  const fallbackWidth = 250;

  try {
    const savedWidth = window.localStorage.getItem(SIDEBAR_PANEL_WIDTH_KEY);
    return savedWidth ? clampSidebarWidth(Number(savedWidth)) : fallbackWidth;
  } catch {
    return fallbackWidth;
  }
};

const loadRecentlyUsedHumanIds = (): string[] => {
  try {
    const saved = window.localStorage.getItem(RECENTLY_USED_HUMAN_IDS_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const makeLocalId = () =>
  globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const isRenderableChatMessage = (message: ChatMessage) => Boolean(
  message.content.trim()
  || message.title?.trim()
  || message.detail?.trim()
  || message.attachments?.length
  || message.steps?.some((step) => step.trim())
  || message.suggestions?.some((suggestion) => suggestion.trim())
  || message.alertAnalysisResult
  || message.riskAssessmentResult
  || message.riskAssessmentJob
  || message.usedSkill
  || message.pendingSkillExecution
  || message.exportedFile,
);

const isAssistantPiMessage = (message: unknown): boolean => (
  typeof message === "object"
  && message !== null
  && (message as { role?: unknown }).role === "assistant"
);

const assistantTextFromPiMessage = (message: unknown): string => {
  if (!isAssistantPiMessage(message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
};

const formatMessageTime = () =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

const progressToMessage = (progress: {
  title: string;
  content: string;
  detail?: string;
  steps?: string[];
  suggestions?: string[];
}): ChatMessage => ({
  id: makeLocalId(),
  role: "assistant",
  title: progress.title,
  content: progress.content,
  detail: progress.detail,
  steps: progress.steps,
  suggestions: progress.suggestions,
  time: formatMessageTime(),
});

const digitalHumanOpeningMessages = (human: DigitalHuman | undefined): ChatMessage[] => {
  const title = human?.welcomeTitle?.trim() ?? "";
  const content = human?.welcomeMessage?.trim() ?? "";
  if (!title && !content) return [];
  return [
    progressToMessage({
      title: title || `欢迎使用${human?.name ?? "数字员工"}`,
      content: content || `请描述需要${human?.role ?? "数字员工"}协助处理的任务。`,
    }),
  ];
};

/**
 * 从消息文本中解析 `@员工名` 提及，返回该员工的 id 与去掉提及前缀的正文。
 *
 * 匹配规则：@ 在文本开头或前面是空白；员工名按 effectiveDigitalHumans 的 name 精确匹配，
 * 取第一个命中项。无匹配时返回通用对话员工 id（GENERAL_CHAT_HUMAN_ID）+ 原文。
 *
 * 注意：员工名可能包含标点（目前都是中文），用 name 长度降序匹配，避免短名前缀误命中长名。
 */
const parseMention = (
  text: string,
  humans: DigitalHuman[],
): { humanId: string; cleanRequest: string } => {
  // 按 name 长度降序，确保「数安风评数字员工」优先于任何前缀匹配。
  const sorted = [...humans].sort((a, b) => b.name.length - a.name.length);
  // 找到所有合法的 @ 位置（开头或前面是空白）。
  const positions: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "@") {
      const prev = text[i - 1];
      if (i === 0 || /\s/.test(prev)) positions.push(i);
    }
  }
  for (const pos of positions) {
    const tail = text.slice(pos + 1);
    for (const human of sorted) {
      if (tail.startsWith(human.name)) {
        // 员工名后必须是空白或文本结尾，否则可能是 @数安风评数字员工xxx 这种粘连。
        const after = tail.slice(human.name.length);
        if (after.length === 0 || /^\s/.test(after)) {
          // cleanRequest = 去掉 @员工名（及紧随其后的一个空白）。
          const before = text.slice(0, pos);
          const rest = after.replace(/^\s/, "");
          const remaining = `${before}${rest}`.trim();
          return { humanId: human.id, cleanRequest: remaining };
        }
      }
    }
  }
  return { humanId: GENERAL_CHAT_HUMAN_ID, cleanRequest: text.trim() };
};

/** 累计多少轮 user+assistant 对话后立即触发大模型提炼任务名。 */
const TITLE_GENERATION_TURN_THRESHOLD = 3;
/** 不足阈值轮次时，对话静默超过该时长（毫秒）后兜底提炼任务名。
 *  用户继续对话会重置计时（防抖），保证只在对话告一段落时才触发。 */
const TITLE_GENERATION_IDLE_DELAY_MS = 45_000;

const buildConversationTitle = (messages: ChatMessage[], fallback: string) => {
  const userMessages = messages.filter((message) => message.role === "user" && message.content.trim());
  const substantive = userMessages.find((m) => m.content.trim().length > 3) ?? userMessages[0];
  if (!substantive) return fallback;
  const title = substantive.content.replace(/\s+/g, " ").trim();
  return title.length > 22 ? `${title.slice(0, 22)}...` : title;
};

const buildLastMessage = (messages: ChatMessage[]) => {
  const last = [...messages].reverse().find((message) => message.content.trim() || message.title?.trim());
  if (!last) return "";
  return (last.content || last.title || "").replace(/\s+/g, " ").trim().slice(0, 260);
};

const buildMessagesFingerprint = (messages: ChatMessage[]) =>
  JSON.stringify(
    messages.map((message) => [
      message.id,
      message.role,
      message.title ?? "",
      message.content,
      message.time,
      message.steps ?? [],
      message.suggestions ?? [],
      message.detail ?? "",
      message.attachments ?? null,
      message.alertAnalysisResult ?? null,
      message.riskAssessmentResult ?? null,
      message.riskAssessmentJob ?? null,
      message.usedSkill ?? null,
      message.pendingSkillExecution ?? null,
      message.exportedFile ?? null,
    ]),
  );

const resolveConversationStatus = (messages: ChatMessage[], busy: boolean): RecentTask["status"] => {
  if (busy) return "running";
  const latestRiskJob = [...messages]
    .reverse()
    .find((message) => message.riskAssessmentJob)
    ?.riskAssessmentJob;
  if (latestRiskJob) {
    if (["pending", "running"].includes(latestRiskJob.status)) return "running";
    if (latestRiskJob.status === "canceled") return "canceled";
    if (["uploaded", "failed"].includes(latestRiskJob.status)) return "paused";
    if (latestRiskJob.status === "completed") return "done";
  }
  const last = messages[messages.length - 1];
  if (!last) return "paused";
  if (
    last.role === "assistant"
    && ["需要授权", "工具未执行", "处理出错", "处理失败"].includes(last.title ?? "")
  ) return "paused";
  return last.role === "assistant" ? "done" : "paused";
};

/**
 * 历史会话的 status 字段可能因为上次崩溃/异常强退而停留在 "running"。
 * 应用启动时内存态 runningConversationIds 必为空，因此库里任何 "running"
 * 都是脏数据 —— 此处按消息列表重新推导一个静默状态（不返回 running）。
 *
 * 注意：风评类会话的 running/pending job 由 hydrateRiskAssessmentContext
 * 在打开会话时单独恢复，这里只兜底落库的脏 running，不与正在轮询的任务冲突。
 */
const sanitizeStaleRunningStatus = (status: RecentTask["status"]): RecentTask["status"] => {
  if (status !== "running") return status;
  return "done";
};

type ConversationMetadata = Pick<ConversationSnapshot, "agentId" | "agentName">;

type PiSessionIdentity = {
  humanId: string;
  mcpServiceId?: string;
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const fileExt = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

const fileToBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
};

type RiskAssessmentContext = {
  jobMessageId: string;
  job: RiskAssessmentJob;
  attachments: ChatMessageAttachment[];
};

const waitForRiskPoll = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

/** 把 pi 的 tool_execution_end 结果映射为前端可识别的结构化负载。
 *  host 已在 details 里附带 module 字段（alert-analysis / data-risk-assessment / ip-threat-analysis）。 */
const interpretToolResult = (
  result: unknown,
): {
  alertAnalysisResult?: AlertAnalysisResult;
  riskAssessmentResult?: RiskAssessmentResult;
  riskAssessmentJob?: RiskAssessmentJob;
  usedSkill?: UsedSkill;
  pendingSkillExecution?: PendingSkillExecution;
  suggestions?: string[];
  riskMatrixTemplate?: { matrixName: string; fileName: string };
} => {
  if (!result || typeof result !== "object") return {};
  const rawDetails = (result as { details?: unknown }).details;
  if (rawDetails && typeof rawDetails === "object") {
    const envelope = rawDetails as Record<string, unknown>;
    // 统一 mcp 代理保留 serviceId/toolName 来源，并把业务负载放在 result 中。
    // 兼容旧工具直接把业务负载放 details 的历史会话。
    const det = envelope.result && typeof envelope.result === "object"
      ? envelope.result as Record<string, unknown>
      : envelope;
    if (det.module === "alert-analysis" || det.module === "ip-threat-analysis") {
      return { alertAnalysisResult: det as unknown as AlertAnalysisResult };
    }
    if (det.module === "data-risk-assessment") {
      return { riskAssessmentResult: det as unknown as RiskAssessmentResult };
    }
    const exported = det.exported_file;
    if (exported && typeof exported === "object" && !Array.isArray(exported)) {
      const file = exported as Record<string, unknown>;
      if (
        file.download_available === true
        && typeof file.matrix_name === "string"
        && typeof file.file_name === "string"
      ) {
        return {
          riskMatrixTemplate: {
            matrixName: file.matrix_name,
            fileName: file.file_name,
          },
        };
      }
    }
  }
  return {};
};

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [currentModelName, setCurrentModelName] = useState("未配置模型");
  const [busy, setBusy] = useState(false);
  const [modelStatus, setModelStatus] = useState<"ok" | "error" | "idle">("idle");
  const [modelError, setModelError] = useState("");
  const [recentTasks, setRecentTasks] = useState<RecentTask[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<RecentTask[]>([]);
  const [historyTimeTick, setHistoryTimeTick] = useState(0);
  const [conversationMessages, setConversationMessages] = useState<ChatMessage[]>([]);
  const [conversationReadOnly, setConversationReadOnly] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [selectedQuickActionId, setSelectedQuickActionId] = useState<string | undefined>();
  const [recentlyUsedHumanIds, setRecentlyUsedHumanIds] = useState<string[]>(loadRecentlyUsedHumanIds);
  const [activeNav, setActiveNav] = useState<SidebarNavId>("home");
  const [sidebarPanelWidth, setSidebarPanelWidth] = useState(getInitialSidebarWidth);
  const [runningConversationIds, setRunningConversationIds] = useState<Set<string>>(() => new Set());
  const [mcpCatalog, setMcpCatalog] = useState<McpConnectionSettings[]>([]);
  const [mcpAvailability, setMcpAvailability] = useState<Record<string, McpAvailability>>({});
  const [computerAgentSettings, setComputerAgentSettings] = useState<ComputerAgentSettings | null>(null);
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(DEFAULT_APP_PREFERENCES);
  const activeRunIdRef = useRef(0);
  // busy 的 ref 镜像：catch/超时等非渲染上下文需要读最新值，避免 stale closure。
  const busyRef = useRef(false);
  // busy 安全超时：agent_end 正常会清 busy，但若 sidecar 崩溃/事件流静默中断，
  // 这里兜底防止 UI 永久卡死。key = `${runId}`。
  const busySafetyTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const BUSY_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

  // conversationId ↔ pi sessionId 映射。pi 的 AgentSession 在 host 内部按 sessionId 管理，
  // 前端只持有这个映射，发 prompt 时把 sessionId 一起带给 host。
  const conversationPiSessionRef = useRef<Record<string, string>>({});
  // A pi session is created with one fixed system prompt and MCP allowlist.
  // Keep its identity in a separate map: the session-id map is also consumed
  // by long-lived event listeners and must retain its stable string shape
  // across development hot updates.
  const conversationPiSessionIdentityRef = useRef<Record<string, PiSessionIdentity>>({});
  // 流式生成中的 assistant 消息 id（按 conversationId 索引），用于把 text_delta 拼到同一条消息。
  const streamingMessageIdRef = useRef<Record<string, string>>({});
  // 工具调用气泡的临时 id（按 conversationId + toolCallId），用于把 tool_execution_end 的结果合进同一条。
  const toolMessageIdRef = useRef<Record<string, string>>({});

  const selectTaskRunIdRef = useRef(0);
  const currentConversationIdRef = useRef<string | undefined>(undefined);
  const conversationReadOnlyRef = useRef(false);
  const conversationMessageBuffersRef = useRef<Record<string, ChatMessage[]>>({});
  const conversationMetadataRef = useRef<Record<string, ConversationMetadata>>({});
  const conversationSaveQueuesRef = useRef<Record<string, Promise<unknown>>>({});
  /** 每个会话累积的普通文件附件（write_uploaded_blob 后的临时路径），发送时收集传给 host。 */
  const fileAttachmentContextsRef = useRef<Record<string, ChatMessageAttachment[]>>({});
  const riskAssessmentContextsRef = useRef<Partial<Record<string, RiskAssessmentContext>>>({});
  const riskAssessmentPollTokensRef = useRef<Record<string, number>>({});
  const loadedConversationFingerprintRef = useRef<{ id: string; fingerprint: string } | null>(null);
  const archivedTaskIdsRef = useRef<Set<string>>(new Set());
  const deletedConversationIdsRef = useRef<Set<string>>(new Set());
  const titleGenerationInFlightRef = useRef<Set<string>>(new Set());
  const titleGenerationTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let active = true;
    void getAppPreferences()
      .then((loaded) => { if (active) setAppPreferences(loaded); })
      .catch(() => {
        // Browser preview or an older native shell: retain safe defaults.
      });
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<AppPreferences>).detail;
      if (detail) setAppPreferences(detail);
    };
    window.addEventListener("nova-app-preferences-changed", onChanged);
    return () => {
      active = false;
      window.removeEventListener("nova-app-preferences-changed", onChanged);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let refreshSequence = 0;

    const refreshMcpAvailability = async () => {
      const sequence = ++refreshSequence;
      let employeeSettings: McpConnectionSettings[];
      try {
        const catalog = await listMcpConnectionSettings();
        employeeSettings = catalog.settings
          .filter((settings) => settings.showInEmployeeList)
          .sort((left, right) => Number(right.enabled) - Number(left.enabled));
        if (!alive || sequence !== refreshSequence) return;
        setMcpCatalog(catalog.settings);
        setMcpAvailability(Object.fromEntries(
          employeeSettings.map((settings) => [
            settings.serviceId,
            {
              state: "checking",
              badge: "检测中",
              disabledReason: "正在检测 MCP 连接",
            } satisfies McpAvailability,
          ]),
        ));
      } catch (error) {
        if (!alive || sequence !== refreshSequence) return;
        console.error("读取 MCP 服务目录失败", error);
        setMcpCatalog([]);
        setMcpAvailability({});
        return;
      }

      const entries = await Promise.all(
        employeeSettings.map(async (settings) => {
          const serviceId = settings.serviceId;
          const label = settings.employeeName || serviceId;
          if (!settings.enabled) {
            return [
              serviceId,
              {
                state: "disabled",
                badge: "待配置",
                disabledReason: `请在数字员工管理中配置并启用${label}对应的 MCP 服务`,
              } satisfies McpAvailability,
            ] as const;
          }

          const configured =
            settings.transport === "http"
              ? settings.httpUrl.trim().length > 0
              : settings.commandPath.trim().length > 0;
          if (!configured) {
            return [
              serviceId,
              {
                state: "unconfigured",
                badge: "待配置",
                disabledReason: `${label}对应的 MCP 服务已启用，但连接地址尚未配置`,
              } satisfies McpAvailability,
            ] as const;
          }

          // MCP 连接按需建立，避免应用启动时同时拉起全部 stdio/Node 服务。
          // 真正的握手错误会由 Agent 的 mcp 发现调用或设置页的“测试连接”明确返回。
          return [serviceId, { state: "connected" } satisfies McpAvailability] as const;
        }),
      );

      if (!alive || sequence !== refreshSequence) return;
      setMcpAvailability(Object.fromEntries(entries));
    };

    void refreshMcpAvailability();
    window.addEventListener("nova-mcp-settings-changed", refreshMcpAvailability);

    return () => {
      alive = false;
      window.removeEventListener("nova-mcp-settings-changed", refreshMcpAvailability);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unlistenRestart: (() => void) | undefined;
    const clearComputerAgentSessions = () => {
      for (const conversationId of Object.keys(conversationPiSessionRef.current)) {
        if (conversationMetadataRef.current[conversationId]?.agentId === COMPUTER_AGENT_ID) {
          delete conversationPiSessionRef.current[conversationId];
          delete conversationPiSessionIdentityRef.current[conversationId];
        }
      }
    };
    const refreshComputerAgent = async (syncHost = true) => {
      try {
        const settings = await getComputerAgentSettings();
        if (alive) setComputerAgentSettings(settings);
        if (syncHost) await configureComputerAgentHost(settings);
      } catch (error) {
        if (alive) console.error("读取或同步 Nova 设置失败", error);
      }
    };
    const handleChanged = (event: Event) => {
      const settings = (event as CustomEvent<ComputerAgentSettings>).detail;
      if (settings) setComputerAgentSettings(settings);
      else void refreshComputerAgent(false);
      clearComputerAgentSessions();
    };
    const handleSkillsChanged = () => {
      clearComputerAgentSessions();
    };
    void refreshComputerAgent();
    window.addEventListener("nova-computer-agent-settings-changed", handleChanged);
    window.addEventListener("nova-skills-changed", handleSkillsChanged);
    void listen("pi-sidecar-restarted", () => {
      conversationPiSessionRef.current = {};
      conversationPiSessionIdentityRef.current = {};
      void refreshComputerAgent();
    }).then((unlisten) => {
      if (alive) unlistenRestart = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      unlistenRestart?.();
      window.removeEventListener("nova-computer-agent-settings-changed", handleChanged);
      window.removeEventListener("nova-skills-changed", handleSkillsChanged);
    };
  }, []);

  type ModalState =
    | { type: "delete"; task: RecentTask }
    | { type: "archive"; task: RecentTask }
    | { type: "rename"; task: RecentTask }
    | null;
  const [modal, setModal] = useState<ModalState>(null);

  // A digital employee is available only after its MCP service completes a
  // real initialize + tools/list handshake.
  const resolveMcpStatus = (
    defaultStatus: "ready" | "pending" | undefined,
    mcpService: string | undefined,
  ): { status: "ready" | "pending"; badge?: string; disabledReason?: string } => {
    if (!mcpService) return { status: defaultStatus ?? "pending" };
    const availability = mcpAvailability[mcpService];
    if (availability?.state === "connected") {
      return { status: "ready" };
    }
    return {
      status: "pending",
      badge: availability?.badge ?? "检测中",
      disabledReason: availability?.disabledReason ?? "正在检测 MCP 连接",
    };
  };

  const catalogDigitalHumans = useMemo(
    () =>
      mcpCatalog
        .filter((settings) => settings.showInEmployeeList)
        .sort((left, right) => Number(right.enabled) - Number(left.enabled))
        .map(mcpSettingsToDigitalHuman),
    [mcpCatalog],
  );

  const effectiveDigitalHumans = useMemo(
    () => {
      // 未启用时不显示内置智能员工（首页卡片、侧栏快捷入口、@ 召唤列表均由本数组派生）。
      const mcpHumans = catalogDigitalHumans.map((human) => {
        const resolved = resolveMcpStatus(human.status, human.mcpService);
        return { ...human, status: resolved.status, disabledReason: resolved.disabledReason ?? human.disabledReason };
      });
      if (!computerAgentSettings?.enabled) return mcpHumans;
      const computerHuman: DigitalHuman = {
        ...COMPUTER_AGENT_TEMPLATE,
        name: computerAgentSettings.displayName || COMPUTER_AGENT_TEMPLATE.name,
        status: "ready",
      };
      return [computerHuman, ...mcpHumans];
    },
    [catalogDigitalHumans, computerAgentSettings, mcpAvailability],
  );

  const effectiveQuickActions = useMemo(
    () =>
      effectiveDigitalHumans.map(digitalHumanToQuickAction).map((action) => {
        const resolved = resolveMcpStatus(action.status, action.mcpService);
        return {
          ...action,
          badge: resolved.badge ?? action.badge,
          status: resolved.status,
          disabledReason: resolved.disabledReason ?? action.disabledReason,
        };
      }),
    [effectiveDigitalHumans, mcpAvailability],
  );

  // @ 召唤可选的员工列表：effectiveDigitalHumans 即真正的数字员工（不含 general-chat），
  // 直接传给 PromptComposer 的 EmployeeMentionPicker。
  const mentionableHumans = effectiveDigitalHumans;

  const selectedQuickActionHuman = useMemo(
    () => (selectedQuickActionId ? effectiveDigitalHumans.find((human) => human.id === selectedQuickActionId) : undefined),
    [selectedQuickActionId, effectiveDigitalHumans],
  );
  // 从当前输入框 prompt 实时解析 @ 提及：有 @ 返回对应员工，否则 undefined。
  // 用于首页默认走通用对话、附件处理基线、以及 submitPrompt 的员工决策。
  const mentionedHuman = useMemo(
    () => {
      const parsed = parseMention(prompt, effectiveDigitalHumans);
      if (parsed.humanId === GENERAL_CHAT_HUMAN_ID) return undefined;
      return effectiveDigitalHumans.find((human) => human.id === parsed.humanId);
    },
    [prompt, effectiveDigitalHumans],
  );
  // selectedHuman 语义（优先级从高到低）：
  // 1. 侧栏快捷动作选中的员工（直接进专业环境的入口）
  // 2. 输入框 @ 提及的员工（首页和对话内通用）
  // 3. 任务页会话绑定的员工（从 metadata 取，保证 header 名稳定）
  // 4. 通用助手（首页默认，纯 LLM 对话）
  // 5. EMPTY_DIGITAL_HUMAN（MCP 目录还在加载）
  const conversationBoundHuman = useMemo(
    () => {
      if (!currentConversationId) return undefined;
      const metadata = conversationMetadataRef.current[currentConversationId];
      if (!metadata?.agentId || metadata.agentId === GENERAL_CHAT_HUMAN_ID) return undefined;
      return effectiveDigitalHumans.find((human) => human.id === metadata.agentId);
    },
    [currentConversationId, effectiveDigitalHumans, conversationMessages],
  );
  const selectedHuman = useMemo(
    () =>
      selectedQuickActionHuman
      ?? mentionedHuman
      ?? conversationBoundHuman
      ?? GENERAL_CHAT_HUMAN
      ?? EMPTY_DIGITAL_HUMAN,
    [selectedQuickActionHuman, mentionedHuman, conversationBoundHuman],
  );
  // 已选中的「专业数字员工」名（@ 提及或会话绑定），通用助手时为 undefined。
  // 用于让 PromptComposer 的 placeholder 不再提示「@ 召唤」。
  const selectedEmployeeName = useMemo(() => {
    const human = selectedQuickActionHuman ?? mentionedHuman ?? conversationBoundHuman;
    return human?.name;
  }, [selectedQuickActionHuman, mentionedHuman, conversationBoundHuman]);

  const recordHumanUsage = (humanId: string) => {
    if (!humanId) return;
    setRecentlyUsedHumanIds((prev) => {
      const next = [humanId, ...prev.filter((id) => id !== humanId)].slice(0, 4);
      try {
        window.localStorage.setItem(RECENTLY_USED_HUMAN_IDS_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  };

  const clearRiskAssessmentContext = (conversationId?: string) => {
    if (conversationId) {
      delete riskAssessmentContextsRef.current[conversationId];
      riskAssessmentPollTokensRef.current[conversationId] =
        (riskAssessmentPollTokensRef.current[conversationId] ?? 0) + 1;
      return;
    }
    riskAssessmentContextsRef.current = {};
    riskAssessmentPollTokensRef.current = {};
  };

  const hydrateRiskAssessmentContext = (
    conversationId: string,
    messages: ChatMessage[],
  ): RiskAssessmentContext | undefined => {
    const job = contextFromMessages(messages);
    if (!job) {
      delete riskAssessmentContextsRef.current[conversationId];
      return undefined;
    }
    const jobMessage = [...messages]
      .reverse()
      .find((message) => message.riskAssessmentJob?.materialId === job.materialId);
    if (!jobMessage) return undefined;
    const context = {
      jobMessageId: jobMessage.id,
      job,
      attachments: [],
    };
    riskAssessmentContextsRef.current[conversationId] = context;
    return context;
  };

  const sortedQuickActions = useMemo(() => {
    if (recentlyUsedHumanIds.length === 0) return effectiveQuickActions;
    const rank = new Map(recentlyUsedHumanIds.map((id, i) => [id, i]));
    return [...effectiveQuickActions].sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      return ra - rb;
    });
  }, [recentlyUsedHumanIds, effectiveQuickActions]);

  const recentHumans = useMemo(() => {
    if (recentlyUsedHumanIds.length === 0) return effectiveDigitalHumans.slice(0, 3);
    const idSet = new Set(recentlyUsedHumanIds);
    const ordered: DigitalHuman[] = [];
    for (const id of recentlyUsedHumanIds) {
      const human = effectiveDigitalHumans.find((item) => item.id === id);
      if (human) ordered.push(human);
    }
    for (const human of effectiveDigitalHumans) {
      if (!idSet.has(human.id)) ordered.push(human);
    }
    return ordered.slice(0, 3);
  }, [recentlyUsedHumanIds, effectiveDigitalHumans]);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  useEffect(() => {
    conversationReadOnlyRef.current = conversationReadOnly;
  }, [conversationReadOnly]);

  useEffect(() => {
    if (currentConversationId) {
      conversationMessageBuffersRef.current[currentConversationId] = conversationMessages;
    }
  }, [conversationMessages, currentConversationId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHistoryTimeTick((tick) => tick + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => cancelIdleTitleGeneration(), []);

  useEffect(() => {
    listConversationSummaries()
      .then((tasks) => {
        // 应用启动时内存态 runningConversationIds 必为空，因此库里残留的
        // status="running" 都是上次崩溃/异常强退留下的脏数据，统一修正。
        // 真正正在轮询的风评任务会在打开对应会话时由 hydrateRiskAssessmentContext 重新置位。
        const sanitized = tasks.map((task) =>
          task.status === "running" ? { ...task, status: sanitizeStaleRunningStatus(task.status) } : task,
        );
        setRecentTasks(sanitized);
      })
      .catch((error) => {
        console.error("读取历史会话失败", error);
      });
  }, []);

  // 应用启动时自动启动配置了 autoStart 的消息渠道（微信 + Telegram）。
  // 等 sidecar ready（轮询 get_state 真正成功），失败静默——用户进面板可手动重试。
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // H5 修复：之前用 get_state + weixin_status 双探针且吞错，weixin_status 是业务命令
    // 不该用于探活基础设施，且 .catch(()=>null) 把成功响应当失败。改为仅用 get_state，
    // 成功响应即说明 host pool 已就绪（pool 为 null 时 host 会抛错）。
    const waitSidecarReady = async (attempts = 30, intervalMs = 500): Promise<boolean> => {
      for (let i = 0; i < attempts; i++) {
        if (cancelled) return false;
        try {
          await sendRpc({ type: "get_state", sessionId: "probe" });
          return true; // get_state 成功响应 = host ready
        } catch {
          // pool 为 null（host 尚未 bootstrap 完）会抛错，重试
          await new Promise((r) => (retryTimer = setTimeout(r, intervalMs)));
        }
      }
      return false;
    };

    const autoStartChannels = async () => {
      try {
        const channels = await listMessageChannels();
        const ready = await waitSidecarReady();
        if (!ready || cancelled) return;
        await syncComputerAgentSettingsToHost().catch((error) => {
          console.error("[消息通道] Nova 授权同步失败", error);
        });

        // 微信：创建后台会话 + 触发登录（token 缓存命中则秒连，否则需扫码）
        const wechat = channels.find((c) => c.channelId === "wechat" && c.enabled && c.autoStart);
        if (wechat && !cancelled) {
          try {
            await startWeixinBot(wechat.humanId);
            await loginWeixinBot();
          } catch (error) {
            console.error("[消息通道] 微信自动启动失败", error);
          }
        }

        // Telegram：需 config_json 里有 botToken 才自动启动
        const telegram = channels.find((c) => c.channelId === "telegram" && c.enabled && c.autoStart);
        if (telegram && !cancelled) {
          try {
            const cfg = JSON.parse(telegram.configJson || "{}");
            if (cfg.botToken) {
              const { startTelegramBot } = await import("./services/telegramBot");
              await startTelegramBot(telegram.humanId, { botToken: cfg.botToken, allowedUserId: cfg.allowedUserId });
            }
          } catch (error) {
            console.error("[消息通道] Telegram 自动启动失败", error);
          }
        }

        // 飞书：每条配置是独立应用实例，可并行连接并绑定不同数字员工。
        const feishuChannels = channels.filter((channel) =>
          (channel.channelType === "feishu" || channel.channelId.startsWith("feishu-"))
          && channel.enabled
          && channel.autoStart,
        );
        if (feishuChannels.length > 0 && !cancelled) {
          const { startFeishuBot } = await import("./services/feishuBot");
          await Promise.allSettled(feishuChannels.map(async (channel) => {
            const config = JSON.parse(channel.configJson || "{}");
            if (!config.appId || !config.appSecret) return;
            const started = await startFeishuBot(channel.channelId, channel.humanId, {
              appId: config.appId,
              appSecret: config.appSecret,
              domain: config.domain === "lark" ? "lark" : "feishu",
              groupPolicy: config.groupPolicy === "open" ? "open" : "mention",
            });
            if (!started) console.error(`[消息通道] 飞书自动启动失败：${channel.displayName}`);
          }));
        }
      } catch (error) {
        // 自动启动失败不影响应用正常使用，用户可手动进面板重试
        console.error("[消息通道] 自动启动失败", error);
      }
    };

    void autoStartChannels();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (activeNav === "projects") {
      listArchivedConversations()
        .then(setArchivedTasks)
        .catch((error) => {
          console.error("读取归档列表失败", error);
        });
    }
  }, [activeNav]);

  useEffect(() => {
    archivedTaskIdsRef.current = new Set(archivedTasks.map((task) => task.id));
  }, [archivedTasks]);

  const displayedRecentTasks = useMemo(
    () => refreshRecentTaskTimes(recentTasks),
    [recentTasks, historyTimeTick],
  );
  const displayedArchivedTasks = useMemo(
    () => refreshRecentTaskTimes(archivedTasks),
    [archivedTasks, historyTimeTick],
  );
  const connectedMcpCount = useMemo(
    () => Object.values(mcpAvailability).filter((item) => item.state === "connected").length,
    [mcpAvailability],
  );
  const mcpChecking = useMemo(
    () => Object.values(mcpAvailability).some((item) => item.state === "checking"),
    [mcpAvailability],
  );
  const selectedTask = useMemo(
    () => [...displayedRecentTasks, ...displayedArchivedTasks].find((task) => task.id === selectedTaskId),
    [displayedArchivedTasks, displayedRecentTasks, selectedTaskId],
  );
  const selectedTaskStatus: RecentTask["status"] = currentConversationId && runningConversationIds.has(currentConversationId)
    ? "running"
    : selectedTask?.status ?? "done";
  const currentConversationRunning =
    !!currentConversationId && runningConversationIds.has(currentConversationId);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const contexts = [...recentTasks.map((task) => ({ ...task, archived: false })), ...archivedTasks.map((task) => ({ ...task, archived: true }))]
        .map((task) => ({
          id: task.id,
          title: task.title,
          agentId: task.agentId,
          agentName: task.agentName,
          status: runningConversationIds.has(task.id) ? "running" as const : task.status,
          updatedAt: task.updatedAt,
          archived: task.archived,
          messageCount: conversationMessageBuffersRef.current[task.id]?.length,
        }));
      void updateNovaContext(contexts).catch(() => {
        // sidecar 启动/重启窗口内允许同步失败；后续任务状态变化会自动重试。
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [archivedTasks, recentTasks, runningConversationIds]);

  useEffect(() => {
    let alive = true;
    let refreshSequence = 0;
    let retryTimer: number | undefined;
    let unlistenSidecarRestart: (() => void) | undefined;

    // 从 pi 的 settings.json 读取默认模型名（与新的模型管理面板一致）。
    const refreshModelName = async (retryAttempt = 0) => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      const sequence = ++refreshSequence;
      setModelStatus("idle");
      setModelError("");
      try {
        const def = await sendRpc<{ provider: string; model: string } | null>({ type: "models_get_default" });
        if (!alive || sequence !== refreshSequence) return;
        if (def) {
          setCurrentModelName(def.model || def.provider || "未配置模型");
          setModelStatus("idle");
          setModelError("");
          try {
            await sendRpc({
              type: "models_test_provider",
              providerId: def.provider,
              modelId: def.model,
            });
            if (!alive || sequence !== refreshSequence) return;
            setModelStatus("ok");
          } catch (error) {
            if (!alive || sequence !== refreshSequence) return;
            setModelStatus("error");
            setModelError(error instanceof Error ? error.message : String(error));
          }
        } else {
          setCurrentModelName("未配置模型");
          setModelStatus("error");
          setModelError("请先在设置中添加模型供应商。");
        }
      } catch (error) {
        if (!alive || sequence !== refreshSequence) return;
        // The WebView can mount before the Node sidecar has completed bootstrap.
        // Retry startup transport/read failures, but do not retry a real model
        // validation failure handled above (for example an invalid API key).
        if (retryAttempt < 5) {
          const delayMs = Math.min(300 * (2 ** retryAttempt), 2_000);
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            void refreshModelName(retryAttempt + 1);
          }, delayMs);
          return;
        }
        setCurrentModelName("未配置模型");
        setModelStatus("error");
        setModelError(error instanceof Error ? error.message : "模型配置读取失败。");
      }
    };

    // 模型配置变更后刷新显示名（新的 SettingsPanel 保存后会派发此事件）。
    const handleModelSettingsChanged = () => {
      void refreshModelName();
    };

    void refreshModelName();
    window.addEventListener("nova-model-settings-changed", handleModelSettingsChanged);
    void listen("pi-sidecar-restarted", () => {
      void refreshModelName();
    }).then((unlisten) => {
      if (alive) {
        unlistenSidecarRestart = unlisten;
      } else {
        unlisten();
      }
    });

    return () => {
      alive = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      unlistenSidecarRestart?.();
      window.removeEventListener("nova-model-settings-changed", handleModelSettingsChanged);
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PANEL_WIDTH_KEY, String(sidebarPanelWidth));
    } catch {
      // Local storage can be unavailable in restricted WebView modes.
    }
  }, [sidebarPanelWidth]);

  const rememberConversationMetadata = (conversationId: string, metadata: ConversationMetadata) => {
    conversationMetadataRef.current[conversationId] = metadata;
  };

  const metadataFromCurrentSelection = (): ConversationMetadata => ({
    agentId: selectedHuman.id,
    agentName: selectedHuman.name,
  });

  const metadataForHumanId = (humanId: string): ConversationMetadata => {
    const human = effectiveDigitalHumans.find((item) => item.id === humanId);
    return {
      agentId: human?.id ?? humanId,
      agentName: human?.name ?? selectedHuman.name,
    };
  };

  const getConversationMetadata = (conversationId: string) =>
    conversationMetadataRef.current[conversationId] ?? metadataFromCurrentSelection();

  const buildSnapshotForConversation = (
    conversationId: string,
    messages: ChatMessage[],
    status: RecentTask["status"],
    fallbackTitle = "新任务",
  ): ConversationSnapshot => {
    const metadata = getConversationMetadata(conversationId);
    const renderableMessages = messages.filter(isRenderableChatMessage);
    return {
      id: conversationId,
      title: buildConversationTitle(renderableMessages, fallbackTitle),
      agentId: metadata.agentId,
      agentName: metadata.agentName,
      status,
      // Drop legacy empty assistant placeholders on the next snapshot save.
      messages: renderableMessages,
    };
  };

  const upsertRecentSummary = (summary: ConversationSummary) => {
    if (archivedTaskIdsRef.current.has(summary.id) || deletedConversationIdsRef.current.has(summary.id)) return;
    setRecentTasks((items) => {
      const next = [summaryToRecentTask(summary), ...items.filter((item) => item.id !== summary.id)];
      return next.slice(0, 80);
    });
  };

  const queueConversationSave = (
    conversationId: string,
    operation: () => Promise<ConversationSummary | void>,
  ) => {
    const previous = conversationSaveQueuesRef.current[conversationId] ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (deletedConversationIdsRef.current.has(conversationId)) return undefined;
        return operation();
      });
    conversationSaveQueuesRef.current[conversationId] = next;
    return next;
  };

  const mergeMessagesById = (loadedMessages: ChatMessage[], bufferedMessages: ChatMessage[]) => {
    const merged = [...loadedMessages];
    for (const buffered of bufferedMessages) {
      const existingIndex = merged.findIndex((message) => message.id === buffered.id);
      if (existingIndex >= 0) {
        merged[existingIndex] = buffered;
      } else {
        merged.push(buffered);
      }
    }
    return merged;
  };

  const queueSaveConversationState = (
    conversationId: string,
    status: RecentTask["status"],
  ) => {
    const next = queueConversationSave(conversationId, async () => {
      let loaded: Awaited<ReturnType<typeof loadConversation>> | undefined;
      try {
        loaded = await loadConversation(conversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith("会话不存在")) throw error;
      }

      if (loaded && !conversationMetadataRef.current[conversationId]) {
        rememberConversationMetadata(conversationId, {
          agentId: loaded.summary.agentId,
          agentName: loaded.summary.agentName,
        });
      }

      const bufferedMessages = conversationMessageBuffersRef.current[conversationId] ?? [];
      const messages = loaded
        ? mergeMessagesById(loaded.messages, bufferedMessages)
        : bufferedMessages;
      conversationMessageBuffersRef.current[conversationId] = messages;

      const snapshot = buildSnapshotForConversation(
        conversationId,
        messages,
        status,
        loaded?.summary.title || "新任务",
      );
      const summary = await saveConversationSnapshot(snapshot);
      upsertRecentSummary(summary);
      loadedConversationFingerprintRef.current = {
        id: conversationId,
        fingerprint: buildMessagesFingerprint(messages),
      };
      return summary;
    });

    next.catch((error) => {
      console.error("保存会话失败", error);
    });
    return next;
  };

  const appendMessagesToConversation = (
    conversationId: string,
    newMessages: ChatMessage[],
    status: RecentTask["status"],
  ) => {
    const appendUnique = (messages: ChatMessage[]) => {
      const next = [...messages];
      for (const message of newMessages) {
        const existingIndex = next.findIndex((item) => item.id === message.id);
        if (existingIndex >= 0) {
          next[existingIndex] = message;
        } else {
          next.push(message);
        }
      }
      return next;
    };

    const bufferedMessages = conversationMessageBuffersRef.current[conversationId] ?? [];
    conversationMessageBuffersRef.current[conversationId] = appendUnique(bufferedMessages);

    if (currentConversationIdRef.current === conversationId && !conversationReadOnlyRef.current) {
      setConversationMessages((messages) => {
        const next = appendUnique(messages);
        conversationMessageBuffersRef.current[conversationId] = next;
        return next;
      });
    }

    queueSaveConversationState(conversationId, status);
  };

  const updateMessageInConversation = (
    conversationId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage,
    status: RecentTask["status"],
  ) => {
    const updateMessages = (messages: ChatMessage[]) =>
      messages.map((message) => (message.id === messageId ? updater(message) : message));

    const bufferedMessages = conversationMessageBuffersRef.current[conversationId] ?? [];
    conversationMessageBuffersRef.current[conversationId] = updateMessages(bufferedMessages);

    if (currentConversationIdRef.current === conversationId && !conversationReadOnlyRef.current) {
      setConversationMessages((messages) => {
        const next = updateMessages(messages);
        conversationMessageBuffersRef.current[conversationId] = next;
        return next;
      });
    }

    queueSaveConversationState(conversationId, status);
  };

  const appendMessageToConversation = (
    conversationId: string,
    message: ChatMessage,
    status: RecentTask["status"],
  ) => {
    appendMessagesToConversation(conversationId, [message], status);
  };

  const runTitleGeneration = (conversationId: string): boolean => {
    if (!conversationId || conversationReadOnlyRef.current) return false;
    if (titleGenerationInFlightRef.current.has(conversationId)) return false;

    const task = [...displayedRecentTasks, ...displayedArchivedTasks].find(
      (item) => item.id === conversationId,
    );
    if (task && task.titleSource && task.titleSource !== "pending") return false;

    titleGenerationInFlightRef.current.add(conversationId);
    void generateConversationTitle(conversationId)
      .then((result) => {
        if (!result.updated) return;
        const nextTitle = result.title.trim();
        if (!nextTitle) return;
        const apply = (items: RecentTask[]) =>
          items.map((item) =>
            item.id === conversationId ? { ...item, title: nextTitle, titleSource: "auto" as const } : item,
          );
        setRecentTasks(apply);
        setArchivedTasks(apply);
      })
      .catch((error) => {
        console.error("提炼任务名失败", error);
      });
    return true;
  };

  const maybeGenerateTitle = (conversationId: string, messages: ChatMessage[]): boolean => {
    if (!conversationId) return false;
    const userTurns = messages.filter((message) => message.role === "user" && message.content.trim());
    if (userTurns.length < TITLE_GENERATION_TURN_THRESHOLD) return false;
    return runTitleGeneration(conversationId);
  };

  const scheduleIdleTitleGeneration = (conversationId: string) => {
    if (!conversationId) return;
    const existing = titleGenerationTimersRef.current[conversationId];
    if (existing) clearTimeout(existing);
    titleGenerationTimersRef.current[conversationId] = setTimeout(() => {
      delete titleGenerationTimersRef.current[conversationId];
      runTitleGeneration(conversationId);
    }, TITLE_GENERATION_IDLE_DELAY_MS);
  };

  const cancelIdleTitleGeneration = (conversationId?: string) => {
    if (conversationId) {
      const existing = titleGenerationTimersRef.current[conversationId];
      if (existing) {
        clearTimeout(existing);
        delete titleGenerationTimersRef.current[conversationId];
      }
      return;
    }
    for (const timer of Object.values(titleGenerationTimersRef.current)) {
      clearTimeout(timer);
    }
    titleGenerationTimersRef.current = {};
  };

  useEffect(() => {
    if (!currentConversationId || conversationMessages.length === 0) return;
    if (conversationReadOnly) return;

    const hasUserMessage = conversationMessages.some((message) => message.role === "user");
    if (!hasUserMessage) {
      setRecentTasks((items) => items.filter((item) => item.id !== currentConversationId));
      return;
    }

    // metadata 优先用会话已记住的（首次创建时由 submitPrompt 写入），见 buildSnapshotForConversation
    // 内部的 getConversationMetadata。这样会话进行中切换"最近使用"员工不会改写历史会话的 agent 元信息。
    const messageFingerprint = buildMessagesFingerprint(conversationMessages);
    if (
      loadedConversationFingerprintRef.current?.id === currentConversationId &&
      loadedConversationFingerprintRef.current.fingerprint === messageFingerprint
    ) {
      return;
    }

    const snapshotStatus =
      currentConversationId && runningConversationIds.has(currentConversationId)
        ? "running"
        : resolveConversationStatus(conversationMessages, busy);
    const snapshot = buildSnapshotForConversation(
      currentConversationId,
      conversationMessages,
      snapshotStatus,
    );

    const optimisticUpdatedAt = new Date().toISOString();
    setRecentTasks((items) => {
      const existing = items.find((item) => item.id === snapshot.id);
      // titleSource 为 auto/manual 时，title 已由 LLM 提炼或用户手改确定，
      // 后端 save_conversation_snapshot 的 ON CONFLICT 也不会覆盖它。
      // 此处乐观更新必须同样保留，否则流式 delta 会把 UI 显示的标题盖回成
      // buildConversationTitle（首条用户消息截断），看起来像自动提炼从未生效。
      const preserveTitle = !!existing && existing.titleSource !== "pending";
      const optimisticSummary: ConversationSummary = {
        id: snapshot.id,
        title: preserveTitle ? existing!.title : snapshot.title,
        titleSource: existing?.titleSource ?? "pending",
        agentId: snapshot.agentId,
        agentName: snapshot.agentName,
        status: snapshot.status,
        lastMessage: buildLastMessage(conversationMessages),
        // Streaming deltas trigger repeated optimistic saves. Preserve the
        // original creation time so the task card cannot alternate between
        // "刚刚" and the persisted absolute timestamp on every delta.
        createdAt: existing?.createdAt || optimisticUpdatedAt,
        updatedAt: optimisticUpdatedAt,
      };
      const next = [summaryToRecentTask(optimisticSummary), ...items.filter((item) => item.id !== optimisticSummary.id)];
      return next.slice(0, 80);
    });

    loadedConversationFingerprintRef.current = {
      id: currentConversationId,
      fingerprint: messageFingerprint,
    };
    queueConversationSave(currentConversationId, async () => saveConversationSnapshot(snapshot))
      .then((summary) => {
        if (summary) upsertRecentSummary(summary);
      })
      .catch((error) => {
        if (
          loadedConversationFingerprintRef.current?.id === currentConversationId &&
          loadedConversationFingerprintRef.current.fingerprint === messageFingerprint
        ) {
          loadedConversationFingerprintRef.current = null;
        }
        console.error("保存会话失败", error);
      });
  }, [
    busy,
    conversationMessages,
    currentConversationId,
    runningConversationIds,
    // 不依赖 selectedHuman：会话的 agentId/agentName 由首次创建时记住（getConversationMetadata），
    // 此处仅按消息变化保存。依赖 selectedHuman 会导致 MCP 可用性变化时触发整库重存，
    // 且会改写历史会话已记住的 agent 元信息。
  ]);

  const setConversationRunning = (conversationId: string, running: boolean) => {
    setRunningConversationIds((items) => {
      const next = new Set(items);
      if (running) {
        next.add(conversationId);
      } else {
        next.delete(conversationId);
      }
      return next;
    });
  };

  const createUserMessage = (content: string, attachments?: ChatMessageAttachment[]): ChatMessage => ({
    id: makeLocalId(),
    role: "user",
    content,
    attachments: attachments?.length ? attachments : undefined,
    time: formatMessageTime(),
  });

  const appendUserMessageToConversation = (
    conversationId: string,
    content: string,
    attachments?: ChatMessageAttachment[],
  ) => {
    appendMessageToConversation(conversationId, createUserMessage(content, attachments), "paused");
  };

  const appendUserMessage = (content: string, attachments?: ChatMessageAttachment[]) => {
    const conversationId = currentConversationIdRef.current;
    if (!conversationId) return;
    appendUserMessageToConversation(conversationId, content, attachments);
  };

  const ensureConversation = (metadata = metadataFromCurrentSelection()) => {
    if (currentConversationId && activeNav === "tasks" && !conversationReadOnly) {
      conversationReadOnlyRef.current = false;
      rememberConversationMetadata(currentConversationId, metadata);
      return currentConversationId;
    }
    const id = makeLocalId();
    setCurrentConversationId(id);
    currentConversationIdRef.current = id;
    setSelectedTaskId(id);
    setConversationReadOnly(false);
    conversationReadOnlyRef.current = false;
    deletedConversationIdsRef.current.delete(id);
    rememberConversationMetadata(id, metadata);
    conversationMessageBuffersRef.current[id] = [];
    return id;
  };

  const handleConfirmSkillExecution = async (messageId: string, plan: PendingSkillExecution) => {
    if (busy || conversationReadOnlyRef.current) return;
    const conversationId = currentConversationIdRef.current;
    if (!conversationId) return;

    setBusy(true);
    setConversationRunning(conversationId, true);
    updateMessageInConversation(
      conversationId,
      messageId,
      (message) => ({
        ...message,
        pendingSkillExecution: message.pendingSkillExecution
          ? { ...message.pendingSkillExecution, status: "running" }
          : undefined,
      }),
      "running",
    );

    try {
      const result = await executeSkillPlan(plan);
      updateMessageInConversation(
        conversationId,
        messageId,
        (message) => ({
          ...message,
          pendingSkillExecution: message.pendingSkillExecution
            ? { ...message.pendingSkillExecution, status: "completed" }
            : undefined,
        }),
        "done",
      );
      appendMessageToConversation(
        conversationId,
        {
          id: makeLocalId(),
          role: "assistant",
          title: "Skill 执行完成",
          content: [
            `已执行 Skill：${plan.skillName}`,
            `已生成文件：${result.fileName}`,
            "可点击下方文件进行另存，或双击直接打开。",
          ].join("\n"),
          steps: [
            "用户已确认本地执行",
            `已运行 ${plan.skillName} 的排版脚本`,
            `已生成文件：${result.fileName}`,
          ],
          time: formatMessageTime(),
          usedSkill: {
            id: plan.skillId,
            name: plan.skillName,
            confidence: 1,
            reason: "user confirmed local Skill execution",
          },
          exportedFile: {
            path: result.path,
            fileName: result.fileName,
          },
        },
        "done",
      );
    } catch (error) {
      updateMessageInConversation(
        conversationId,
        messageId,
        (message) => ({
          ...message,
          pendingSkillExecution: message.pendingSkillExecution
            ? { ...message.pendingSkillExecution, status: "failed" }
            : undefined,
        }),
        "paused",
      );
      appendMessageToConversation(
        conversationId,
        {
          id: makeLocalId(),
          role: "assistant",
          title: "Skill 执行失败",
          content: error instanceof Error ? error.message : String(error),
          steps: [`Skill: ${plan.skillName}`, "Execution failed after user confirmation"],
          time: formatMessageTime(),
          usedSkill: {
            id: plan.skillId,
            name: plan.skillName,
            confidence: 1,
            reason: "user confirmed local Skill execution",
          },
        },
        "paused",
      );
    } finally {
      setConversationRunning(conversationId, false);
      setBusy(false);
    }
  };

  const updateRiskAssessmentJob = (
    conversationId: string,
    context: RiskAssessmentContext,
    patch: Partial<RiskAssessmentJob>,
    content: string,
    conversationStatus: RecentTask["status"],
  ) => {
    const nextJob = { ...context.job, ...patch };
    const nextContext = { ...context, job: nextJob };
    riskAssessmentContextsRef.current[conversationId] = nextContext;
    updateMessageInConversation(
      conversationId,
      context.jobMessageId,
      (message) => ({
        ...message,
        title:
          nextJob.status === "completed"
            ? "数据安全风险评估完成"
            : nextJob.status === "failed"
              ? "数据安全风险评估失败"
              : nextJob.status === "canceled"
                ? "数据安全风险评估已取消"
                : "数据安全风险评估中",
        content,
        steps:
          typeof nextJob.progressPct === "number"
            ? [`当前进度：${nextJob.progressPct}%`]
            : message.steps,
        suggestions: nextJob.status === "uploaded" ? message.suggestions : undefined,
        riskAssessmentJob: nextJob,
      }),
      conversationStatus,
    );
    return nextContext;
  };

  const pollRiskAssessment = async (
    conversationId: string,
    initialContext: RiskAssessmentContext,
  ) => {
    const taskId = initialContext.job.taskId;
    if (!taskId) return;
    const pollToken = (riskAssessmentPollTokensRef.current[conversationId] ?? 0) + 1;
    riskAssessmentPollTokensRef.current[conversationId] = pollToken;
    let networkFailures = 0;

    while (riskAssessmentPollTokensRef.current[conversationId] === pollToken) {
      let task: RiskTaskStatus;
      try {
        task = await getRiskAssessmentStatus(taskId);
        networkFailures = 0;
      } catch (error) {
        networkFailures += 1;
        const context = riskAssessmentContextsRef.current[conversationId] ?? initialContext;
        updateRiskAssessmentJob(
          conversationId,
          context,
          { status: "running", progress: "连接中断，正在重试" },
          `暂时无法读取评估进度，将自动重试（${networkFailures}）。\n\n${error instanceof Error ? error.message : String(error)}`,
          "running",
        );
        await waitForRiskPoll(Math.min(15_000, 3_000 * networkFailures));
        continue;
      }

      const context = riskAssessmentContextsRef.current[conversationId] ?? initialContext;
      if (task.status === "pending" || task.status === "running") {
        updateRiskAssessmentJob(
          conversationId,
          context,
          {
            status: task.status,
            progress: task.progress || "评估任务处理中",
            progressPct: task.progressPct,
          },
          `${task.progress || "评估任务处理中"}，当前进度 ${task.progressPct}%。`,
          "running",
        );
        await waitForRiskPoll(3_000);
        continue;
      }

      if (task.status === "completed") {
        let downloaded: { path: string; fileName: string } | undefined;
        let downloadError: unknown;
        for (let attempt = 0; attempt < 3 && !downloaded; attempt += 1) {
          try {
            downloaded = await downloadRiskAssessmentResult(taskId, task.outputFile);
          } catch (error) {
            downloadError = error;
            if (attempt < 2) await waitForRiskPoll(2_000 * (attempt + 1));
          }
        }
        const result = normalizeRiskAssessmentResult(task.result ?? {}, downloaded?.path);
        const completionText = downloaded
          ? "评估已完成，结果表已下载到本地。"
          : `评估已完成，但结果表下载失败：${downloadError instanceof Error ? downloadError.message : String(downloadError)}`;
        updateRiskAssessmentJob(
          conversationId,
          context,
          {
            status: "completed",
            progress: completionText,
            progressPct: 100,
            resultFileId: task.resultFileId,
          },
          completionText,
          "done",
        );
        appendMessageToConversation(
          conversationId,
          {
            id: makeLocalId(),
            role: "assistant",
            title: "数据安全风险评估结果",
            content: result.overview,
            riskAssessmentResult: result,
            exportedFile: downloaded,
            time: formatMessageTime(),
          },
          "done",
        );
        maybeGenerateTitle(
          conversationId,
          conversationMessageBuffersRef.current[conversationId] ?? [],
        );
      } else {
        const canceled = task.status === "canceled";
        updateRiskAssessmentJob(
          conversationId,
          context,
          {
            status: canceled ? "canceled" : "failed",
            progress: canceled ? "评估已取消" : "评估失败",
            error: task.error,
          },
          canceled
            ? "评估任务已取消，已上传材料仍可用于重新评估。"
            : `评估失败：${task.error || "服务端未返回具体原因"}`,
          canceled ? "canceled" : "paused",
        );
      }
      break;
    }

    setConversationRunning(conversationId, false);
    if (currentConversationIdRef.current === conversationId) setBusy(false);
  };

  const startRiskAssessment = async (
    conversationId: string,
    matrixName: string,
    userMessage: string,
  ) => {
    const context =
      riskAssessmentContextsRef.current[conversationId]
      ?? hydrateRiskAssessmentContext(
        conversationId,
        conversationMessageBuffersRef.current[conversationId] ?? [],
      );
    if (!context) {
      appendMessageToConversation(
        conversationId,
        progressToMessage({ title: "请先上传评估材料", content: "未找到已上传的材料，请重新上传 zip 压缩包。" }),
        "paused",
      );
      return;
    }
    if (context.job.taskId && ["pending", "running"].includes(context.job.status)) {
      void pollRiskAssessment(conversationId, context);
      return;
    }

    appendUserMessageToConversation(conversationId, userMessage);
    setConversationRunning(conversationId, true);
    if (currentConversationIdRef.current === conversationId) setBusy(true);
    let nextContext = updateRiskAssessmentJob(
      conversationId,
      context,
      { matrixName, status: "pending", progress: "正在提交评估任务", progressPct: 0, error: undefined },
      `正在基于矩阵「${matrixName}」提交评估任务。`,
      "running",
    );
    try {
      const submitted = await submitRiskAssessment(context.job.materialId, matrixName);
      nextContext = updateRiskAssessmentJob(
        conversationId,
        nextContext,
        {
          taskId: submitted.taskId,
          matrixName: submitted.matrixName,
          status: submitted.status,
          progress: submitted.progress || "评估任务已提交",
          progressPct: submitted.progressPct,
        },
        "评估任务已提交，正在等待服务端处理。",
        "running",
      );
      void pollRiskAssessment(conversationId, nextContext);
    } catch (error) {
      updateRiskAssessmentJob(
        conversationId,
        nextContext,
        { status: "failed", progress: "评估任务提交失败", error: error instanceof Error ? error.message : String(error) },
        `评估任务提交失败：${error instanceof Error ? error.message : String(error)}`,
        "paused",
      );
      setConversationRunning(conversationId, false);
      if (currentConversationIdRef.current === conversationId) setBusy(false);
    }
  };

  const isCurrentRun = (runId: number) => activeRunIdRef.current === runId;

  // 提交 prompt 成功后，启动一个安全超时：若超时后该 run 仍在跑（说明 agent_end
  // 因 sidecar 崩溃/事件流中断而未到达），强制清理 running/busy，避免会话永久卡死。
  const scheduleBusySafetyTimeout = (runId: number, conversationId: string) => {
    const key = `${runId}`;
    const existing = busySafetyTimersRef.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      busySafetyTimersRef.current.delete(key);
      // 仍在跑才需要兜底；正常已由 agent_end 清理并取消本 timer。
      if (activeRunIdRef.current === runId && busyRef.current) {
        console.warn(`[busy-safety] run ${runId} 超时未收到 agent_end，强制清理`);
        setConversationRunning(conversationId, false);
        setBusy(false);
        busyRef.current = false;
        activeRunIdRef.current += 1; // 后续 run 失效
      }
    }, BUSY_SAFETY_TIMEOUT_MS);
    busySafetyTimersRef.current.set(key, timer);
  };

  const clearBusySafetyTimeout = (runId: number) => {
    const key = `${runId}`;
    const timer = busySafetyTimersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      busySafetyTimersRef.current.delete(key);
    }
  };

  // ── pi 事件订阅：把 host 转发的 AgentSessionEvent 流映射为 ChatMessage 增量 ──
  // 这是新架构的核心：pi 的 agent loop 在 host 内部跑，事件流驱动前端对话视图。
  useEffect(() => {
    const unsubscribe = subscribePiEvents((event: PiEvent) => {
      // 只有携带 sessionId 的事件才能关联回具体会话；usage/session_saved 等无 sessionId
      // 的事件在别处处理（TokenUsagePanel 轮询、auto-save）。
      if (!("sessionId" in event) || !event.sessionId) return;
      const conversationId = Object.keys(conversationPiSessionRef.current).find(
        (cid) => conversationPiSessionRef.current[cid] === event.sessionId,
      );
      if (!conversationId) return;
      if (conversationReadOnlyRef.current) return;

      switch (event.type) {
        case "message_start": {
          // pi emits message_start for user prompts and tool results too. Only
          // assistant messages participate in the visible response stream, and
          // the bubble is created lazily on the first final-text delta so a
          // thinking-only phase cannot leave an empty card behind.
          if (!isAssistantPiMessage(event.message)) break;
          const messageId = makeLocalId();
          streamingMessageIdRef.current[conversationId] = messageId;
          break;
        }
        case "message_update": {
          // Do not expose thinking_delta/reasoning content in the conversation.
          if (event.assistantMessageEvent?.type !== "text_delta") break;
          const delta = event.assistantMessageEvent.delta ?? event.assistantMessageEvent.text ?? "";
          if (!delta) break;
          let messageId = streamingMessageIdRef.current[conversationId];
          if (!messageId) {
            messageId = makeLocalId();
            streamingMessageIdRef.current[conversationId] = messageId;
          }
          const exists = (conversationMessageBuffersRef.current[conversationId] ?? [])
            .some((message) => message.id === messageId);
          if (exists) {
            updateMessageInConversation(
              conversationId,
              messageId,
              (message) => ({ ...message, content: message.content + delta }),
              "running",
            );
          } else {
            appendMessageToConversation(
              conversationId,
              { id: messageId, role: "assistant", content: delta, time: formatMessageTime() },
              "running",
            );
          }
          break;
        }
        case "message_end": {
          if (!isAssistantPiMessage(event.message)) break;
          const messageId = streamingMessageIdRef.current[conversationId];
          const finalText = assistantTextFromPiMessage(event.message);
          const exists = messageId
            ? (conversationMessageBuffersRef.current[conversationId] ?? [])
              .some((message) => message.id === messageId)
            : false;
          // Some providers do not emit text_delta consistently. Reconcile from
          // the finalized assistant message, still excluding thinking blocks.
          if (finalText.trim()) {
            if (messageId && exists) {
              updateMessageInConversation(
                conversationId,
                messageId,
                (message) => ({ ...message, content: finalText }),
                "running",
              );
            } else {
              appendMessageToConversation(
                conversationId,
                {
                  id: messageId ?? makeLocalId(),
                  role: "assistant",
                  content: finalText,
                  time: formatMessageTime(),
                },
                "running",
              );
            }
          }
          delete streamingMessageIdRef.current[conversationId];
          break;
        }
        case "tool_execution_start": {
          // 工具调用气泡：登记 id，end 时把结果合进同一条。
          const key = `${conversationId}:${event.toolCallId}`;
          const messageId = makeLocalId();
          toolMessageIdRef.current[key] = messageId;
          appendMessageToConversation(
            conversationId,
            {
              id: messageId,
              role: "assistant",
              kind: "tool",
              title: `正在调用工具：${event.toolName}`,
              content: `正在执行 ${event.toolName}…`,
              time: formatMessageTime(),
            },
            "running",
          );
          break;
        }
        case "tool_execution_update": {
          // Runtime progress remains available to diagnostics, but raw tool
          // arguments and intermediate JSON are not shown in the conversation.
          break;
        }
        case "tool_execution_end": {
          const key = `${conversationId}:${event.toolCallId}`;
          const messageId = toolMessageIdRef.current[key];
          if (!messageId) break;
          delete toolMessageIdRef.current[key];
          const interpreted = interpretToolResult(event.result);
          // 研判/风评结构化结果：把卡片负载合进工具气泡，并抽取 suggestions。
          updateMessageInConversation(
            conversationId,
            messageId,
            (message) => ({
              ...message,
              kind: "tool",
              title: event.isError ? `工具调用失败：${event.toolName}` : `工具调用完成：${event.toolName}`,
              content: event.isError
                ? `${event.toolName} 执行失败，请检查相关配置后重试。`
                : `已完成 ${event.toolName}。`,
              steps: undefined,
              alertAnalysisResult: interpreted.alertAnalysisResult ?? message.alertAnalysisResult,
              riskAssessmentResult: interpreted.riskAssessmentResult ?? message.riskAssessmentResult,
              riskAssessmentJob: interpreted.riskAssessmentJob ?? message.riskAssessmentJob,
              usedSkill: interpreted.usedSkill ?? message.usedSkill,
              pendingSkillExecution: interpreted.pendingSkillExecution ?? message.pendingSkillExecution,
              suggestions: interpreted.suggestions ?? message.suggestions,
            }),
            "running",
          );
          if (interpreted.riskMatrixTemplate) {
            const template = interpreted.riskMatrixTemplate;
            void downloadRiskAssessmentMatrixTemplate(template.matrixName, template.fileName).then(
              (downloaded) => {
                updateMessageInConversation(
                  conversationId,
                  messageId,
                  (message) => ({
                    ...message,
                    title: "空白评估表已导出",
                    content: "空白评估表已下载到本地，可点击下方文件另存或打开。",
                    exportedFile: downloaded,
                  }),
                  "running",
                );
              },
              (error: unknown) => {
                updateMessageInConversation(
                  conversationId,
                  messageId,
                  (message) => ({
                    ...message,
                    content: `评估矩阵已获取，但空白评估表下载失败：${error instanceof Error ? error.message : String(error)}`,
                  }),
                  "running",
                );
              },
            );
          }
          break;
        }
        case "computer_agent_blocked": {
          const existingMessageId = streamingMessageIdRef.current[conversationId];
          const existingMessage = existingMessageId
            ? (conversationMessageBuffersRef.current[conversationId] ?? [])
              .find((message) => message.id === existingMessageId)
            : undefined;
          const title = event.reason === "permission_required" ? "需要授权" : "工具未执行";
          const steps = event.permissionLabels.length > 0
            ? [`需要开启：${event.permissionLabels.join("、")}`]
            : undefined;
          if (existingMessageId && existingMessage) {
            updateMessageInConversation(
              conversationId,
              existingMessageId,
              (message) => ({
                ...message,
                title,
                content: event.message,
                steps,
                suggestions: undefined,
              }),
              "paused",
            );
          } else {
            appendMessageToConversation(
              conversationId,
              progressToMessage({ title, content: event.message, steps }),
              "paused",
            );
          }
          delete streamingMessageIdRef.current[conversationId];
          setConversationRunning(conversationId, false);
          clearBusySafetyTimeout(activeRunIdRef.current);
          if (currentConversationIdRef.current === conversationId) {
            setBusy(false);
            busyRef.current = false;
          }
          break;
        }
        case "agent_end": {
          delete streamingMessageIdRef.current[conversationId];
          setConversationRunning(conversationId, false);
          clearBusySafetyTimeout(activeRunIdRef.current);
          if (currentConversationIdRef.current === conversationId) {
            setBusy(false);
            busyRef.current = false;
          }
          const triggered = maybeGenerateTitle(
            conversationId,
            conversationMessageBuffersRef.current[conversationId] ?? [],
          );
          if (triggered) {
            cancelIdleTitleGeneration(conversationId);
          } else {
            scheduleIdleTitleGeneration(conversationId);
          }
          break;
        }
        case "risk_job_update": {
          // 当前 host 不 emit 此事件（风评进度由前端 pollRiskAssessment 每 3s 轮询）。
          // 保留 case 以兼容未来 host 推送进度的实现。
          const job = event.job as RiskAssessmentJob | undefined;
          if (!job) break;
          const context = riskAssessmentContextsRef.current[conversationId];
          if (!context) break;
          updateRiskAssessmentJob(conversationId, context, job, job.progress ?? "", job.status === "running" ? "running" : "done");
          break;
        }
        case "usage": {
          // token 用量由 Rust 在 rpc.rs 拦截 usage 事件写入 token_usage 表（见 persist_usage_event）。
          // 前端不在此处理，TokenUsagePanel 轮询 list_token_usage 时读取最新数据。
          break;
        }
        case "error": {
          // host 的 error 事件都是会话级不可恢复错误（prompt 抛错、agent loop 异常）。
          // 可恢复错误（如单次工具调用失败）由 pi 在 customTool execute 内部处理，不走此事件。
          // 因此这里无条件展示错误并清理 running/busy（recoverable 字段保留供未来扩展）。
          appendMessageToConversation(
            conversationId,
            progressToMessage({ title: "处理出错", content: event.message }),
            "paused",
          );
          setConversationRunning(conversationId, false);
          clearBusySafetyTimeout(activeRunIdRef.current);
          if (currentConversationIdRef.current === conversationId) {
            setBusy(false);
            busyRef.current = false;
          }
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, []);

  const submitPrompt = async (
    override?: {
      request: string;
      userMessage?: string;
      skipUserMessage?: boolean;
    },
  ) => {
    // override 是程序化调用（如风评卡片），request 已指定，不再走 @ 解析。
    // 普通发送时：从输入框文本解析 @ 提及，去掉 @员工名 前缀得到真正要发给 agent 的正文。
    const rawRequest = (override?.request ?? prompt).trim();
    const parsed = override ? { humanId: selectedHuman.id, cleanRequest: rawRequest } : parseMention(rawRequest, effectiveDigitalHumans);
    const request = parsed.cleanRequest;
    // 无 @ 时沿用当前会话绑定的员工；有明确 @ 时以解析结果为准。
    // 不直接依赖标题/UI 状态，确保本次发送使用的员工身份是确定的。
    const explicitlyMentionedHuman = !override && parsed.humanId !== GENERAL_CHAT_HUMAN_ID
      ? effectiveDigitalHumans.find((human) => human.id === parsed.humanId)
      : undefined;
    const targetHuman = explicitlyMentionedHuman ?? selectedHuman;
    const targetMetadata: ConversationMetadata = {
      agentId: targetHuman.id,
      agentName: targetHuman.name,
    };
    if (!request) return;
    if (!override && targetHuman.status !== "ready") return;
    if (!override && currentConversationRunning) return;

    // 通用对话（general-chat）不计入「最近使用」，只有真正的数字员工才记。
    if (targetHuman.id !== GENERAL_CHAT_HUMAN_ID) {
      recordHumanUsage(targetHuman.id);
    }
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;

    const conversationId = ensureConversation(targetMetadata);
    // Capture only prior turns. The current user message is sent through the
    // prompt command below and must not also be injected into rebuilt history.
    const resumeMessages = conversationMessageBuffersRef.current[conversationId]?.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const resumeAttachments = (conversationMessageBuffersRef.current[conversationId] ?? [])
      .flatMap((message) => message.attachments ?? [])
      .filter((item): item is ChatMessageAttachment & { path: string; ext: string } => Boolean(item.path && item.ext))
      .map((item) => ({ name: item.name, path: item.path, ext: item.ext, size: item.size }));
    setBusy(true);
    busyRef.current = true;
    setConversationRunning(conversationId, true);
    setActiveNav("tasks");
    if (!override?.skipUserMessage) {
      appendUserMessage(override?.userMessage ?? request);
    }
    setPrompt("");

    try {
      // 在 host 内创建/复用 pi 会话，然后把 prompt 发给 pi 的 agent loop。
      // 流式 token、工具调用、结构化结果都通过 subscribePiEvents 的事件回流。
      let piSessionId = conversationPiSessionRef.current[conversationId];
      const existingIdentity = piSessionId
        ? conversationPiSessionIdentityRef.current[conversationId]
        : undefined;
      const sessionIdentityChanged = requiresNewPiSession(existingIdentity, {
        humanId: targetHuman.id,
        mcpServiceId: targetHuman.mcpService,
      });
      if (sessionIdentityChanged) {
        if (targetHuman.id === COMPUTER_AGENT_ID) {
          const latestSettings = await syncComputerAgentSettingsToHost();
          setComputerAgentSettings(latestSettings);
        }
        piSessionId = await sendRpc<string>({
          type: "new_session",
          humanId: targetHuman.id,
          conversationId,
          // 自定义 MCP 员工（非内置 9 个）需要 mcpServiceId 才能在 host 端获得 MCP 工具白名单。
          mcpServiceId: targetHuman.mcpService,
          resumeMessages,
          resumeAttachments,
        });
        conversationPiSessionRef.current[conversationId] = piSessionId;
        conversationPiSessionIdentityRef.current[conversationId] = {
          humanId: targetHuman.id,
          mcpServiceId: targetHuman.mcpService,
        };
      }

      // 仅传本轮新附件；host 会维护会话级受控附件清单，模型通过 mcp.attachment 引用。
      const fileAttachments = fileAttachmentContextsRef.current[conversationId] ?? [];
      const filePayload = fileAttachments
        .filter((item) => item.path && item.ext)
        .map((item) => ({ name: item.name, path: item.path!, ext: item.ext!, size: item.size }));
      const attachments: ConversationAttachments = {
        files: filePayload.length > 0 ? filePayload : undefined,
      };
      await sendRpc({
        type: "prompt",
        sessionId: piSessionId,
        message: request,
        attachments,
      });
      // 文件附件已随本次 prompt 发送给 host，清空避免下一轮重复发送。
      delete fileAttachmentContextsRef.current[conversationId];

      if (!isCurrentRun(runId)) return;
      if (currentConversationIdRef.current === conversationId) {
        setSelectedTaskId(conversationId);
        setSelectedQuickActionId(undefined);
      }
    } catch (error) {
      // prompt 调用本身失败（网络/会话不存在等），pi 尚未或已停止跑 agent loop，
      // agent_end 不会到达，必须在此兜底清理 running/busy，否则会话永久卡死。
      if (isCurrentRun(runId)) {
        appendMessageToConversation(
          conversationId,
          progressToMessage({
            title: "处理失败",
            content: error instanceof Error ? error.message : String(error),
          }),
          "paused",
        );
        setConversationRunning(conversationId, false);
        if (busyRef.current) setBusy(false);
      }
    } finally {
      // 正常情况下 pi 的 agent_end 事件负责清理 running/busy（见 subscribePiEvents）。
      // 但 agent loop 内部异步异常（LLM 网络错误、customTool 抛错）可能不发 agent_end/error，
      // 此时 sendRpc 已成功返回但事件流静默中断。为防止 UI 永久卡死，加一个安全超时：
      // 若 5 分钟后该 run 仍在跑，强制清理。
      const runIdAtFinally = runId;
      const conversationIdAtFinally = conversationId;
      scheduleBusySafetyTimeout(runIdAtFinally, conversationIdAtFinally);
    }
  };

  const clearConversationView = () => {
    setSelectedTaskId(undefined);
    setCurrentConversationId(undefined);
    currentConversationIdRef.current = undefined;
    setConversationMessages([]);
    setConversationReadOnly(false);
    conversationReadOnlyRef.current = false;
    loadedConversationFingerprintRef.current = null;
  };

  const handleSelectNav = (nav: SidebarNavId) => {
    setActiveNav(nav);
    if (nav === "home" || nav === "tasks" || nav === "projects") {
      clearConversationView();
    } else {
      setConversationReadOnly(false);
    }
  };

  const startAlertAnalysisConversation = () => {
    const conversationId = makeLocalId();
    setActiveNav("tasks");
    setSelectedQuickActionId("alert-analysis");
    setSelectedTaskId(conversationId);
    setCurrentConversationId(conversationId);
    currentConversationIdRef.current = conversationId;
    setConversationReadOnly(false);
    conversationReadOnlyRef.current = false;
    setPrompt("");
    deletedConversationIdsRef.current.delete(conversationId);
    rememberConversationMetadata(conversationId, metadataForHumanId("alert-analysis"));
    const alertHuman = effectiveDigitalHumans.find((human) => human.id === "alert-analysis");
    const openingMessages = digitalHumanOpeningMessages(alertHuman);
    conversationMessageBuffersRef.current[conversationId] = openingMessages;
    setConversationMessages(openingMessages);
  };

  const handleSelectQuickAction = (action: QuickAction) => {
    if (action.status === "pending") return;

    if (action.id === "alert-analysis") {
      recordHumanUsage(action.id);
      startAlertAnalysisConversation();
      return;
    }

    recordHumanUsage(action.id);

    const conversationId = makeLocalId();
    setActiveNav("tasks");
    setSelectedQuickActionId(action.id);
    setSelectedTaskId(conversationId);
    setCurrentConversationId(conversationId);
    currentConversationIdRef.current = conversationId;
    setConversationReadOnly(false);
    conversationReadOnlyRef.current = false;
    setPrompt(action.prompt);
    deletedConversationIdsRef.current.delete(conversationId);
    rememberConversationMetadata(conversationId, metadataForHumanId(action.id));
    const human = effectiveDigitalHumans.find((item) => item.id === action.id);
    const openingMessages = digitalHumanOpeningMessages(human);
    conversationMessageBuffersRef.current[conversationId] = openingMessages;
    setConversationMessages(openingMessages);
  };

  const handleBackFromConversation = () => {
    const returnToArchive = activeNav === "projects";
    clearConversationView();
    setActiveNav(returnToArchive ? "projects" : "tasks");
  };

  /**
   * 首页「最近使用」卡片点击：不再立即跳转任务页/建会话，
   * 而是把 `@员工名 ` 注入输入框（与输入框内 @ 选择语义一致）。
   * 若输入框已有 @ 提及则替换之，避免重复。
   */
  const handleSelectHuman = (humanId: string) => {
    const human = effectiveDigitalHumans.find((item) => item.id === humanId);
    if (!human || human.status === "pending") return;
    recordHumanUsage(human.id);
    setPrompt((current) => {
      // 移除已有的 @员工名 前缀（任意员工），再前置新的 @员工名。
      const stripped = current.replace(/(^|\s)@[^\s@]+\s?/g, "").trimStart();
      return `@${human.name} ${stripped}`;
    });
  };

  const handleSelectTask = async (task: RecentTask) => {
    const runId = selectTaskRunIdRef.current + 1;
    selectTaskRunIdRef.current = runId;
    const isCurrent = () => selectTaskRunIdRef.current === runId;

    const isArchived = archivedTasks.some((item) => item.id === task.id);
    const isRunning = runningConversationIds.has(task.id);
    if (!isArchived) setActiveNav("tasks");
    setSelectedQuickActionId(undefined);
    setSelectedTaskId(task.id);
    setPrompt("");
    setBusy(true);
    setCurrentConversationId(task.id);
    currentConversationIdRef.current = task.id;
    setConversationReadOnly(isArchived);
    conversationReadOnlyRef.current = isArchived;
    loadedConversationFingerprintRef.current = null;
    if (task.agentId && task.agentName) {
      rememberConversationMetadata(task.id, {
        agentId: task.agentId,
        agentName: task.agentName,
      });
    }

    if (isRunning) {
      const buffered = conversationMessageBuffersRef.current[task.id] ?? [];
      setConversationMessages(buffered);
      loadedConversationFingerprintRef.current = {
        id: task.id,
        fingerprint: buildMessagesFingerprint(buffered),
      };
      setBusy(true);
      return;
    }

    setConversationMessages([]);
    conversationMessageBuffersRef.current[task.id] = [];

    try {
      const loaded = await loadConversation(task.id);
      if (!isCurrent()) return;
      loadedConversationFingerprintRef.current = {
        id: task.id,
        fingerprint: buildMessagesFingerprint(loaded.messages),
      };
      rememberConversationMetadata(task.id, {
        agentId: loaded.summary.agentId,
        agentName: loaded.summary.agentName,
      });
      setConversationMessages(loaded.messages);
      conversationMessageBuffersRef.current[task.id] = loaded.messages;
      const riskContext = hydrateRiskAssessmentContext(task.id, loaded.messages);
      if (
        !isArchived
        && riskContext?.job.taskId
        && ["pending", "running"].includes(riskContext.job.status)
      ) {
        setConversationRunning(task.id, true);
        void pollRiskAssessment(task.id, riskContext);
      } else if (loaded.summary.status === "running") {
        // 历史会话落库的 status 可能因上次崩溃停留在 "running"。
        // 这里没有正在轮询的风评任务，也不是内存态 running，按消息推导修正。
        const correctedStatus = sanitizeStaleRunningStatus(loaded.summary.status);
        setRecentTasks((items) =>
          items.map((item) => (item.id === task.id ? { ...item, status: correctedStatus } : item)),
        );
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("会话不存在")) {
        setRecentTasks((items) => items.filter((item) => item.id !== task.id));
        setArchivedTasks((items) => items.filter((item) => item.id !== task.id));
        conversationMessageBuffersRef.current[task.id] = [];
        setConversationMessages([]);
        setSelectedTaskId(undefined);
        setCurrentConversationId(undefined);
        currentConversationIdRef.current = undefined;
        setConversationReadOnly(false);
        conversationReadOnlyRef.current = false;
      } else {
        const errorMessages: ChatMessage[] = [
          {
            id: makeLocalId(),
            role: "assistant",
            title: "历史会话读取失败",
            content: message,
            time: formatMessageTime(),
          },
        ];
        conversationMessageBuffersRef.current[task.id] = errorMessages;
        setConversationMessages(errorMessages);
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const delegateAttachmentsToAgent = async (
    conversationId: string,
    uploaded: ChatMessageAttachment[],
  ) => {
    appendUserMessageToConversation(
      conversationId,
      `已上传附件：${uploaded.map((item) => item.name).join("、")}`,
      uploaded,
    );
    const previous = fileAttachmentContextsRef.current[conversationId] ?? [];
    fileAttachmentContextsRef.current[conversationId] = [...previous, ...uploaded];
    setBusy(false);
    await submitPrompt({
      request: "请结合当前对话分析这些附件所对应的用户目的，并自主决定下一步处理。需要外部能力时，先发现并调用当前数字员工绑定的 MCP 服务；如果目的不明确，请先提出最少量的澄清问题。",
      skipUserMessage: true,
    });
  };

  const handleAttachFiles = async (files: File[]) => {
    if (!files.length || currentConversationRunning) return;
    const conversationId = ensureConversation();
    setActiveNav("tasks");
    setBusy(true);

    try {
      const uploaded: ChatMessageAttachment[] = [];
      for (const file of files) {
        const base64 = await fileToBase64(file);
        const ext = fileExt(file.name) || "bin";
        const tmpPath = await invoke<string>("write_uploaded_blob", {
          base64Data: base64,
          extension: ext,
          fileName: file.name,
        });
        const isImage = Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXT, ext);
        uploaded.push({
          kind: isImage ? "image" : "file",
          name: file.name,
          previewUrl: isImage ? `data:${IMAGE_MIME_BY_EXT[ext]};base64,${base64}` : undefined,
          path: tmpPath,
          ext,
          size: file.size,
        });
      }

      await delegateAttachmentsToAgent(conversationId, uploaded);
    } catch (error) {
      setBusy(false);
      appendMessageToConversation(
        conversationId,
        progressToMessage({
          title: "附件上传失败",
          content: error instanceof Error ? error.message : String(error),
        }),
        "paused",
      );
    }
  };

  const handlePickAttachments = async () => {
    if (currentConversationRunning) return;
    setBusy(true);
    try {
      const uploaded = await invoke<ChatMessageAttachment[]>("pick_and_store_attachments");
      if (!uploaded.length) {
        setBusy(false);
        return;
      }
      const conversationId = ensureConversation();
      setActiveNav("tasks");
      await delegateAttachmentsToAgent(conversationId, uploaded);
    } catch (error) {
      setBusy(false);
      if (String(error).includes("已取消")) return;
      const conversationId = ensureConversation();
      appendMessageToConversation(
        conversationId,
        progressToMessage({
          title: "附件上传失败",
          content: error instanceof Error ? error.message : String(error),
        }),
        "paused",
      );
    }
  };

  const handleCancel = async () => {
    activeRunIdRef.current += 1;
    const conversationId = currentConversationIdRef.current;
    const riskContext = conversationId
      ? riskAssessmentContextsRef.current[conversationId]
      : undefined;
    if (
      conversationId
      && riskContext?.job.taskId
      && ["pending", "running"].includes(riskContext.job.status)
    ) {
      riskAssessmentPollTokensRef.current[conversationId] =
        (riskAssessmentPollTokensRef.current[conversationId] ?? 0) + 1;
      try {
        const canceled = await cancelRiskAssessment(riskContext.job.taskId);
        updateRiskAssessmentJob(
          conversationId,
          riskContext,
          {
            status: canceled.status === "canceled" ? "canceled" : canceled.status,
            progress: canceled.progress || "评估已取消",
            progressPct: canceled.progressPct,
            error: canceled.error,
          },
          canceled.status === "canceled"
            ? "评估任务已取消，已上传材料仍可用于重新评估。"
            : `任务当前状态：${canceled.progress || canceled.status}`,
          canceled.status === "canceled" ? "canceled" : "paused",
        );
      } catch (error) {
        const current = riskAssessmentContextsRef.current[conversationId] ?? riskContext;
        updateRiskAssessmentJob(
          conversationId,
          current,
          { status: "running", progress: "取消请求失败，继续查询任务状态" },
          `取消请求失败：${error instanceof Error ? error.message : String(error)}。将继续查询服务端任务状态。`,
          "running",
        );
        setConversationRunning(conversationId, true);
        setBusy(true);
        void pollRiskAssessment(conversationId, current);
        return;
      }
      setConversationRunning(conversationId, false);
      setBusy(false);
      setPrompt("");
      return;
    }

    // pi 中止：通过 host 的 abort 命令取消当前 agent loop。
    const piSessionId = conversationId ? conversationPiSessionRef.current[conversationId] : undefined;
    if (piSessionId) {
      await sendRpc({ type: "abort", sessionId: piSessionId }).catch(() => {});
    }
    if (conversationId) {
      setConversationRunning(conversationId, false);
    }
    // 取消安全超时并清理 busy（abort 后 agent_end 可能仍会到达，但这里即时清理更稳）。
    clearBusySafetyTimeout(activeRunIdRef.current);
    activeRunIdRef.current += 1; // 使当前 run 失效，避免迟到的 agent_end 错误清理
    setBusy(false);
    busyRef.current = false;
    setPrompt("");
  };

  const handleSuggestionSelect = (value: string) => {
    if (currentConversationRunning) return;
    const trimmed = value.trim();
    if (/[？?:：]$/.test(trimmed)) {
      setPrompt(value);
      return;
    }
    if (selectedHuman.id === "alert-analysis") {
      void submitPrompt({ request: value, userMessage: value });
      return;
    }
    if (selectedHuman.id === "data-security-risk-assessment") {
      const conversationId = currentConversationIdRef.current;
      const matrixMatch = value.match(/^评估：\s*(.+)$/);
      if (conversationId && matrixMatch) {
        void startRiskAssessment(conversationId, matrixMatch[1].trim(), value);
      }
      return;
    }
    setPrompt(value);
  };

  // 侧栏拖拽 resize：把 window 级 pointer 监听器的清理函数存到 ref，
  // 组件卸载时统一移除，避免拖拽中路由切换/StrictMode 双调导致监听器残留。
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      sidebarResizeCleanupRef.current?.();
      sidebarResizeCleanupRef.current = null;
    };
  }, []);

  const handleSidebarResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarPanelWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setSidebarPanelWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };

    const handlePointerUp = () => {
      document.body.classList.remove("is-resizing-sidebar");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      sidebarResizeCleanupRef.current = null;
    };

    // 启动新拖拽前，先清理上一次未正常结束的监听器（防御性）。
    sidebarResizeCleanupRef.current?.();
    document.body.classList.add("is-resizing-sidebar");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    sidebarResizeCleanupRef.current = () => {
      document.body.classList.remove("is-resizing-sidebar");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  };

  const handleDeleteTask = (task: RecentTask) => setModal({ type: "delete", task });
  const handleRenameTask = (task: RecentTask) => setModal({ type: "rename", task });
  const handleArchiveTask = (task: RecentTask) => setModal({ type: "archive", task });

  const stopPersistedRiskAssessment = async (
    conversationId: string,
    persistFinalState: boolean,
  ) => {
    let context = riskAssessmentContextsRef.current[conversationId];
    if (!context) {
      try {
        const loaded = await loadConversation(conversationId);
        conversationMessageBuffersRef.current[conversationId] = loaded.messages;
        rememberConversationMetadata(conversationId, {
          agentId: loaded.summary.agentId,
          agentName: loaded.summary.agentName,
        });
        context = hydrateRiskAssessmentContext(conversationId, loaded.messages);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("会话不存在")) return;
        throw error;
      }
    }
    if (
      !context?.job.taskId
      || !["pending", "running"].includes(context.job.status)
    ) {
      return;
    }

    riskAssessmentPollTokensRef.current[conversationId] =
      (riskAssessmentPollTokensRef.current[conversationId] ?? 0) + 1;
    const task = await cancelRiskAssessment(context.job.taskId);
    if (persistFinalState) {
      if (task.status === "completed" || task.status === "failed") {
        await pollRiskAssessment(conversationId, context);
      } else {
        updateRiskAssessmentJob(
          conversationId,
          context,
          {
            status: task.status,
            progress: task.progress || "评估已取消",
            progressPct: task.progressPct,
            error: task.error,
          },
          task.status === "canceled"
            ? "评估任务已取消，已上传材料仍可用于重新评估。"
            : `任务当前状态：${task.progress || task.status}`,
          task.status === "canceled" ? "canceled" : "paused",
        );
        await conversationSaveQueuesRef.current[conversationId];
      }
    }
    setConversationRunning(conversationId, false);
  };

  const handleRestoreTask = async (task: RecentTask) => {
    try {
      await restoreConversation(task.id);
      archivedTaskIdsRef.current.delete(task.id);
      deletedConversationIdsRef.current.delete(task.id);
      setArchivedTasks((items) => items.filter((item) => item.id !== task.id));
      setRecentTasks((items) => {
        const exists = items.some((item) => item.id === task.id);
        if (exists) return items;
        return [task, ...items].slice(0, 80);
      });
      if (selectedTaskId === task.id) {
        setActiveNav("tasks");
        setConversationReadOnly(false);
        conversationReadOnlyRef.current = false;
        setSelectedTaskId(task.id);
        setCurrentConversationId(task.id);
        currentConversationIdRef.current = task.id;
      }
    } catch (error) {
      console.error("恢复任务失败", error);
    }
  };

  /** 清理某会话相关的所有内存 ref（删除/归档时调用，避免长期使用后 ref 表无限增长）。 */
  const cleanupConversationRefs = (conversationId: string) => {
    delete conversationMessageBuffersRef.current[conversationId];
    delete conversationMetadataRef.current[conversationId];
    delete conversationPiSessionRef.current[conversationId];
    delete conversationPiSessionIdentityRef.current[conversationId];
    delete streamingMessageIdRef.current[conversationId];
    delete conversationSaveQueuesRef.current[conversationId];
    // toolMessageIdRef 按 `${conversationId}:${toolCallId}` 索引，需按前缀清理。
    const prefix = `${conversationId}:`;
    for (const key of Object.keys(toolMessageIdRef.current)) {
      if (key.startsWith(prefix)) delete toolMessageIdRef.current[key];
    }
    clearRiskAssessmentContext(conversationId);
  };

  const handleModalConfirm = async (value?: string) => {
    if (!modal) return;
    const { type, task } = modal;
    const taskIsArchived = archivedTasks.some((item) => item.id === task.id);
    setModal(null);

    try {
      if (type === "delete") {
        await stopPersistedRiskAssessment(task.id, false);
        deletedConversationIdsRef.current.add(task.id);
        archivedTaskIdsRef.current.delete(task.id);
        cleanupConversationRefs(task.id);
        await deleteConversation(task.id);
        setRecentTasks((items) => items.filter((item) => item.id !== task.id));
        setArchivedTasks((items) => items.filter((item) => item.id !== task.id));
        if (selectedTaskId === task.id) {
          clearConversationView();
          setActiveNav(taskIsArchived ? "projects" : "home");
        }
      } else if (type === "archive") {
        await stopPersistedRiskAssessment(task.id, true);
        await archiveConversation(task.id);
        // 归档会话不再活跃，释放其内存 ref（恢复时会重新 load）。
        cleanupConversationRefs(task.id);
        archivedTaskIdsRef.current.add(task.id);
        setRecentTasks((items) => items.filter((item) => item.id !== task.id));
        setArchivedTasks((items) => {
          const exists = items.some((item) => item.id === task.id);
          if (exists) return items;
          return [{ ...task, status: "paused" as const }, ...items].slice(0, 80);
        });
        if (selectedTaskId === task.id) {
          clearConversationView();
          setActiveNav("home");
        }
      } else if (type === "rename" && value?.trim()) {
        if (value.trim() === task.title) return;
        await renameConversation(task.id, value.trim());
        setRecentTasks((items) =>
          items.map((item) =>
            item.id === task.id
              ? { ...item, title: value.trim(), titleSource: "manual" as const }
              : item,
          ),
        );
        setArchivedTasks((items) =>
          items.map((item) =>
            item.id === task.id
              ? { ...item, title: value.trim(), titleSource: "manual" as const }
              : item,
          ),
        );
      }
    } catch (error) {
      if (type === "delete") {
        deletedConversationIdsRef.current.delete(task.id);
      }
      if (type === "archive") {
        archivedTaskIdsRef.current.delete(task.id);
      }
      console.error("任务操作失败", error);
    }
  };

  return (
    <div className="app-shell">
      {/* 外部链接守门人：点击走系统浏览器、右键菜单复制链接，兜底任何渲染路径 */}
      <LinkGuard />
      <Sidebar
        quickActions={sortedQuickActions}
        recentTasks={displayedRecentTasks}
        archivedTasks={displayedArchivedTasks}
        activeNav={activeNav}
        selectedQuickActionId={selectedQuickActionId}
        selectedTaskId={selectedTaskId}
        panelWidth={sidebarPanelWidth}
        onSelectNav={handleSelectNav}
        onSelectQuickAction={handleSelectQuickAction}
        onSelectTask={handleSelectTask}
        onResizeStart={handleSidebarResizeStart}
        onDeleteTask={handleDeleteTask}
        onRenameTask={handleRenameTask}
        onArchiveTask={handleArchiveTask}
        onRestoreTask={handleRestoreTask}
      />
      <main
        className={`workspace ${activeNav === "settings" || activeNav === "mcp" || activeNav === "skill" ? "settings-workspace" : ""} ${activeNav === "skill" ? "skill-workspace" : ""} ${
          activeNav === "tasks" || (activeNav === "projects" && selectedTaskId) ? "tasks-workspace" : ""
        }`}
      >
        {activeNav === "settings" ? (
          <SettingsPanel />
        ) : activeNav === "skill" ? (
          <SkillCenterPanel />
        ) : activeNav === "mcp" ? (
          <McpSquarePanel />
        ) : activeNav === "usage" ? (
          <TokenUsagePanel />
        ) : activeNav === "projects" && !selectedTaskId ? (
          <section className="archive-empty-state">
            <div className="archive-empty-icon">
              <Archive size={28} />
            </div>
            <h2>归档列表</h2>
            <p>已归档的任务会出现在这里。归档内容仅支持只读查看，无法继续对话或提交新任务。随时可以从归档中打开查看完整的对话记录和任务结果。</p>
            <p className="archive-empty-hint">从左侧历史任务右键选择「归档」，即可将任务移至此处。</p>
          </section>
        ) : activeNav === "tasks" && !selectedTaskId ? (
          <TaskCenter
            tasks={displayedRecentTasks}
            employees={effectiveDigitalHumans}
            mcpConnectedCount={connectedMcpCount}
            mcpTotalCount={catalogDigitalHumans.length}
            mcpChecking={mcpChecking}
            onSelectTask={handleSelectTask}
            onRenameTask={handleRenameTask}
            onArchiveTask={handleArchiveTask}
            onDeleteTask={handleDeleteTask}
          />
        ) : (activeNav === "tasks" || (activeNav === "projects" && selectedTaskId)) ? (
          <TaskConversation
            key={currentConversationId ?? selectedTaskId ?? "new-task"}
            messages={conversationMessages}
            prompt={prompt}
            modelName={currentModelName}
            busy={currentConversationRunning}
            modelStatus={modelStatus}
            modelError={modelError}
            readOnly={conversationReadOnly}
            mcpReady={selectedHuman.status === "ready"}
            mcpStatusReason={selectedHuman.disabledReason}
            selectedHumanName={selectedTask?.agentName ?? selectedHuman.name}
            mentionHumans={mentionableHumans}
            taskTitle={selectedTask?.title ?? "新任务"}
            taskStatus={selectedTaskStatus}
            showToolMessages={appPreferences.showToolMessages}
            taskStartedAt={selectedTask?.createdAt}
            updatedTime={selectedTask?.time}
            backLabel={activeNav === "projects" ? "返回归档列表" : "返回任务中心"}
            onBack={handleBackFromConversation}
            onPromptChange={setPrompt}
            onAttachFiles={handleAttachFiles}
            onPickAttachment={handlePickAttachments}
            onSubmit={submitPrompt}
            onCancel={handleCancel}
            onSuggestionSelect={handleSuggestionSelect}
            onConfirmSkillExecution={handleConfirmSkillExecution}
          />
        ) : (
          <>
            <Hero
              prompt={prompt}
              introduction={mentionedHuman?.welcomeMessage?.trim()}
              mentionHumans={mentionableHumans}
              selectedEmployeeName={selectedEmployeeName}
              modelName={currentModelName}
              busy={currentConversationRunning}
              disabled={selectedHuman.status !== "ready"}
              disabledReason={selectedHuman.disabledReason}
              modelStatus={modelStatus}
              modelError={modelError}
              onPromptChange={setPrompt}
              onAttachFiles={handleAttachFiles}
              onPickAttachment={handlePickAttachments}
              onSubmit={submitPrompt}
              onCancel={handleCancel}
            />
            <section className="human-picker-section">
              <p className="human-picker-hint">最近使用</p>
              <DigitalHumanPicker humans={recentHumans} selectedId={mentionedHuman?.id ?? ""} onSelect={handleSelectHuman} />
            </section>
          </>
        )}
      </main>

      <ConfirmModal
        open={modal?.type === "delete"}
        title="删除任务"
        message={`确认删除任务「${modal?.task.title ?? ""}」？此操作不可恢复。`}
        confirmLabel="删除"
        danger
        onConfirm={handleModalConfirm}
        onCancel={() => setModal(null)}
      />
      <ConfirmModal
        open={modal?.type === "archive"}
        title="归档任务"
        message={`确认归档任务「${modal?.task.title ?? ""}」？归档后可从归档列表恢复。`}
        confirmLabel="归档"
        onConfirm={handleModalConfirm}
        onCancel={() => setModal(null)}
      />
      <ConfirmModal
        open={modal?.type === "rename"}
        title="重命名"
        message="为任务设置新名称："
        mode="input"
        inputLabel="任务名称"
        inputDefault={modal?.task.title ?? ""}
        confirmLabel="保存"
        onConfirm={handleModalConfirm}
        onCancel={() => setModal(null)}
      />
    </div>
  );
}
