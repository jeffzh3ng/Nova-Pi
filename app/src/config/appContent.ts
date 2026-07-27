import type { DigitalHuman, QuickAction } from "../types";
import {
  ALERT_ANALYSIS_MCP_SERVICE,
  DATA_RISK_ASSESSMENT_MCP_SERVICE,
} from "../services/mcpSettings";

export const digitalHumans: DigitalHuman[] = [
  {
    id: "data-security-risk-assessment",
    name: "数安风评数字员工",
    role: "数据安全风险评估",
    description: "辅助梳理数据处理活动，开展合规对比、证据留痕和风险分析。",
    accent: "teal",
    mcpService: DATA_RISK_ASSESSMENT_MCP_SERVICE,
    status: "pending",
  },
  {
    id: "alert-analysis",
    name: "威胁研判数字员工",
    role: "安全告警威胁研判",
    description: "处理告警、日志、截图和流量材料，输出研判结论与处置建议。",
    accent: "indigo",
    mcpService: ALERT_ANALYSIS_MCP_SERVICE,
    status: "pending",
    disabledReason: "请在数字员工管理中配置并启用威胁研判服务",
  },
];

export const quickActions: QuickAction[] = digitalHumans.map((human) => ({
  id: human.id,
  title: human.name,
  prompt: "",
  tone: human.accent,
  mcpService: human.mcpService,
  status: human.status,
  disabledReason: human.disabledReason,
}));
