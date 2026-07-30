import { invoke } from "@tauri-apps/api/core";

export type McpTransport = "stdio" | "http";

/// stdio 启动方式：`script` = 直接运行 .py 脚本路径；
/// `module` = 通过 `python -m <模块名>` 运行（适用于使用包内相对导入的 MCP）。
export type McpLaunchMode = "script" | "module";

export type McpConnectionSettings = {
  serviceId: string;
  employeeName: string;
  employeeRole: string;
  welcomeTitle: string;
  welcomeMessage: string;
  showInEmployeeList: boolean;
  enabled: boolean;
  transport: McpTransport;
  commandPath: string;
  commandArgs: string;
  httpUrl: string;
  launchMode: McpLaunchMode;
};

export type McpConnectionSettingsStatus = {
  settings: McpConnectionSettings;
};

export type McpConnectionSettingsCatalog = {
  settings: McpConnectionSettings[];
};

export const ALERT_ANALYSIS_MCP_SERVICE = "alert-analysis-mcp";
export const DATA_CLASSIFICATION_MCP_SERVICE = "data-classification-mcp";
export const DATA_RISK_ASSESSMENT_MCP_SERVICE = "data-security-risk-assessment-mcp";
/// 列出评估矩阵的工具名（上传 zip 后调用，让用户选择评估矩阵）。
export const DATA_RISK_LIST_MATRICES_TOOL = "list_assessment_matrices";
export const DATA_RISK_UPLOAD_TOOL = "upload_materials";
export const DATA_RISK_SUBMIT_TOOL = "submit_evaluation";
export const DATA_RISK_GET_STATUS_TOOL = "get_task_status";
export const DATA_RISK_CANCEL_TOOL = "cancel_evaluation";
export const DIGITAL_EMPLOYEE_MCP_SERVICE_IDS = [
  DATA_RISK_ASSESSMENT_MCP_SERVICE,
  ALERT_ANALYSIS_MCP_SERVICE,
] as const;

export const BUILT_IN_MCP_SERVICE_IDS = [
  ...DIGITAL_EMPLOYEE_MCP_SERVICE_IDS,
  DATA_CLASSIFICATION_MCP_SERVICE,
] as const;

type McpEmployeeDefaults = {
  name: string;
  role: string;
  showInEmployeeList: boolean;
};

const BUILT_IN_MCP_EMPLOYEE_DEFAULTS: Record<string, McpEmployeeDefaults> = {
  [DATA_RISK_ASSESSMENT_MCP_SERVICE]: {
    name: "数安风评数字员工",
    role: "数据安全风险评估",
    showInEmployeeList: true,
  },
  [ALERT_ANALYSIS_MCP_SERVICE]: {
    name: "威胁研判数字员工",
    role: "安全告警威胁研判",
    showInEmployeeList: true,
  },
  [DATA_CLASSIFICATION_MCP_SERVICE]: {
    name: "分类分级工具",
    role: "数据资产分类分级",
    showInEmployeeList: false,
  },
};

const customEmployeeName = (serviceId: string) => {
  const baseName = serviceId.replace(/-mcp$/i, "").trim() || "自定义";
  return `${baseName}数字员工`;
};

export function getMcpEmployeeDefaults(serviceId: string): McpEmployeeDefaults {
  return BUILT_IN_MCP_EMPLOYEE_DEFAULTS[serviceId] ?? {
    name: customEmployeeName(serviceId),
    role: "自定义 MCP 服务",
    showInEmployeeList: true,
  };
}

export function getMcpWelcomeDefaults(
  serviceId: string,
  employeeName: string,
  employeeRole: string,
) {
  if (serviceId === ALERT_ANALYSIS_MCP_SERVICE) {
    return {
      title: "欢迎使用告警分析",
      message:
        "我可以对安全告警进行研判，分析影响范围并生成处置建议。你可以直接描述告警情况，也可以粘贴告警原文，或上传告警截图、数据包。",
    };
  }
  if (serviceId === DATA_CLASSIFICATION_MCP_SERVICE) {
    return {
      title: "欢迎使用数据分类分级",
      message: "我可以协助梳理数据资产，并依据分类分级规则生成结构化结果。",
    };
  }
  const shortName = employeeName.replace(/数字员工$/, "");
  return {
    title: `欢迎使用${shortName}`,
    message: `我可以协助开展${employeeRole}相关工作。请描述任务目标，或上传需要处理的材料。`,
  };
}

export const defaultAlertMcpSettings: McpConnectionSettings = {
  serviceId: ALERT_ANALYSIS_MCP_SERVICE,
  employeeName: BUILT_IN_MCP_EMPLOYEE_DEFAULTS[ALERT_ANALYSIS_MCP_SERVICE].name,
  employeeRole: BUILT_IN_MCP_EMPLOYEE_DEFAULTS[ALERT_ANALYSIS_MCP_SERVICE].role,
  welcomeTitle: "欢迎使用告警分析",
  welcomeMessage:
    "我可以对安全告警进行研判，分析影响范围并生成处置建议。你可以直接描述告警情况，也可以粘贴告警原文，或上传告警截图、数据包。",
  showInEmployeeList: true,
  enabled: false,
  transport: "stdio",
  commandPath: "",
  commandArgs: "--transport stdio",
  httpUrl: "",
  launchMode: "script",
};

export const defaultDataClassificationMcpSettings: McpConnectionSettings = {
  serviceId: DATA_CLASSIFICATION_MCP_SERVICE,
  employeeName: BUILT_IN_MCP_EMPLOYEE_DEFAULTS[DATA_CLASSIFICATION_MCP_SERVICE].name,
  employeeRole: BUILT_IN_MCP_EMPLOYEE_DEFAULTS[DATA_CLASSIFICATION_MCP_SERVICE].role,
  welcomeTitle: "欢迎使用数据分类分级",
  welcomeMessage: "我可以协助梳理数据资产，并依据分类分级规则生成结构化结果。",
  showInEmployeeList: false,
  enabled: false,
  transport: "stdio",
  commandPath: "",
  commandArgs: "--transport stdio",
  httpUrl: "",
  launchMode: "script",
};

const makeDisabledMcpSettings = (serviceId: string): McpConnectionSettings => {
  const employee = getMcpEmployeeDefaults(serviceId);
  const welcome = getMcpWelcomeDefaults(serviceId, employee.name, employee.role);
  return {
    serviceId,
    employeeName: employee.name,
    employeeRole: employee.role,
    welcomeTitle: welcome.title,
    welcomeMessage: welcome.message,
    showInEmployeeList: employee.showInEmployeeList,
    enabled: false,
    transport: "stdio",
    commandPath: "",
    commandArgs: "--transport stdio",
    httpUrl: "",
    launchMode: "script",
  };
};

export const defaultMcpSettingsByService: Record<string, McpConnectionSettings> = {
  ...Object.fromEntries(
    DIGITAL_EMPLOYEE_MCP_SERVICE_IDS.map((serviceId) => [serviceId, makeDisabledMcpSettings(serviceId)]),
  ),
  [ALERT_ANALYSIS_MCP_SERVICE]: defaultAlertMcpSettings,
  [DATA_CLASSIFICATION_MCP_SERVICE]: defaultDataClassificationMcpSettings,
};

export const defaultBuiltInMcpSettings = BUILT_IN_MCP_SERVICE_IDS.map((serviceId) =>
  makeDefaultMcpSettings(serviceId),
);

export function makeDefaultMcpSettings(serviceId = ALERT_ANALYSIS_MCP_SERVICE): McpConnectionSettings {
  const normalizedServiceId = serviceId.trim() || ALERT_ANALYSIS_MCP_SERVICE;
  const builtIn = defaultMcpSettingsByService[normalizedServiceId];
  if (builtIn) {
    return { ...builtIn };
  }
  return makeDisabledMcpSettings(normalizedServiceId);
}

export async function listMcpConnectionSettings(): Promise<McpConnectionSettingsCatalog> {
  return await invoke<McpConnectionSettingsCatalog>("list_mcp_connection_settings");
}

export async function saveMcpConnectionSettings(
  settings: McpConnectionSettings,
): Promise<McpConnectionSettingsStatus> {
  return await invoke<McpConnectionSettingsStatus>("save_mcp_connection_settings", { settings });
}

export async function deleteMcpConnectionSettings(serviceId: string): Promise<void> {
  await invoke<void>("delete_mcp_connection_settings", { serviceId });
}

export async function testMcpConnection(serviceId: string): Promise<void> {
  await invoke<void>("test_mcp_connection", { serviceId });
}

/**
 * 强制重连 MCP 服务：断开 sidecar 缓存的旧子进程后重新 spawn。
 * 用于 Python 侧 config.local.json 等进程内配置变化后手动重启生效。
 * 返回重连后探测到的工具数量。
 */
export async function reconnectMcpConnection(serviceId: string): Promise<number> {
  const response = await invoke<{ toolCount?: number }>("reconnect_mcp_connection", { serviceId });
  return typeof response?.toolCount === "number" ? response.toolCount : 0;
}
