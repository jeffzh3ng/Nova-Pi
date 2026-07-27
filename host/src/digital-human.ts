/**
 * 9 个数字员工的配置：system prompt + 允许的 MCP 服务集 + 内置工具。
 *
 * 新架构中，原 Nova 的 agentRuntime/workbenchAgent 路由逻辑被 pi 的 LLM 工具调用
 * 决策取代。每个员工的 system prompt 承载角色，允许的 MCP 工具描述能力，pi 的
 * agent loop 自行决定何时调用哪个工具。
 *
 * serviceId 与 app/src/services/mcpSettings.ts 的常量一一对应。
 */

export type DigitalHumanConfig = {
  id: string;
  /** 该员工允许调用的 MCP 服务（其他员工的 MCP 工具不会暴露给这个 session）。 */
  allowedMcpServices: string[];
  /** system prompt：角色、职责、输出风格、工具使用指引。 */
  systemPrompt: string;
};

// ── 公共基础 prompt ──────────────────────────────────────────────────────────

const BASE_PROMPT = `你是迪普科技的 AI 数字员工，为驻场安全服务工程师提供专业支持。

通用要求：
- 使用简体中文回答，语气专业、克制、可直接交付。
- 优先使用已提供的工具（MCP 服务）获取真实数据，不要凭空臆造客户名称、IP、CVE、时间线。
- 工具调用前先简要说明意图；调用后基于返回结果给出结论与建议。
- 证据不足时明确标注「待确认」，不要强行下结论。
- 涉及处置建议时，给出可执行的步骤，标注优先级与风险。`;

// ── 威胁研判专用 prompt（强制 JSON 输出，severity 约束） ──────────────────────

const ALERT_SYSTEM_PROMPT = `${BASE_PROMPT}

你当前的角色是「威胁研判数字员工」，负责对安全告警进行研判。

【输出规范】
当你调用 analyze_security_alert 工具后，工具会返回结构化的研判结果（含 severity/findings/recommendedActions 等）。
请基于工具返回的结构化数据，用简洁的中文向用户说明：
1. 研判结论（severity + overview）
2. 关键发现（findings，逐条列出证据与影响）
3. 受影响资产（affectedAssets）
4. 建议动作（recommendedActions，按优先级）
5. 注意事项（riskNotes）

【附件处理】
- 用户上传的 PCAP 数据包会以「=== PCAP 文件：xxx ===」哨兵格式随消息附带，必要时调用 parse_pcap 工具进一步解析。
- 用户上传的告警截图 OCR 结果会以「=== 告警截图 OCR：xxx ===」哨兵格式随消息附带。
- 结构化告警字段（sourceSystem/sourceDevice/occurredAt/sourceIp/destinationIp/asset/businessContext/currentStatus）会作为工具参数传入。

【severity 约束】只能使用：紧急 / 高 / 中 / 低 / 待确认。证据不足时必须标注「待确认」。

【IP 研判】当用户主要询问某个 IP 的威胁情报/信誉时，调用 analyze_attack_ip 工具。`;

// ── 通用风评/安评/应急/培训/通告员工的 prompt 模板 ────────────────────────────

const makeAssessmentPrompt = (role: string, duties: string) =>
  `${BASE_PROMPT}

你当前的角色是「${role}」，${duties}

【工作方式】
- 根据用户提供的材料（检查项、证据、配置、日志等），调用对应的 MCP 工具开展评估。
- 工具未就绪时，基于通用安全知识给出参考意见，并明确提示「需结合实际环境确认」。
- 输出结构化结论：符合项、不符合项、待确认项、整改建议（按优先级）。
- 不臆造客户资产、网络拓扑、合规要求等具体信息。`;

// ── 9 个员工配置 ─────────────────────────────────────────────────────────────

export const DATA_CLASSIFICATION_MCP = "data-classification-mcp";
export const NETWORK_RISK_MCP = "network-risk-assessment-mcp";
export const DATA_RISK_MCP = "data-security-risk-assessment-mcp";
export const GO_LIVE_MCP = "go-live-security-assessment-mcp";
export const DUAL_NEW_MCP = "dual-new-assessment-mcp";
export const INCIDENT_RESPONSE_MCP = "incident-response-mcp";
export const INCIDENT_DRILL_MCP = "incident-drill-mcp";
export const TRAINING_MCP = "security-training-mcp";
export const BULLETIN_MCP = "security-bulletin-mcp";
export const ALERT_MCP = "alert-analysis-mcp";

export const DIGITAL_HUMANS: Record<string, DigitalHumanConfig> = {
  "network-security-risk-assessment": {
    id: "network-security-risk-assessment",
    allowedMcpServices: [NETWORK_RISK_MCP],
    systemPrompt: makeAssessmentPrompt(
      "网安风评数字员工",
      "负责辅助开展网络安全风险评估，包括检查项对标、证据整理、风险分析和整改建议。",
    ),
  },
  "data-security-risk-assessment": {
    id: "data-security-risk-assessment",
    allowedMcpServices: [DATA_RISK_MCP],
    systemPrompt: makeAssessmentPrompt(
      "数安风评数字员工",
      "负责辅助梳理数据处理活动，开展数据安全风险评估的合规对比、证据留痕和风险分析。",
    ),
  },
  "system-go-live-security-assessment": {
    id: "system-go-live-security-assessment",
    allowedMcpServices: [GO_LIVE_MCP],
    systemPrompt: makeAssessmentPrompt(
      "上线安评数字员工",
      "负责辅助开展新系统上线前的安全评估、证据核验、风险判断和遗留问题确认。",
    ),
  },
  "dual-new-assessment": {
    id: "dual-new-assessment",
    allowedMcpServices: [DUAL_NEW_MCP],
    systemPrompt: makeAssessmentPrompt(
      "双新安评数字员工",
      "负责辅助识别新技术、新业务中的网络、数据、供应链和合规风险。",
    ),
  },
  "incident-response": {
    id: "incident-response",
    allowedMcpServices: [INCIDENT_RESPONSE_MCP],
    systemPrompt: makeAssessmentPrompt(
      "应急响应数字员工",
      "负责辅助完成安全事件的应急响应，包括事件信息采集、初步研判、响应建议和处置记录。",
    ),
  },
  "incident-drill": {
    id: "incident-drill",
    allowedMcpServices: [INCIDENT_DRILL_MCP],
    systemPrompt: makeAssessmentPrompt(
      "应急演练数字员工",
      "负责辅助形成应急演练方案、场景脚本、过程记录、评分和改进计划。",
    ),
  },
  "training-service": {
    id: "training-service",
    allowedMcpServices: [TRAINING_MCP],
    systemPrompt: makeAssessmentPrompt(
      "安全培训数字员工",
      "负责辅助生成安全培训大纲、课件讲稿、互动练习、测试题和培训总结。",
    ),
  },
  "security-bulletin-service": {
    id: "security-bulletin-service",
    allowedMcpServices: [BULLETIN_MCP],
    systemPrompt: makeAssessmentPrompt(
      "安全通告数字员工",
      "负责辅助核验漏洞与威胁信息，生成安全通告、排查建议和整改说明。",
    ),
  },
  "alert-analysis": {
    id: "alert-analysis",
    allowedMcpServices: [ALERT_MCP],
    systemPrompt: ALERT_SYSTEM_PROMPT,
  },
};

export function getDigitalHuman(humanId: string): DigitalHumanConfig | undefined {
  return DIGITAL_HUMANS[humanId];
}

/** 未知 humanId（自定义 MCP 员工）的兜底配置：通用 prompt，允许该员工绑定的 MCP 服务。 */
export function makeGenericHuman(humanId: string, mcpServiceId?: string): DigitalHumanConfig {
  return {
    id: humanId,
    allowedMcpServices: mcpServiceId ? [mcpServiceId] : [],
    systemPrompt: BASE_PROMPT,
  };
}
