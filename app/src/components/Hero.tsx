import { PromptComposer } from "./PromptComposer";

type HeroProps = {
  prompt: string;
  introduction?: string;
  modelName: string;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  modelStatus: "ok" | "error" | "idle";
  modelError?: string;
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
  onPromptChange,
  onAttachFiles,
  onPickAttachment,
  onSubmit,
  onCancel,
}: HeroProps) {
  return (
    <section className="hero-section">
      <div className="hero-backdrop" aria-hidden="true">
        <img src="/assets/digital-human-blueprint.png" alt="" />
      </div>
      <div className="hero-copy">
        <p>欢迎使用</p>
        <h1>迪普科技驻场服务 AI 工作台</h1>
      </div>
      <PromptComposer
        value={prompt}
        introduction={introduction}
        modelName={modelName}
        busy={busy}
        disabled={disabled}
        disabledReason={disabledReason}
        modelStatus={modelStatus}
        modelError={modelError}
        onChange={onPromptChange}
        onAttachFiles={onAttachFiles}
        onPickAttachment={onPickAttachment}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </section>
  );
}
