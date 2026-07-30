import {
  BookOpenText,
  CheckCircle2,
  CircleOff,
  FolderOpen,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import {
  deleteUserSkill,
  getSkill,
  listSkillCatalog,
  openUserSkillDir,
  pickAndInstallSkill,
  setSkillEnabled,
  type SkillDefinition,
  type SkillLoadError,
  type SkillManifest,
} from "../services/skillRegistry";
import { resolveSkill } from "../services/skillResolver";

const runtimeLabel = (runtime: string) => {
  if (runtime === "instruction") return "Instruction";
  if (runtime === "script") return "Script";
  if (runtime === "workflow") return "Workflow";
  return runtime || "Unknown";
};

const sourceLabel = (source?: string) => {
  if (source === "project") return "项目内置";
  if (source === "user") return "用户安装";
  if (source === "resource") return "应用资源";
  return source || "未知来源";
};

const joinTags = (items: string[]) => (items.length ? items.join(" / ") : "未配置");

const permissionText = (permissions: unknown) => {
  if (!permissions) return "未声明";
  try {
    return JSON.stringify(permissions, null, 2);
  } catch {
    return String(permissions);
  }
};

function SkillPanelHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof BookOpenText;
  title: string;
  description: string;
}) {
  return (
    <div className="settings-card-title">
      <Icon size={20} />
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

function SkillListItem({
  skill,
  selected,
  onSelect,
}: {
  skill: SkillManifest;
  selected: boolean;
  onSelect: () => void;
}) {
  const StatusIcon = skill.enabled ? CheckCircle2 : CircleOff;

  return (
    <button
      type="button"
      className={`skill-list-item ${selected ? "selected" : ""}`}
      onClick={onSelect}
      title={skill.description}
    >
      <span className="skill-list-icon">
        <BookOpenText size={16} />
      </span>
      <span className="skill-list-main">
        <strong>{skill.name}</strong>
        <small>{skill.id}</small>
      </span>
      <span className={`skill-status ${skill.enabled ? "ready" : "disabled"}`}>
        <StatusIcon size={13} />
        {skill.enabled ? "启用" : "禁用"}
      </span>
    </button>
  );
}

function SkillErrors({ errors }: { errors: SkillLoadError[] }) {
  if (!errors.length) return null;
  return (
    <section className="settings-card settings-card-wide skill-error-panel">
      <div className="settings-card-title">
        <CircleOff size={20} />
        <div>
          <h2>无效 SKILL 包</h2>
          <p>这些目录包含无法加载的 Skill。修复标准 SKILL.md（可选 skill.json）后刷新。</p>
        </div>
      </div>
      <div className="skill-error-list">
        {errors.map((error) => (
          <div key={`${error.source}-${error.path}`} className="skill-error-item">
            <strong>{sourceLabel(error.source)}</strong>
            <code>{error.path}</code>
            <span>{error.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SkillCenterPanel() {
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [errors, setErrors] = useState<SkillLoadError[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [definition, setDefinition] = useState<SkillDefinition | null>(null);
  const [status, setStatus] = useState("正在读取 Skill...");
  const [busy, setBusy] = useState(false);
  const [testText, setTestText] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SkillManifest | null>(null);

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedId) ?? skills[0],
    [selectedId, skills],
  );

  const resolution = useMemo(() => resolveSkill(testText, skills), [testText, skills]);

  const refreshSkills = async () => {
    setBusy(true);
    setStatus("正在刷新 Skill 列表...");
    try {
      const catalog = await listSkillCatalog();
      setSkills(catalog.skills);
      setErrors(catalog.errors);
      setSelectedId((current) => {
        if (current && catalog.skills.some((skill) => skill.id === current)) return current;
        return catalog.skills[0]?.id ?? null;
      });
      setStatus(
        catalog.skills.length
          ? `已读取 ${catalog.skills.length} 个 Skill，${catalog.errors.length} 个无效包。`
          : `未发现已安装 SKILL，${catalog.errors.length} 个无效包。`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refreshSkills();
  }, []);

  useEffect(() => {
    let alive = true;
    setDefinition(null);
    if (!selectedSkill) return;

    getSkill(selectedSkill.id)
      .then((nextDefinition) => {
        if (!alive) return;
        setDefinition(nextDefinition);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setStatus(error instanceof Error ? error.message : String(error));
      });

    return () => {
      alive = false;
    };
  }, [selectedSkill]);

  const handlePickInstall = async () => {
    setBusy(true);
    setStatus("请选择 Skill ZIP 包，或选择目录中的 SKILL.md / skill.json...");
    try {
      const skill = await pickAndInstallSkill();
      setStatus(`已安装 SKILL：${skill.name}`);
      await refreshSkills();
      setSelectedId(skill.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message === "cancelled" ? "已取消导入。" : message);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenUserDir = async () => {
    setBusy(true);
    try {
      await openUserSkillDir();
      setStatus("已打开用户 Skill 目录。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleSkill = async (skill: SkillManifest) => {
    setBusy(true);
    try {
      const updated = await setSkillEnabled(skill.id, !skill.enabled);
      setSkills((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setStatus(`${updated.name} 已${updated.enabled ? "启用" : "禁用"}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSkill = (skill: SkillManifest) => {
    if (!skill.canDelete) {
      setStatus("只能删除用户安装的 Skill，项目内置和应用资源 Skill 不支持在这里删除。");
      return;
    }
    setPendingDelete(skill);
  };

  const confirmDeleteSkill = async () => {
    const skill = pendingDelete;
    setPendingDelete(null);
    if (!skill) return;
    setBusy(true);
    try {
      await deleteUserSkill(skill.id);
      setStatus(`已删除 Skill：${skill.name}`);
      await refreshSkills();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-page mcp-square-page skill-center-page" aria-label="SKILL 中心">
      <header className="settings-header skill-center-header">
        <div>
          <span>SKILL 中心</span>
          <h1>SKILL 管理</h1>
          {status ? <p className="mcp-status-line">{status}</p> : null}
        </div>
        <div className="settings-actions">
          <button type="button" onClick={handlePickInstall} disabled={busy}>
            <Upload size={17} />
            导入
          </button>
          <button type="button" onClick={handleOpenUserDir} disabled={busy}>
            <FolderOpen size={17} />
            用户目录
          </button>
          <button type="button" onClick={refreshSkills} disabled={busy}>
            <RefreshCw size={17} />
            刷新
          </button>
        </div>
      </header>

      <div className="skill-center-scroll">
        <div className="skill-center-layout">
          <section className="settings-card skill-list-panel">
          <SkillPanelHeading
            icon={BookOpenText}
            title="已安装 SKILL"
            description="可在右侧查看详情并管理状态。"
          />

          <div className="skill-list">
            {skills.length ? (
              skills.map((skill) => (
                <SkillListItem
                  key={skill.id}
                  skill={skill}
                  selected={skill.id === selectedSkill?.id}
                  onSelect={() => setSelectedId(skill.id)}
                />
              ))
            ) : (
              <div className="skill-empty">
                <CircleOff size={20} />
                <span>暂无 SKILL</span>
                <small>导入标准 Skill ZIP，或把含 SKILL.md 的目录放入用户 Skill 目录后刷新。</small>
              </div>
            )}
          </div>
          </section>

          <section className="settings-card skill-detail-panel">
          {selectedSkill ? (
            <>
              <div className="skill-detail-sticky">
                <SkillPanelHeading
                  icon={ShieldCheck}
                  title={selectedSkill.name}
                  description={selectedSkill.description}
                />

                <div className="skill-action-row">
                  <button type="button" onClick={() => handleToggleSkill(selectedSkill)} disabled={busy || !selectedSkill.canToggle}>
                    <Power size={15} />
                    {selectedSkill.enabled ? "禁用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => handleDeleteSkill(selectedSkill)}
                    disabled={busy || !selectedSkill.canDelete}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </div>

              <div className="skill-detail-scroll">
              <dl className="skill-meta-grid">
                <div>
                  <dt>ID</dt>
                  <dd>{selectedSkill.id}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{selectedSkill.version || "未声明"}</dd>
                </div>
                <div>
                  <dt>运行时</dt>
                  <dd>{runtimeLabel(selectedSkill.runtime)}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>{sourceLabel(selectedSkill.source)}</dd>
                </div>
              </dl>

              <div className="skill-path">
                <span>目录</span>
                <code>{selectedSkill.sourcePath || "未返回路径"}</code>
              </div>

              <div className="skill-section">
                <h3>触发配置</h3>
                <p>
                  <strong>关键词：</strong>
                  {joinTags(selectedSkill.keywords)}
                </p>
                <p>
                  <strong>触发句：</strong>
                  {joinTags(selectedSkill.triggers)}
                </p>
              </div>

              <div className="skill-section">
                <h3>权限声明</h3>
                <pre>{permissionText(selectedSkill.permissions)}</pre>
              </div>

              <div className="skill-section">
                <h3>命中测试</h3>
                <label className="skill-test-input">
                  <span>
                    <Search size={14} />
                    测试输入
                  </span>
                  <input
                    value={testText}
                    placeholder="例如：根据这次告警帮我生成一份安全报告"
                    onChange={(event) => setTestText(event.target.value)}
                  />
                </label>
                <p className="skill-resolution">
                  {testText.trim()
                    ? resolution.skillId
                      ? `命中：${resolution.skillId}，置信度 ${resolution.confidence.toFixed(2)}，原因：${resolution.reason}`
                      : `未命中。${resolution.reason}`
                    : "输入一句任务描述后可测试 Skill 识别结果。"}
                </p>
              </div>

              <div className="skill-section skill-entry-section">
                <h3>{selectedSkill.entry}</h3>
                <pre>{definition?.entryContent || "正在读取 Skill 内容..."}</pre>
              </div>
              </div>
            </>
          ) : (
            <div className="skill-empty">
              <CircleOff size={22} />
              <span>未选择 SKILL</span>
              <small>左侧列表为空时，请先安装或创建 Skill。</small>
            </div>
          )}
          </section>
        </div>

        <SkillErrors errors={errors} />
      </div>

      <ConfirmModal
        open={pendingDelete !== null}
        title="删除 Skill"
        message={`确认删除 Skill「${pendingDelete?.name ?? ""}」？该操作会删除用户 Skill 目录中的文件，不可恢复。`}
        confirmLabel="删除"
        danger
        onConfirm={confirmDeleteSkill}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
