import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import { APP_DIALOG_EVENT, type AppDialogRequest } from "../services/appDialog";

const isDialogRequest = (value: unknown): value is AppDialogRequest => {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<AppDialogRequest>;
  return Boolean(request.title && request.message && (request.tone === "error" || request.tone === "warning"));
};

export function AppAlertDialog() {
  const [dialog, setDialog] = useState<AppDialogRequest | null>(null);
  const queueRef = useRef<AppDialogRequest[]>([]);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  const closeDialog = useCallback(() => {
    setDialog(queueRef.current.shift() ?? null);
  }, []);

  useEffect(() => {
    const handleDialog = (event: Event) => {
      const request = (event as CustomEvent<unknown>).detail;
      if (!isDialogRequest(request)) return;

      setDialog((current) => {
        if (current) {
          queueRef.current.push(request);
          return current;
        }
        return request;
      });
    };

    window.addEventListener(APP_DIALOG_EVENT, handleDialog);
    return () => window.removeEventListener(APP_DIALOG_EVENT, handleDialog);
  }, []);

  useEffect(() => {
    if (!dialog) return;
    requestAnimationFrame(() => confirmButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        closeDialog();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDialog, dialog]);

  if (!dialog) return null;

  const Icon = dialog.tone === "error" ? CircleAlert : TriangleAlert;

  return (
    <div className="modal-overlay app-alert-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeDialog();
    }}>
      <section
        className={`modal-dialog app-alert-dialog is-${dialog.tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <header className="app-alert-header">
          <div className="app-alert-icon" aria-hidden="true">
            <Icon size={22} />
          </div>
          <div>
            <span>{dialog.tone === "error" ? "发生错误" : "操作提示"}</span>
            <h2 id={titleId}>{dialog.title}</h2>
          </div>
          <button type="button" className="app-alert-close" aria-label="关闭" onClick={closeDialog}>
            <X size={18} />
          </button>
        </header>

        <p id={messageId} className="app-alert-message">{dialog.message}</p>

        <footer className="app-alert-actions">
          <button ref={confirmButtonRef} type="button" className="modal-btn primary" onClick={closeDialog}>
            我知道了
          </button>
        </footer>
      </section>
    </div>
  );
}
