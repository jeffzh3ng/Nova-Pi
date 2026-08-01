export type SidebarNavId = "home" | "tasks" | "projects" | "skill" | "mcp" | "extensions" | "usage" | "settings";

export type DigitalHuman = {
  id: string;
  name: string;
  role: string;
  description: string;
  welcomeTitle?: string;
  welcomeMessage?: string;
  accent: "primary" | "blue" | "cyan" | "soft" | "emerald" | "indigo" | "crimson" | "teal" | "amber";
  mcpService?: string;
  status?: "ready" | "pending";
  /** Shown as the tooltip when status is "pending". Falls back to "待开发". */
  disabledReason?: string;
};

export type QuickAction = {
  id: string;
  title: string;
  prompt: string;
  badge?: string;
  tone:
    | "primary"
    | "soft"
    | "line"
    | "blue"
    | "cyan"
    | "emerald"
    | "indigo"
    | "crimson"
    | "teal"
    | "amber";
  mcpService?: string;
  status?: "ready" | "pending";
  /** Shown as the tooltip when status is "pending". Falls back to "待开发". */
  disabledReason?: string;
};

export type AlertAnalysisFinding = {
  title?: string;
  severity?: string;
  evidence?: string;
  impact?: string;
};

export type AlertAnalysisResult = {
  module: "alert-analysis" | "ip-threat-analysis";
  model: string;
  usedModel: boolean;
  overview: string;
  severity: string;
  confidence: string;
  alertSummary?: Record<string, unknown>;
  findings?: AlertAnalysisFinding[];
  timeline?: string[];
  affectedAssets?: string[];
  recommendedActions?: string[];
  questions?: string[];
  processingPlan?: string[];
  riskNotes?: string[];
  generatedAt?: string;
  rawModelOutput?: string | null;
  results?: unknown[];
};

/// 数据安全风险评估 MCP 返回的结构化结果。
/// 字段刻意保持宽松：MCP 返回的结构形态多变，overview 作兜底摘要，
/// detail 放完整 markdown/JSON 折叠展示，raw 留存原始返回。
export type RiskAssessmentResult = {
  module: "data-risk-assessment";
  overview: string;
  detail?: string;
  raw?: unknown;
  /// Nova 下载后的本地评估结果表路径（可打开或另存）。
  outputFile?: string;
};

export type RiskAssessmentJob = {
  materialId: string;
  fileName: string;
  matrixName?: string;
  taskId?: string;
  status: "uploaded" | "pending" | "running" | "completed" | "failed" | "canceled";
  progress?: string;
  progressPct?: number;
  resultFileId?: string;
  error?: string;
};

export type RecentTask = {
  id: string;
  title: string;
  status: "done" | "running" | "paused" | "canceled";
  time: string;
  agentId?: string;
  agentName?: string;
  lastMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 任务名来源：pending=未提炼，auto=大模型已提炼，manual=用户手改 */
  titleSource?: "pending" | "auto" | "manual";
};

export type UsedSkill = {
  id: string;
  name: string;
  confidence: number;
  reason: string;
  source?: string;
};

export type PendingSkillExecution = {
  id: string;
  skillId: string;
  skillName: string;
  status: "pending" | "running" | "completed" | "failed";
  actionLabel: string;
  summary: string;
  operations: string[];
  commandPreview: string[];
  inputFileName: string;
  inputContent: string;
  outputFileName: string;
  outputFormat: "docx" | "pdf";
  parameters: Record<string, string>;
  riskNotice: string;
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  kind?: "tool";
  title?: string;
  content: string;
  time: string;
  steps?: string[];
  suggestions?: string[];
  /** 额外可折叠详情，默认完全折叠（无预览），如 OCR 识别原文 */
  detail?: string;
  attachments?: ChatMessageAttachment[];
  alertAnalysisResult?: AlertAnalysisResult;
  riskAssessmentResult?: RiskAssessmentResult;
  riskAssessmentJob?: RiskAssessmentJob;
  usedSkill?: UsedSkill;
  pendingSkillExecution?: PendingSkillExecution;
  exportedFile?: {
    path: string;
    fileName: string;
  };
};

export type ChatMessageAttachment = {
  kind: "image" | "file";
  name: string;
  /** 图片预览 data URL（仅 image） */
  previewUrl?: string;
  /** 临时盘上路径，双击打开 */
  path?: string;
  /** 扩展名，用于标签着色 */
  ext?: string;
  /** 原始文件字节数，用于 Agent 判断处理方式。 */
  size?: number;
  /** 上传过渡状态；省略等同于 ready，兼容历史会话。 */
  uploadStatus?: "uploading" | "ready" | "failed";
  uploadError?: string;
};

export type AgentTurn = {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  createdAt: string;
  alertAnalysisResult?: AlertAnalysisResult;
  riskAssessmentResult?: RiskAssessmentResult;
  usedSkill?: UsedSkill;
  pendingSkillExecution?: PendingSkillExecution;
  suggestions?: string[];
  exportedFile?: {
    path: string;
    fileName: string;
  };
};
