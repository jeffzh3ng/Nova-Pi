import { useEffect, useRef } from "react";
import type { DigitalHuman } from "../types";
import { resolveDigitalHumanIcon } from "./digitalHumanIcons";

type EmployeeMentionPickerProps = {
  /** 候选数字员工列表（已由父级按 query 过滤，仅含可选项）。 */
  humans: DigitalHuman[];
  /** 当前高亮项索引（父级在 textarea keydown 中驱动 ↑↓）。 */
  highlightIndex: number;
  /** 选中某员工时触发。父级用 onMouseDown 触发以免 textarea 失焦。 */
  onSelect: (human: DigitalHuman) => void;
  /** 鼠标移入某项时同步高亮。 */
  onHighlightChange: (index: number) => void;
};

/**
 * PromptComposer 内嵌的「@ 召唤数字员工」浮层（纯渲染组件）。
 *
 * 设计：状态（open/query/highlight）全部由父级 PromptComposer 管理，本组件只负责
 * 渲染过滤后的列表 + 滚动高亮项进入视图。键盘 ↑↓/Enter/Esc 在父级 textarea 的
 * keydown 处理，避免焦点争抢。
 *
 * 选中用 onMouseDown + preventDefault，这样点击不会让 textarea 失焦，光标位置保留。
 */
export function EmployeeMentionPicker({
  humans,
  highlightIndex,
  onSelect,
  onHighlightChange,
}: EmployeeMentionPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLButtonElement>(null);

  // 高亮项变化时滚入视图（键盘 ↑↓ 触发）。
  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  // 阻止浮层内 pointerdown 冒泡到 textarea，防止意外失焦。
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const stop = (event: PointerEvent) => event.stopPropagation();
    node.addEventListener("pointerdown", stop);
    return () => node.removeEventListener("pointerdown", stop);
  }, []);

  return (
    <div className="mention-picker" ref={listRef} role="listbox" aria-label="选择要召唤的数字员工">
      {humans.length === 0 ? (
        <div className="mention-item-empty">没有匹配的数字员工</div>
      ) : (
        humans.map((human, index) => {
          const Icon = resolveDigitalHumanIcon(human.id);
          const highlighted = index === highlightIndex;
          return (
            <button
              type="button"
              key={human.id}
              ref={highlighted ? highlightRef : undefined}
              role="option"
              aria-selected={highlighted}
              className={`mention-item ${highlighted ? "highlighted" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(human);
              }}
              onMouseEnter={() => onHighlightChange(index)}
            >
              <span className={`mention-item-icon ${human.accent}`}>
                <Icon size={16} />
              </span>
              <span className="mention-item-copy">
                <strong>{human.name}</strong>
                <span>{human.role}</span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
