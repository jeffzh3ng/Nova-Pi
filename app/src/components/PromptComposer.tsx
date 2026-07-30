import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowUp, Cpu, Paperclip } from "lucide-react";
import type { DigitalHuman } from "../types";
import { EmployeeMentionPicker } from "./EmployeeMentionPicker";

type MentionInsert = {
  /** @ 符号在文本中的起始位置（含）。 */
  start: number;
  /** @ 之后查询文本的结束位置（不含，即光标位置）。 */
  end: number;
  /** @ 之后的查询关键字。 */
  query: string;
};

/**
 * 从 textarea 当前光标位置向前找最近的 @ 触发点。
 * 触发条件：@ 在文本开头，或 @ 前一个字符是空白。
 * 返回 undefined 表示当前光标位置不在 @ 提及范围内。
 */
function detectMentionAt(text: string, cursor: number): MentionInsert | undefined {
  if (cursor <= 0) return undefined;
  // 从光标向前扫，遇到 @ 停；遇到空白或换行则放弃（@ 提及不能跨空格）。
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "@") {
      const prev = text[i - 1];
      // @ 必须在开头或前面是空白/换行才算提及触发符，避免邮箱 a@b 误触发。
      if (i === 0 || /\s/.test(prev)) {
        return { start: i, end: cursor, query: text.slice(i + 1, cursor) };
      }
      return undefined;
    }
    // 遇到空白说明前面没有 @，放弃。
    if (/\s/.test(ch)) return undefined;
  }
  return undefined;
}

/**
 * 统计文本里已完成的 `@员工名` 提及数量（精确匹配已知员工，@ 后跟空白或结尾）。
 * 用于约束「一条消息最多 @ 一个数字员工」：若已有一个完成的提及，再次输入 @ 不再打开选择器。
 */
function countCompletedMentions(value: string, humans: DigitalHuman[]): number {
  const sortedNames = humans
    .map((human) => human.name)
    .filter((name) => Boolean(name) && !name.includes("@"))
    .sort((a, b) => b.length - a.length);
  if (sortedNames.length === 0) return 0;
  const escapedNames = sortedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:^|(?<=\\s))@(?:${escapedNames.join("|")})(?=\\s|$)`, "g");
  return (value.match(pattern) ?? []).length;
}

/**
 * 把输入文本里的 `@员工名`（精确匹配已知数字员工）包成高亮 span，返回 React 节点。
 * 用 name 长度降序匹配，避免短名前缀误命中长名。@ 必须在开头或前面是空白才生效。
 * 其余文字原样（转义）输出，保持与 textarea 内文字一一对应。
 */
function renderHighlightedValue(value: string, humans: DigitalHuman[]): ReactNode {
  if (!value) return null;
  const sortedNames = humans
    .map((human) => human.name)
    .filter((name) => name && !name.includes("@"))
    .sort((a, b) => b.length - a.length);
  if (sortedNames.length === 0) return value;

  // 构造一个匹配任意员工名的正则：(^|(?<=\s))@(?<name>员工名)(?=\s|$)
  const escapedNames = sortedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:^|(?<=\\s))@(${escapedNames.join("|")})(?=\\s|$)`, "g");

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push(value.slice(lastIndex, match.index));
    }
    // match[0] 是含 @ 的完整匹配，match[1] 是员工名。
    const fullMatch = match[0];
    const mentionText = fullMatch.startsWith("@") ? fullMatch : fullMatch.slice(fullMatch.indexOf("@"));
    parts.push(
      <span key={`mention-${key++}`} className="mention-token">
        {mentionText}
      </span>,
    );
    lastIndex = match.index + fullMatch.length;
  }
  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }
  return parts;
}

type PromptComposerProps = {
  value: string;
  introduction?: string;
  placeholder?: string;
  modelName: string;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  modelStatus: "ok" | "error" | "idle";
  modelError?: string;
  /** @ 召唤可选的数字员工列表（不含通用对话员工）。 */
  mentionHumans: DigitalHuman[];
  /** 当前已选中的数字员工名（@ 提及或会话绑定）。有值时 placeholder 不再提示「@ 召唤」。 */
  selectedEmployeeName?: string;
  onChange: (value: string) => void;
  onAttachFiles: (files: File[]) => void;
  onPickAttachment?: () => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function PromptComposer({
  value,
  introduction,
  placeholder,
  modelName,
  busy,
  disabled = false,
  disabledReason,
  modelStatus,
  modelError,
  mentionHumans,
  selectedEmployeeName,
  onChange,
  onAttachFiles,
  onPickAttachment,
  onSubmit,
  onCancel,
}: PromptComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayInnerRef = useRef<HTMLDivElement>(null);

  // textarea 文字透明、可见文字由 overlay 渲染，二者必须同高同滚动，
  // 否则 caret 与可见文字错位。overlay 用 overflow:hidden 裁剪溢出内容，
  // 内层用 transform 平移跟随 textarea 的 scrollTop——比直接设置 overflow:hidden
  // 元素的 scrollTop 更可靠（不依赖其可滚动行为，跨 WebView2/WebKit 一致）。
  const syncOverlayScroll = () => {
    const ta = textareaRef.current;
    const ov = overlayRef.current;
    const inner = overlayInnerRef.current;
    if (!ta || !ov || !inner) return;
    inner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    // textarea 出现垂直滚动条时占用内容宽度，overlay 无滚动条会更宽、换行更晚，
    // 导致 caret 与可见文字横向错位。这里动态给 overlay 留出等宽的右内边距，
    // 使二者内容区宽度始终一致。
    const scrollbar = ta.offsetWidth - ta.clientWidth;
    ov.style.paddingRight = scrollbar ? `${scrollbar}px` : "";
  };

  useEffect(() => {
    // 输入/粘贴后 textarea 会程序滚动到光标，rAF 在布局后同步 overlay 位置，
    // 保证 caret 与可见文字始终对齐。
    const id = requestAnimationFrame(syncOverlayScroll);
    return () => cancelAnimationFrame(id);
  }, [value]);

  const canSubmit = value.trim().length > 0 && !busy && !disabled;

  // @ 浮层状态：触发位置 + 查询关键字 + 高亮索引。
  // 我们用 textarea 的 selectionStart 作为光标位置（受控组件，每次 onChange 重算）。
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  // 过滤候选员工（按 name/role/id 模糊匹配）。空 query 时展示全部可用员工。
  const filteredHumans = useMemo(() => {
    const keyword = mentionQuery.trim().toLocaleLowerCase("zh-CN");
    const ready = mentionHumans.filter((human) => human.status !== "pending");
    if (!keyword) return ready;
    return ready.filter((human) =>
      [human.name, human.role, human.id]
        .filter(Boolean)
        .some((field) => String(field).toLocaleLowerCase("zh-CN").includes(keyword)),
    );
  }, [mentionHumans, mentionQuery]);

  // 高亮越界保护（列表缩短时回退到末项）。
  const safeHighlight =
    filteredHumans.length === 0 ? 0 : Math.min(highlightIndex, filteredHumans.length - 1);

  const closeMention = () => {
    setMentionActive(false);
    setMentionQuery("");
    setHighlightIndex(0);
  };

  const handleChange = (next: string) => {
    onChange(next);
    // 受控组件，setState 后 textarea 的 value 才更新；这里直接用 next + selectionStart 检测。
    // 但 React 在 onChange 后才会同步 selectionStart，所以用 requestAnimationFrame 取下一帧的光标。
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const mention = detectMentionAt(next, cursor);
    if (mention) {
      // 约束：一条消息最多 @ 一个数字员工。若文本里已有完成的 @员工名 提及，
      // 不再打开选择器（用户正在输入的这个 @ 会被当作普通文本）。
      // 「正在输入的这个 @」本身不算完成（后面还没空格），所以选第一个时不受影响。
      const alreadyMentioned = countCompletedMentions(next, mentionHumans);
      if (alreadyMentioned > 0) {
        closeMention();
        return;
      }
      setMentionActive(true);
      setMentionQuery(mention.query);
      setHighlightIndex(0);
    } else {
      closeMention();
    }
  };

  /** 选中某员工：把 @query 替换为 @员工名（带尾随空格），光标移到末尾。 */
  const handleSelectMention = (human: DigitalHuman) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const mention = detectMentionAt(value, cursor);
    if (!mention) {
      closeMention();
      return;
    }
    const before = value.slice(0, mention.start);
    const after = value.slice(mention.end);
    const inserted = `@${human.name} `;
    const nextValue = `${before}${inserted}${after}`;
    onChange(nextValue);
    closeMention();
    // 把光标放到插入文本之后，并重新聚焦。
    const newCursor = before.length + inserted.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursor, newCursor);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @ 浮层打开时优先处理导航键。
    if (mentionActive && filteredHumans.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((current) => (current + 1) % filteredHumans.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((current) =>
          current === 0 ? filteredHumans.length - 1 : current - 1,
        );
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const target = filteredHumans[safeHighlight];
        if (target) {
          handleSelectMention(target);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
    } else if (mentionActive && event.key === "Escape") {
      event.preventDefault();
      closeMention();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  };

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
      <div className="composer-input-wrap">
        {/* 高亮覆盖层：和 textarea 完全同尺寸同排版，渲染着色后的 @员工名。
            textarea 文字透明（仅保留 caret 与交互），由本层负责可见文字。
            这是 Slack/Notion 式 mention 高亮的标准做法。 */}
        {value ? (
          <div className="composer-highlight-overlay" ref={overlayRef} aria-hidden="true">
            <div className="composer-highlight-inner" ref={overlayInnerRef}>
              {renderHighlightedValue(value, mentionHumans)}
            </div>
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={3}
          value={value}
          placeholder={
            introduction?.trim()
              ? ""
              : placeholder?.trim()
              ? placeholder
              : disabled
              ? "可先输入任务目标，选择可用数字员工后发送"
              : selectedEmployeeName || countCompletedMentions(value, mentionHumans) > 0
              ? `请描述需要${selectedEmployeeName ?? "数字员工"}处理的任务`
              : "请输入任务或问题，可用 @ 召唤数字员工"
          }
          title={disabled ? disabledReason : undefined}
          onChange={(event) => handleChange(event.target.value)}
          onScroll={syncOverlayScroll}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // 延迟关闭，让浮层 onMouseDown 有机会触发。
            window.setTimeout(() => closeMention(), 120);
          }}
        />
        {mentionActive && mentionHumans.length > 0 ? (
          <EmployeeMentionPicker
            humans={filteredHumans}
            highlightIndex={safeHighlight}
            onSelect={handleSelectMention}
            onHighlightChange={setHighlightIndex}
          />
        ) : null}
      </div>
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
              title="中止当前任务"
              onClick={onCancel}
            >
              <span className="stop-button-glyph" aria-hidden="true" />
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
