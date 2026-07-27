import { Bot, CirclePlus, Cpu, Pencil, Save, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import {
  getDefaultModel,
  listAllModels,
  listProviders,
  removeProvider,
  setDefaultModel,
  setProviderApiKey,
  upsertProvider,
  PI_API_TYPES,
} from "../services/modelsService";
import type { DefaultModelInfo, ModelSummary, ProviderSummary } from "../services/hostBridge";

type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
};

type EditorState = { mode: "add" | "edit"; draft: ProviderDraft };

const EMPTY_DRAFT: ProviderDraft = {
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
};

const apiLabel = (api: string) =>
  PI_API_TYPES.find((item) => item.value === api)?.label ?? api;

export function SettingsPanel() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [allModels, setAllModels] = useState<ModelSummary[]>([]);
  const [defaultModel, setDefaultModelState] = useState<DefaultModelInfo | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderSummary | null>(null);
  const [searchText, setSearchText] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [status, setStatus] = useState("正在读取模型配置...");

  const refresh = async () => {
    setBusy(true);
    try {
      const [providerList, models, def] = await Promise.all([
        listProviders(),
        listAllModels(),
        getDefaultModel(),
      ]);
      setProviders(providerList);
      setAllModels(models);
      setDefaultModelState(def);
      setStatus(`已读取 ${providerList.length} 个供应商配置。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!editor) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editorBusy) setEditor(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editor, editorBusy]);

  const updateEditor = (key: keyof ProviderDraft, value: string) => {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, [key]: value } } : current,
    );
  };

  const saveEditor = async () => {
    if (!editor) return;
    const id = editor.draft.id.trim();
    if (!id) {
      setStatus("请填写供应商 ID。");
      return;
    }
    if (editor.mode === "add" && providers.some((p) => p.id === id)) {
      setStatus(`供应商 ID ${id} 已存在。`);
      return;
    }
    setEditorBusy(true);
    setStatus("正在保存供应商配置...");
    try {
      await upsertProvider({
        id,
        name: editor.draft.name.trim() || id,
        baseUrl: editor.draft.baseUrl.trim(),
        api: editor.draft.api,
        apiKey: editor.draft.apiKey.trim() || undefined,
      });
      setEditor(null);
      setStatus(`已保存供应商 ${id} 配置。`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorBusy(false);
    }
  };

  const handleSetDefault = async (model: ModelSummary) => {
    setBusy(true);
    setStatus(`正在设置默认模型：${model.provider}/${model.id}...`);
    try {
      await setDefaultModel(model.provider, model.id);
      setDefaultModelState({ provider: model.provider, model: model.id });
      setStatus(`已设为默认模型：${model.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveApiKey = async (providerId: string) => {
    const key = (apiKeyDraft[providerId] ?? "").trim();
    if (!key) {
      setStatus("API Key 不能为空。");
      return;
    }
    setBusyProviderId(providerId);
    setStatus(`正在更新 ${providerId} 的 API Key...`);
    try {
      await setProviderApiKey(providerId, key);
      setApiKeyDraft((draft) => {
        const next = { ...draft };
        delete next[providerId];
        return next;
      });
      setStatus(`已更新 ${providerId} 的 API Key。`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyProviderId(null);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    setBusyProviderId(target.id);
    setStatus(`正在删除供应商 ${target.name}...`);
    try {
      await removeProvider(target.id);
      setStatus(`已删除供应商 ${target.name}。`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyProviderId(null);
    }
  };

  const visibleProviders = useMemo(() => {
    const query = searchText.trim().toLocaleLowerCase();
    if (!query) return providers;
    return providers.filter((p) =>
      `${p.id} ${p.name} ${p.baseUrl} ${p.api}`.toLocaleLowerCase().includes(query),
    );
  }, [providers, searchText]);

  // 默认模型下拉选项：全部可用模型（pi 内置 + 自定义）
  const defaultModelOptions = useMemo(() => {
    const seen = new Set<string>();
    return allModels.filter((m) => {
      const key = `${m.provider}/${m.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [allModels]);

  return (
    <section className="settings-page mcp-square-page" aria-label="模型配置">
      <header className="settings-header">
        <div>
          <span>系统设置</span>
          <h1>模型配置</h1>
          {status ? <p className="mcp-status-line">{status}</p> : null}
        </div>
        <div className="settings-actions">
          <button
            type="button"
            onClick={() => setEditor({ mode: "add", draft: { ...EMPTY_DRAFT } })}
            disabled={busy || editorBusy}
          >
            <CirclePlus size={17} />
            添加供应商
          </button>
        </div>
      </header>

      {/* 默认模型选择 */}
      <section className="settings-card settings-card-wide" style={{ margin: "0 24px 16px" }}>
        <div className="settings-card-title">
          <Cpu size={20} />
          <div>
            <h2>默认模型</h2>
            <p>对话时使用的默认模型。pi 会按此配置选择模型（可在会话中临时切换）。</p>
          </div>
        </div>
        <div className="settings-form-grid">
          <label className="settings-form-full">
            <span>当前默认</span>
            <select
              value={defaultModel ? `${defaultModel.provider}/${defaultModel.model}` : ""}
              onChange={(event) => {
                const value = event.target.value;
                const [provider, ...modelParts] = value.split("/");
                const model = modelParts.join("/");
                const found = allModels.find((m) => m.provider === provider && m.id === model);
                if (found) void handleSetDefault(found);
              }}
              disabled={busy || defaultModelOptions.length === 0}
            >
              <option value="">{defaultModelOptions.length ? "未选择" : "无可用模型"}</option>
              {defaultModelOptions.map((m) => (
                <option
                  key={`${m.provider}/${m.id}`}
                  value={`${m.provider}/${m.id}`}
                  disabled={!m.available}
                >
                  {m.provider}/{m.id}{m.available ? "" : "（缺 API Key）"}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <div className="mcp-catalog-toolbar">
        <label className="mcp-search-box">
          <Search size={17} />
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索供应商"
            aria-label="搜索供应商"
          />
        </label>
      </div>

      <div className="mcp-card-grid">
        {visibleProviders.map((provider) => {
          const isBusy = busyProviderId === provider.id;
          return (
            <article
              className={`mcp-service-card ${provider.available ? "" : "is-disabled"}`}
              key={provider.id}
            >
              <div className="mcp-card-top">
                <span className="mcp-card-icon" aria-hidden="true">
                  <Bot size={24} />
                </span>
                <span
                  className={`mcp-connection-badge is-${provider.available ? "connected" : "pending"}`}
                  title={provider.available ? "已配置 API Key，可用" : "缺少 API Key"}
                >
                  {provider.available ? "可用" : "待配置"}
                </span>
              </div>
              <div className="mcp-card-copy">
                <h2>{provider.name}</h2>
                <p>{apiLabel(provider.api)} · {provider.modelCount} 个模型</p>
              </div>
              <dl className="mcp-card-meta">
                <div>
                  <dt>供应商 ID</dt>
                  <dd title={provider.id}>{provider.id}</dd>
                </div>
                <div>
                  <dt>Base URL</dt>
                  <dd title={provider.baseUrl}>{provider.baseUrl || "未配置"}</dd>
                </div>
                <div>
                  <dt>API Key</dt>
                  <dd>{provider.hasApiKey ? provider.apiKeyHint : "未配置"}</dd>
                </div>
              </dl>

              {/* API Key 快速更新 */}
              <div className="mcp-card-endpoint" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <input
                  type="password"
                  placeholder={provider.hasApiKey ? `当前：${provider.apiKeyHint}（输入新值替换）` : "输入 API Key"}
                  value={apiKeyDraft[provider.id] ?? ""}
                  onChange={(event) =>
                    setApiKeyDraft((draft) => ({ ...draft, [provider.id]: event.target.value }))
                  }
                  disabled={isBusy}
                />
                <button
                  type="button"
                  className="mcp-edit-button"
                  style={{ alignSelf: "flex-end" }}
                  disabled={isBusy || !(apiKeyDraft[provider.id] ?? "").trim()}
                  onClick={() => void handleSaveApiKey(provider.id)}
                >
                  <Save size={14} /> 保存 Key
                </button>
              </div>

              {/* 模型列表 */}
              {provider.models.length > 0 ? (
                <details className="alert-raw-output" style={{ marginTop: 8 }}>
                  <summary>模型（{provider.models.length}）</summary>
                  <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
                    {provider.models.map((model) => (
                      <li
                        key={model.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "4px 0",
                          fontSize: 13,
                          color: "var(--color-text)",
                        }}
                      >
                        <span>{model.name}</span>
                        <span style={{ color: "var(--color-muted)" }}>
                          {model.reasoning ? "推理 · " : ""}
                          {Math.round(model.contextWindow / 1000)}K
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <footer className="mcp-card-footer">
                <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                  {isBusy ? "处理中..." : `来源：models.json`}
                </span>
                <div className="mcp-card-actions">
                  <button
                    type="button"
                    className="mcp-edit-button"
                    disabled={busy}
                    onClick={() =>
                      setEditor({
                        mode: "edit",
                        draft: {
                          id: provider.id,
                          name: provider.name,
                          baseUrl: provider.baseUrl,
                          api: provider.api,
                          apiKey: "",
                        },
                      })
                    }
                  >
                    <Pencil size={16} />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="mcp-delete-button"
                    disabled={busy}
                    onClick={() => setPendingDelete(provider)}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
        {visibleProviders.length === 0 ? (
          <div className="mcp-empty-result">
            <Search size={24} />
            <strong>没有供应商配置</strong>
            <span>点击「添加供应商」配置第一个模型供应商。</span>
          </div>
        ) : null}
      </div>

      {/* 编辑/新增供应商对话框 */}
      {editor ? (
        <div
          className="mcp-editor-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !editorBusy) setEditor(null);
          }}
        >
          <section className="mcp-editor-dialog" role="dialog" aria-modal="true">
            <header className="mcp-editor-header">
              <div>
                <span className="mcp-card-icon" aria-hidden="true">
                  <ShieldCheck size={22} />
                </span>
                <div>
                  <span>{editor.mode === "add" ? "新增供应商" : "编辑供应商"}</span>
                  <h2>{editor.mode === "add" ? "添加模型供应商" : editor.draft.id}</h2>
                </div>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setEditor(null)} disabled={editorBusy}>
                <X size={19} />
              </button>
            </header>

            <div className="mcp-editor-body">
              <label>
                <span>供应商 ID（唯一标识，如 my-deepseek）</span>
                <input
                  value={editor.draft.id}
                  disabled={editor.mode === "edit"}
                  placeholder="my-provider"
                  onChange={(event) => updateEditor("id", event.target.value)}
                />
              </label>
              <label>
                <span>显示名称</span>
                <input
                  value={editor.draft.name}
                  placeholder="我的 DeepSeek"
                  onChange={(event) => updateEditor("name", event.target.value)}
                />
              </label>
              <label>
                <span>API 类型</span>
                <select value={editor.draft.api} onChange={(event) => updateEditor("api", event.target.value)}>
                  {PI_API_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Base URL</span>
                <input
                  value={editor.draft.baseUrl}
                  placeholder="https://api.deepseek.com"
                  onChange={(event) => updateEditor("baseUrl", event.target.value)}
                />
              </label>
              <label>
                <span>API Key{editor.mode === "edit" ? "（留空保留原值）" : ""}</span>
                <input
                  type="password"
                  value={editor.draft.apiKey}
                  placeholder="sk-..."
                  onChange={(event) => updateEditor("apiKey", event.target.value)}
                />
              </label>
              <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "4px 0 0" }}>
                模型列表可在保存后通过编辑 models.json 扩展，或在会话中由 pi 按需发现。
                配置写入 <code>~/.pi/agent/models.json</code>，pi 每次 /model 自动重载。
              </p>
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
        title="删除供应商"
        message={`确认删除供应商「${pendingDelete?.name ?? ""}」？该操作会从 models.json 移除该供应商及其全部模型，不可恢复。`}
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
