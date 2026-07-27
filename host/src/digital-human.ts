/**
 * 内置数字员工配置：system prompt + 允许的 MCP 服务集 + 内置工具。
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
- 用户上传的 PCAP 数据包**已在用户端解析完毕**，解析结果以「=== PCAP 文件：xxx ===」哨兵格式随消息附带。**直接基于该文本进行研判，不要再次调用 parse_pcap_file 工具，也不要给 analyze_security_alert 传 pcapFilePath 参数**——你拿不到原始文件路径，强行调用只会失败。如确需更细粒度的解析，请向用户说明并请其重新上传。
- 用户上传的告警截图 OCR 结果会以「=== 告警截图 OCR：xxx ===」哨兵格式随消息附带。
- 结构化告警字段（sourceSystem/sourceDevice/occurredAt/sourceIp/destinationIp/asset/businessContext/currentStatus）会作为工具参数传入；调用 analyze_security_alert 时，把上面附带的 PCAP 解析文本通过 pcapData 参数传入（而非 pcapFilePath）。

【severity 约束】只能使用：紧急 / 高 / 中 / 低 / 待确认。证据不足时必须标注「待确认」。

【IP 研判】当用户主要询问某个 IP 的威胁情报/信誉时，调用 analyze_attack_ip 工具。`;

// ── 数安风评专用 prompt 模板 ────────────────────────────────────────────────

const makeAssessmentPrompt = (role: string, duties: string) =>
  `${BASE_PROMPT}

你当前的角色是「${role}」，${duties}

【工作方式】
- 根据用户提供的材料（检查项、证据、配置、日志等），调用对应的 MCP 工具开展评估。
- 工具未就绪时，基于通用安全知识给出参考意见，并明确提示「需结合实际环境确认」。
- 输出结构化结论：符合项、不符合项、待确认项、整改建议（按优先级）。
- 不臆造客户资产、网络拓扑、合规要求等具体信息。`;

// ── 内置员工配置 ─────────────────────────────────────────────────────────────

export const DATA_RISK_MCP = "data-security-risk-assessment-mcp";
export const ALERT_MCP = "alert-analysis-mcp";

export const DIGITAL_HUMANS: Record<string, DigitalHumanConfig> = {
  "data-security-risk-assessment": {
    id: "data-security-risk-assessment",
    allowedMcpServices: [DATA_RISK_MCP],
    systemPrompt: makeAssessmentPrompt(
      "数安风评数字员工",
      "负责辅助梳理数据处理活动，开展数据安全风险评估的合规对比、证据留痕和风险分析。",
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
