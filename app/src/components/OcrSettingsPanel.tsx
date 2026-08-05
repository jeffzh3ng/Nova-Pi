import { ScanText, Save, KeyRound, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getOcrSettings,
  saveOcrSettings,
  testOcrConnection,
} from "../services/ocrSettings";
import { toUserFacingError } from "../services/uiError";

const GLM_OCR_DOC_URL = "https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%A1%A3%E8%A7%A3%E6%9E%90";

/**
 * 智谱 GLM-OCR 文档解析配置面板。
 *
 * 仅一个 API Key 字段：配置后，document 工具对图片/扫描件自动走内置 OCR；
 * 未配置时自动降级到 vision（当前模型支持图像输入时）。
 */
export function OcrSettingsPanel() {
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("正在读取文档解析设置...");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getOcrSettings()
      .then((result) => {
        if (!alive) return;
        setStoredKey(result.settings.apiKey);
        setDraft("");
        setDirty(false);
        setStatus(
          result.settings.apiKey
            ? `已配置 API Key（${maskKey(result.settings.apiKey)}）。图片/扫描件会自动走内置 OCR。`
            : "尚未配置。图片/扫描件将直接降级到视觉读取（需当前模型支持图像输入）。",
        );
      })
      .catch((error) => {
        if (alive) setStatus(toUserFacingError(error, "文档解析设置读取失败。"));
      });
    return () => {
      alive = false;
    };
  }, []);

  const beginEdit = () => {
    if (!dirty) {
      setDirty(true);
      setDraft("");
    }
  };

  const save = async () => {
    setSaving(true);
    setStatus("正在保存...");
    try {
      // 编辑模式下未改动则保留原值（传 null 表示清空）。
      const nextKey = dirty ? draft : storedKey;
      const saved = await saveOcrSettings(nextKey);
      setStoredKey(saved.settings.apiKey);
      setDraft("");
      setDirty(false);
      setStatus(
        saved.settings.apiKey
          ? `已保存 API Key（${maskKey(saved.settings.apiKey)}）。新 key 立即对正在进行的会话生效。`
          : "已清空 API Key。图片/扫描件将降级到视觉读取。",
      );
    } catch (error) {
      setStatus(toUserFacingError(error, "保存失败。"));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setStatus("正在测试连接...");
    try {
      const message = await testOcrConnection();
      setStatus(message);
    } catch (error) {
      setStatus(toUserFacingError(error, "连接测试失败。"));
    } finally {
      setTesting(false);
    }
  };

  const hasKey = Boolean(storedKey);
  const placeholder = dirty
    ? "输入新的 API Key"
    : hasKey
      ? `已保存（${maskKey(storedKey ?? "")}），点击此处修改`
      : "粘贴智谱 API Key（如 xxxxxx.xxxxxx）";

  return (
    <section className="settings-section ocr-settings" aria-label="文档解析设置">
      <header className="settings-section-header computer-agent-header">
        <div>
          <h2>文档解析（智谱 GLM-OCR）</h2>
          <p className="mcp-status-line" title={status}>{status}</p>
        </div>
        <span className={`computer-agent-state ${hasKey ? "is-enabled" : ""}`}>
          {hasKey ? <KeyRound size={15} /> : <ScanText size={15} />}
          {hasKey ? "已启用内置 OCR" : "未配置"}
        </span>
      </header>

      <section className="computer-agent-config-card">
        <div className="computer-agent-card-title">
          <div className="computer-agent-card-title-copy">
            <span className="mcp-card-icon"><ScanText size={22} /></span>
            <div>
              <h2>智谱 GLM-OCR API Key</h2>
              <p>
                用于图片和扫描件的内置文字识别。未配置时自动降级到视觉读取。
                <a
                  href={GLM_OCR_DOC_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="ocr-doc-link"
                >
                  查看接口文档 <ExternalLink size={12} />
                </a>
              </p>
            </div>
          </div>
        </div>

        <div className="computer-agent-fields">
          <label>
            <span>API Key</span>
            <input
              type={dirty ? "password" : "text"}
              value={dirty ? draft : ""}
              placeholder={placeholder}
              onFocus={beginEdit}
              onChange={(event) => { setDirty(true); setDraft(event.target.value); }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <div className="mcp-editor-footer">
          <button
            type="button"
            disabled={!hasKey || testing || saving}
            onClick={() => void test()}
          >
            {testing ? "测试中..." : "测试连接"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || testing}
            onClick={() => void save()}
          >
            <Save size={16} />
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </section>
    </section>
  );
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}
