import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
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

/** 浮层与锚点之间的间距。 */
const PICKER_GAP = 6;
/** 浮层与窗口边缘之间的安全边距。 */
const VIEWPORT_MARGIN = 8;
/** 浮层的最大高度上限（空间充足时也不超过此值）。 */
const PICKER_MAX_HEIGHT = 280;

/**
 * PromptComposer 内嵌的「@ 召唤数字员工」浮层（纯渲染组件）。
 *
 * 设计：状态（open/query/highlight）全部由父级 PromptComposer 管理，本组件只负责
 * 渲染过滤后的列表 + 滚动高亮项进入视图。键盘 ↑↓/Enter/Esc 在父级 textarea 的
 * keydown 处理，避免焦点争抢。
 *
 * 选中用 onMouseDown + preventDefault，这样点击不会让 textarea 失焦，光标位置保留。
 *
 * 定位：用 fixed 定位，以自身所在的 .composer-input-wrap（输入框）为锚点。优先向上
 * 展开（贴输入框上沿）；上方空间不足则向下翻转。max-height 钳制为可用空间，避免浮层
 * 顶部超出窗口边界导致被祖先 overflow 裁剪、滚不到顶部。
 */
export function EmployeeMentionPicker({
  humans,
  highlightIndex,
  onSelect,
  onHighlightChange,
}: EmployeeMentionPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const highlightRef = useRef<HTMLButtonElement>(null);
  const [positionStyle, setPositionStyle] = useState<CSSProperties>({});

  // 计算浮层定位：以留在原位的锚点（.composer-input-wrap 内的 sentinel）为基准。
  // 浮层本身通过 portal 渲染到 body，脱离 .hero-section 的 isolation 层叠上下文，
  // 否则 fixed+z-index 会被 hero-section 外、之后的「最近使用」卡片盖住。
  // 每次列表展开、窗口滚动/缩放时重算，保证贴边且不溢出。
  useLayoutEffect(() => {
    const compute = () => {
      // 以锚点的父节点 .composer-input-wrap（输入框容器）作为定位基准。
      // sentinel 本身零尺寸，仅作驻留引用，测量目标是其父元素。
      const anchor = anchorRef.current?.parentElement;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      // fixed 定位下坐标基于视口。
      const spaceAbove = rect.top - VIEWPORT_MARGIN;
      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
      let top: number;
      let maxHeight: number;
      if (spaceAbove >= PICKER_MAX_HEIGHT || spaceAbove >= spaceBelow) {
        // 向上展开（默认方向，与历史行为一致）。
        top = Math.max(VIEWPORT_MARGIN, rect.top - PICKER_GAP - PICKER_MAX_HEIGHT);
        maxHeight = Math.min(PICKER_MAX_HEIGHT, rect.top - PICKER_GAP - VIEWPORT_MARGIN);
      } else {
        // 向下翻转：贴输入框下沿。
        top = rect.bottom + PICKER_GAP;
        maxHeight = Math.min(PICKER_MAX_HEIGHT, spaceBelow);
      }
      setPositionStyle({
        top,
        left: rect.left,
        // 至少给一个能放下几项的高度，避免 max-height 为负导致不可见。
        maxHeight: Math.max(120, maxHeight),
      });
    };
    compute();
    // 滚动/缩放会改变锚点视口坐标，需要重算。capture=true 以捕获祖先滚动容器内的滚动。
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, []);

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
    <>
      {/* 锚点：留在 .composer-input-wrap 原位，仅用于测量视口坐标。
          零尺寸 inline 元素（非 display:none，否则 getBoundingClientRect 返回全 0）。 */}
      <span ref={anchorRef} aria-hidden="true" style={{ display: "inline", width: 0, height: 0 }} />
      {createPortal(
        <div
          className="mention-picker"
          ref={listRef}
          role="listbox"
          aria-label="选择要召唤的数字员工"
          style={positionStyle}
        >
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
        </div>,
        document.body,
      )}
    </>
  );
}
