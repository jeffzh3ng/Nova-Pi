import { Bot, CirclePlus, Pencil, RefreshCw, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import type { McpConnectionSettings, McpHttpHeader, McpLaunchMode, McpTransport } from "../services/mcpSettings";
import {
  ALERT_ANALYSIS_MCP_SERVICE,
  BUILT_IN_MCP_SERVICE_IDS,
  DATA_CLASSIFICATION_MCP_SERVICE,
  DATA_RISK_ASSESSMENT_MCP_SERVICE,
  defaultBuiltInMcpSettings,
  deleteMcpConnectionSettings,
  getMcpWelcomeDefaults,
  listMcpConnectionSettings,
  makeDefaultMcpSettings,
  reconnectMcpConnection,
  saveMcpConnectionSettings,
  testMcpConnection,
} from "../services/mcpSettings";

type ToggleRowProps = {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

type McpServiceMeta = {
  title: string;
  description: string;
  enabledDescription: string;
  pathPlaceholder: string;
  httpPlaceholder: string;
};

type McpConnectionState = {
  kind: "disabled" | "pending" | "checking" | "connected" | "error";
  label: string;
  detail: string;
};

type McpEditorState = {
  mode: "add" | "edit";
  draft: McpConnectionSettings;
};

type McpFilter = "all" | "connected" | "pending";

const BUILT_IN_SERVICE_META: Record<string, McpServiceMeta> = {
  [DATA_RISK_ASSESSMENT_MCP_SERVICE]: {
    title: "数安风评数字员工 MCP",
    description: "数据安全风险评估数字员工使用的 MCP 服务连接。",
    enabledDescription: "连接成功后数安风评数字员工显示为可用",
    pathPlaceholder: "",
    httpPlaceholder: "",
  },
  [ALERT_ANALYSIS_MCP_SERVICE]: {
    title: "威胁研判数字员工 MCP",
    description: "告警研判、流量解析和威胁分析使用的 MCP 服务连接。",
    enabledDescription: "连接成功后威胁研判数字员工显示为可用",
    pathPlaceholder: "",
    httpPlaceholder: "",
  },
  [DATA_CLASSIFICATION_MCP_SERVICE]: {
    title: "分类分级工具 MCP",
    description: "数据资产分类分级任务使用的 MCP 服务连接。",
    enabledDescription: "启用后分类分级工具使用该连接配置",
    pathPlaceholder: "",
    httpPlaceholder: "",
  },
};

const EMPTY_DRAFT: McpConnectionSettings = {
  serviceId: "",
  employeeName: "",
  employeeRole: "",
  welcomeTitle: "",
  welcomeMessage: "",
  showInEmployeeList: true,
  enabled: false,
  transport: "stdio",
  commandPath: "",
  commandArgs: "--transport stdio",
  httpUrl: "",
  launchMode: "script",
  httpHeaders: [],
};

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "stdio", label: "stdio 路径" },
  { value: "http", label: "HTTP 地址" },
];

const LAUNCH_MODE_OPTIONS: { value: McpLaunchMode; label: string }[] = [
  { value: "script", label: "脚本路径" },
  { value: "module", label: "Python 模块" },
];

function ToggleRow({ title, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function TransportToggle({ value, onChange }: { value: McpTransport; onChange: (value: McpTransport) => void }) {
  return (
    <div className="mcp-segmented" role="tablist" aria-label="连接方式">
      {TRANSPORT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function LaunchModeToggle({ value, onChange }: { value: McpLaunchMode; onChange: (value: McpLaunchMode) => void }) {
  return (
    <div className="mcp-segmented" role="tablist" aria-label="启动方式">
      {LAUNCH_MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const notifyMcpSettingsChanged = () => {
  window.dispatchEvent(new CustomEvent("nova-mcp-settings-changed"));
};

const normalizeServiceId = (value: string) => value.trim();

const isBuiltInService = (serviceId: string) => BUILT_IN_MCP_SERVICE_IDS.includes(
  serviceId as (typeof BUILT_IN_MCP_SERVICE_IDS)[number],
);

const serviceMeta = (
  serviceId: string,
  settings?: Pick<McpConnectionSettings, "employeeName" | "employeeRole">,
): McpServiceMeta => {
  const base = BUILT_IN_SERVICE_META[serviceId] ?? {
    title: serviceId,
    description: "自定义 MCP 服务连接，可供数字员工或工具调用。",
    enabledDescription: "启用后将检测该 MCP 服务连接",
    pathPlaceholder: "",
    httpPlaceholder: "",
  };
  const employeeName = settings?.employeeName.trim();
  const employeeRole = settings?.employeeRole.trim();
  if (!employeeName && !employeeRole) return base;
  return {
    ...base,
    title: employeeName ? `${employeeName} MCP` : base.title,
    description: employeeRole || base.description,
    enabledDescription: employeeName
      ? `连接成功后${employeeName}显示为可用`
      : base.enabledDescription,
  };
};

const moduleProjectRootPlaceholder = (): string => "";

/// Module 模式下的「Python 模块名」占位提示。
const modulePlaceholder = (serviceId: string): string => {
  switch (serviceId) {
    case DATA_RISK_ASSESSMENT_MCP_SERVICE:
      return "data_sec_risk_mcp.server";
    default:
      return "your_mcp_package.server";
  }
};

const sortMcpSettings = (items: McpConnectionSettings[]) =>
  [...items].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    const leftIndex = BUILT_IN_MCP_SERVICE_IDS.indexOf(
      left.serviceId as (typeof BUILT_IN_MCP_SERVICE_IDS)[number],
    );
    const rightIndex = BUILT_IN_MCP_SERVICE_IDS.indexOf(
      right.serviceId as (typeof BUILT_IN_MCP_SERVICE_IDS)[number],
    );
    const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.serviceId.localeCompare(right.serviceId);
  });

const normalizeMcpSettingsList = (items: McpConnectionSettings[]) => {
  const byServiceId = new Map<string, McpConnectionSettings>();
  for (const item of items) {
    const serviceId = normalizeServiceId(item.serviceId);
    if (!serviceId) continue;
    byServiceId.set(serviceId, { ...item, serviceId });
  }
  return sortMcpSettings([...byServiceId.values()]);
};

const configuredConnectionValue = (settings: McpConnectionSettings) =>
  settings.transport === "http" ? settings.httpUrl.trim() : settings.commandPath.trim();

const staticConnectionState = (settings: McpConnectionSettings): McpConnectionState => {
  if (!settings.enabled) {
    return { kind: "disabled", label: "未启用", detail: "启用后检测 MCP 连接" };
  }
  if (!configuredConnectionValue(settings)) {
    return { kind: "pending", label: "待配置", detail: "连接地址尚未配置" };
  }
  return { kind: "checking", label: "检测中", detail: "正在检测 MCP 连接" };
};

const inspectMcpConnection = async (settings: McpConnectionSettings): Promise<McpConnectionState> => {
  const initial = staticConnectionState(settings);
  if (initial.kind !== "checking") return initial;
  try {
    await testMcpConnection(settings.serviceId);
    return { kind: "connected", label: "连接正常", detail: "MCP 握手和工具列表检测通过" };
  } catch (error) {
    const detail = String(error).replace(/^Error:\s*/i, "").slice(0, 180);
    return { kind: "error", label: "连接失败", detail: detail || "请检查 MCP 服务配置" };
  }
};

const initialConnectionStates = Object.fromEntries(
  defaultBuiltInMcpSettings.map((settings) => [settings.serviceId, staticConnectionState(settings)]),
) as Record<string, McpConnectionState>;

export function McpSquarePanel() {
  const [settingsList, setSettingsList] = useState<McpConnectionSettings[]>(defaultBuiltInMcpSettings);
  const [connectionStates, setConnectionStates] = useState<Record<string, McpConnectionState>>(initialConnectionStates);
  const [editor, setEditor] = useState<McpEditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpConnectionSettings | null>(null);
  const [filter, setFilter] = useState<McpFilter>("all");
  const [searchText, setSearchText] = useState("");
  const [busyServiceId, setBusyServiceId] = useState<string | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [status, setStatus] = useState("正在读取数字员工配置...");

  const probeOne = async (settings: McpConnectionSettings) => {
    const initial = staticConnectionState(settings);
    setConnectionStates((current) => ({ ...current, [settings.serviceId]: initial }));
    if (initial.kind !== "checking") return;
    const inspected = await inspectMcpConnection(settings);
    setConnectionStates((current) => ({ ...current, [settings.serviceId]: inspected }));
  };

  /**
   * 强制重连：断开旧子进程重新 spawn，让 Python 侧 config.local.json 等进程内配置生效。
   * 重连成功后再做一次握手探测，刷新连接状态徽章。
   */
  const handleReconnect = async (settings: McpConnectionSettings) => {
    if (busyServiceId || pageBusy) return;
    if (!settings.enabled) {
      setStatus("请先启用该 MCP 服务再重连。");
      return;
    }
    setBusyServiceId(settings.serviceId);
    setConnectionStates((current) => ({
      ...current,
      [settings.serviceId]: { kind: "checking", label: "重连中", detail: "正在重启 MCP 子进程" },
    }));
    try {
      const toolCount = await reconnectMcpConnection(settings.serviceId);
      const inspected = await inspectMcpConnection(settings);
      setConnectionStates((current) => ({ ...current, [settings.serviceId]: inspected }));
      setStatus(`已重连 ${settings.serviceId}，${toolCount} 个工具就绪。`);
    } catch (error) {
      const detail = String(error).replace(/^Error:\s*/i, "").slice(0, 180);
      setConnectionStates((current) => ({
        ...current,
        [settings.serviceId]: { kind: "error", label: "重连失败", detail: detail || "请检查 MCP 服务配置与日志" },
      }));
      setStatus(`重连失败：${detail || "请检查 MCP 服务配置"}`);
    } finally {
      setBusyServiceId(null);
    }
  };

  const probeAll = async (items: McpConnectionSettings[]) => {
    const entries = await Promise.all(
      items.map(async (settings) => [settings.serviceId, await inspectMcpConnection(settings)] as const),
    );
    setConnectionStates(Object.fromEntries(entries));
  };

  useEffect(() => {
    let alive = true;
    listMcpConnectionSettings()
      .then((result) => {
        if (!alive) return;
        const normalized = normalizeMcpSettingsList(result.settings);
        setSettingsList(normalized);
        setStatus("已读取数字员工连接配置。");
        void probeAll(normalized);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const detail = error instanceof Error ? error.message : String(error);
        setStatus(detail.includes("invoke") ? "请在桌面应用中管理 MCP 连接配置。" : detail);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editorBusy) setEditor(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editor, editorBusy]);

  const updateEditor = <Key extends keyof McpConnectionSettings>(
    key: Key,
    value: McpConnectionSettings[Key],
  ) => {
    setEditor((current) => current ? { ...current, draft: { ...current.draft, [key]: value } } : current);
  };

  const addHttpHeader = () => {
    if (!editor) return;
    updateEditor("httpHeaders", [
      ...editor.draft.httpHeaders,
      { name: editor.draft.httpHeaders.length === 0 ? "Authorization" : "", value: "" },
    ]);
  };
  const updateHttpHeader = (index: number, field: keyof McpHttpHeader, value: string) => {
    if (!editor) return;
    updateEditor(
      "httpHeaders",
      editor.draft.httpHeaders.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    );
  };
  const removeHttpHeader = (index: number) => {
    if (!editor) return;
    updateEditor("httpHeaders", editor.draft.httpHeaders.filter((_, i) => i !== index));
  };

  const replaceSettings = (saved: McpConnectionSettings) => {
    setSettingsList((items) => normalizeMcpSettingsList([
      ...items.filter((item) => item.serviceId !== saved.serviceId),
      saved,
    ]));
  };

  const saveEditor = async () => {
    if (!editor) return;
    const serviceId = normalizeServiceId(editor.draft.serviceId);
    if (!serviceId) {
      setStatus("请填写数字员工的服务 ID。");
      return;
    }
    if (editor.mode === "add" && settingsList.some((settings) => settings.serviceId === serviceId)) {
      setStatus(`服务 ID ${serviceId} 已存在。`);
      return;
    }
    if (editor.draft.showInEmployeeList && !editor.draft.employeeName.trim()) {
      setStatus("请填写数字员工名称。");
      return;
    }

    const defaults = makeDefaultMcpSettings(serviceId);
    const employeeName = editor.draft.employeeName.trim() || defaults.employeeName;
    const employeeRole = editor.draft.employeeRole.trim() || defaults.employeeRole;
    const welcomeDefaults = getMcpWelcomeDefaults(serviceId, employeeName, employeeRole);
    const nextSettings: McpConnectionSettings = {
      ...defaults,
      ...editor.draft,
      serviceId,
      employeeName,
      employeeRole,
      welcomeTitle: editor.draft.welcomeTitle.trim() || welcomeDefaults.title,
      welcomeMessage: editor.draft.welcomeMessage.trim() || welcomeDefaults.message,
      commandArgs: editor.draft.commandArgs.trim() || defaults.commandArgs,
      commandPath: editor.draft.commandPath.trim(),
      httpUrl: editor.draft.httpUrl.trim(),
      httpHeaders: editor.draft.transport === "http"
        ? editor.draft.httpHeaders
            .map((item) => ({ name: item.name.trim(), value: item.value.trim() }))
            .filter((item) => item.name.length > 0)
        : [],
    };

    setEditorBusy(true);
    setStatus("正在保存数字员工配置...");
    try {
      const result = await saveMcpConnectionSettings(nextSettings);
      replaceSettings(result.settings);
      setEditor(null);
      notifyMcpSettingsChanged();
      setStatus(`已保存 ${serviceMeta(result.settings.serviceId, result.settings).title} 配置。`);
      void probeOne(result.settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorBusy(false);
    }
  };

  const toggleService = async (settings: McpConnectionSettings, enabled: boolean) => {
    setBusyServiceId(settings.serviceId);
    setStatus(enabled ? "正在启用 MCP 服务..." : "正在停用 MCP 服务...");
    try {
      const result = await saveMcpConnectionSettings({ ...settings, enabled });
      replaceSettings(result.settings);
      notifyMcpSettingsChanged();
      setStatus(`${serviceMeta(settings.serviceId, settings).title}已${enabled ? "启用" : "停用"}。`);
      void probeOne(result.settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyServiceId(null);
    }
  };

  const deleteService = async () => {
    if (!pendingDelete) return;
    const settings = pendingDelete;
    const meta = serviceMeta(settings.serviceId, settings);
    setPendingDelete(null);
    setBusyServiceId(settings.serviceId);
    setStatus(`正在删除${settings.employeeName}...`);
    try {
      await deleteMcpConnectionSettings(settings.serviceId);
      setSettingsList((items) => items.filter((item) => item.serviceId !== settings.serviceId));
      setConnectionStates((current) => {
        const next = { ...current };
        delete next[settings.serviceId];
        return next;
      });
      notifyMcpSettingsChanged();
      setStatus(`已删除 ${meta.title}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyServiceId(null);
    }
  };

  const resetBuiltInSettings = async () => {
    setPageBusy(true);
    setStatus("正在恢复内置 MCP 默认配置...");
    try {
      const customSettings = settingsList.filter((settings) => !isBuiltInService(settings.serviceId));
      const results = await Promise.all(defaultBuiltInMcpSettings.map(saveMcpConnectionSettings));
      const normalized = normalizeMcpSettingsList([
        ...results.map((result) => result.settings),
        ...customSettings,
      ]);
      setSettingsList(normalized);
      notifyMcpSettingsChanged();
      setStatus("已恢复内置 MCP 默认配置，自定义服务保持不变。");
      void probeAll(normalized);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPageBusy(false);
    }
  };

  const connectedCount = settingsList.filter(
    (settings) => connectionStates[settings.serviceId]?.kind === "connected",
  ).length;
  const pendingCount = settingsList.length - connectedCount;

  const visibleSettings = useMemo(() => {
    const query = searchText.trim().toLocaleLowerCase();
    return settingsList.filter((settings) => {
      const state = connectionStates[settings.serviceId] ?? staticConnectionState(settings);
      if (filter === "connected" && state.kind !== "connected") return false;
      if (filter === "pending" && state.kind === "connected") return false;
      if (!query) return true;
      const meta = serviceMeta(settings.serviceId, settings);
      return `${meta.title} ${meta.description} ${settings.serviceId}`.toLocaleLowerCase().includes(query);
    });
  }, [connectionStates, filter, searchText, settingsList]);

  const busy = pageBusy || editorBusy || busyServiceId !== null;

  return (
    <section className="settings-page mcp-square-page" aria-label="数字员工管理">
      <header className="settings-header">
        <div>
          <span>服务目录</span>
          <h1>数字员工管理</h1>
          {status ? <p className="mcp-status-line">{status}</p> : null}
        </div>
        <div className="settings-actions">
          <button
            type="button"
            onClick={() => setEditor({ mode: "add", draft: { ...EMPTY_DRAFT } })}
            disabled={busy}
          >
            <CirclePlus size={17} />
            添加数字员工
          </button>
          <button type="button" onClick={resetBuiltInSettings} disabled={busy}>
            <RotateCcw size={17} />
            重置内置
          </button>
        </div>
      </header>

      <div className="mcp-catalog-toolbar">
        <div className="mcp-filter-tabs" role="tablist" aria-label="MCP 状态筛选">
          <button type="button" className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>
            全部 {settingsList.length}
          </button>
          <button
            type="button"
            className={filter === "connected" ? "is-active" : ""}
            onClick={() => setFilter("connected")}
          >
            连接正常 {connectedCount}
          </button>
          <button
            type="button"
            className={filter === "pending" ? "is-active" : ""}
            onClick={() => setFilter("pending")}
          >
            待配置 {pendingCount}
          </button>
        </div>
        <label className="mcp-search-box">
          <Search size={17} />
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索数字员工"
            aria-label="搜索数字员工"
          />
        </label>
      </div>

      <div className="mcp-card-grid">
        {visibleSettings.map((settings) => {
          const meta = serviceMeta(settings.serviceId, settings);
          const connection = connectionStates[settings.serviceId] ?? staticConnectionState(settings);
          const endpoint = configuredConnectionValue(settings);
          const serviceBusy = busyServiceId === settings.serviceId;
          return (
            <article className={`mcp-service-card ${settings.enabled ? "" : "is-disabled"}`} key={settings.serviceId}>
              <div className="mcp-card-top">
                <span className="mcp-card-icon" aria-hidden="true">
                  <Bot size={24} />
                </span>
                <span className={`mcp-connection-badge is-${connection.kind}`} title={connection.detail}>
                  MCP · {connection.label}
                </span>
              </div>
              <div className="mcp-card-copy">
                <h2>{meta.title}</h2>
                <p>{meta.description}</p>
              </div>
              <dl className="mcp-card-meta">
                <div>
                  <dt>连接方式</dt>
                  <dd>{settings.transport === "http" ? "HTTP" : "stdio"}</dd>
                </div>
                <div>
                  <dt>服务 ID</dt>
                  <dd title={settings.serviceId}>{settings.serviceId}</dd>
                </div>
              </dl>
              <p className={`mcp-card-endpoint ${endpoint ? "" : "is-empty"}`} title={endpoint || connection.detail}>
                {endpoint || "尚未配置连接地址"}
              </p>
              <footer className="mcp-card-footer">
                <label className="mcp-card-switch" title={meta.enabledDescription}>
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    disabled={busy}
                    aria-label={`${settings.enabled ? "停用" : "启用"} ${meta.title}`}
                    onChange={(event) => void toggleService(settings, event.target.checked)}
                  />
                  <span aria-hidden="true" />
                  <em>{serviceBusy ? "处理中" : settings.enabled ? "已启用" : "未启用"}</em>
                </label>
                <div className="mcp-card-actions">
                  {settings.transport === "stdio" && settings.enabled ? (
                    <button
                      type="button"
                      className="mcp-reconnect-button"
                      disabled={busy}
                      title="断开并重启 MCP 子进程，让修改后的服务端配置（如 config.local.json）生效"
                      onClick={() => handleReconnect(settings)}
                    >
                      <RefreshCw size={15} className={serviceBusy ? "spin" : ""} />
                      重连
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="mcp-edit-button"
                    disabled={busy}
                    onClick={() => setEditor({ mode: "edit", draft: { ...settings } })}
                  >
                    <Pencil size={16} />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="mcp-delete-button"
                    disabled={busy}
                    onClick={() => setPendingDelete(settings)}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
        {visibleSettings.length === 0 ? (
          <div className="mcp-empty-result">
            <Search size={24} />
            <strong>没有匹配的数字员工</strong>
            <span>请调整筛选条件或搜索关键词。</span>
          </div>
        ) : null}
      </div>

      {editor ? (
        <div
          className="mcp-editor-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !editorBusy) setEditor(null);
          }}
        >
          <section className="mcp-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-editor-title">
            <header className="mcp-editor-header">
              <div>
                <span className="mcp-card-icon" aria-hidden="true">
                  <Bot size={22} />
                </span>
                <div>
                  <span>{editor.mode === "add" ? "新增数字员工" : "连接配置"}</span>
                  <h2 id="mcp-editor-title">
                    {editor.mode === "add"
                      ? "添加数字员工"
                      : serviceMeta(editor.draft.serviceId, editor.draft).title}
                  </h2>
                </div>
              </div>
              <button type="button" aria-label="关闭编辑配置" onClick={() => setEditor(null)} disabled={editorBusy}>
                <X size={19} />
              </button>
            </header>

            <div className="mcp-editor-body">
              <div className="mcp-editor-two-column">
                <label>
                  <span>数字员工名称</span>
                  <input
                    value={editor.draft.employeeName}
                    placeholder="例如：日志分析"
                    onChange={(event) => updateEditor("employeeName", event.target.value)}
                  />
                </label>
                <label>
                  <span>职责说明</span>
                  <input
                    value={editor.draft.employeeRole}
                    placeholder="例如：安全日志分析与研判"
                    onChange={(event) => updateEditor("employeeRole", event.target.value)}
                  />
                </label>
              </div>

              <label>
                <span>介绍标题</span>
                <input
                  value={editor.draft.welcomeTitle}
                  placeholder="例如：欢迎使用告警分析"
                  onChange={(event) => updateEditor("welcomeTitle", event.target.value)}
                />
              </label>

              <label>
                <span>介绍内容</span>
                <textarea
                  value={editor.draft.welcomeMessage}
                  placeholder="说明数字员工可以完成什么，以及用户可以如何开始任务。"
                  rows={2}
                  onChange={(event) => updateEditor("welcomeMessage", event.target.value)}
                />
              </label>

              <label>
                <span>服务 ID</span>
                <input
                  value={editor.draft.serviceId}
                  disabled={editor.mode === "edit"}
                  placeholder="custom-service-mcp"
                  onChange={(event) => updateEditor("serviceId", event.target.value)}
                />
              </label>

              <label>
                <span>连接方式</span>
                <TransportToggle value={editor.draft.transport} onChange={(value) => updateEditor("transport", value)} />
              </label>

              <div className="mcp-editor-two-column">
                <ToggleRow
                  title="启用数字员工服务"
                  description="保存后立即检测连接状态"
                  checked={editor.draft.enabled}
                  onChange={(checked) => updateEditor("enabled", checked)}
                />
                <ToggleRow
                  title="显示在工作台"
                  description="同步显示在左侧列表和首页入口"
                  checked={editor.draft.showInEmployeeList}
                  onChange={(checked) => updateEditor("showInEmployeeList", checked)}
                />
              </div>

              {editor.draft.transport === "stdio" ? (
                <>
                  <label>
                    <span>启动方式</span>
                    <LaunchModeToggle
                      value={editor.draft.launchMode}
                      onChange={(value) => updateEditor("launchMode", value)}
                    />
                  </label>
                  <label>
                    <span>
                      {editor.draft.launchMode === "module" ? "项目根目录" : "MCP 启动路径"}
                    </span>
                    <input
                      value={editor.draft.commandPath}
                      placeholder={
                        editor.draft.launchMode === "module"
                          ? moduleProjectRootPlaceholder()
                          : serviceMeta(editor.draft.serviceId, editor.draft).pathPlaceholder
                      }
                      onChange={(event) => updateEditor("commandPath", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>
                      {editor.draft.launchMode === "module" ? "Python 模块名" : "启动参数"}
                    </span>
                    <input
                      value={editor.draft.commandArgs}
                      placeholder={
                        editor.draft.launchMode === "module"
                          ? modulePlaceholder(editor.draft.serviceId)
                          : "--transport stdio"
                      }
                      onChange={(event) => updateEditor("commandArgs", event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    <span>HTTP MCP 地址</span>
                    <input
                      value={editor.draft.httpUrl}
                      placeholder={serviceMeta(editor.draft.serviceId, editor.draft).httpPlaceholder}
                      onChange={(event) => updateEditor("httpUrl", event.target.value)}
                    />
                  </label>
                  <div className="mcp-headers">
                    <div className="mcp-headers-head">
                      <span>认证请求头</span>
                      <button type="button" className="mcp-headers-add" onClick={() => addHttpHeader()}>
                        <CirclePlus size={14} /> 添加请求头
                      </button>
                    </div>
                    <small className="mcp-headers-hint">
                      用于鉴权,如添加名为「Authorization」、值为「Bearer xxxxxkey」的请求头。
                    </small>
                    {editor.draft.httpHeaders.map((item, index) => (
                      <div className="mcp-headers-row" key={index}>
                        <input
                          className="mcp-headers-name"
                          value={item.name}
                          placeholder="Header 名称，如 Authorization"
                          onChange={(event) => updateHttpHeader(index, "name", event.target.value)}
                        />
                        <input
                          className="mcp-headers-value"
                          value={item.value}
                          placeholder="Header 值，如 Bearer xxxxxkey"
                          onChange={(event) => updateHttpHeader(index, "value", event.target.value)}
                        />
                        <button
                          type="button"
                          className="mcp-headers-remove"
                          aria-label="删除请求头"
                          onClick={() => removeHttpHeader(index)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <footer className="mcp-editor-footer">
              <button type="button" onClick={() => setEditor(null)} disabled={editorBusy}>
                取消
              </button>
              <button className="primary" type="button" onClick={() => void saveEditor()} disabled={editorBusy}>
                <Save size={17} />
                {editorBusy ? "正在保存" : "保存配置"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        title="删除数字员工"
        message={`确认删除“${pendingDelete?.employeeName ?? ""}”？删除后将同时从左侧列表和首页入口移除。`}
        confirmLabel="删除"
        danger
        onConfirm={() => void deleteService()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
