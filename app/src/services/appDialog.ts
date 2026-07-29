export type AppDialogTone = "error" | "warning";

export type AppDialogRequest = {
  title: string;
  message: string;
  tone: AppDialogTone;
};

export const APP_DIALOG_EVENT = "nova-app-dialog";

const normalizeDialogMessage = (message: unknown, fallback: string) => {
  const value = message instanceof Error ? message.message : String(message ?? "");
  return value.replace(/^Error:\s*/i, "").trim() || fallback;
};

const showAppDialog = (request: AppDialogRequest) => {
  window.dispatchEvent(new CustomEvent<AppDialogRequest>(APP_DIALOG_EVENT, { detail: request }));
};

export const showAppError = (message: unknown, title = "操作失败") => {
  showAppDialog({
    title,
    message: normalizeDialogMessage(message, "发生未知错误，请稍后重试。"),
    tone: "error",
  });
};

export const showAppWarning = (message: unknown, title = "请检查输入") => {
  showAppDialog({
    title,
    message: normalizeDialogMessage(message, "请检查后重试。"),
    tone: "warning",
  });
};
