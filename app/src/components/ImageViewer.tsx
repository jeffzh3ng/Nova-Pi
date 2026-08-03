import { useEffect } from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { showAppError } from "../services/appDialog";

/// 图片大图预览（lightbox）状态。src 为预览 data URL；path 可用于系统打开 / 另存。
export type ImageViewerState = {
  src: string;
  fileName: string;
  path?: string;
} | null;

/// 全屏图片预览遮罩。点遮罩 / Esc / 关闭按钮关闭；
/// 顶栏「系统打开」「另存为」复用 open_file_path / save_file_as。
export function ImageViewer({
  state,
  onClose,
}: {
  state: ImageViewerState;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  if (!state) return null;

  const openExternally = () => {
    if (!state.path) return;
    invoke("open_file_path", { path: state.path }).catch((error: unknown) => {
      const msg = String(error);
      if (msg === "已取消" || msg.includes("已取消")) return;
      showAppError(error, "打开文件失败");
    });
  };

  const saveAs = () => {
    if (!state.path) return;
    invoke("save_file_as", { sourcePath: state.path }).catch((error: unknown) => {
      const msg = String(error);
      if (msg === "已取消" || msg.includes("已取消")) return;
      showAppError(error, "另存文件失败");
    });
  };

  return (
    <div
      className="image-viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览：${state.fileName}`}
      onClick={onClose}
    >
      <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <span className="image-viewer-name" title={state.fileName}>
          {state.fileName}
        </span>
        <div className="image-viewer-actions">
          <button type="button" onClick={openExternally} disabled={!state.path} title="用系统程序打开">
            <ExternalLink size={16} />
            <span>系统打开</span>
          </button>
          <button type="button" onClick={saveAs} disabled={!state.path} title="另存为">
            <Download size={16} />
            <span>另存为</span>
          </button>
          <button type="button" onClick={onClose} title="关闭（Esc）">
            <X size={16} />
            <span>关闭</span>
          </button>
        </div>
      </div>
      <img
        className="image-viewer-img"
        src={state.src}
        alt={state.fileName}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
