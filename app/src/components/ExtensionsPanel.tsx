import { CirclePlus, Code2, FileCode, FolderOpen, Puzzle, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import {
  DEFAULT_EXTENSION_TEMPLATE,
  addExtension,
  createExtension,
  listExtensions,
  readExtensionContent,
  removeExtension,
  setExtensionEnabled,
} from "../services/extensionsService";
import type { ExtensionSummary } from "../services/hostBridge";

type CreateDraft = {
  name: string;
  template: string;
};

const sourceLabel = (source: ExtensionSummary["source"]) =>
  source === "user-managed" ? "settings.json" : "全局扩展目录";

const sourceIcon = FolderOpen;

export function ExtensionsPanel() {
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [addPath, setAddPath] = useState("");
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExtensionSummary | null>(null);
  const [viewing, setViewing] = useState<ExtensionSummary | null>(null);
  const [viewContent, setViewContent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("正在读取 Pi 扩展...");

  const refresh = async () => {
    setBusy(true);
    setStatus("正在刷新扩展列表...");
    try {
      const result = await listExtensions();
      setExtensions(result.extensions);
      setErrors(result.errors);
      setStatus(
        result.extensions.length
          ? `已读取 ${result.extensions.length} 个扩展。`
          : "未发现扩展。可添加本地 .ts 文件或新建扩展。",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleAdd = async () => {
    const path = addPath.trim();
    if (!path) {
      setStatus("请填写扩展文件路径。");
      return;
    }
    setBusy(true);
    setStatus(`正在添加扩展：${path}...`);
    try {
      await addExtension(path);
      setAddPath("");
      setStatus(`已添加扩展：${path}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!createDraft) return;
    const name = createDraft.name.trim();
    if (!name) {
      setStatus("请填写扩展名称。");
      return;
    }
    setBusy(true);
    setStatus(`正在创建扩展：${name}...`);
    try {
      await createExtension(name, createDraft.template || DEFAULT_EXTENSION_TEMPLATE);
      setCreateDraft(null);
      setStatus(`已创建扩展：${name}（位于全局扩展目录，已自动启用）`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (extension: ExtensionSummary, enabled: boolean) => {
    setBusyId(extension.id);
    try {
      await setExtensionEnabled(extension.id, enabled);
      setExtensions((items) =>
        items.map((item) => (item.id === extension.id ? { ...item, enabled } : item)),
      );
      setStatus(`${extension.name} 已${enabled ? "启用" : "禁用"}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    setBusyId(target.id);
    setStatus(`正在移除扩展：${target.name}...`);
    try {
      await removeExtension(target.id);
      setStatus(`已从 settings.json 移除：${target.name}（磁盘文件保留）。`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleView = async (extension: ExtensionSummary) => {
    setViewing(extension);
    setViewContent("正在读取...");
    try {
      const content = await readExtensionContent(extension.id);
      setViewContent(content);
    } catch (error) {
      setViewContent(error instanceof Error ? error.message : String(error));
    }
  };

  const visibleExtensions = useMemo(() => {
    const query = searchText.trim().toLocaleLowerCase();
    if (!query) return extensions;
    return extensions.filter((e) =>
      `${e.id} ${e.name} ${e.path} ${e.description}`.toLocaleLowerCase().includes(query),
    );
  }, [extensions, searchText]);

  return (
    <section className="settings-page mcp-square-page" aria-label="Pi 扩展管理">
      <header className="settings-header">
        <div>
          <span>Pi 扩展</span>
          <h1>扩展管理</h1>
          {status ? <p className="mcp-status-line">{status}</p> : null}
        </div>
        <div className="settings-actions">
          <button type="button" onClick={() => setCreateDraft({ name: "", template: DEFAULT_EXTENSION_TEMPLATE })} disabled={busy}>
            <FileCode size={17} />
            新建扩展
          </button>
          <button type="button" onClick={refresh} disabled={busy}>
            <RefreshCw size={17} />
            刷新
          </button>
        </div>
      </header>

      {/* 添加本地扩展路径 */}
      <section className="settings-card settings-card-wide" style={{ margin: "0 24px 16px" }}>
        <div className="settings-card-title">
          <CirclePlus size={20} />
          <div>
            <h2>添加已有扩展</h2>
            <p>填写本地 .ts 文件或目录路径（相对 settings.json 或绝对路径）。npm 包请用 pi 的 packages 配置。</p>
          </div>
        </div>
        <div className="settings-form-grid">
          <label className="settings-form-full">
            <span>扩展路径</span>
            <input
              value={addPath}
              placeholder="./my-extension.ts 或 /abs/path/to/extension.ts"
              onChange={(event) => setAddPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && addPath.trim() && !busy) void handleAdd();
              }}
            />
          </label>
        </div>
        <div className="settings-actions" style={{ marginTop: 8 }}>
          <button className="primary" type="button" onClick={() => void handleAdd()} disabled={busy || !addPath.trim()}>
            <CirclePlus size={16} />
            添加
          </button>
        </div>
      </section>

      <div className="mcp-catalog-toolbar">
        <label className="mcp-search-box">
          <Search size={17} />
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索扩展"
            aria-label="搜索扩展"
          />
        </label>
      </div>

      <div className="mcp-card-grid">
        {visibleExtensions.map((extension) => {
          const SourceIcon = sourceIcon;
          const isBusy = busyId === extension.id;
          return (
            <article
              className={`mcp-service-card ${extension.enabled ? "" : "is-disabled"}`}
              key={extension.id}
            >
              <div className="mcp-card-top">
                <span className="mcp-card-icon" aria-hidden="true">
                  <Puzzle size={24} />
                </span>
                <span
                  className={`mcp-connection-badge is-${extension.enabled && extension.exists ? "connected" : "pending"}`}
                  title={extension.exists ? (extension.enabled ? "已启用" : "已禁用") : "文件不存在"}
                >
                  {!extension.exists ? "缺失" : extension.enabled ? "已启用" : "已禁用"}
                </span>
              </div>
              <div className="mcp-card-copy">
                <h2>{extension.name}</h2>
                <p>{extension.description || "（无描述，建议在扩展文件头部 JSDoc 注释中补充）"}</p>
              </div>
              <dl className="mcp-card-meta">
                <div>
                  <dt>来源</dt>
                  <dd>{sourceLabel(extension.source)}{extension.isDirectory ? " · 目录" : ""}</dd>
                </div>
                <div>
                  <dt>路径</dt>
                  <dd title={extension.path} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{extension.path}</dd>
                </div>
              </dl>
              <p className={`mcp-card-endpoint ${extension.exists ? "" : "is-empty"}`} title={extension.path}>
                <SourceIcon size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
                {extension.exists ? extension.path : "文件不存在"}
              </p>

              <footer className="mcp-card-footer">
                <label className="mcp-card-switch" title={extension.enabled ? "禁用" : "启用"}>
                  <input
                    type="checkbox"
                    checked={extension.enabled}
                    disabled={isBusy || busy}
                    aria-label={`${extension.enabled ? "禁用" : "启用"} ${extension.name}`}
                    onChange={(event) => void handleToggle(extension, event.target.checked)}
                  />
                  <span aria-hidden="true" />
                  <em>{isBusy ? "处理中" : extension.enabled ? "已启用" : "已禁用"}</em>
                </label>
                <div className="mcp-card-actions">
                  <button
                    type="button"
                    className="mcp-edit-button"
                    disabled={busy || !extension.exists}
                    onClick={() => void handleView(extension)}
                  >
                    <Code2 size={16} />
                    源码
                  </button>
                  <button
                    type="button"
                    className="mcp-delete-button"
                    disabled={busy}
                    onClick={() => setPendingDelete(extension)}
                  >
                    <Trash2 size={15} />
                    移除
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
        {visibleExtensions.length === 0 ? (
          <div className="mcp-empty-result">
            <Search size={24} />
            <strong>没有扩展</strong>
            <span>添加本地 .ts 文件路径，或点击「新建扩展」用模板创建。</span>
          </div>
        ) : null}
      </div>

      {errors.length > 0 ? (
        <section className="settings-card settings-card-wide" style={{ margin: "0 24px" }}>
          <div className="settings-card-title">
            <Puzzle size={20} />
            <div>
              <h2>加载错误</h2>
              <p>以下扩展在加载时出错（不影响其他扩展）。</p>
            </div>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {errors.map((error, index) => (
              <li key={index} style={{ padding: "6px 0", color: "var(--color-notice)", fontSize: 13 }}>
                {error}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 新建扩展对话框 */}
      {createDraft ? (
        <div
          className="mcp-editor-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setCreateDraft(null);
          }}
        >
          <section className="mcp-editor-dialog" role="dialog" aria-modal="true">
            <header className="mcp-editor-header">
              <div>
                <span className="mcp-card-icon" aria-hidden="true">
                  <FileCode size={22} />
                </span>
                <div>
                  <span>新建 Pi 扩展</span>
                  <h2>从模板创建</h2>
                </div>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setCreateDraft(null)} disabled={busy}>
                <X size={19} />
              </button>
            </header>
            <div className="mcp-editor-body">
              <label>
                <span>扩展名称（文件名，仅字母数字._-）</span>
                <input
                  value={createDraft.name}
                  placeholder="my-extension"
                  onChange={(event) => setCreateDraft((d) => (d ? { ...d, name: event.target.value } : d))}
                />
              </label>
              <label>
                <span>扩展代码（TypeScript，jiti 直接加载）</span>
                <textarea
                  value={createDraft.template}
                  rows={14}
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
                  onChange={(event) => setCreateDraft((d) => (d ? { ...d, template: event.target.value } : d))}
                />
              </label>
              <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "4px 0 0" }}>
                扩展文件创建在全局扩展目录，并自动加入 settings.json。文档：
                <a href="https://pi.dev/docs/latest/extensions" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent)" }}>
                  pi.dev/docs/extensions
                </a>
              </p>
            </div>
            <footer className="mcp-editor-footer">
              <button type="button" onClick={() => setCreateDraft(null)} disabled={busy}>
                取消
              </button>
              <button className="primary" type="button" onClick={() => void handleCreate()} disabled={busy || !createDraft.name.trim()}>
                <FileCode size={17} />
                {busy ? "正在创建" : "创建扩展"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {/* 查看扩展源码 */}
      {viewing ? (
        <div
          className="mcp-editor-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewing(null);
          }}
        >
          <section className="mcp-editor-dialog" role="dialog" aria-modal="true">
            <header className="mcp-editor-header">
              <div>
                <span className="mcp-card-icon" aria-hidden="true">
                  <Code2 size={22} />
                </span>
                <div>
                  <span>扩展源码</span>
                  <h2>{viewing.name}</h2>
                </div>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setViewing(null)}>
                <X size={19} />
              </button>
            </header>
            <div className="mcp-editor-body">
              <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "0 0 8px" }}>{viewing.path}</p>
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  background: "var(--color-panel)",
                  borderRadius: 8,
                  maxHeight: "60vh",
                  overflow: "auto",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {viewContent}
              </pre>
            </div>
            <footer className="mcp-editor-footer">
              <button type="button" onClick={() => setViewing(null)}>
                关闭
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        title="移除扩展"
        message={`确认从 settings.json 移除扩展「${pendingDelete?.name ?? ""}」？磁盘上的 .ts 文件会保留，可随时重新添加。`}
        confirmLabel="移除"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
