import { PromptComposer } from "./PromptComposer";
import type { DigitalHuman } from "../types";

/** 按当前小时返回时段问候语（上午好 / 下午好 / 晚上好 / 凌晨好）。 */
function greetingByHour(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 9) return "早上好";
  if (h >= 9 && h < 12) return "上午好";
  if (h >= 12 && h < 14) return "中午好";
  if (h >= 14 && h < 18) return "下午好";
  if (h >= 18 && h < 23) return "晚上好";
  return "夜深了";
}

type HeroProps = {
  prompt: string;
  introduction?: string;
  modelName: string;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  modelStatus: "ok" | "error" | "idle";
  modelError?: string;
  mentionHumans: DigitalHuman[];
  selectedEmployeeName?: string;
  onPromptChange: (value: string) => void;
  onAttachFiles: (files: File[]) => void;
  onPickAttachment?: () => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function Hero({
  prompt,
  introduction,
  modelName,
  busy,
  disabled,
  disabledReason,
  modelStatus,
  modelError,
  mentionHumans,
  selectedEmployeeName,
  onPromptChange,
  onAttachFiles,
  onPickAttachment,
  onSubmit,
  onCancel,
}: HeroProps) {
  const composerPlaceholder = disabled
    ? "先描述任务目标、相关背景和期望结果\n选择可用数字员工后即可发送"
    : selectedEmployeeName
      ? `告诉${selectedEmployeeName}你想完成什么\n建议补充任务背景、处理要求和期望结果，也可以上传相关文件`
      : "请描述你的任务背景、具体需求和期望结果，也可以使用 @ 召唤数字员工，我会据此为你提供更准确的帮助。";

  return (
    <section className="hero-section">
      <div className="hero-backdrop" aria-hidden="true">
        <img src="/assets/hero-background.webp" alt="" />
      </div>
      <div className="hero-copy">
        <h1>{greetingByHour()}，需要我帮你做点什么？</h1>
      </div>
      <PromptComposer
        value={prompt}
        introduction={introduction}
        placeholder={composerPlaceholder}
        modelName={modelName}
        busy={busy}
        disabled={disabled}
        disabledReason={disabledReason}
        modelStatus={modelStatus}
        modelError={modelError}
        mentionHumans={mentionHumans}
        selectedEmployeeName={selectedEmployeeName}
        onChange={onPromptChange}
        onAttachFiles={onAttachFiles}
        onPickAttachment={onPickAttachment}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </section>
  );
}
