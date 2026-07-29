import { Bot, CheckCircle2, CirclePlus, Pencil, Save, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import {
  cancelOAuthLogin,
  getDefaultModel,
  listAllModels,
  listProviders,
  loginOAuthProvider,
  removeProvider,
  setDefaultModel,
  testProviderConnection,
  upsertProvider,
  PI_API_TYPES,
} from "../services/modelsService";
import type { DefaultModelInfo, ModelSummary, ProviderSummary } from "../services/hostBridge";
import { toUserFacingError } from "../services/uiError";
import { showAppWarning } from "../services/appDialog";
import { ComputerAgentSettingsPanel } from "./ComputerAgentSettingsPanel";
import { TokenActivityCard } from "./TokenActivityCard";

type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  model: ModelDraft;
};

type ModelDraft = {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
};

type EditorState = { mode: "add" | "edit"; draft: ProviderDraft; apiKeyDirty: boolean };
type ProviderTextField = Exclude<keyof ProviderDraft, "model">;
type ProviderConnectionState = {
  state: "checking" | "available" | "error" | "unconfigured";
  message: string;
};

const EMPTY_DRAFT: ProviderDraft = {
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  model: {
    id: "",
    name: "",
    contextWindow: "128000",
    maxTokens: "4096",
    reasoning: false,
  },
};

const EMPTY_MODEL_DRAFT: ModelDraft = {
  id: "",
  name: "",
  contextWindow: "128000",
  maxTokens: "4096",
  reasoning: false,
};

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_MODEL_FALLBACK: ModelDraft = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  contextWindow: "272000",
  maxTokens: "128000",
  reasoning: true,
};

const providerSlug = (providerName: string, modelId: string) => {
  const normalize = (value: string) => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalize(providerName) || normalize(modelId) || "custom-provider";
};

const uniqueProviderId = (providerName: string, modelId: string, providers: ProviderSummary[]) => {
  const base = providerSlug(providerName, modelId);
  const existingIds = new Set(providers.map((provider) => provider.id));
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

/** 模型供应商数量上限。超出时需先删除现有供应商才能添加新的。 */
const MAX_PROVIDERS = 4;

function ModelSettingsPanel() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [defaultModel, setDefaultModelState] = useState<DefaultModelInfo | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [providerConnections, setProviderConnections] = useState<Record<string, ProviderConnectionState>>({});
  const [status, setStatus] = useState("正在读取模型配置...");
  const [codexModels, setCodexModels] = useState<ModelSummary[]>([]);
  const [oauthStatus, setOauthStatus] = useState<{ message: string; url?: string; userCode?: string } | null>(null);
  const connectionCheckRunRef = useRef(0);
  const activeOAuthLoginIdRef = useRef<string | null>(null);
  const oauthUrlInputRef = useRef<HTMLInputElement>(null);

  const verifyProviderConnections = (providerList: ProviderSummary[]) => {
    const runId = ++connectionCheckRunRef.current;
    const initial = Object.fromEntries(
      providerList.map((provider) => [
        provider.id,
        provider.authType === "oauth" || provider.hasApiKey
          ? { state: "checking", message: "正在验证模型连接..." }
          : { state: "unconfigured", message: "尚未配置 API Key。" },
      ]),
    ) as Record<string, ProviderConnectionState>;
    setProviderConnections(initial);

    for (const provider of providerList) {
      if (provider.authType !== "oauth" && !provider.hasApiKey) continue;
      const model = provider.models[0];
      if (!model) {
        initial[provider.id] = { state: "error", message: "尚未配置模型 ID。" };
        setProviderConnections({ ...initial });
        continue;
      }
      void testProviderConnection(provider.id, model.id)
        .then(() => {
          if (connectionCheckRunRef.current !== runId) return;
          setProviderConnections((current) => ({
            ...current,
            [provider.id]: { state: "available", message: "模型连接验证通过。" },
          }));
        })
        .catch((error) => {
          if (connectionCheckRunRef.current !== runId) return;
          setProviderConnections((current) => ({
            ...current,
            [provider.id]: {
              state: "error",
              message: toUserFacingError(error, "模型连接验证失败。"),
            },
          }));
        });
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const [providerList, def] = await Promise.all([
        listProviders(),
        getDefaultModel(),
      ]);
      setProviders(providerList);
      setDefaultModelState(def);
      setStatus(`已读取 ${providerList.length} 个供应商配置。`);
      verifyProviderConnections(providerList);
    } catch (error) {
      connectionCheckRunRef.current += 1;
      setProviderConnections({});
      setStatus(toUserFacingError(error, "模型服务暂不可用，请确认桌面服务已启动后重试。"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      connectionCheckRunRef.current += 1;
      const loginId = activeOAuthLoginIdRef.current;
      if (loginId) void cancelOAuthLogin(loginId);
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

  /** 打开「添加供应商」编辑器；超过上限时拦截并提示先删除现有供应商。 */
  const handleAddProvider = () => {
    if (providers.length >= MAX_PROVIDERS) {
      showAppWarning(`最多支持 ${MAX_PROVIDERS} 个供应商，请先删除现有供应商再添加。`);
      return;
    }
    setEditor({
      mode: "add",
      apiKeyDirty: false,
      draft: {
        ...EMPTY_DRAFT,
        model: { ...EMPTY_DRAFT.model },
      },
    });
    setOauthStatus(null);
  };

  const closeEditor = () => {
    const loginId = activeOAuthLoginIdRef.current;
    if (loginId) {
      activeOAuthLoginIdRef.current = null;
      void cancelOAuthLogin(loginId);
    }
    setEditor(null);
    setOauthStatus(null);
  };

  const updateEditor = (key: ProviderTextField, value: string) => {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, [key]: value } } : current,
    );
  };

  const handleApiTypeChange = (api: string) => {
    setOauthStatus(null);
    if (api !== OPENAI_CODEX_PROVIDER_ID) {
      setEditor((current) => {
        if (!current) return current;
        const wasOAuth = current.draft.api === OPENAI_CODEX_PROVIDER_ID;
        return {
          ...current,
          apiKeyDirty: wasOAuth ? false : current.apiKeyDirty,
          draft: {
            ...current.draft,
            api,
            name: wasOAuth ? "" : current.draft.name,
            baseUrl: wasOAuth ? "" : current.draft.baseUrl,
            apiKey: wasOAuth ? "" : current.draft.apiKey,
            model: wasOAuth ? { ...EMPTY_MODEL_DRAFT } : current.draft.model,
          },
        };
      });
      return;
    }

    const applyModels = (models: ModelSummary[]) => {
      const preferred = models.find((model) => model.id === "gpt-5.5") ?? models[0];
      setEditor((current) => {
        if (!current || current.draft.api !== OPENAI_CODEX_PROVIDER_ID) return current;
        return {
          ...current,
          apiKeyDirty: false,
          draft: {
            ...current.draft,
            id: OPENAI_CODEX_PROVIDER_ID,
            name: "OpenAI Codex",
            baseUrl: OPENAI_CODEX_BASE_URL,
            apiKey: "",
            model: preferred
              ? {
                  id: preferred.id,
                  name: preferred.name,
                  contextWindow: String(preferred.contextWindow),
                  maxTokens: String(preferred.maxTokens),
                  reasoning: preferred.reasoning,
                }
              : { ...OPENAI_CODEX_MODEL_FALLBACK },
          },
        };
      });
    };

    setEditor((current) => current ? {
      ...current,
      apiKeyDirty: false,
      draft: {
        ...current.draft,
        id: OPENAI_CODEX_PROVIDER_ID,
        name: "OpenAI Codex",
        baseUrl: OPENAI_CODEX_BASE_URL,
        api: OPENAI_CODEX_PROVIDER_ID,
        apiKey: "",
        model: { ...OPENAI_CODEX_MODEL_FALLBACK },
      },
    } : current);
    if (codexModels.length > 0) {
      applyModels(codexModels);
      return;
    }
    void listAllModels()
      .then((models) => {
        const filtered = models.filter((model) => model.provider === OPENAI_CODEX_PROVIDER_ID);
        setCodexModels(filtered);
        applyModels(filtered);
      })
      .catch(() => {
        // 内置目录读取失败时仍保留与当前 pi 版本匹配的预填模型。
      });
  };

  const beginApiKeyEdit = () => {
    setEditor((current) => {
      if (!current || current.mode !== "edit" || current.apiKeyDirty) return current;
      return {
        ...current,
        apiKeyDirty: true,
        draft: { ...current.draft, apiKey: "" },
      };
    });
  };

  const updateApiKey = (value: string) => {
    setEditor((current) =>
      current
        ? {
            ...current,
            apiKeyDirty: true,
            draft: { ...current.draft, apiKey: value },
          }
        : current,
    );
  };

  const updateEditorModel = (key: keyof ModelDraft, value: string | boolean) => {
    setEditor((current) =>
      current
        ? {
            ...current,
            draft: {
              ...current.draft,
              model: { ...current.draft.model, [key]: value },
            },
          }
        : current,
    );
  };

  const copyOAuthUrl = async () => {
    const url = oauthStatus?.url;
    if (!url) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setOauthStatus((current) => current ? {
        ...current,
        message: "授权地址已复制，请粘贴到浏览器并完成登录。",
      } : current);
    } catch {
      oauthUrlInputRef.current?.focus();
      oauthUrlInputRef.current?.select();
      setOauthStatus((current) => current ? {
        ...current,
        message: "请按 Ctrl+C 复制已选中的授权地址，再粘贴到浏览器。",
      } : current);
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    const isOAuth = editor.draft.api === OPENAI_CODEX_PROVIDER_ID;
    const providerName = editor.draft.name.trim();
    if (!providerName) {
      setStatus("请填写供应商名称。");
      return;
    }
    const baseUrl = editor.draft.baseUrl.trim();
    if (!baseUrl) {
      setStatus("请填写 Base URL。");
      return;
    }
    try {
      const parsedUrl = new URL(baseUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error();
    } catch {
      setStatus("Base URL 必须是有效的 http 或 https 地址。");
      return;
    }
    if (!isOAuth && editor.mode === "add" && !editor.draft.apiKey.trim()) {
      setStatus("请填写 API Key。");
      return;
    }
    const modelId = editor.draft.model.id.trim();
    if (!modelId) {
      setStatus("请填写模型 ID。");
      return;
    }
    const contextWindow = Number(editor.draft.model.contextWindow);
    const maxTokens = Number(editor.draft.model.maxTokens);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0 || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      setStatus("上下文长度和最大输出 Token 必须是大于 0 的整数。");
      return;
    }
    const id = editor.mode === "edit"
      ? editor.draft.id.trim()
      : uniqueProviderId(providerName, modelId, providers);
    setEditorBusy(true);
    setStatus(isOAuth ? "正在生成 ChatGPT 账号授权地址..." : "正在保存供应商配置...");
    try {
      if (isOAuth) {
        const alreadyAuthorized = providers.some((provider) => provider.id === OPENAI_CODEX_PROVIDER_ID);
        const resolvedDefault = await loginOAuthProvider(
          OPENAI_CODEX_PROVIDER_ID,
          modelId,
          {
            onStarted: (loginId) => {
              activeOAuthLoginIdRef.current = loginId;
              setOauthStatus({
                message: alreadyAuthorized
                  ? "正在更新 OpenAI Codex 模型配置。"
                  : "正在生成授权地址，请稍候。",
              });
            },
            onEvent: (event) => {
              setOauthStatus((current) => ({
                message: event.message ?? "正在等待账号授权...",
                url: event.url ?? current?.url,
                userCode: event.userCode ?? current?.userCode,
              }));
            },
          },
        );
        activeOAuthLoginIdRef.current = null;
        setDefaultModelState(resolvedDefault);
        setEditor(null);
        setOauthStatus(null);
        setStatus("OpenAI Codex 已通过 ChatGPT 账号授权并添加。");
        await refresh();
        return;
      }
      const autoDefault = await upsertProvider({
        id,
        name: providerName,
        baseUrl,
        api: editor.draft.api,
        apiKey:
          editor.mode === "edit" && !editor.apiKeyDirty
            ? undefined
            : editor.draft.apiKey.trim() || undefined,
        models: [{
          id: modelId,
          name: editor.draft.model.name.trim() || undefined,
          contextWindow,
          maxTokens,
          reasoning: editor.draft.model.reasoning,
        }],
      });
      if (autoDefault) {
        setDefaultModelState(autoDefault);
      } else if (defaultModel?.provider === id) {
        await setDefaultModel(id, modelId);
        setDefaultModelState({ provider: id, model: modelId });
      }
      setEditor(null);
      setStatus(`已保存供应商 ${id} 配置。`);
      await refresh();
    } catch (error) {
      setStatus(toUserFacingError(error, "供应商配置保存失败，请稍后重试。"));
    } finally {
      activeOAuthLoginIdRef.current = null;
      setEditorBusy(false);
    }
  };

  const handleSetDefault = async (model: ModelSummary) => {
    setBusy(true);
    setStatus(`正在设置默认模型：${model.provider.toUpperCase()}/${model.id.toUpperCase()}...`);
    try {
      await setDefaultModel(model.provider, model.id);
      setDefaultModelState({ provider: model.provider, model: model.id });
      setStatus(`已设为默认模型：${model.name.toUpperCase()}`);
    } catch (error) {
      setStatus(toUserFacingError(error, "默认模型设置失败，请检查配置后重试。"));
    } finally {
      setBusy(false);
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
      setStatus(toUserFacingError(error, "供应商删除失败，请稍后重试。"));
    } finally {
      setBusyProviderId(null);
    }
  };

  return (
    <section className="settings-section" aria-label="模型配置">
      <header className="settings-section-header">
        <div>
          <h2>模型配置</h2>
          {status ? <p className="mcp-status-line" title={status}>{status}</p> : null}
        </div>
        <div className="settings-actions">
          <button
            type="button"
            onClick={handleAddProvider}
            disabled={busy || editorBusy}
          >
            <CirclePlus size={17} />
            添加供应商
          </button>
        </div>
      </header>

      <div className={`mcp-card-grid ${providers.length === 0 ? "is-empty" : ""}`}>
        {providers.map((provider) => {
          const isBusy = busyProviderId === provider.id;
          const currentProviderModel = provider.models.find(
            (model) => model.id === defaultModel?.model && model.provider === defaultModel?.provider,
          );
          const configuredModel = currentProviderModel ?? provider.models[0];
          const isDefaultProvider = Boolean(currentProviderModel);
          const connection = providerConnections[provider.id] ?? (
            provider.authType === "oauth" || provider.hasApiKey
              ? { state: "checking", message: "正在验证模型连接..." }
              : { state: "unconfigured", message: "尚未配置 API Key。" }
          );
          const isAvailable = connection.state === "available";
          const connectionBadge = {
            checking: { className: "checking", label: "检测中" },
            available: { className: "connected", label: "可用" },
            error: { className: "error", label: "不可用" },
            unconfigured: { className: "pending", label: "待配置" },
          }[connection.state];
          return (
            <article
              className={`mcp-service-card pi-provider-card ${isAvailable ? "" : "is-disabled"} ${
                isDefaultProvider ? "is-default" : ""
              }`}
              key={provider.id}
              aria-label={`${provider.name}，${connectionBadge.label}`}
            >
              <div className="pi-provider-card-header">
                <span className="mcp-card-icon" aria-hidden="true">
                  <Bot size={24} />
                </span>
                <h2>{provider.name}</h2>
                <span className="pi-provider-badges">
                  {isDefaultProvider ? (
                    <span className="mcp-connection-badge is-default">使用中</span>
                  ) : null}
                  <span
                    className={`mcp-connection-badge is-${connectionBadge.className}`}
                    title={connection.message}
                  >
                    {connectionBadge.label}
                  </span>
                </span>
              </div>

              {/* 每个供应商只展示一个模型，点击模型切换当前供应商。 */}
              {configuredModel ? (
                <button
                  type="button"
                  className={`pi-provider-model ${isDefaultProvider ? "is-active" : ""}`}
                  disabled={busy || !isAvailable}
                  title={isAvailable ? `切换到 ${configuredModel.name}` : connection.message}
                  onClick={() => void handleSetDefault(configuredModel)}
                >
                  <span className="pi-model-name">{configuredModel.name}</span>
                  {isDefaultProvider ? <CheckCircle2 size={15} aria-label="当前模型" /> : null}
                </button>
              ) : (
                <div className="pi-model-empty">尚未配置模型，请点击“编辑”添加。</div>
              )}

              <footer className="mcp-card-footer">
                <div className="mcp-card-actions">
                  <button
                    type="button"
                    className="mcp-edit-button"
                    disabled={busy || isBusy}
                    onClick={() => {
                      setOauthStatus(null);
                      if (provider.authType === "oauth") setCodexModels(provider.models);
                      setEditor({
                        mode: "edit",
                        apiKeyDirty: false,
                        draft: {
                          id: provider.id,
                          name: provider.name,
                          baseUrl: provider.baseUrl,
                          api: provider.api,
                          apiKey: provider.apiKeyHint,
                          model: configuredModel
                            ? {
                                id: configuredModel.id,
                                name: configuredModel.name,
                                contextWindow: String(configuredModel.contextWindow),
                                maxTokens: String(configuredModel.maxTokens),
                                reasoning: configuredModel.reasoning,
                              }
                            : { ...EMPTY_MODEL_DRAFT },
                        },
                      });
                    }}
                  >
                    <Pencil size={16} />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="mcp-delete-button"
                    disabled={busy || isBusy}
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
        {providers.length === 0 ? (
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
            if (event.target === event.currentTarget && !editorBusy) closeEditor();
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
                  <h2>{editor.mode === "add" ? "添加模型供应商" : editor.draft.name || "供应商配置"}</h2>
                </div>
              </div>
              <button type="button" aria-label="关闭" onClick={closeEditor}>
                <X size={19} />
              </button>
            </header>

            <div className="mcp-editor-body">
              <label>
                <span>供应商名称 <b>*</b></span>
                <input
                  value={editor.draft.name}
                  placeholder="例如：DeepSeek"
                  readOnly={editor.draft.api === OPENAI_CODEX_PROVIDER_ID}
                  onChange={(event) => updateEditor("name", event.target.value)}
                />
              </label>
              <label>
                <span>API 类型 <b>*</b></span>
                <select
                  value={editor.draft.api}
                  disabled={editor.mode === "edit" && editor.draft.api === OPENAI_CODEX_PROVIDER_ID}
                  onChange={(event) => handleApiTypeChange(event.target.value)}
                >
                  {PI_API_TYPES.map((item) => (
                    <option
                      key={item.value}
                      value={item.value}
                      disabled={editor.mode === "edit" && item.value === OPENAI_CODEX_PROVIDER_ID}
                    >
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Base URL <b>*</b></span>
                <input
                  value={editor.draft.baseUrl}
                  placeholder="https://api.deepseek.com"
                  readOnly={editor.draft.api === OPENAI_CODEX_PROVIDER_ID}
                  onChange={(event) => updateEditor("baseUrl", event.target.value)}
                />
              </label>
              {editor.draft.api !== OPENAI_CODEX_PROVIDER_ID ? <label>
                <span>API Key <b>{editor.mode === "add" ? "*" : ""}</b>{editor.mode === "edit" ? "（留空保留原值）" : ""}</span>
                <input
                  type={editor.mode === "edit" && !editor.apiKeyDirty ? "text" : "password"}
                  value={editor.draft.apiKey}
                  placeholder={editor.mode === "edit" ? "点击输入新的 API Key" : "sk-..."}
                  onFocus={beginApiKeyEdit}
                  onChange={(event) => updateApiKey(event.target.value)}
                />
              </label> : (
                <div className="pi-oauth-note" role="status">
                  <strong>ChatGPT 账号授权</strong>
                  <span>{oauthStatus?.message ?? "保存配置后会显示授权地址，无需填写 API Key。"}</span>
                  {oauthStatus?.userCode ? <code>{oauthStatus.userCode}</code> : null}
                  {oauthStatus?.url ? (
                    <div className="pi-oauth-url-row">
                      <input
                        ref={oauthUrlInputRef}
                        className="pi-oauth-url"
                        value={oauthStatus.url}
                        readOnly
                        aria-label="OpenAI 授权地址"
                        onFocus={(event) => event.currentTarget.select()}
                        onClick={(event) => event.currentTarget.select()}
                      />
                      <button
                        type="button"
                        onClick={() => void copyOAuthUrl()}
                      >
                        复制授权地址
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
              <section className="pi-model-editor" aria-label="模型配置">
                <header>
                  <div>
                    <strong>模型 <b>*</b></strong>
                    <span>{editor.draft.api === OPENAI_CODEX_PROVIDER_ID
                      ? "模型来自 OpenAI Codex 内置目录，保存时一并完成账号授权。"
                      : "每个供应商配置一个模型，需要更换时直接修改模型 ID。"}</span>
                  </div>
                </header>
                <article className="pi-model-editor-item">
                  <label>
                    <span>模型 ID <b>*</b></span>
                    {editor.draft.api === OPENAI_CODEX_PROVIDER_ID && codexModels.length > 0 ? (
                      <select
                        value={editor.draft.model.id}
                        onChange={(event) => {
                          const selected = codexModels.find((model) => model.id === event.target.value);
                          if (!selected) return;
                          setEditor((current) => current ? {
                            ...current,
                            draft: {
                              ...current.draft,
                              model: {
                                id: selected.id,
                                name: selected.name,
                                contextWindow: String(selected.contextWindow),
                                maxTokens: String(selected.maxTokens),
                                reasoning: selected.reasoning,
                              },
                            },
                          } : current);
                        }}
                      >
                        {codexModels.map((model) => (
                          <option key={model.id} value={model.id}>{model.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={editor.draft.model.id}
                        placeholder="例如：deepseek-chat"
                        readOnly={editor.draft.api === OPENAI_CODEX_PROVIDER_ID}
                        onChange={(event) => updateEditorModel("id", event.target.value)}
                      />
                    )}
                  </label>
                  {editor.draft.api !== OPENAI_CODEX_PROVIDER_ID ? <details className="pi-model-advanced">
                    <summary>高级参数</summary>
                    <div className="pi-model-advanced-fields">
                      <label className="pi-model-field-full">
                        <span>模型显示名称（可选）</span>
                        <input
                          value={editor.draft.model.name}
                          placeholder="默认使用模型 ID"
                          onChange={(event) => updateEditorModel("name", event.target.value)}
                        />
                      </label>
                      <label>
                        <span>上下文长度</span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={editor.draft.model.contextWindow}
                          onChange={(event) => updateEditorModel("contextWindow", event.target.value)}
                        />
                      </label>
                      <label>
                        <span>最大输出 Token</span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={editor.draft.model.maxTokens}
                          onChange={(event) => updateEditorModel("maxTokens", event.target.value)}
                        />
                      </label>
                      <label className="settings-toggle pi-model-reasoning">
                        <input
                          type="checkbox"
                          checked={editor.draft.model.reasoning}
                          onChange={(event) => updateEditorModel("reasoning", event.target.checked)}
                        />
                        <span>推理模型</span>
                      </label>
                    </div>
                  </details> : null}
                </article>
              </section>
            </div>

            <footer className="mcp-editor-footer">
              <button type="button" onClick={closeEditor}>
                取消
              </button>
              <button className="primary" type="button" onClick={() => void saveEditor()} disabled={editorBusy}>
                <Save size={17} />
                {editorBusy
                  ? editor.draft.api === OPENAI_CODEX_PROVIDER_ID ? "正在授权" : "正在保存"
                  : "保存配置"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        title="删除供应商"
        message={pendingDelete?.authType === "oauth"
          ? `确认删除供应商「${pendingDelete.name}」？该操作会清除本机保存的 ChatGPT 账号授权。`
          : `确认删除供应商「${pendingDelete?.name ?? ""}」？该操作会移除该供应商及其全部模型配置，不可恢复。`}
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

export function SettingsPanel() {
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    let active = true;

    void getVersion()
      .then((version) => {
        if (active) setAppVersion(version);
      })
      .catch(() => {
        // Browser previews do not expose the Tauri app API. Keep the badge hidden there.
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="settings-page mcp-square-page pi-settings-page" aria-label="系统设置">
      <header className="settings-header">
        <div>
          <span>系统设置</span>
          <h1>系统设置</h1>
          <p className="mcp-status-line">配置模型供应商与内置智能员工</p>
        </div>
        {appVersion ? (
          <p className="settings-app-version" aria-label={`当前版本 ${appVersion}`}>
            Nova v{appVersion}
          </p>
        ) : null}
      </header>
      <ModelSettingsPanel />
      <ComputerAgentSettingsPanel />
      <TokenActivityCard />
    </section>
  );
}
