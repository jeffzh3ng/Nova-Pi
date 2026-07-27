import { Activity, Bot, CheckCircle2, DatabaseZap } from "lucide-react";
import type { DigitalHuman } from "../types";

const humanIcons = {
  "data-security-risk-assessment": DatabaseZap,
  "alert-analysis": Activity,
};

type DigitalHumanPickerProps = {
  humans: DigitalHuman[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export function DigitalHumanPicker({ humans, selectedId, onSelect }: DigitalHumanPickerProps) {
  return (
    <section className="human-picker" aria-label="选择数字员工">
      <div className="human-grid">
        {humans.map((human) => {
          const Icon = humanIcons[human.id as keyof typeof humanIcons] ?? Bot;
          const selected = human.id === selectedId;
          const disabled = human.status === "pending";

          return (
            <button
              className={`human-card ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`}
              key={human.id}
              type="button"
              disabled={disabled}
              title={disabled ? (human.disabledReason ?? "待配置") : human.description}
              onClick={() => onSelect(human.id)}
              aria-disabled={disabled}
              aria-pressed={selected}
            >
              <span className={`human-card-icon ${human.accent}`}>
                <Icon size={25} />
              </span>
              <span className="human-card-copy">
                <strong>{human.name}</strong>
                <span>{human.role}</span>
              </span>
              <span className="human-card-check" aria-hidden="true">
                {selected ? <CheckCircle2 size={17} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
