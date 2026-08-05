import { ScanText, Save } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getOcrSettings,
  saveOcrSettings,
  testOcrConnection,
} from "../services/ocrSettings";
import { toUserFacingError } from "../services/uiError";

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
            ? ""
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
          ? ""
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
      ? "已保存，点击此处修改"
      : "粘贴智谱 API Key（如 xxxxxx.xxxxxx）";

  return (
    <section className="settings-section ocr-settings" aria-label="文档解析设置">
      <header className="settings-section-header">
        <h2>GLM-OCR 配置</h2>
        <span className={`ocr-settings-state ${hasKey ? "is-enabled" : ""}`}>
          {hasKey ? "已启用" : "未配置"}
        </span>
      </header>

      <div className="ocr-settings-body">
        <div className="ocr-settings-input">
          <ScanText size={16} className="ocr-settings-input-icon" />
          <input
            type={dirty ? "password" : "text"}
            value={dirty ? draft : ""}
            placeholder={placeholder}
            onFocus={beginEdit}
            onChange={(event) => { setDirty(true); setDraft(event.target.value); }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button
          type="button"
          className="ocr-settings-test"
          disabled={!hasKey || testing || saving}
          onClick={() => void test()}
        >
          {testing ? "测试中..." : "测试连接"}
        </button>
        <button
          type="button"
          className="primary ocr-settings-save"
          disabled={saving || testing}
          onClick={() => void save()}
        >
          <Save size={15} />
          {saving ? "保存中..." : "保存"}
        </button>
      </div>

      {status && <p className="ocr-settings-status" title={status}>{status}</p>}
    </section>
  );
}
