import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  Activity,
  Archive,
  BarChart3,
  Blocks,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardList,
  DatabaseZap,
  GraduationCap,
  History,
  Megaphone,
  Pencil,
  Puzzle,
  Rocket,
  Settings,
  ShieldCheck,
  Siren,
  Sparkles,
  Store,
  Trash2,
  Workflow,
  XCircle,
} from "lucide-react";
import type { QuickAction, RecentTask, SidebarNavId } from "../types";

const quickIcons = {
  "network-security-risk-assessment": ShieldCheck,
  "data-security-risk-assessment": DatabaseZap,
  "system-go-live-security-assessment": Rocket,
  "dual-new-assessment": Sparkles,
  "incident-response": Siren,
  "incident-drill": Workflow,
  "training-service": GraduationCap,
  "security-bulletin-service": Megaphone,
  "alert-analysis": Activity,
};

type SidebarProps = {
  quickActions: QuickAction[];
  recentTasks: RecentTask[];
  archivedTasks: RecentTask[];
  activeNav: SidebarNavId;
  selectedQuickActionId?: string;
  selectedTaskId?: string;
  panelWidth: number;
  onSelectNav: (nav: SidebarNavId) => void;
  onSelectQuickAction: (action: QuickAction) => void;
  onSelectTask: (task: RecentTask) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDeleteTask: (task: RecentTask) => void;
  onRenameTask: (task: RecentTask) => void;
  onArchiveTask: (task: RecentTask) => void;
  onRestoreTask: (task: RecentTask) => void;
};

const statusIcon = {
  done: CheckCircle2,
  running: CircleDot,
  paused: History,
  canceled: XCircle,
};

type ContextMenuState = {
  task: RecentTask;
  x: number;
  y: number;
} | null;

export function Sidebar({
  quickActions,
  recentTasks,
  archivedTasks,
  activeNav,
  selectedQuickActionId,
  selectedTaskId,
  panelWidth,
  onSelectNav,
  onSelectQuickAction,
  onSelectTask,
  onResizeStart,
  onDeleteTask,
  onRenameTask,
  onArchiveTask,
  onRestoreTask,
}: SidebarProps) {
  const [quickActionsExpanded, setQuickActionsExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [contextMenuY, setContextMenuY] = useState<number>(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const visibleQuickActions = quickActionsExpanded ? quickActions : quickActions.slice(0, 4);
  const showContextPanel = activeNav === "home" || activeNav === "projects";

  const handleContextMenu = useCallback(
    (task: RecentTask) => (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setContextMenu({ task, x: event.clientX, y: event.clientY });
      setContextMenuY(event.clientY);
    },
    [],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => closeContextMenu();
    const handleScroll = () => closeContextMenu();
    window.addEventListener("click", handleClick);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [contextMenu, closeContextMenu]);

  // Flip context menu upward if it overflows the viewport bottom
  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) {
      setContextMenuY(contextMenu?.y ?? 0);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const overflow = rect.bottom - window.innerHeight;
    if (overflow > 0) {
      setContextMenuY(contextMenu.y - rect.height - 4);
    } else {
      setContextMenuY(contextMenu.y);
    }
  }, [contextMenu]);

  return (
    <aside
      className={`sidebar-shell ${showContextPanel ? "" : "compact"}`}
      aria-label="任务导航"
      style={{ "--sidebar-panel-current": `${panelWidth}px` } as CSSProperties}
    >
      <div className="nav-rail">
        <button
          className={`rail-logo ${activeNav === "home" ? "active" : ""}`}
          aria-label="首页"
          data-tooltip="首页"
          onClick={() => onSelectNav("home")}
        >
          <Bot size={26} />
        </button>
        <button
          className={`rail-item ${activeNav === "tasks" ? "active" : ""}`}
          aria-label="任务"
          data-tooltip="任务"
          onClick={() => onSelectNav("tasks")}
        >
          <ClipboardList size={24} />
        </button>
        <button
          className={`rail-item ${activeNav === "projects" ? "active" : ""}`}
          aria-label="归档"
          data-tooltip="归档"
          onClick={() => onSelectNav("projects")}
        >
          <Archive size={24} />
        </button>
        <div className="rail-spacer" />
        <button
          className={`rail-tool ${activeNav === "skill" ? "active" : ""}`}
          aria-label="SKILL 中心"
          data-tooltip="SKILL 中心"
          onClick={() => onSelectNav("skill")}
        >
          <Puzzle size={22} />
        </button>
        <button
          className={`rail-tool ${activeNav === "mcp" ? "active" : ""}`}
          aria-label="数字员工管理"
          data-tooltip="数字员工管理"
          onClick={() => onSelectNav("mcp")}
        >
          <Store size={22} />
        </button>
        <button
          className={`rail-tool ${activeNav === "extensions" ? "active" : ""}`}
          aria-label="Pi 扩展"
          data-tooltip="Pi 扩展"
          onClick={() => onSelectNav("extensions")}
        >
          <Blocks size={22} />
        </button>
        <button
          className={`rail-tool ${activeNav === "usage" ? "active" : ""}`}
          aria-label="用量"
          data-tooltip="用量"
          onClick={() => onSelectNav("usage")}
        >
          <BarChart3 size={22} />
        </button>
        <button
          className={`rail-tool ${activeNav === "settings" ? "active" : ""}`}
          aria-label="设置"
          data-tooltip="设置"
          onClick={() => onSelectNav("settings")}
        >
          <Settings size={22} />
        </button>
      </div>

      {showContextPanel ? (
        <div className="sidebar-panel">
          <div className="sidebar-scroll">
            <section className="sidebar-section">
              <div className="section-heading">
                <span>数字员工</span>
                <button type="button" onClick={() => setQuickActionsExpanded(true)}>
                  全部数字员工
                </button>
              </div>
              <div className="quick-list">
                {visibleQuickActions.map((item) => {
                  const Icon = quickIcons[item.id as keyof typeof quickIcons] ?? Bot;
                  const disabled = item.status === "pending";
                  const badge = item.badge ?? (disabled ? "待配置" : "可用");
                  const disabledTitle = item.disabledReason ?? "该数字员工暂不可用";

                  return (
                    <button
                      className={`quick-action ${selectedQuickActionId === item.id ? "selected" : ""} ${
                        disabled ? "disabled" : ""
                      }`}
                      key={item.id}
                      type="button"
                      disabled={disabled}
                      aria-disabled={disabled}
                      title={disabled ? disabledTitle : item.title}
                      onClick={() => onSelectQuickAction(item)}
                    >
                      <span className={`quick-icon ${item.tone}`}>
                        <Icon size={15} />
                      </span>
                      <span>{item.title}</span>
                      {badge ? <strong>{badge}</strong> : null}
                    </button>
                  );
                })}
              </div>
              {quickActions.length > 4 ? (
                <button
                  className={`more-button ${quickActionsExpanded ? "expanded" : ""}`}
                  type="button"
                  aria-expanded={quickActionsExpanded}
                  onClick={() => setQuickActionsExpanded((expanded) => !expanded)}
                >
                  {quickActionsExpanded ? "收起" : "更多"} <ChevronDown size={14} />
                </button>
              ) : null}
            </section>

            <section className="sidebar-section history-section">
              <div className="section-heading muted">
                <span>{activeNav === "projects" ? "归档列表" : "历史任务"}</span>
              </div>
              <div className="history-list">
                {activeNav === "projects" ? (
                  archivedTasks.length === 0 ? (
                    <div className="history-empty">暂无归档记录</div>
                  ) : (
                    archivedTasks.map((task) => {
                      const Icon = statusIcon[task.status];
                      return (
                        <button
                          className={`history-item ${selectedTaskId === task.id ? "selected" : ""}`}
                          key={task.id}
                          onClick={() => onSelectTask(task)}
                          onContextMenu={handleContextMenu(task)}
                        >
                          <Icon size={14} />
                          <span className="history-title">{task.title}</span>
                          <time>{task.time}</time>
                          {task.agentName ? (
                            <span className="history-agent-badge">{task.agentName}</span>
                          ) : null}
                        </button>
                      );
                    })
                  )
                ) : recentTasks.length === 0 ? (
                  <div className="history-empty">暂无历史会话记录</div>
                ) : (
                  recentTasks.map((task) => {
                    const Icon = statusIcon[task.status];
                    return (
                      <button
                        className={`history-item ${selectedTaskId === task.id ? "selected" : ""}`}
                        key={task.id}
                        onClick={() => onSelectTask(task)}
                        onContextMenu={handleContextMenu(task)}
                      >
                        <Icon size={14} />
                        <span className="history-title">{task.title}</span>
                        <time>{task.time}</time>
                        {task.agentName ? (
                          <span className="history-agent-badge">{task.agentName}</span>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </section>
          </div>
          <button className="sidebar-resize-handle" aria-label="调整侧栏宽度" onPointerDown={onResizeStart} />
        </div>
      ) : null}

      {contextMenu ? (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenuY }}
          role="menu"
          aria-label="任务操作"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onRenameTask(contextMenu.task);
              closeContextMenu();
            }}
          >
            <Pencil size={14} />
            重命名
          </button>
          {activeNav !== "projects" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onArchiveTask(contextMenu.task);
                closeContextMenu();
              }}
            >
              <Archive size={14} />
              归档
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onRestoreTask(contextMenu.task);
                closeContextMenu();
              }}
            >
              <Archive size={14} />
              移动到任务
            </button>
          )}
          <div className="context-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              onDeleteTask(contextMenu.task);
              closeContextMenu();
            }}
          >
            <Trash2 size={14} />
            删除
          </button>
        </div>
      ) : null}
    </aside>
  );
}
