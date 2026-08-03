import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ArrowLeft, Bot, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Clock3, Download, FileText, FolderOpen, Link2, LoaderCircle, Paperclip, MessageSquareText, Pin, Play, Save, ShieldAlert, Sparkles, User } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertAnalysisCard } from "./AlertAnalysisCard";
import { ImageViewer, type ImageViewerState } from "./ImageViewer";
import { PromptComposer } from "./PromptComposer";
import { limitText, MAX_SUGGESTION_TEXT_LENGTH } from "../services/alertAnalysisText";
import { isConversationNearBottom } from "../services/conversationScroll";
import { sandboxImageFileName } from "../services/imageLinks";
import { showAppError } from "../services/appDialog";
import type { ChatMessage, ChatMessageAttachment, DigitalHuman, PendingSkillExecution } from "../types";

type TaskConversationProps = {
  messages: ChatMessage[];
  prompt: string;
  modelName: string;
  busy: boolean;
  modelStatus: "ok" | "error" | "idle";
  modelError?: string;
  readOnly?: boolean;
  mcpReady: boolean;
  mcpStatusReason?: string;
  selectedHumanName: string;
  mentionHumans: DigitalHuman[];
  taskTitle: string;
  taskStatus: "done" | "running" | "paused" | "canceled";
  showToolMessages: boolean;
  taskStartedAt?: string;
  updatedTime?: string;
  backLabel?: string;
  onBack: () => void;
  onPromptChange: (value: string) => void;
  onAttachFiles: (files: File[]) => void;
  onPickAttachment?: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  onSuggestionSelect: (value: string) => void;
  onConfirmSkillExecution: (messageId: string, plan: PendingSkillExecution) => void;
};

const splitSuggestion = (suggestion: unknown) => {
  const text = String(suggestion ?? "").trim();
  const match = text.match(/^([A-Z])\s+(.+)$/);
  return match ? { key: match[1], label: match[2] } : { key: undefined, label: text };
};

const COLLAPSE_THRESHOLD = 200;

type RelatedTaskFile = {
  name: string;
  path?: string;
  source: "attachment" | "export";
};

type FileContextMenuState = {
  file: RelatedTaskFile;
  x: number;
  y: number;
} | null;

/// Renders assistant message content as GitHub-flavored Markdown.
/// Kept separate from CollapsibleContent so the text/markdown rendering switch
/// stays explicit; the collapse wrapper treats both variants the same way
/// (CSS-based visual collapse rather than string truncation, which would chop
/// Markdown tables/lists mid-structure).
function MarkdownContent({
  content,
  attachments,
  onOpenImage,
}: {
  content: string;
  attachments?: ChatMessageAttachment[];
  onOpenImage?: (attachment: ChatMessageAttachment) => void;
}) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(value) => (
          value.toLowerCase().startsWith("sandbox:") ? value : defaultUrlTransform(value)
        )}
        components={{
          a: ({ href, children }) => {
            const sandboxName = href ? sandboxImageFileName(href) : undefined;
            if (sandboxName) {
              const attachment = attachments?.find((item) => (
                item.kind === "image" && item.name === sandboxName && Boolean(item.path)
              ));
              return (
                <button
                  type="button"
                  className="markdown-sandbox-image-link"
                  disabled={!attachment}
                  title={attachment ? `查看图片：${sandboxName}` : `正在恢复图片：${sandboxName}`}
                  onClick={() => {
                    if (attachment) onOpenImage?.(attachment);
                  }}
                >
                  {children}
                </button>
              );
            }
            return <a href={href}>{children}</a>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CollapsibleContent({
  content,
  variant = "text",
  attachments,
  onOpenImage,
}: {
  content: string;
  variant?: "text" | "markdown";
  attachments?: ChatMessageAttachment[];
  onOpenImage?: (attachment: ChatMessageAttachment) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > COLLAPSE_THRESHOLD;

  // Short content: render inline without the collapse affordance.
  if (!isLong) {
    return variant === "markdown" ? (
      <MarkdownContent content={content} attachments={attachments} onOpenImage={onOpenImage} />
    ) : (
      <p>{content}</p>
    );
  }

  // Long content: always render the full DOM, visually collapse via CSS
  // (max-height + overflow hidden) instead of truncating the source string —
  // string slicing would break Markdown tables/lists mid-row.
  return (
    <div className={`collapsible-content is-markdown-${variant} ${expanded ? "" : "is-collapsed"}`}>
      {variant === "markdown" ? (
        <MarkdownContent content={content} attachments={attachments} onOpenImage={onOpenImage} />
      ) : (
        <p>{content}</p>
      )}
      <button type="button" className="collapse-toggle" onClick={() => setExpanded((prev) => !prev)}>
        {expanded ? (
          <>
            <ChevronUp size={13} /> 收起
          </>
        ) : (
          <>
            <ChevronDown size={13} /> 展开
          </>
        )}
      </button>
    </div>
  );
}

function MessageAttachments({
  attachments,
  onOpenImage,
}: {
  attachments: ChatMessageAttachment[];
  /// 图片双击打开 lightbox 大图预览。未提供时回退到系统程序打开。
  onOpenImage?: (attachment: ChatMessageAttachment) => void;
}) {
  const open = (path?: string) => {
    if (!path) return;
    invoke("open_file_path", { path }).catch((error: unknown) => {
      const msg = String(error);
      if (msg === "已取消" || msg.includes("已取消")) return;
      console.error("打开文件失败", error);
    });
  };

  return (
    <div className="message-attachments">
      {attachments.map((att) =>
        att.kind === "image" ? (
          <AttachmentImageThumb
            key={att.path || att.name}
            attachment={att}
            onOpen={(previewUrl) => {
              if (previewUrl && onOpenImage) onOpenImage({ ...att, previewUrl });
              else open(att.path);
            }}
          />
        ) : (
          <div
            key={att.name}
            className={`attachment-file ext-${att.ext ?? "file"} ${
              att.uploadStatus === "uploading"
                ? "is-uploading"
                : att.uploadStatus === "failed"
                  ? "is-failed"
                  : ""
            }`}
            title={
              att.uploadStatus === "uploading"
                ? `正在上传：${att.name}`
                : att.uploadStatus === "failed"
                  ? att.uploadError || `上传失败：${att.name}`
                  : `双击打开：${att.name}`
            }
            onDoubleClick={() => {
              if (att.uploadStatus !== "uploading" && att.uploadStatus !== "failed") {
                open(att.path);
              }
            }}
          >
            {att.uploadStatus === "uploading" ? (
              <LoaderCircle className="attachment-upload-spinner" size={14} />
            ) : att.uploadStatus === "failed" ? (
              <CircleAlert size={14} />
            ) : (
              <Paperclip size={13} />
            )}
            <span className="attachment-file-name">{att.name}</span>
            {att.uploadStatus === "uploading" ? (
              <span className="attachment-upload-state">上传中</span>
            ) : att.uploadStatus === "failed" ? (
              <span className="attachment-upload-state">失败</span>
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}

function AttachmentImageThumb({
  attachment,
  onOpen,
}: {
  attachment: ChatMessageAttachment;
  onOpen: (previewUrl?: string) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState(attachment.previewUrl);

  useEffect(() => {
    let active = true;
    setPreviewUrl(attachment.previewUrl);
    if (attachment.previewUrl || !attachment.path) return () => { active = false; };
    void invoke<string>("read_image_preview", { path: attachment.path })
      .then((url) => {
        if (active) setPreviewUrl(url);
      })
      .catch((error: unknown) => {
        console.error("读取图片预览失败", error);
      });
    return () => { active = false; };
  }, [attachment.path, attachment.previewUrl]);

  return (
    <div
      className="attachment-thumb"
      title={previewUrl ? `双击查看大图：${attachment.name}` : `双击打开：${attachment.name}`}
      onDoubleClick={() => onOpen(previewUrl)}
    >
      {previewUrl ? <img src={previewUrl} alt={attachment.name} /> : <span>{attachment.name}</span>}
    </div>
  );
}

function CollapsibleDetail({ label, detail }: { label: string; detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((prev) => !prev), []);
  return (
    <div className="collapsible-detail">
      <button type="button" className="collapse-toggle" onClick={toggle}>
        {expanded ? (
          <>
            <ChevronUp size={13} /> 收起{label}
          </>
        ) : (
          <>
            <ChevronDown size={13} /> 展开{label}
          </>
        )}
      </button>
      {expanded ? <pre className="collapsible-detail-text">{detail}</pre> : null}
    </div>
  );
}

function FileLink({ exportedFile }: { exportedFile: { path: string; fileName: string } }) {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending single-click timer if the link unmounts mid-wait,
  // otherwise the "Save As" dialog could fire on a stale element.
  useEffect(() => {
    return () => {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
    };
  }, []);

  const handleClick = () => {
    // 延迟执行单击动作，等待可能的第二次点击（双击）
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      // 双击：打开文件
      invoke("open_file_path", { path: exportedFile.path }).catch((error: unknown) => {
        console.error("打开文件失败", error);
        // 用户取消不算错误
        const msg = String(error);
        if (msg === "已取消" || msg.includes("已取消")) return;
        showAppError(error, "打开文件失败");
      });
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        // 单击：另存为
        invoke("save_file_as", { sourcePath: exportedFile.path }).catch((error: unknown) => {
          console.error("另存文件失败", error);
          const msg = String(error);
          if (msg === "已取消" || msg.includes("已取消")) return;
          showAppError(error, "另存文件失败");
        });
      }, 280);
    }
  };

  return (
    <div
      className="exported-file-link"
      title="单击另存为 · 双击打开文件"
      onClick={handleClick}
    >
      <Download size={15} />
      <span className="exported-file-name">{exportedFile.fileName}</span>
      <span className="exported-file-hint">单击另存为 · 双击打开</span>
    </div>
  );
}

function SkillExecutionCard({
  plan,
  busy,
  readOnly,
  onConfirm,
}: {
  plan: PendingSkillExecution;
  busy: boolean;
  readOnly: boolean;
  onConfirm: () => void;
}) {
  const disabled = busy || readOnly || plan.status === "running" || plan.status === "completed";
  const buttonLabel =
    plan.status === "running"
      ? "执行中"
      : plan.status === "completed"
        ? "已执行"
        : plan.status === "failed"
          ? "重新确认执行"
          : plan.actionLabel;

  return (
    <div className={`skill-execution-card ${plan.status}`}>
      <div className="skill-execution-title">
        <ShieldAlert size={16} />
        <div>
          <strong>需要确认本地执行</strong>
          <span>{plan.summary}</span>
        </div>
      </div>
      <ul className="skill-execution-ops">
        {plan.operations.map((operation) => (
          <li key={operation}>{operation}</li>
        ))}
      </ul>
      <code className="skill-execution-command">{plan.commandPreview.join(" ")}</code>
      <p className="skill-execution-risk">{plan.riskNotice}</p>
      <button type="button" onClick={onConfirm} disabled={disabled}>
        <Play size={14} />
        {buttonLabel}
      </button>
    </div>
  );
}

const displayStepsForMessage = (message: ChatMessage) => {
  // Identify a completed Skill-execution turn by its structure (a produced
  // file plus a used-skill record) rather than a localized title string, so
  // the synthesized steps survive title/wording changes.
  if (message.exportedFile && message.usedSkill) {
    return [
      "用户已确认本地执行",
      `已运行 ${message.usedSkill.name} 的排版脚本`,
      `已生成文件：${message.exportedFile.fileName}`,
    ];
  }
  return message.steps ?? [];
};

const isToolExecutionMessage = (message: ChatMessage) => (
  message.kind === "tool"
  || /^(?:正在)?调用工具[：:]|^工具调用(?:完成|失败)[：:]/.test(message.title?.trim() ?? "")
);

const isPureExecutionRecord = (message: ChatMessage) => (
  isToolExecutionMessage(message)
  && !message.alertAnalysisResult
  && !message.riskAssessmentResult
  && !message.riskAssessmentJob
  && !message.exportedFile
  && !message.attachments?.length
  && !message.pendingSkillExecution
  && !message.suggestions?.length
);

export function TaskConversation({
  messages,
  prompt,
  modelName,
  busy,
  modelStatus,
  modelError,
  readOnly = false,
  mcpReady,
  mcpStatusReason,
  selectedHumanName,
  mentionHumans,
  taskTitle,
  taskStatus,
  showToolMessages,
  taskStartedAt,
  updatedTime,
  backLabel = "返回任务中心",
  onBack,
  onPromptChange,
  onAttachFiles,
  onPickAttachment,
  onSubmit,
  onCancel,
  onSuggestionSelect,
  onConfirmSkillExecution,
}: TaskConversationProps) {
  const threadRef = useRef<HTMLDivElement>(null);
  const followConversationTailRef = useRef(true);
  const [showAllRelatedFiles, setShowAllRelatedFiles] = useState(false);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState>(null);
  const [imageViewer, setImageViewer] = useState<ImageViewerState>(null);
  const openImagePreview = useCallback((attachment: ChatMessageAttachment) => {
    const showPreview = (src: string) => {
      setImageViewer({ src, fileName: attachment.name, path: attachment.path });
    };
    if (attachment.previewUrl) {
      showPreview(attachment.previewUrl);
      return;
    }
    if (!attachment.path) return;
    void invoke<string>("read_image_preview", { path: attachment.path })
      .then(showPreview)
      .catch((error: unknown) => {
        console.error("读取图片预览失败", error);
        showAppError(error, "读取图片预览失败");
      });
  }, []);
  const visibleMessages = useMemo(
    () => messages.filter((message) => {
      if (!showToolMessages && isPureExecutionRecord(message)) return false;
      return Boolean(
        message.content.trim()
        || message.title?.trim()
        || message.detail?.trim()
        || message.attachments?.length
        || message.steps?.some((step) => step.trim())
        || message.suggestions?.some((suggestion) => suggestion.trim())
        || message.alertAnalysisResult
        || message.riskAssessmentResult
        || message.riskAssessmentJob
        || message.usedSkill
        || message.pendingSkillExecution
        || message.exportedFile
      );
    }),
    [messages, showToolMessages],
  );
  const conversationRounds = useMemo(
    () => messages.filter((message) => message.role === "user").length,
    [messages],
  );
  const relatedFiles = useMemo(() => {
    const files = messages.flatMap<RelatedTaskFile>((message) => [
      ...(message.attachments?.map((attachment) => ({
        name: attachment.name,
        path: attachment.path,
        source: "attachment" as const,
      })) ?? []),
      ...(message.exportedFile?.fileName
        ? [{
            name: message.exportedFile.fileName,
            path: message.exportedFile.path,
            source: "export" as const,
          }]
        : []),
    ]);
    const seen = new Set<string>();
    return files.filter((file) => {
      const key = file.path?.trim() || `${file.source}:${file.name}`;
      if (!file.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [messages]);
  const formattedStartedAt = useMemo(() => {
    if (!taskStartedAt) return "刚刚";
    const normalized = taskStartedAt.includes("T")
      ? taskStartedAt
      : taskStartedAt.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return taskStartedAt;
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }, [taskStartedAt]);
  const visibleRelatedFiles = showAllRelatedFiles ? relatedFiles : relatedFiles.slice(0, 2);
  const taskStatusLabel = taskStatus === "running"
    ? "进行中"
    : taskStatus === "done"
      ? "已完成"
      : taskStatus === "canceled"
        ? "已取消"
        : "已暂停";

  useEffect(() => {
    setShowAllRelatedFiles(false);
    setFileContextMenu(null);
  }, [taskTitle]);

  useEffect(() => {
    if (!fileContextMenu) return;
    const close = () => setFileContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fileContextMenu]);

  const openRelatedFile = useCallback((file: RelatedTaskFile) => {
    if (!file.path) return;
    invoke("open_file_path", { path: file.path }).catch((error: unknown) => {
      console.error("打开相关文件失败", error);
      showAppError(error, "打开文件失败");
    });
  }, []);

  const showRelatedFileInFolder = useCallback((file: RelatedTaskFile) => {
    if (!file.path) return;
    setFileContextMenu(null);
    invoke("show_file_in_folder", { path: file.path }).catch((error: unknown) => {
      console.error("打开文件所在目录失败", error);
      showAppError(error, "定位文件失败");
    });
  }, []);

  const saveRelatedFileAs = useCallback((file: RelatedTaskFile) => {
    if (!file.path) return;
    setFileContextMenu(null);
    invoke<string>("save_file_as", { sourcePath: file.path }).catch((error: unknown) => {
      const message = String(error);
      if (message === "已取消" || message.includes("已取消")) return;
      console.error("另存相关文件失败", error);
      showAppError(message, "另存文件失败");
    });
  }, []);

  const handleThreadScroll = useCallback(() => {
    const thread = threadRef.current;
    if (!thread) return;
    followConversationTailRef.current = isConversationNearBottom(thread);
  }, []);

  const handleThreadWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    // The scroll event follows the wheel event. Disable tail following here as
    // well so a streaming message update cannot win the race and pull the user
    // back down before the browser has applied the upward scroll.
    if (event.deltaY < 0) {
      followConversationTailRef.current = false;
    }
  }, []);

  const openRelatedFileMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, file: RelatedTaskFile) => {
      if (!file.path) return;
      event.preventDefault();
      event.stopPropagation();
      const menuWidth = 166;
      const menuHeight = 82;
      const viewportGap = 8;
      setFileContextMenu({
        file,
        x: Math.max(viewportGap, Math.min(event.clientX, window.innerWidth - menuWidth - viewportGap)),
        y: Math.max(viewportGap, Math.min(event.clientY, window.innerHeight - menuHeight - viewportGap)),
      });
    },
    [],
  );

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !followConversationTailRef.current) return;
    thread.scrollTop = thread.scrollHeight;
  }, [messages, busy]);

  return (
    <section className="task-conversation" aria-label="任务对话">
      <div className="conversation-header">
        <div className="conversation-heading">
          <button type="button" className="conversation-back" onClick={onBack} title={backLabel}>
            <ArrowLeft size={16} />
          </button>
          <div className="conversation-title-group">
            <div className="conversation-title-line">
              <h1>{taskTitle}</h1>
              {updatedTime ? <time>{updatedTime}</time> : null}
            </div>
            <div className="conversation-subtitle">
              <span>{selectedHumanName}</span>
            </div>
          </div>
        </div>
        <div className="conversation-header-meta">
          <div
            className={`conversation-status ${mcpReady ? "is-connected" : "is-disconnected"}`}
            title={!mcpReady ? mcpStatusReason : undefined}
          >
            {mcpReady ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
            <span>{mcpReady ? "MCP" : "MCP 不可用"}</span>
          </div>
          <strong className={`task-status-pill ${taskStatus}`}>{taskStatusLabel}</strong>
          {readOnly ? <span className="conversation-readonly-badge">只读查看</span> : null}
        </div>
      </div>

      <div
        className="conversation-thread"
        ref={threadRef}
        onScroll={handleThreadScroll}
        onWheel={handleThreadWheel}
      >
        {visibleMessages.length === 0 ? (
          <div className="conversation-empty">
            <span className="conversation-empty-icon">
              <Sparkles size={24} />
            </span>
            <h2>开始一个任务对话</h2>
            <p>在下方输入任务信息，数字员工会继续完成当前任务。</p>
          </div>
        ) : (
          visibleMessages.map((message) => {
            const toolExecution = isToolExecutionMessage(message);
            const compactToolExecution = toolExecution
              && !message.alertAnalysisResult
              && !message.riskAssessmentResult
              && !message.exportedFile
              && !message.pendingSkillExecution
              && !message.suggestions?.length;
            const displaySteps = toolExecution ? [] : displayStepsForMessage(message);
            return (
            <article
              className={`message-row ${message.role} ${compactToolExecution ? "tool-execution" : ""}`}
              key={message.id}
            >
              <div className="message-avatar" aria-hidden="true">
                {message.role === "assistant" ? <Bot size={20} /> : <User size={20} />}
              </div>
              <div className="message-bubble">
                <div className="message-meta">
                  <strong>{message.role === "assistant" ? selectedHumanName : "你"}</strong>
                  <time>{message.time}</time>
                  {message.usedSkill ? (
                    <span
                      className="message-skill-badge"
                      title={`Skill: ${message.usedSkill.id}; ${message.usedSkill.reason}`}
                    >
                      Skill {message.usedSkill.name}
                    </span>
                  ) : null}
                </div>
                {message.title ? <h2>{message.title}</h2> : null}
                {message.attachments?.length ? (
                  <MessageAttachments
                    attachments={message.attachments}
                    onOpenImage={openImagePreview}
                  />
                ) : null}
                {(() => {
                  // 有结构化结果（告警研判 / 数安风评）时抑制默认 summary/steps，
                  // 改用专用卡片或 markdown 渲染对应结构化结果。
                  if (message.alertAnalysisResult) {
                    return <AlertAnalysisCard result={message.alertAnalysisResult} />;
                  }
                  if (message.riskAssessmentResult) {
                    return (
                      <>
                        <CollapsibleContent
                          content={message.riskAssessmentResult.overview}
                          variant="markdown"
                        />
                        {message.riskAssessmentResult.detail ? (
                          <CollapsibleDetail
                            label="完整结果"
                            detail={message.riskAssessmentResult.detail}
                          />
                        ) : null}
                      </>
                    );
                  }
                  if (toolExecution) return null;
                  return (
                    <CollapsibleContent
                      content={message.content}
                      variant={message.role === "assistant" ? "markdown" : "text"}
                      attachments={message.attachments}
                      onOpenImage={openImagePreview}
                    />
                  );
                })()}
                {message.detail ? (
                  <CollapsibleDetail label="识别原文" detail={message.detail} />
                ) : null}
                {message.alertAnalysisResult || message.riskAssessmentResult
                  ? null
                  : displaySteps.length ? (
                  <ul className="message-steps">
                    {displaySteps.map((step, i) => (
                      <li key={typeof step === "string" ? step : i}>
                        {typeof step === "string" ? step : JSON.stringify(step)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {message.exportedFile ? (
                  <FileLink exportedFile={message.exportedFile} />
                ) : null}
                {message.pendingSkillExecution ? (
                  <SkillExecutionCard
                    plan={message.pendingSkillExecution}
                    busy={busy}
                    readOnly={readOnly}
                    onConfirm={() => onConfirmSkillExecution(message.id, message.pendingSkillExecution!)}
                  />
                ) : null}
                {message.suggestions?.length ? (
                  <div className="message-suggestions">
                    {message.suggestions.map((rawSuggestion, index) => {
                      const suggestion = String(rawSuggestion ?? "").trim();
                      if (!suggestion) return null;
                      const option = splitSuggestion(suggestion);
                      const displayLabel = limitText(option.label, MAX_SUGGESTION_TEXT_LENGTH);
                      return (
                        <button
                          key={`${suggestion}-${index}`}
                          type="button"
                          disabled={busy || readOnly}
                          title={option.label}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => onSuggestionSelect(suggestion)}
                        >
                          {option.key ? <span className="suggestion-key">{option.key}</span> : null}
                          <span className="suggestion-label">{displayLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </article>
            );
          })
        )}
        {busy ? (
          <article className="message-row assistant">
            <div className="message-avatar" aria-hidden="true">
              <Bot size={18} />
            </div>
            <div className="message-bubble thinking">
              <div className="typing-dots" aria-label="正在生成">
                <span />
                <span />
                <span />
              </div>
            </div>
          </article>
        ) : null}
      </div>

      {!readOnly ? (
        <div className="conversation-composer">
          <PromptComposer
            value={prompt}
            modelName={modelName}
            busy={busy}
            disabled={!mcpReady}
            disabledReason={mcpStatusReason}
            modelStatus={modelStatus}
            modelError={modelError}
            mentionHumans={mentionHumans}
            selectedEmployeeName={selectedHumanName}
            onChange={onPromptChange}
            onAttachFiles={onAttachFiles}
            onPickAttachment={onPickAttachment}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        </div>
      ) : (
        <div className="conversation-readonly-footer">归档内容，只读查看</div>
      )}

      <aside className="task-context-panel" aria-label="任务信息">
        <div className="task-context-heading">
          <span>任务</span>
          <Pin size={16} aria-hidden="true" />
        </div>

        <section className="task-context-section">
          <h2>概况</h2>
          <div className="task-context-row">
            <CheckCircle2 size={17} aria-hidden="true" />
            <span>{taskStatusLabel}</span>
          </div>
          <div className="task-context-row">
            <Clock3 size={17} aria-hidden="true" />
            <span>开始于 {formattedStartedAt}</span>
          </div>
          <div className="task-context-row">
            <MessageSquareText size={17} aria-hidden="true" />
            <span>{conversationRounds} 轮对话</span>
          </div>
        </section>

        <section className="task-context-section related-files">
          <h2>相关文件</h2>
          {visibleRelatedFiles.length > 0 ? (
            visibleRelatedFiles.map((file) => (
              <div
                className={`task-context-row file ${file.path ? "is-interactive" : "is-unavailable"}`}
                key={file.path || `${file.source}:${file.name}`}
                title={file.path ? `${file.name}（双击打开，右键查看更多操作）` : file.name}
                role={file.path ? "button" : undefined}
                tabIndex={file.path ? 0 : undefined}
                onDoubleClick={() => openRelatedFile(file)}
                onContextMenu={(event) => openRelatedFileMenu(event, file)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") openRelatedFile(file);
                }}
              >
                <FileText size={17} aria-hidden="true" />
                <span>{file.name}</span>
              </div>
            ))
          ) : (
            <p className="task-context-empty">暂无相关文件</p>
          )}
          {relatedFiles.length > 2 ? (
            <button
              type="button"
              className="task-context-more"
              onClick={() => setShowAllRelatedFiles((expanded) => !expanded)}
            >
              <Link2 size={16} />
              {showAllRelatedFiles ? "收起" : "查看全部"}
            </button>
          ) : null}
        </section>
      </aside>

      {fileContextMenu ? (
        <div
          className="context-menu task-file-context-menu"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          role="menu"
          aria-label={`${fileContextMenu.file.name} 文件操作`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => showRelatedFileInFolder(fileContextMenu.file)}
          >
            <FolderOpen size={15} />
            打开所在目录
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => saveRelatedFileAs(fileContextMenu.file)}
          >
            <Save size={15} />
            另存为
          </button>
        </div>
      ) : null}

      <ImageViewer state={imageViewer} onClose={() => setImageViewer(null)} />
    </section>
  );
}
