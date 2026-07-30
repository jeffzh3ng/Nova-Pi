import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  Archive,
  ArrowUpDown,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  ListFilter,
  MoreHorizontal,
  Pencil,
  Search,
  ShieldCheck,
  ShieldX,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { DigitalHuman, RecentTask } from "../types";

type TaskFilter = "all" | RecentTask["status"];
type TaskSort = "recent" | "oldest" | "title";

// "通用助手 / 其他" 桶的筛选项 id：覆盖 general-chat 及历史遗留（已下线）员工的 agentId。
const AGENT_FILTER_OTHER = "__other__";

type TaskCenterProps = {
  tasks: RecentTask[];
  employees?: DigitalHuman[];
  mcpConnectedCount: number;
  mcpTotalCount: number;
  mcpChecking: boolean;
  onSelectTask: (task: RecentTask) => void;
  onRenameTask: (task: RecentTask) => void;
  onArchiveTask: (task: RecentTask) => void;
  onDeleteTask: (task: RecentTask) => void;
};

const statusMeta = {
  running: { label: "进行中", icon: CirclePlay },
  done: { label: "已完成", icon: CheckCircle2 },
  paused: { label: "已暂停", icon: CirclePause },
  canceled: { label: "已取消", icon: XCircle },
} satisfies Record<RecentTask["status"], { label: string; icon: typeof CirclePlay }>;

const parseUpdatedAt = (task: RecentTask) => {
  if (!task.updatedAt) return 0;
  const normalized = task.updatedAt.includes("T")
    ? task.updatedAt
    : task.updatedAt.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  const value = new Date(normalized).getTime();
  return Number.isNaN(value) ? 0 : value;
};

const isUpdatedToday = (task: RecentTask) => {
  const timestamp = parseUpdatedAt(task);
  if (!timestamp) return false;
  const updated = new Date(timestamp);
  const today = new Date();
  return (
    updated.getFullYear() === today.getFullYear()
    && updated.getMonth() === today.getMonth()
    && updated.getDate() === today.getDate()
  );
};

export function TaskCenter({
  tasks,
  employees = [],
  mcpConnectedCount,
  mcpTotalCount,
  mcpChecking,
  onSelectTask,
  onRenameTask,
  onArchiveTask,
  onDeleteTask,
}: TaskCenterProps) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TaskSort>("recent");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftFilter, setDraftFilter] = useState<TaskFilter>("all");
  const [draftAgentFilter, setDraftAgentFilter] = useState<string>("all");
  const [menuTaskId, setMenuTaskId] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuTaskId) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuTaskId(undefined);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuTaskId]);

  useEffect(() => {
    if (!filterOpen) return;
    const close = (event: MouseEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterOpen]);

  const counts = useMemo(
    () => ({
      all: tasks.length,
      running: tasks.filter((task) => task.status === "running").length,
      done: tasks.filter((task) => task.status === "done").length,
      paused: tasks.filter((task) => task.status === "paused").length,
      canceled: tasks.filter((task) => task.status === "canceled").length,
    }),
    [tasks],
  );

  // 已知员工的 id 集合，用于把 general-chat 及历史遗留 agentId 归入"其他"桶。
  const knownAgentIds = useMemo(() => new Set(employees.map((human) => human.id)), [employees]);

  // 只展示当前任务列表中实际存在的员工，避免下拉框列出无任务的员工。
  const agentOptions = useMemo(() => {
    const countsById = new Map<string, number>();
    let otherCount = 0;
    tasks.forEach((task) => {
      const id = task.agentId ?? "";
      if (id && knownAgentIds.has(id)) {
        countsById.set(id, (countsById.get(id) ?? 0) + 1);
      } else {
        otherCount += 1;
      }
    });
    const known = employees
      .filter((human) => countsById.has(human.id))
      .map((human) => ({ id: human.id, label: human.name, count: countsById.get(human.id) ?? 0 }));
    const options: Array<{ id: string; label: string; count: number }> = [...known];
    if (otherCount > 0) {
      options.push({ id: AGENT_FILTER_OTHER, label: "通用助手 / 其他", count: otherCount });
    }
    return options;
  }, [employees, knownAgentIds, tasks]);

  const visibleTasks = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    const filtered = tasks.filter((task) => {
      if (filter !== "all" && task.status !== filter) return false;
      if (agentFilter !== "all") {
        if (agentFilter === AGENT_FILTER_OTHER) {
          if (knownAgentIds.has(task.agentId ?? "")) return false;
        } else if (task.agentId !== agentFilter) {
          return false;
        }
      }
      if (!keyword) return true;
      return [task.title, task.agentName, task.lastMessage]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("zh-CN").includes(keyword));
    });

    return [...filtered].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title, "zh-CN");
      const timeDelta = parseUpdatedAt(b) - parseUpdatedAt(a);
      return sort === "oldest" ? -timeDelta : timeDelta;
    });
  }, [agentFilter, filter, knownAgentIds, query, sort, tasks]);

  const taskGroups = useMemo(() => {
    const today: RecentTask[] = [];
    const earlier: RecentTask[] = [];
    visibleTasks.forEach((task) => {
      (isUpdatedToday(task) ? today : earlier).push(task);
    });
    return [
      { id: "today", label: "今天", tasks: today },
      { id: "earlier", label: "更早", tasks: earlier },
    ].filter((group) => group.tasks.length > 0);
  }, [visibleTasks]);

  const filterOptions: Array<{ id: TaskFilter; label: string }> = [
    { id: "all", label: "全部" },
    { id: "running", label: "进行中" },
    { id: "done", label: "已完成" },
    { id: "paused", label: "已暂停" },
  ];
  if (counts.canceled > 0) filterOptions.push({ id: "canceled", label: "已取消" });
  const primaryFilters = filterOptions.filter((item) => ["all", "running", "done"].includes(item.id));
  const selectedAgent = agentOptions.find((option) => option.id === agentFilter);
  const hasSecondaryStatus = filter === "paused" || filter === "canceled";
  const activeFilterCount = Number(hasSecondaryStatus) + Number(agentFilter !== "all");

  const openFilters = () => {
    setDraftFilter(filter);
    setDraftAgentFilter(agentFilter);
    setFilterOpen(true);
  };

  const applyFilters = () => {
    setFilter(draftFilter);
    setAgentFilter(draftAgentFilter);
    setFilterOpen(false);
  };

  const clearExtraFilters = () => {
    setFilter("all");
    setAgentFilter("all");
  };

  const openTask = (task: RecentTask) => {
    setMenuTaskId(undefined);
    onSelectTask(task);
  };

  const handleRowKeyDown = (task: RecentTask) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTask(task);
    }
  };

  const handleRowContextMenu = (task: RecentTask) => (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setMenuTaskId(task.id);
  };

  const mcpLabel = mcpChecking
    ? "MCP 检测中"
    : mcpConnectedCount > 0
      ? `MCP ${mcpConnectedCount}/${mcpTotalCount} 可用`
      : "MCP 未连接";

  return (
    <section className="task-center" aria-label="任务中心">
      <header className="task-center-header">
        <div>
          <p>任务管理</p>
          <h1>任务中心</h1>
          <span>集中查看任务进度，继续处理已有任务。<b>共 {tasks.length} 个任务</b></span>
        </div>
        <div className={`task-center-mcp ${mcpConnectedCount > 0 ? "connected" : ""}`}>
          {mcpConnectedCount > 0 ? <ShieldCheck size={16} /> : <ShieldX size={16} />}
          {mcpLabel}
        </div>
      </header>

      <div className="task-center-controls">
        <div className="task-center-toolbar">
          <div className="task-filter-group" aria-label="按状态筛选">
            {primaryFilters.map((item) => (
              <button
                type="button"
                key={item.id}
                className={filter === item.id ? "active" : ""}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label} <strong>{counts[item.id]}</strong>
              </button>
            ))}
          </div>
          <div className="task-center-tools">
            <label className="task-search">
              <Search size={16} />
              <input
                type="search"
                value={query}
                placeholder="搜索任务"
                aria-label="搜索任务"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="task-filter-menu" ref={filterRef}>
              <button
                type="button"
                className={`task-filter-trigger ${activeFilterCount > 0 ? "active" : ""}`}
                aria-expanded={filterOpen}
                onClick={() => (filterOpen ? setFilterOpen(false) : openFilters())}
              >
                <ListFilter size={15} />
                筛选
                {activeFilterCount > 0 ? <strong>{activeFilterCount}</strong> : null}
              </button>
              {filterOpen ? (
                <section className="task-filter-popover" role="dialog" aria-label="筛选任务">
                  <header>
                    <strong>筛选任务</strong>
                    <button type="button" aria-label="关闭筛选" onClick={() => setFilterOpen(false)}>
                      <X size={16} />
                    </button>
                  </header>
                  <div className="task-filter-section">
                    <span>任务状态</span>
                    <div className="task-filter-options">
                      {filterOptions.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className={draftFilter === item.id ? "selected" : ""}
                          aria-pressed={draftFilter === item.id}
                          onClick={() => setDraftFilter(item.id)}
                        >
                          <span>{item.label}</span>
                          <strong>{counts[item.id]}</strong>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="task-filter-section">
                    <span>数字员工</span>
                    <div className="task-agent-filter-options">
                      <button
                        type="button"
                        className={draftAgentFilter === "all" ? "selected" : ""}
                        aria-pressed={draftAgentFilter === "all"}
                        onClick={() => setDraftAgentFilter("all")}
                      >
                        <span>全部数字员工</span>
                        <strong>{tasks.length}</strong>
                      </button>
                      {agentOptions.map((option) => (
                        <button
                          type="button"
                          key={option.id}
                          className={draftAgentFilter === option.id ? "selected" : ""}
                          aria-pressed={draftAgentFilter === option.id}
                          onClick={() => setDraftAgentFilter(option.id)}
                        >
                          <span>{option.label}</span>
                          <strong>{option.count}</strong>
                        </button>
                      ))}
                    </div>
                  </div>
                  <footer>
                    <button type="button" onClick={() => { setDraftFilter("all"); setDraftAgentFilter("all"); }}>
                      重置
                    </button>
                    <button type="button" className="primary" onClick={applyFilters}>应用筛选</button>
                  </footer>
                </section>
              ) : null}
            </div>
            <label className="task-sort-control">
              <ArrowUpDown size={15} />
              <select value={sort} aria-label="任务排序" onChange={(event) => setSort(event.target.value as TaskSort)}>
                <option value="recent">最近更新</option>
                <option value="oldest">最早更新</option>
                <option value="title">任务名称</option>
              </select>
            </label>
          </div>
        </div>
        {activeFilterCount > 0 ? (
          <div className="task-active-filters" aria-label="当前筛选条件">
            {hasSecondaryStatus ? (
              <button type="button" onClick={() => setFilter("all")}>
                {statusMeta[filter].label}<X size={12} />
              </button>
            ) : null}
            {selectedAgent ? (
              <button type="button" onClick={() => setAgentFilter("all")}>
                {selectedAgent.label}<X size={12} />
              </button>
            ) : null}
            <button type="button" className="clear" onClick={clearExtraFilters}>清除筛选</button>
          </div>
        ) : null}
      </div>

      <div className="task-center-list">
        {visibleTasks.length === 0 ? (
          <div className="task-center-empty">
            <Search size={24} />
            <strong>{tasks.length === 0 ? "暂无任务" : "没有匹配的任务"}</strong>
            <span>{tasks.length === 0 ? "请从首页选择数字员工创建任务。" : "请调整筛选条件或搜索关键词。"}</span>
          </div>
        ) : (
          <div className="task-center-groups">
            {taskGroups.map((group) => (
              <section className="task-center-group" key={group.id}>
                <header className="task-center-group-header">
                  <span aria-hidden="true" />
                  <h2>{group.label}</h2>
                  <strong>{group.tasks.length}</strong>
                </header>
                <div className="task-card-grid">
                  {group.tasks.map((task) => {
                    const meta = statusMeta[task.status];
                    const StatusIcon = meta.icon;
                    const menuOpen = menuTaskId === task.id;
                    return (
                      <div
                        className={`task-center-row ${task.status}`}
                        key={task.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openTask(task)}
                        onKeyDown={handleRowKeyDown(task)}
                        onContextMenu={handleRowContextMenu(task)}
                      >
                        <div className="task-card-header">
                          <span className={`task-row-status-icon ${task.status}`} aria-hidden="true">
                            <StatusIcon size={19} />
                          </span>
                          <div className="task-row-title">
                            <strong title={task.title}>{task.title}</strong>
                            <span>{task.agentName ?? "通用助手"}</span>
                          </div>
                          <span className={`task-status-pill ${task.status}`}>{meta.label}</span>
                          <div className="task-row-menu" ref={menuOpen ? menuRef : undefined}>
                            <button
                              type="button"
                              aria-label={`管理任务 ${task.title}`}
                              aria-expanded={menuOpen}
                              onClick={(event) => {
                                event.stopPropagation();
                                setMenuTaskId((current) => (current === task.id ? undefined : task.id));
                              }}
                            >
                              <MoreHorizontal size={18} />
                            </button>
                            {menuOpen ? (
                              <div className="task-row-menu-popover" role="menu">
                                <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); setMenuTaskId(undefined); onRenameTask(task); }}>
                                  <Pencil size={14} /> 重命名
                                </button>
                                <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); setMenuTaskId(undefined); onArchiveTask(task); }}>
                                  <Archive size={14} /> 归档
                                </button>
                                <button className="danger" type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); setMenuTaskId(undefined); onDeleteTask(task); }}>
                                  <Trash2 size={14} /> 删除
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <p>{task.lastMessage || "暂无任务摘要"}</p>
                        <div className="task-card-footer">
                          <div className={`task-card-status-line ${task.status}`} aria-hidden="true">
                            <span />
                          </div>
                          <time>{task.time ? `更新于 ${task.time}` : "刚刚更新"}</time>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
