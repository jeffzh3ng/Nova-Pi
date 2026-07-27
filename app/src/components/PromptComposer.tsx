import { useRef } from "react";
import { ArrowUp, Cpu, Paperclip, Square } from "lucide-react";

type PromptComposerProps = {
  value: string;
  introduction?: string;
  modelName: string;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  modelStatus: "ok" | "error" | "idle";
  modelError?: string;
  onChange: (value: string) => void;
  onAttachFiles: (files: File[]) => void;
  onPickAttachment?: () => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function PromptComposer({
  value,
  introduction,
  modelName,
  busy,
  disabled = false,
  disabledReason,
  modelStatus,
  modelError,
  onChange,
  onAttachFiles,
  onPickAttachment,
  onSubmit,
  onCancel,
}: PromptComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canSubmit = value.trim().length > 0 && !busy && !disabled;

  return (
    <form
      className="prompt-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      {!value && introduction?.trim() ? (
        <p className="composer-introduction" aria-hidden="true">
          {introduction.trim()}
        </p>
      ) : null}
      <textarea
        rows={3}
        value={value}
        placeholder={
          introduction?.trim()
            ? ""
            : disabled
            ? "可先输入任务目标，选择可用数字员工后发送..."
            : "请输入任务目标，或上传待处理文件..."
        }
        title={disabled ? disabledReason : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }
        }}
      />
      <div className="composer-footer">
        <div
          className={`model-chip ${modelStatus}`}
          aria-label={`模型状态: ${modelStatus}`}
          title={modelStatus === "error" ? modelError : undefined}
        >
          <Cpu size={15} />
          <span>{(modelName || "未配置模型").toUpperCase()}</span>
        </div>
        <div className="composer-actions">
          <button
            type="button"
            aria-label="添加附件"
            onClick={() => (onPickAttachment ? onPickAttachment() : fileInputRef.current?.click())}
            disabled={busy || disabled}
            title={disabled ? disabledReason : undefined}
          >
            <Paperclip size={17} />
          </button>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            disabled={disabled}
            accept=".txt,.log,.md,.csv,.tsv,.json,.xml,.yaml,.yml,.pcap,.pcapng,.cap,.png,.jpg,.jpeg,.bmp,.webp,.tif,.tiff,.zip"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.currentTarget.value = "";
              if (files.length) onAttachFiles(files);
            }}
          />
          {busy ? (
            <button
              className="stop-button"
              type="button"
              aria-label="中止任务"
              onClick={onCancel}
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              disabled={!canSubmit}
              aria-label="发送任务"
              title={disabled ? disabledReason : undefined}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
