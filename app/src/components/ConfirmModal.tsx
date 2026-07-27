import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

export type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string;
  mode?: "confirm" | "input";
  inputLabel?: string;
  inputDefault?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: (value?: string) => void;
  onCancel: () => void;
};

export function ConfirmModal({
  open,
  title,
  message,
  mode = "confirm",
  inputLabel,
  inputDefault = "",
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [inputValue, setInputValue] = useState(inputDefault);
  const inputRef = useRef<HTMLInputElement>(null);
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);
  const inputValueRef = useRef(inputValue);

  onConfirmRef.current = onConfirm;
  onCancelRef.current = onCancel;
  inputValueRef.current = inputValue;

  useEffect(() => {
    if (open) {
      setInputValue(inputDefault);
      if (mode === "input") {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
  }, [open, inputDefault, mode]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancelRef.current();
      if (event.key === "Enter" && mode === "confirm") onConfirmRef.current();
      if (event.key === "Enter" && mode === "input" && inputValueRef.current.trim()) {
        onConfirmRef.current(inputValueRef.current.trim());
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, mode]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-icon-wrap">
            <AlertTriangle size={18} />
          </div>
          <h2>{title}</h2>
        </div>
        <p>{message}</p>

        {mode === "input" ? (
          <label className="modal-input-row">
            {inputLabel ? <span>{inputLabel}</span> : null}
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder={inputLabel}
            />
          </label>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="modal-btn cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`modal-btn ${danger ? "danger" : "primary"}`}
            disabled={mode === "input" && !inputValue.trim()}
            onClick={() => onConfirm(mode === "input" ? inputValue.trim() : undefined)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
