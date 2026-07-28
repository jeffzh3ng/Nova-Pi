import {
  Activity,
  Bot,
  CheckCircle2,
  Code2,
  Command,
  FilePenLine,
  FileSearch,
  FolderOpen,
  MonitorCog,
  RefreshCw,
  Save,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getComputerAgentSettings,
  getNovaStatus,
  manageNovaTask,
  pickComputerAgentWorkingDirectory,
  saveComputerAgentSettings,
  type ComputerAgentSettings,
  type NovaStatusSnapshot,
} from "../services/computerAgent";
import { toUserFacingError } from "../services/uiError";

const EMPTY_STATUS: NovaStatusSnapshot = {
  host: { pid: 0, uptimeSeconds: 0, nodeVersion: "", platform: "" },
  totals: { conversations: 0, sessions: 0, running: 0, background: 0 },
  conversations: [],
  sessions: [],
};

type PermissionKey = keyof Pick<
  ComputerAgentSettings,
  "allowFileRead" | "allowFileWrite" | "allowCommandExecution" | "allowComputerInfo" | "allowNovaManagement"
>;

const PERMISSIONS: Array<{
  key: PermissionKey;
  title: string;
  description: string;
  icon: typeof FileSearch;
  risk?: boolean;
}> = [
  { key: "allowFileRead", title: "读取文件", description: "查看任意可访问路径中的文本、代码和图片。", icon: FileSearch },
  { key: "allowFileWrite", title: "修改文件与编程", description: "使用 pi 的 edit/write 工具创建、修改代码和其他文件。", icon: FilePenLine, risk: true },
  { key: "allowCommandExecution", title: "执行命令", description: "在工作目录执行 PowerShell、Git、构建、测试和系统命令。", icon: Command, risk: true },
  { key: "allowComputerInfo", title: "查看电脑信息", description: "读取系统、CPU、内存、网络接口和用户目录信息。", icon: MonitorCog },
  { key: "allowNovaManagement", title: "管理 Nova-PI", description: "查看对话与运行任务，并中止或释放其他任务会话。", icon: Activity, risk: true },
];

const formatUptime = (seconds: number) => {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
};

export function ComputerAgentSettingsPanel() {
  const [draft, setDraft] = useState<ComputerAgentSettings | null>(null);
  const [snapshot, setSnapshot] = useState<NovaStatusSnapshot>(EMPTY_STATUS);
  const [status, setStatus] = useState("正在读取智能员工设置...");
  const [saving, setSaving] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState<string | null>(null);

  const refreshRuntime = async () => {
    try {
      setSnapshot(await getNovaStatus());
    } catch {
      setSnapshot(EMPTY_STATUS);
    }
  };

  useEffect(() => {
    let alive = true;
    getComputerAgentSettings()
      .then((settings) => {
        if (!alive) return;
        setDraft(settings);
        const granted = PERMISSIONS.filter((item) => settings[item.key]).length;
        setStatus(settings.enabled
          ? granted > 0
            ? `Nova 智能员工已启用，${granted} 项能力已授权。`
            : "Nova 智能员工已启用，但尚未授权电脑操作能力；普通对话仍可使用。"
          : "Nova 智能员工默认存在，当前尚未启用。");
      })
      .catch((error) => {
        if (alive) setStatus(toUserFacingError(error, "智能员工设置读取失败。"));
      });
    void refreshRuntime();
    const timer = window.setInterval(() => void refreshRuntime(), 3_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const authorizedCount = useMemo(
    () => draft ? PERMISSIONS.filter((item) => draft[item.key]).length : 0,
    [draft],
  );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setStatus("正在保存并应用授权...");
    try {
      const saved = await saveComputerAgentSettings(draft);
      setDraft(saved);
      const granted = PERMISSIONS.filter((item) => saved[item.key]).length;
      setStatus(saved.enabled
        ? granted > 0
          ? `已启用 ${saved.displayName}，${granted} 项能力已授权。新授权会从下一次会话开始生效。`
          : `已启用 ${saved.displayName}，当前仅可普通对话；电脑操作会提示开启对应授权。`
        : `已停用 ${saved.displayName}，现有该员工会话已释放。`);
      await refreshRuntime();
    } catch (error) {
      setStatus(toUserFacingError(error, "智能员工设置保存失败。"));
    } finally {
      setSaving(false);
    }
  };

  const chooseDirectory = async () => {
    try {
      const selected = await pickComputerAgentWorkingDirectory();
      if (selected) setDraft((current) => current ? { ...current, workingDirectory: selected } : current);
    } catch (error) {
      setStatus(toUserFacingError(error, "工作目录选择失败。"));
    }
  };

  const manage = async (conversationId: string, action: "abort" | "dispose") => {
    setRuntimeBusy(`${conversationId}:${action}`);
    try {
      const result = await manageNovaTask(conversationId, action);
      setStatus(result.message);
      await refreshRuntime();
    } catch (error) {
      setStatus(toUserFacingError(error, "任务管理失败。"));
    } finally {
      setRuntimeBusy(null);
    }
  };

  if (!draft) {
    return <section className="settings-section computer-agent-settings"><p className="mcp-status-line">{status}</p></section>;
  }

  const conversationsById = new Map(snapshot.conversations.map((item) => [item.id, item]));

  return (
    <section className="settings-section computer-agent-settings" aria-label="Nova 智能员工设置">
      <header className="settings-section-header computer-agent-header">
        <div>
          <h2>Nova 智能员工</h2>
          <p className="mcp-status-line" title={status}>{status}</p>
        </div>
        <span className={`computer-agent-state ${draft.enabled ? "is-enabled" : ""}`}>
          {draft.enabled ? <CheckCircle2 size={15} /> : <Square size={14} />}
          {draft.enabled ? "已启用" : "未启用"}
        </span>
      </header>

      <div className="computer-agent-layout">
        <section className="computer-agent-config-card">
          <div className="computer-agent-card-title">
            <span className="mcp-card-icon"><Bot size={22} /></span>
            <div>
              <h2>员工与工作区</h2>
              <p>该员工直接运行在 pi agent 内核中，不依赖 MCP 服务。</p>
            </div>
          </div>

          <label className="computer-agent-master-toggle">
            <span>
              <strong>启用内置智能员工</strong>
              <small>启用后会出现在首页、@ 召唤和消息通道的员工列表中。</small>
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
          </label>

          <div className="computer-agent-fields">
            <label>
              <span>显示名称</span>
              <input
                value={draft.displayName}
                maxLength={40}
                onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
              />
            </label>
            <label>
              <span>默认工作目录</span>
              <div className="computer-agent-path-field">
                <input
                  value={draft.workingDirectory}
                  onChange={(event) => setDraft({ ...draft, workingDirectory: event.target.value })}
                  spellCheck={false}
                />
                <button type="button" onClick={() => void chooseDirectory()} title="选择文件夹">
                  <FolderOpen size={17} /> 选择
                </button>
              </div>
              <small>相对路径以此目录为基准；授权后仍可使用绝对路径访问电脑上的其他位置。</small>
            </label>
          </div>

          <div className="computer-agent-permission-heading">
            <div>
              <strong>能力授权</strong>
              <span>已选择 {authorizedCount} / {PERMISSIONS.length}</span>
            </div>
            <p>授权会决定 pi 会话里实际存在的工具。其他数字员工不会继承这些权限。</p>
          </div>
          <div className="computer-agent-permissions">
            {PERMISSIONS.map((permission) => {
              const Icon = permission.icon;
              return (
                <label className={`computer-agent-permission ${draft[permission.key] ? "is-selected" : ""}`} key={permission.key}>
                  <input
                    type="checkbox"
                    checked={draft[permission.key]}
                    onChange={(event) => setDraft({ ...draft, [permission.key]: event.target.checked })}
                  />
                  <span className="computer-agent-permission-icon"><Icon size={20} /></span>
                  <span>
                    <strong>{permission.title}{permission.risk ? <ShieldAlert size={14} /> : null}</strong>
                    <small>{permission.description}</small>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="computer-agent-risk-note">
            <ShieldAlert size={18} />
            <span>文件修改和命令执行可影响整台电脑。只授权实际需要的能力，涉及删除或系统级变更时仍应人工确认。</span>
          </div>
          <footer className="computer-agent-save-row">
            <button className="primary" type="button" onClick={() => void save()} disabled={saving}>
              <Save size={17} /> {saving ? "正在应用" : "保存并应用"}
            </button>
          </footer>
        </section>

        <section className="computer-agent-runtime-card">
          <header>
            <div>
              <h2>Nova-PI 工作状态</h2>
              <p>{snapshot.host.pid ? `Host PID ${snapshot.host.pid} · 已运行 ${formatUptime(snapshot.host.uptimeSeconds)}` : "Host 暂未连接"}</p>
            </div>
            <button type="button" onClick={() => void refreshRuntime()} title="刷新状态"><RefreshCw size={16} /></button>
          </header>
          <div className="computer-agent-metrics">
            <span><strong>{snapshot.totals.conversations}</strong>对话</span>
            <span><strong>{snapshot.totals.sessions}</strong>会话</span>
            <span className={snapshot.totals.running ? "is-running" : ""}><strong>{snapshot.totals.running}</strong>运行中</span>
            <span><strong>{snapshot.totals.background}</strong>消息渠道</span>
          </div>

          <div className="computer-agent-runtime-section">
            <div className="computer-agent-runtime-heading">
              <strong>运行时任务</strong>
              <span>{snapshot.sessions.length}</span>
            </div>
            {snapshot.sessions.length === 0 ? (
              <p className="computer-agent-empty">当前没有已加载的 Agent 会话。</p>
            ) : (
              <div className="computer-agent-session-list">
                {snapshot.sessions.map((session) => {
                  const conversation = conversationsById.get(session.conversationId);
                  const busyKey = `${session.conversationId}:${session.status === "running" ? "abort" : "dispose"}`;
                  return (
                    <article key={session.sessionId}>
                      <div>
                        <strong>{conversation?.title || (session.background ? "消息渠道对话" : session.conversationId)}</strong>
                        <span>{session.background ? "后台" : conversation?.agentName || session.humanId}{session.activeTool ? ` · ${session.activeTool}` : ""}</span>
                      </div>
                      <span className={`computer-agent-runtime-status ${session.status}`}>{session.status === "running" ? "运行中" : "空闲"}</span>
                      <button
                        type="button"
                        className={session.status === "running" ? "is-stop" : ""}
                        disabled={runtimeBusy === busyKey}
                        title={session.status === "running" ? "中止任务" : "释放会话"}
                        onClick={() => void manage(session.conversationId, session.status === "running" ? "abort" : "dispose")}
                      >
                        {session.status === "running" ? <Square size={14} /> : <Trash2 size={14} />}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <div className="computer-agent-runtime-section">
            <div className="computer-agent-runtime-heading">
              <strong>最近对话</strong>
              <span>{snapshot.conversations.length}</span>
            </div>
            {snapshot.conversations.length === 0 ? (
              <p className="computer-agent-empty">暂无已同步的对话记录。</p>
            ) : (
              <div className="computer-agent-conversation-list">
                {snapshot.conversations.slice(0, 10).map((conversation) => (
                  <article key={conversation.id}>
                    <span className={`computer-agent-conversation-dot ${conversation.status}`} />
                    <div>
                      <strong>{conversation.title}</strong>
                      <span>{conversation.agentName || conversation.agentId || "数字员工"} · {conversation.messageCount ?? 0} 条消息{conversation.archived ? " · 已归档" : ""}</span>
                    </div>
                    <em>{conversation.status === "running" ? "运行中" : conversation.status === "done" ? "已完成" : conversation.status === "canceled" ? "已取消" : "已暂停"}</em>
                  </article>
                ))}
              </div>
            )}
          </div>
          <div className="computer-agent-runtime-footnote"><Code2 size={15} /> 智能员工也可通过 nova_status、nova_list_tasks 和 nova_manage_task 使用这些能力。</div>
        </section>
      </div>
    </section>
  );
}
