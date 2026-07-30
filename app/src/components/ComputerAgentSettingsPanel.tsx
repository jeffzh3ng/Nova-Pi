import {
  Activity,
  BookOpenCheck,
  Bot,
  CheckCircle2,
  CircleMinus,
  Command,
  FilePenLine,
  FileSearch,
  FolderOpen,
  MonitorCog,
  Save,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getComputerAgentSettings,
  pickComputerAgentWorkingDirectory,
  saveComputerAgentSettings,
  type ComputerAgentSettings,
} from "../services/computerAgent";
import { toUserFacingError } from "../services/uiError";

type PermissionKey = keyof Pick<
  ComputerAgentSettings,
  "allowFileRead" | "allowFileWrite" | "allowCommandExecution" | "allowSkills" | "allowComputerInfo" | "allowNovaManagement"
>;

const PERMISSIONS: Array<{
  key: PermissionKey;
  title: string;
  description: string;
  icon: typeof FileSearch;
  risk?: boolean;
}> = [
  { key: "allowFileRead", title: "读取文件", description: "查看任意可访问路径中的文本、代码和图片。", icon: FileSearch },
  { key: "allowFileWrite", title: "修改文件与编程", description: "创建、修改代码和其他文件。", icon: FilePenLine, risk: true },
  { key: "allowCommandExecution", title: "执行命令", description: "在工作目录执行 PowerShell、Git、构建、测试和系统命令。", icon: Command, risk: true },
  { key: "allowSkills", title: "使用 Skill", description: "调用 Skill 设置中已启用的能力，并安全保存其 Token 等环境配置。", icon: BookOpenCheck, risk: true },
  { key: "allowComputerInfo", title: "查看设备信息", description: "读取系统、CPU、内存、网络接口和用户目录信息。", icon: MonitorCog },
  { key: "allowNovaManagement", title: "管理 Nova", description: "查看对话与运行任务，并中止或释放其他任务会话。", icon: Activity, risk: true },
];

export function ComputerAgentSettingsPanel() {
  const [draft, setDraft] = useState<ComputerAgentSettings | null>(null);
  const [status, setStatus] = useState("正在读取智能员工设置...");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getComputerAgentSettings()
      .then((settings) => {
        if (!alive) return;
        setDraft(settings);
        const granted = PERMISSIONS.filter((item) => settings[item.key]).length;
        setStatus(settings.enabled
          ? granted > 0
            ? `Nova 已启用，${granted} 项能力已授权。`
            : "Nova 已启用，但尚未授权本机任务能力；普通对话仍可使用。"
          : "Nova 默认存在，当前尚未启用。");
      })
      .catch((error) => {
        if (alive) setStatus(toUserFacingError(error, "智能员工设置读取失败。"));
      });
    return () => {
      alive = false;
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
          : `已启用 ${saved.displayName}，当前仅可普通对话；执行本机任务时会提示开启对应授权。`
        : `已停用 ${saved.displayName}，现有该员工会话已释放。`);
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

  if (!draft) {
    return <section className="settings-section computer-agent-settings"><p className="mcp-status-line">{status}</p></section>;
  }

  return (
    <section className="settings-section computer-agent-settings" aria-label="Nova 智能助手设置">
      <header className="settings-section-header computer-agent-header">
        <div>
          <h2>Nova 智能助手</h2>
          <p className="mcp-status-line" title={status}>{status}</p>
        </div>
        <span className={`computer-agent-state ${draft.enabled ? "is-enabled" : ""}`}>
          {draft.enabled ? <CheckCircle2 size={15} /> : <CircleMinus size={15} />}
          {draft.enabled ? "已启用" : "未启用"}
        </span>
      </header>

      <section className="computer-agent-config-card">
        <div className="computer-agent-card-title">
          <div className="computer-agent-card-title-copy">
            <span className="mcp-card-icon"><Bot size={22} /></span>
            <div>
              <h2>基础配置</h2>
              <p>设置员工名称、默认工作目录和可使用的任务能力。</p>
            </div>
          </div>
          <label className="computer-agent-master-toggle">
            <span>
              <strong>启用智能员工</strong>
              <small>显示在首页、@ 召唤和消息渠道中。</small>
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
          </label>
        </div>

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
            <span>默认工作目录 <small>（相对路径基准，也支持绝对路径）</small></span>
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
          </label>
        </div>

        <div className="computer-agent-permission-heading">
          <div>
            <strong>能力授权</strong>
            <span>已选择 {authorizedCount} / {PERMISSIONS.length}</span>
          </div>
          <p>仅为 Nova 开放所选能力，其他数字员工不会继承这些权限。</p>
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
          <span>文件修改、命令执行和第三方 Skill 可能影响本机或访问外部服务。只授权实际需要的能力，涉及删除或系统级变更时仍应人工确认。</span>
        </div>
        <footer className="computer-agent-save-row">
          <button className="primary" type="button" onClick={() => void save()} disabled={saving}>
            <Save size={17} /> {saving ? "正在应用" : "保存并应用"}
          </button>
        </footer>
      </section>
    </section>
  );
}
