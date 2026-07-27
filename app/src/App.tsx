import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Archive } from "lucide-react";
import { ConfirmModal } from "./components/ConfirmModal";
import { DigitalHumanPicker } from "./components/DigitalHumanPicker";
import { Hero } from "./components/Hero";
import { McpSquarePanel } from "./components/McpSquarePanel";
import { ExtensionsPanel } from "./components/ExtensionsPanel";
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
import { executeSkillPlan } from "./services/skillExecution";
import { parseAlertFileContent } from "./services/alertFileParser";
import type { ParsedAlertFields } from "./services/alertFileParser";
import { sendRpc, subscribePiEvents } from "./services/hostBridge";
import type { ConversationAttachments, PiEvent } from "./services/hostBridge";
import {
  cancelRiskAssessment,
  contextFromMessages,
  downloadRiskAssessmentResult,
  getRiskAssessmentStatus,
  listRiskAssessmentMatrices,
  normalizeRiskAssessmentResult,
  pickAndUploadRemoteRiskMaterial,
  submitRiskAssessment,
  uploadLocalRiskMaterial,
} from "./services/riskAssessment";
import type { RemoteRiskMaterial, RiskTaskStatus } from "./services/riskAssessment";
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
import {
  DATA_RISK_ASSESSMENT_MCP_SERVICE,
  listMcpConnectionSettings,
  testMcpConnection,
} from "./services/mcpSettings";
import type { McpConnectionSettings } from "./services/mcpSettings";

const SIDEBAR_PANEL_WIDTH_KEY = "dp-agent-sidebar-panel-width";
const RECENTLY_USED_HUMAN_IDS_KEY = "dp-recently-used-human-ids";
const SIDEBAR_PANEL_MIN = 190;
const SIDEBAR_PANEL_MAX = 420;

type McpAvailability = {
  state: "checking" | "connected" | "disabled" | "unconfigured" | "error";
  badge: "检测中" | "可用" | "待配置" | "不可用";
  disabledReason?: string;
};

const DIGITAL_HUMAN_TEMPLATE_BY_MCP = new Map(
  digitalHumans.flatMap((human) => (human.mcpService ? [[human.mcpService, human] as const] : [])),
);

const QUICK_ACTION_TEMPLATE_BY_MCP = new Map(
  quickActions.flatMap((action) => (action.mcpService ? [[action.mcpService, action] as const] : [])),
);

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
  return last.role === "assistant" ? "done" : "paused";
};

type AlertAttachmentContext = {
  fields?: ParsedAlertFields;
  pcapSections: string[];
  imageSections: string[];
  /** 用户上传的 PCAP/抓包文件元信息，用于在用户消息上展示彩色标签、双击打开 */
  pcapFiles: ChatMessageAttachment[];
};

type ConversationMetadata = Pick<ConversationSnapshot, "agentId" | "agentName">;

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

const readTextFiles = async (files: File[]) =>
  Promise.all(
    files.map(async (file) => {
      const text = await file.text();
      if (!text.trim()) {
        throw new Error(`文件「${file.name}」没有可读取的文本内容。`);
      }
      return {
        name: file.name,
        text,
        preview: text.slice(0, 1200),
      };
    }),
  );

const formatPcapSection = (fileName: string, pcapText: string) =>
  `=== PCAP 文件：${fileName} ===\n${pcapText}`;

const formatAlertImageSection = (fileName: string, imageText: string) =>
  `=== 告警截图 OCR：${fileName} ===\n${imageText}`;

const mergeAlertFields = (...fieldSets: Array<ParsedAlertFields | undefined>) => {
  const merged: ParsedAlertFields = {};
  for (const fields of fieldSets) {
    if (!fields) continue;
    for (const [key, value] of Object.entries(fields) as Array<[keyof ParsedAlertFields, string | undefined]>) {
      if (value && !merged[key]) {
        merged[key] = value;
      }
    }
  }
  return merged;
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
} => {
  if (!result || typeof result !== "object") return {};
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const det = details as Record<string, unknown>;
    if (det.module === "alert-analysis" || det.module === "ip-threat-analysis") {
      return { alertAnalysisResult: det as unknown as AlertAnalysisResult };
    }
    if (det.module === "data-risk-assessment") {
      return { riskAssessmentResult: det as unknown as RiskAssessmentResult };
    }
  }
  return {};
};

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [currentModelName, setCurrentModelName] = useState("deepseek-v4-pro");
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
  const [selectedHumanId, setSelectedHumanId] = useState(
    loadRecentlyUsedHumanIds()[0] ?? "",
  );
  const [recentlyUsedHumanIds, setRecentlyUsedHumanIds] = useState<string[]>(loadRecentlyUsedHumanIds);
  const [activeNav, setActiveNav] = useState<SidebarNavId>("home");
  const [sidebarPanelWidth, setSidebarPanelWidth] = useState(getInitialSidebarWidth);
  const [runningConversationIds, setRunningConversationIds] = useState<Set<string>>(() => new Set());
  const [mcpCatalog, setMcpCatalog] = useState<McpConnectionSettings[]>([]);
  const [mcpAvailability, setMcpAvailability] = useState<Record<string, McpAvailability>>({});
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
  const alertAttachmentContextsRef = useRef<Record<string, AlertAttachmentContext>>({});
  const riskAssessmentContextsRef = useRef<Partial<Record<string, RiskAssessmentContext>>>({});
  const riskAssessmentPollTokensRef = useRef<Record<string, number>>({});
  const loadedConversationFingerprintRef = useRef<{ id: string; fingerprint: string } | null>(null);
  const archivedTaskIdsRef = useRef<Set<string>>(new Set());
  const deletedConversationIdsRef = useRef<Set<string>>(new Set());
  const titleGenerationInFlightRef = useRef<Set<string>>(new Set());
  const titleGenerationTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // 自检带重试：deepseek 偶发慢响应（数十秒）或网络抖动时，启动瞬间的单次自检
    // 可能失败并让模型标签永久停在红色。失败后延迟重试，最多尝试 4 次。
    const MAX_RETRIES = 4;
    const RETRY_DELAY_MS = 12_000;
    const runCheck = (attempt: number) => {
      if (!alive) return;
      sendRpc<string>({ type: "test_model", provider: "deepseek", modelId: "" })
        .then(() => {
          if (!alive) return;
          setModelStatus("ok");
          setModelError("");
        })
        .catch((error) => {
          if (!alive) return;
          const message = String(error);
          setModelStatus("error");
          setModelError(message);
          if (attempt < MAX_RETRIES) {
            retryTimer = setTimeout(() => runCheck(attempt + 1), RETRY_DELAY_MS);
          }
        });
    };
    runCheck(0);
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
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

          try {
            await testMcpConnection(serviceId);
            return [serviceId, { state: "connected", badge: "可用" } satisfies McpAvailability] as const;
          } catch (error) {
            const detail = String(error).replace(/^Error:\s*/i, "").slice(0, 180);
            return [
              serviceId,
              {
                state: "error",
                badge: "不可用",
                disabledReason: `${label}对应的 MCP 服务连接失败${detail ? `：${detail}` : ""}`,
              } satisfies McpAvailability,
            ] as const;
          }
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
      return { status: "ready", badge: availability.badge };
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
    () =>
      catalogDigitalHumans.map((human) => {
        const resolved = resolveMcpStatus(human.status, human.mcpService);
        return { ...human, status: resolved.status, disabledReason: resolved.disabledReason ?? human.disabledReason };
      }),
    [catalogDigitalHumans, mcpAvailability],
  );

  const effectiveQuickActions = useMemo(
    () =>
      catalogDigitalHumans.map(digitalHumanToQuickAction).map((action) => {
        const resolved = resolveMcpStatus(action.status, action.mcpService);
        return {
          ...action,
          badge: resolved.badge ?? action.badge,
          status: resolved.status,
          disabledReason: resolved.disabledReason ?? action.disabledReason,
        };
      }),
    [catalogDigitalHumans, mcpAvailability],
  );

  const selectedQuickActionHuman = useMemo(
    () => (selectedQuickActionId ? effectiveDigitalHumans.find((human) => human.id === selectedQuickActionId) : undefined),
    [selectedQuickActionId, effectiveDigitalHumans],
  );
  const selectedHuman = useMemo(
    () =>
      selectedQuickActionHuman
      ?? effectiveDigitalHumans.find((human) => human.id === selectedHumanId)
      ?? effectiveDigitalHumans[0]
      ?? EMPTY_DIGITAL_HUMAN,
    [selectedHumanId, selectedQuickActionHuman, effectiveDigitalHumans],
  );
  useEffect(() => {
    if (effectiveDigitalHumans.length === 0) return;
    if (!effectiveDigitalHumans.some((human) => human.id === selectedHumanId)) {
      setSelectedHumanId(effectiveDigitalHumans[0].id);
    }
  }, [effectiveDigitalHumans, selectedHumanId]);

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

  const getAlertAttachmentContext = (conversationId: string): AlertAttachmentContext => (
    alertAttachmentContextsRef.current[conversationId] ?? { pcapSections: [], imageSections: [], pcapFiles: [] }
  );

  const setAlertAttachmentContext = (
    conversationId: string,
    patch: Partial<AlertAttachmentContext>,
  ) => {
    const previous = getAlertAttachmentContext(conversationId);
    alertAttachmentContextsRef.current[conversationId] = {
      fields: patch.fields ?? previous.fields,
      pcapSections: patch.pcapSections ?? previous.pcapSections,
      imageSections: patch.imageSections ?? previous.imageSections,
      pcapFiles: patch.pcapFiles ?? previous.pcapFiles,
    };
  };

  const clearAlertAttachmentContext = (conversationId?: string) => {
    if (conversationId) {
      delete alertAttachmentContextsRef.current[conversationId];
      return;
    }
    alertAttachmentContextsRef.current = {};
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
      .then(setRecentTasks)
      .catch((error) => {
        console.error("读取历史会话失败", error);
      });
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
    : selectedTask?.status ?? "running";
  const currentConversationRunning =
    !!currentConversationId && runningConversationIds.has(currentConversationId);
  const riskAssessmentTransport =
    mcpCatalog.find((settings) => settings.serviceId === DATA_RISK_ASSESSMENT_MCP_SERVICE)
      ?.transport ?? "stdio";

  useEffect(() => {
    let alive = true;

    // 从 pi 的 settings.json 读取默认模型名（与新的模型管理面板一致）。
    const refreshModelName = async () => {
      try {
        const def = await sendRpc<{ provider: string; model: string } | null>({ type: "models_get_default" });
        if (!alive) return;
        if (def) {
          setCurrentModelName(def.model || def.provider || "未配置模型");
        } else {
          // 没有默认模型时，尝试列举可用模型取第一个
          const models = await sendRpc<Array<{ id: string; provider: string; available: boolean }>>({ type: "models_list_all" });
          if (!alive) return;
          const first = models.find((m) => m.available) ?? models[0];
          setCurrentModelName(first ? `${first.id}` : "未配置模型");
        }
      } catch {
        if (alive) setCurrentModelName("未配置模型");
      }
    };

    // 模型配置变更后刷新显示名（新的 SettingsPanel 保存后会派发此事件）。
    const handleModelSettingsChanged = () => {
      void refreshModelName();
    };

    void refreshModelName();
    window.addEventListener("nova-model-settings-changed", handleModelSettingsChanged);

    return () => {
      alive = false;
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
    return {
      id: conversationId,
      title: buildConversationTitle(messages, fallbackTitle),
      agentId: metadata.agentId,
      agentName: metadata.agentName,
      status,
      messages,
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

      if (loaded) {
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

    const optimisticSummary: ConversationSummary = {
      id: snapshot.id,
      title: snapshot.title,
      titleSource: "pending",
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      status: snapshot.status,
      lastMessage: buildLastMessage(conversationMessages),
      createdAt: "",
      updatedAt: new Date().toISOString(),
    };
    setRecentTasks((items) => {
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

  const ensureConversation = () => {
    if (currentConversationId && activeNav === "tasks" && !conversationReadOnly) {
      conversationReadOnlyRef.current = false;
      rememberConversationMetadata(currentConversationId, metadataFromCurrentSelection());
      return currentConversationId;
    }
    const id = makeLocalId();
    setCurrentConversationId(id);
    currentConversationIdRef.current = id;
    setSelectedTaskId(id);
    setConversationReadOnly(false);
    conversationReadOnlyRef.current = false;
    deletedConversationIdsRef.current.delete(id);
    rememberConversationMetadata(id, metadataFromCurrentSelection());
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

  const beginRiskMaterialUpload = (
    conversationId: string,
    fileName: string,
  ) => {
    const message = createUserMessage(
      `正在上传评估材料「${fileName}」，大文件可能需要一些时间，请稍候。`,
      [{
        kind: "file",
        name: fileName,
        ext: "zip",
        uploadStatus: "uploading",
      }],
    );
    appendMessageToConversation(conversationId, message, "running");
    return message.id;
  };

  const finishRiskMaterialUpload = (
    conversationId: string,
    messageId: string,
    fileName: string,
    status: "ready" | "failed",
    path?: string,
    error?: string,
  ) => {
    const attachment: ChatMessageAttachment = {
      kind: "file",
      name: fileName,
      path,
      ext: "zip",
      uploadStatus: status,
      uploadError: error,
    };
    updateMessageInConversation(
      conversationId,
      messageId,
      (message) => ({
        ...message,
        content: status === "ready"
          ? `已上传评估材料：${fileName}`
          : `评估材料上传失败：${fileName}`,
        attachments: [attachment],
      }),
      "paused",
    );
    return attachment;
  };

  const prepareRiskAssessmentMaterial = async (
    conversationId: string,
    uploaded: RemoteRiskMaterial,
    displayFileName: string,
    attachments: ChatMessageAttachment[],
  ) => {
    let matrices: string[] = [];
    try {
      matrices = await listRiskAssessmentMatrices();
    } catch (error) {
      console.error("读取评估矩阵失败", error);
    }
    if (!matrices.length) matrices = ["网络数据安全风险评估项目清单"];

    const job: RiskAssessmentJob = {
      materialId: uploaded.materialId,
      fileName: displayFileName,
      status: "uploaded",
      progress: "材料已上传",
      progressPct: 0,
    };
    const jobMessageId = makeLocalId();
    riskAssessmentContextsRef.current[conversationId] = {
      jobMessageId,
      job,
      attachments,
    };
    appendMessageToConversation(
      conversationId,
      {
        id: jobMessageId,
        role: "assistant",
        title: "评估材料已就绪",
        content: `已接收「${displayFileName}」（${uploaded.fileCount} 个文件）。请选择评估矩阵开始评估。`,
        suggestions: matrices.map((name) => `评估：${name}`),
        riskAssessmentJob: job,
        time: formatMessageTime(),
      },
      "paused",
    );
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
          // 新的 assistant 消息开始：登记一个 streaming 消息 id，后续 text_delta 拼到这里。
          const messageId = makeLocalId();
          streamingMessageIdRef.current[conversationId] = messageId;
          appendMessageToConversation(
            conversationId,
            { id: messageId, role: "assistant", content: "", time: formatMessageTime() },
            "running",
          );
          break;
        }
        case "message_update": {
          const delta = event.assistantMessageEvent?.delta ?? event.assistantMessageEvent?.text ?? "";
          if (!delta) break;
          const messageId = streamingMessageIdRef.current[conversationId];
          if (!messageId) break;
          updateMessageInConversation(
            conversationId,
            messageId,
            (message) => ({ ...message, content: message.content + delta }),
            "running",
          );
          break;
        }
        case "message_end": {
          // 单条 assistant 消息流式结束：清理 streaming id，防止下一轮 message_start 复用旧 id。
          // agent_end 会再清一次（兜底），但若中途有多条 message（如工具调用后继续回复），
          // 这里逐条清理更准确。
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
              title: `调用工具：${event.toolName}`,
              content: `正在执行 ${event.toolName}…`,
              steps: [`参数：${JSON.stringify(event.args ?? {}).slice(0, 500)}`],
              time: formatMessageTime(),
            },
            "running",
          );
          break;
        }
        case "tool_execution_update": {
          // 工具执行中的进度片段（partialResult）。把进度文本追加到工具气泡的 steps，
          // 让用户看到长任务（如风评、研判）的实时进度，而非只有 start/end 两个状态。
          const key = `${conversationId}:${event.toolCallId}`;
          const messageId = toolMessageIdRef.current[key];
          if (!messageId) break;
          const partial = event.partialResult;
          const partialText =
            typeof partial === "string"
              ? partial
              : (partial as { text?: string; content?: unknown })?.text ??
                (typeof (partial as { content?: unknown })?.content === "string"
                  ? String((partial as { content: string }).content)
                  : (() => {
                      try {
                        return partial == null ? "" : JSON.stringify(partial).slice(0, 300);
                      } catch {
                        return "";
                      }
                    })());
          if (!partialText) break;
          updateMessageInConversation(
            conversationId,
            messageId,
            (message) => ({ ...message, steps: [...(message.steps ?? []), partialText] }),
            "running",
          );
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
              title: event.isError ? `工具调用失败：${event.toolName}` : `工具调用完成：${event.toolName}`,
              content: event.isError
                ? String((event.result as { content?: unknown })?.content ?? "工具执行失败")
                : `已完成 ${event.toolName}。`,
              alertAnalysisResult: interpreted.alertAnalysisResult ?? message.alertAnalysisResult,
              riskAssessmentResult: interpreted.riskAssessmentResult ?? message.riskAssessmentResult,
              riskAssessmentJob: interpreted.riskAssessmentJob ?? message.riskAssessmentJob,
              usedSkill: interpreted.usedSkill ?? message.usedSkill,
              pendingSkillExecution: interpreted.pendingSkillExecution ?? message.pendingSkillExecution,
              suggestions: interpreted.suggestions ?? message.suggestions,
            }),
            "running",
          );
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
      fields?: ParsedAlertFields;
      skipUserMessage?: boolean;
    },
  ) => {
    const request = (override?.request ?? prompt).trim();
    if (!request) return;
    if (!override && selectedHuman.status !== "ready") return;
    if (!override && currentConversationRunning) return;

    // 数安风评：「评估：<矩阵名>」走异步评估，不经 pi。
    if (selectedHuman.id === "data-security-risk-assessment") {
      const matrixName = request.match(/^评估：\s*(.+)$/)?.[1]?.trim();
      if (matrixName) {
        const conversationId = ensureConversation();
        setPrompt("");
        await startRiskAssessment(
          conversationId,
          matrixName,
          override?.userMessage ?? request,
        );
        return;
      }
    }

    recordHumanUsage(selectedHuman.id);
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;

    const conversationId = ensureConversation();
    setBusy(true);
    busyRef.current = true;
    setConversationRunning(conversationId, true);
    setActiveNav("tasks");
    const attachmentContext = getAlertAttachmentContext(conversationId);
    if (!override?.skipUserMessage) {
      const userAttachments =
        attachmentContext.pcapFiles.length > 0 ? attachmentContext.pcapFiles : undefined;
      appendUserMessage(override?.userMessage ?? request, userAttachments);
    }
    setPrompt("");

    try {
      const alertFields = override?.fields ?? attachmentContext.fields;
      const pcapData = attachmentContext.pcapSections.length
        ? attachmentContext.pcapSections.join("\n\n")
        : undefined;
      const alertImageData = attachmentContext.imageSections.length
        ? attachmentContext.imageSections.join("\n\n")
        : undefined;
      const requestForAgent =
        selectedHuman.id === "alert-analysis" && alertImageData
          ? `${request}\n\n${alertImageData}`
          : request;
      clearAlertAttachmentContext(conversationId);

      // 在 host 内创建/复用 pi 会话，然后把 prompt 发给 pi 的 agent loop。
      // 流式 token、工具调用、结构化结果都通过 subscribePiEvents 的事件回流。
      let piSessionId = conversationPiSessionRef.current[conversationId];
      if (!piSessionId) {
        piSessionId = await sendRpc<string>({
          type: "new_session",
          humanId: selectedHuman.id,
          conversationId,
          // 自定义 MCP 员工（非内置 9 个）需要 mcpServiceId 才能在 host 端获得 MCP 工具白名单。
          mcpServiceId: selectedHuman.mcpService,
          resumeMessages: conversationMessageBuffersRef.current[conversationId]?.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
        conversationPiSessionRef.current[conversationId] = piSessionId;
      }

      const attachments: ConversationAttachments = {
        pcapSections: pcapData ? [pcapData] : undefined,
        alertFields: alertFields as Record<string, string> | undefined,
      };
      await sendRpc({
        type: "prompt",
        sessionId: piSessionId,
        message: requestForAgent,
        attachments,
      });

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
    clearAlertAttachmentContext(currentConversationIdRef.current);
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
    setSelectedHumanId("alert-analysis");
    setPrompt("");
    deletedConversationIdsRef.current.delete(conversationId);
    rememberConversationMetadata(conversationId, metadataForHumanId("alert-analysis"));
    alertAttachmentContextsRef.current[conversationId] = { pcapSections: [], imageSections: [], pcapFiles: [] };
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
    setSelectedHumanId(action.id);
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

  const handleSelectHuman = (humanId: string) => {
    const human = effectiveDigitalHumans.find((item) => item.id === humanId);
    if (!human || human.status === "pending") return;
    recordHumanUsage(human.id);
    if (human.id === "alert-analysis") {
      startAlertAnalysisConversation();
      return;
    }
    const conversationId = makeLocalId();
    setActiveNav("tasks");
    setSelectedQuickActionId(human.id);
    setSelectedTaskId(conversationId);
    setCurrentConversationId(conversationId);
    currentConversationIdRef.current = conversationId;
    setSelectedHumanId(human.id);
    setConversationReadOnly(false);
    conversationReadOnlyRef.current = false;
    setPrompt("");
    deletedConversationIdsRef.current.delete(conversationId);
    rememberConversationMetadata(conversationId, metadataForHumanId(human.id));
    const openingMessages = digitalHumanOpeningMessages(human);
    conversationMessageBuffersRef.current[conversationId] = openingMessages;
    setConversationMessages(openingMessages);
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
    clearAlertAttachmentContext(task.id);
    setCurrentConversationId(task.id);
    currentConversationIdRef.current = task.id;
    setConversationReadOnly(isArchived);
    conversationReadOnlyRef.current = isArchived;
    loadedConversationFingerprintRef.current = null;
    if (task.agentId && task.agentName) {
      setSelectedHumanId(task.agentId);
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
      setSelectedHumanId(loaded.summary.agentId);
      const riskContext = hydrateRiskAssessmentContext(task.id, loaded.messages);
      if (
        !isArchived
        && riskContext?.job.taskId
        && ["pending", "running"].includes(riskContext.job.status)
      ) {
        setConversationRunning(task.id, true);
        void pollRiskAssessment(task.id, riskContext);
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

  const handleAttachFiles = async (files: File[]) => {
    if (!files.length || currentConversationRunning) return;

    const conversationId = ensureConversation();
    setActiveNav("tasks");
    setBusy(true);

    try {
      const pcapExts = ["pcap", "pcapng", "cap"];
      const imageExts = ["png", "jpg", "jpeg", "bmp", "webp", "tif", "tiff"];
      const zipExts = ["zip"];
      const pcapFiles = files.filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return pcapExts.includes(ext);
      });
      const imageFiles = files.filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return imageExts.includes(ext);
      });
      const zipFiles = files.filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return zipExts.includes(ext);
      });
      const regularFiles = files.filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return (
          !pcapExts.includes(ext) && !imageExts.includes(ext) && !zipExts.includes(ext)
        );
      });

      if (zipFiles.length > 0 && selectedHuman.id !== "data-security-risk-assessment") {
        throw new Error("仅数安风评数字员工支持上传压缩包（.zip）。");
      }

      if (!imageFiles.length && !pcapFiles.length && !zipFiles.length) {
        appendUserMessageToConversation(conversationId, `上传文件：${files.map((file) => file.name).join("、")}`);
      }

      if (pcapFiles.length > 0 && selectedHuman.id === "alert-analysis") {
        const pcapAttachments: ChatMessageAttachment[] = [];
        const pcapJobs: { name: string; tmpPath: string }[] = [];
        for (const pcapFile of pcapFiles) {
          const base64 = await fileToBase64(pcapFile);
          const ext = fileExt(pcapFile.name) || "pcap";
          const tmpPath = await invoke<string>("write_uploaded_blob", {
            base64Data: base64,
            extension: ext,
          });
          pcapAttachments.push({ kind: "file", name: pcapFile.name, path: tmpPath, ext });
          pcapJobs.push({ name: pcapFile.name, tmpPath });
        }
        appendUserMessageToConversation(
          conversationId,
          `已上传数据包：${pcapFiles.map((f) => f.name).join("、")}`,
          pcapAttachments,
        );

        const pcapSections: string[] = [];
        let totalPcapChars = 0;
        for (const job of pcapJobs) {
          const pcapText = await invoke<string>("parse_pcap_file_cmd", { path: job.tmpPath });
          pcapSections.push(formatPcapSection(job.name, pcapText));
          totalPcapChars += pcapText.length;
          appendMessageToConversation(
            conversationId,
            progressToMessage({
              title: `已解析数据包：${job.name}`,
              content: `已提取数据包内容，共 ${pcapText.length} 字符。`,
              detail: pcapText,
            }),
            "paused",
          );
        }
        const previous = getAlertAttachmentContext(conversationId);
        setAlertAttachmentContext(conversationId, {
          pcapSections: [...previous.pcapSections, ...pcapSections],
          pcapFiles: [...previous.pcapFiles, ...pcapAttachments],
        });
        appendMessageToConversation(
          conversationId,
          progressToMessage({
            title: "数据包解析完成",
            content: `已解析 ${pcapFiles.length} 个数据包（共 ${totalPcapChars} 字符）。是否开始分析？也可在输入框补充说明后提交。`,
            suggestions: ["开始研判"],
          }),
          "paused",
        );
      }

      if (zipFiles.length > 0 && selectedHuman.id === "data-security-risk-assessment") {
        const zipFile = zipFiles[zipFiles.length - 1];
        const uploadMessageId = beginRiskMaterialUpload(conversationId, zipFile.name);
        try {
          const base64 = await fileToBase64(zipFile);
          const tmpPath = await invoke<string>("write_uploaded_blob", {
            base64Data: base64,
            extension: "zip",
          });
          const uploaded = riskAssessmentTransport === "http"
            ? await pickAndUploadRemoteRiskMaterial(tmpPath)
            : await uploadLocalRiskMaterial(tmpPath);
          const zipAttachment = finishRiskMaterialUpload(
            conversationId,
            uploadMessageId,
            zipFile.name,
            "ready",
            tmpPath,
          );
          await prepareRiskAssessmentMaterial(
            conversationId,
            uploaded,
            zipFile.name,
            [zipAttachment],
          );
        } catch (error) {
          finishRiskMaterialUpload(
            conversationId,
            uploadMessageId,
            zipFile.name,
            "failed",
            undefined,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }

      if (imageFiles.length > 0) {
        if (selectedHuman.id !== "alert-analysis") {
          throw new Error("告警截图识别仅支持威胁研判数字员工。");
        }
        const imageAttachments: ChatMessageAttachment[] = [];
        const imageJobs: { name: string; tmpPath: string }[] = [];
        for (const imageFile of imageFiles) {
          const base64 = await fileToBase64(imageFile);
          const ext = fileExt(imageFile.name) || "png";
          const tmpPath = await invoke<string>("write_uploaded_blob", {
            base64Data: base64,
            extension: ext,
          });
          const mime = IMAGE_MIME_BY_EXT[ext] ?? "image/png";
          imageAttachments.push({
            kind: "image",
            name: imageFile.name,
            previewUrl: `data:${mime};base64,${base64}`,
            path: tmpPath,
            ext,
          });
          imageJobs.push({ name: imageFile.name, tmpPath });
        }
        appendUserMessageToConversation(
          conversationId,
          `已上传告警截图：${imageFiles.map((f) => f.name).join("、")}`,
          imageAttachments,
        );
        const imageSections: string[] = [];
        const parsedImageFields: ParsedAlertFields[] = [];
        let totalOcrChars = 0;
        for (const job of imageJobs) {
          const imageText = await invoke<string>("extract_alert_image_text_cmd", {
            path: job.tmpPath,
          });
          imageSections.push(formatAlertImageSection(job.name, imageText));
          parsedImageFields.push(parseAlertFileContent(imageText).fields);
          totalOcrChars += imageText.length;
          appendMessageToConversation(
            conversationId,
            progressToMessage({
              title: `已识别告警截图：${job.name}`,
              content: `智谱 OCR 已识别告警截图，提取约 ${imageText.length} 字符。`,
              detail: imageText,
            }),
            "paused",
          );
        }
        const previous = getAlertAttachmentContext(conversationId);
        const mergedFields = mergeAlertFields(previous.fields, ...parsedImageFields);
        setAlertAttachmentContext(conversationId, {
          fields: Object.keys(mergedFields).length ? mergedFields : previous.fields,
          imageSections: [...previous.imageSections, ...imageSections],
        });
        appendMessageToConversation(
          conversationId,
          progressToMessage({
            title: "截图解析完成",
            content: `已解析 ${imageFiles.length} 张告警截图（共 ${totalOcrChars} 字符）。是否开始分析？也可在输入框补充说明后提交。`,
            suggestions: ["开始研判"],
          }),
          "paused",
        );
      }

      const parsedFiles = regularFiles.length > 0
        ? await readTextFiles(regularFiles)
        : [];

      if (selectedHuman.id === "alert-analysis") {
        const parsedAlerts = parsedFiles.map((file) => parseAlertFileContent(file.text));
        const primaryAlert = parsedAlerts[0];
        if (primaryAlert) {
          setAlertAttachmentContext(conversationId, { fields: primaryAlert.fields });
          if (currentConversationIdRef.current === conversationId) {
            setPrompt(primaryAlert.alertText);
          }
          const fieldCount = Object.values(primaryAlert.fields).filter(Boolean).length;
          appendMessageToConversation(
            conversationId,
            progressToMessage({
              title: "已解析告警文件",
              content: `已读取「${parsedFiles[0].name}」并提取告警内容${
                fieldCount > 0
                  ? `，识别到 ${fieldCount} 个结构化字段`
                  : ""
              }。可在输入框中修改或补充后提交。`,
              steps: fieldCount > 0
                ? Object.entries(primaryAlert.fields)
                    .filter(([, v]) => v)
                    .map(([k, v]) => `${k}: ${v}`)
                : undefined,
            }),
            "paused",
          );
        }
      } else {
        if (parsedFiles.length === 0) {
          // no-op: zip/pcap/图片已有各自的分支处理
        } else {
          const fileContext = parsedFiles
            .map((file) => `附件：${file.name}\n${file.preview || file.text.slice(0, 1200)}`)
            .join("\n\n");
          if (currentConversationIdRef.current === conversationId) {
            setPrompt((value) => (value.trim() ? `${value.trim()}\n\n${fileContext}` : fileContext));
          }
          appendMessageToConversation(
            conversationId,
            progressToMessage({
              title: "已读取附件",
              content: `已读取 ${parsedFiles.length} 个文件，并把预览内容加入输入框。`,
            }),
            "paused",
          );
        }
      }
    } catch (error) {
      appendMessageToConversation(
        conversationId,
        progressToMessage({
          title: "附件读取失败",
          content: error instanceof Error ? error.message : String(error),
        }),
        "paused",
      );
    } finally {
      setBusy(false);
    }
  };

  const handlePickRiskAssessmentMaterial = async () => {
    if (currentConversationRunning || selectedHuman.id !== "data-security-risk-assessment") return;
    const conversationId = ensureConversation();
    setActiveNav("tasks");
    setBusy(true);
    setConversationRunning(conversationId, true);
    let uploadMessageId: string | undefined;
    let selectedFileName = "评估材料.zip";
    let unlisten = () => {};
    try {
      unlisten = await listen<{ fileName: string; totalSize: number }>(
        "risk-assessment-upload-started",
        (event) => {
          if (uploadMessageId) return;
          selectedFileName = event.payload.fileName || selectedFileName;
          uploadMessageId = beginRiskMaterialUpload(conversationId, selectedFileName);
        },
      );
      const uploaded = await pickAndUploadRemoteRiskMaterial();
      selectedFileName = uploaded.fileName || selectedFileName;
      uploadMessageId ??= beginRiskMaterialUpload(conversationId, selectedFileName);
      const attachment = finishRiskMaterialUpload(
        conversationId,
        uploadMessageId,
        selectedFileName,
        "ready",
      );
      await prepareRiskAssessmentMaterial(
        conversationId,
        uploaded,
        selectedFileName,
        [attachment],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "已取消") {
        if (uploadMessageId) {
          finishRiskMaterialUpload(
            conversationId,
            uploadMessageId,
            selectedFileName,
            "failed",
            undefined,
            message,
          );
        }
        appendMessageToConversation(
          conversationId,
          progressToMessage({ title: "材料上传失败", content: message }),
          "paused",
        );
      }
    } finally {
      unlisten();
      setConversationRunning(conversationId, false);
      setBusy(false);
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
    };

    document.body.classList.add("is-resizing-sidebar");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
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
    delete streamingMessageIdRef.current[conversationId];
    delete conversationSaveQueuesRef.current[conversationId];
    // toolMessageIdRef 按 `${conversationId}:${toolCallId}` 索引，需按前缀清理。
    const prefix = `${conversationId}:`;
    for (const key of Object.keys(toolMessageIdRef.current)) {
      if (key.startsWith(prefix)) delete toolMessageIdRef.current[key];
    }
    clearAlertAttachmentContext(conversationId);
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
        className={`workspace ${activeNav === "settings" || activeNav === "mcp" || activeNav === "skill" || activeNav === "extensions" ? "settings-workspace" : ""} ${
          activeNav === "tasks" || (activeNav === "projects" && selectedTaskId) ? "tasks-workspace" : ""
        }`}
      >
        {activeNav === "settings" ? (
          <SettingsPanel />
        ) : activeNav === "skill" ? (
          <SkillCenterPanel />
        ) : activeNav === "mcp" ? (
          <McpSquarePanel />
        ) : activeNav === "extensions" ? (
          <ExtensionsPanel />
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
            mcpConnectedCount={connectedMcpCount}
            mcpTotalCount={effectiveDigitalHumans.length}
            mcpChecking={mcpChecking}
            onSelectTask={handleSelectTask}
            onRenameTask={handleRenameTask}
            onArchiveTask={handleArchiveTask}
            onDeleteTask={handleDeleteTask}
          />
        ) : (activeNav === "tasks" || (activeNav === "projects" && selectedTaskId)) ? (
          <TaskConversation
            messages={conversationMessages}
            prompt={prompt}
            modelName={currentModelName}
            busy={currentConversationRunning}
            modelStatus={modelStatus}
            modelError={modelError}
            readOnly={conversationReadOnly}
            mcpReady={selectedHuman.status === "ready"}
            mcpStatusReason={selectedHuman.disabledReason}
            selectedHumanName={selectedHuman.name}
            taskTitle={selectedTask?.title ?? "新任务"}
            taskStatus={selectedTaskStatus}
            taskStartedAt={selectedTask?.createdAt}
            updatedTime={selectedTask?.time}
            backLabel={activeNav === "projects" ? "返回归档列表" : "返回任务中心"}
            onBack={handleBackFromConversation}
            onPromptChange={setPrompt}
            onAttachFiles={handleAttachFiles}
            onPickAttachment={
              selectedHuman.id === "data-security-risk-assessment"
              && riskAssessmentTransport === "http"
                ? handlePickRiskAssessmentMaterial
                : undefined
            }
            onSubmit={submitPrompt}
            onCancel={handleCancel}
            onSuggestionSelect={handleSuggestionSelect}
            onConfirmSkillExecution={handleConfirmSkillExecution}
          />
        ) : (
          <>
            <Hero
              prompt={prompt}
              introduction={selectedHuman.welcomeMessage?.trim()}
              modelName={currentModelName}
              busy={currentConversationRunning}
              disabled={selectedHuman.status !== "ready"}
              disabledReason={selectedHuman.disabledReason}
              modelStatus={modelStatus}
              modelError={modelError}
              onPromptChange={setPrompt}
              onAttachFiles={handleAttachFiles}
              onPickAttachment={
                selectedHuman.id === "data-security-risk-assessment"
                && riskAssessmentTransport === "http"
                  ? handlePickRiskAssessmentMaterial
                  : undefined
              }
              onSubmit={submitPrompt}
              onCancel={handleCancel}
            />
            <section className="human-picker-section">
              <p className="human-picker-hint">最近使用</p>
              <DigitalHumanPicker humans={recentHumans} selectedId={selectedHumanId} onSelect={handleSelectHuman} />
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
