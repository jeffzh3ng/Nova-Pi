import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";

type TokenActivityMode = "daily" | "weekly" | "cumulative";

type TokenDailyTotal = {
  date: string;
  totalTokens: number;
  callCount: number;
};

type TokenUsageSummary = {
  totalTokens: number;
  callCount: number;
  dailyTotals: TokenDailyTotal[];
};

type ActivityCell = {
  key: string;
  label: string;
  tokens: number;
  calls: number;
  padding?: boolean;
};

type ActivityLabel = {
  column: number;
  text: string;
};

type ActivityView = {
  cells: ActivityCell[];
  labels: ActivityLabel[];
  rows: number;
  columns: number;
  totalTokens: number;
  callCount: number;
  periodLabel: string;
};

type ActivityTooltip = {
  label: string;
  tokens: number;
  calls: number;
  x: number;
  y: number;
};

const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());

const addDays = (value: Date, amount: number) => {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
};

const addMonths = (value: Date, amount: number) => (
  new Date(value.getFullYear(), value.getMonth() + amount, 1)
);

const dateKey = (value: Date) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const monthKey = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;

const mondayOffset = (value: Date) => (value.getDay() + 6) % 7;

const fmt = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

const buildDailyMap = (dailyTotals: TokenDailyTotal[]) => (
  new Map(dailyTotals.map((item) => [item.date, item]))
);

const sumCells = (cells: ActivityCell[]) => cells.reduce(
  (totals, cell) => ({
    totalTokens: totals.totalTokens + (cell.padding ? 0 : cell.tokens),
    callCount: totals.callCount + (cell.padding ? 0 : cell.calls),
  }),
  { totalTokens: 0, callCount: 0 },
);

const removeCrowdedLeadingLabel = (labels: ActivityLabel[]) => {
  if (labels.length > 1 && labels[1].column - labels[0].column < 3) labels.shift();
};

const buildDailyView = (dailyTotals: TokenDailyTotal[]): ActivityView => {
  const totalsByDay = buildDailyMap(dailyTotals);
  const today = startOfDay(new Date());
  const rangeStart = addDays(today, -364);
  const graphStart = addDays(rangeStart, -mondayOffset(rangeStart));
  const graphEnd = addDays(today, 6 - mondayOffset(today));
  const cells: ActivityCell[] = [];

  for (let cursor = graphStart; cursor <= graphEnd; cursor = addDays(cursor, 1)) {
    const key = dateKey(cursor);
    const total = totalsByDay.get(key);
    const padding = cursor < rangeStart || cursor > today;
    cells.push({
      key,
      label: `${cursor.getFullYear()}年${cursor.getMonth() + 1}月${cursor.getDate()}日`,
      tokens: padding ? 0 : total?.totalTokens ?? 0,
      calls: padding ? 0 : total?.callCount ?? 0,
      padding,
    });
  }

  const columns = Math.ceil(cells.length / 7);
  const labels: ActivityLabel[] = [];
  let previousMonth = -1;
  for (let column = 0; column < columns; column += 1) {
    const weekStart = addDays(graphStart, column * 7);
    if (weekStart.getMonth() !== previousMonth) {
      labels.push({ column, text: `${weekStart.getMonth() + 1}月` });
      previousMonth = weekStart.getMonth();
    }
  }
  removeCrowdedLeadingLabel(labels);

  return { cells, labels, rows: 7, columns, ...sumCells(cells), periodLabel: "近一年" };
};

const buildWeeklyView = (dailyTotals: TokenDailyTotal[]): ActivityView => {
  const totalsByDay = buildDailyMap(dailyTotals);
  const today = startOfDay(new Date());
  const currentWeekStart = addDays(today, -mondayOffset(today));
  const graphStart = addDays(currentWeekStart, -51 * 7);
  const cells: ActivityCell[] = [];
  const labels: ActivityLabel[] = [];
  let previousMonth = -1;

  for (let column = 0; column < 52; column += 1) {
    const weekStart = addDays(graphStart, column * 7);
    let tokens = 0;
    let calls = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(weekStart, offset);
      if (day > today) continue;
      const total = totalsByDay.get(dateKey(day));
      tokens += total?.totalTokens ?? 0;
      calls += total?.callCount ?? 0;
    }
    const weekEnd = addDays(weekStart, 6);
    cells.push({
      key: dateKey(weekStart),
      label: `${weekStart.getMonth() + 1}月${weekStart.getDate()}日—${weekEnd.getMonth() + 1}月${weekEnd.getDate()}日`,
      tokens,
      calls,
    });
    if (weekStart.getMonth() !== previousMonth) {
      labels.push({ column, text: `${weekStart.getMonth() + 1}月` });
      previousMonth = weekStart.getMonth();
    }
  }
  removeCrowdedLeadingLabel(labels);

  return { cells, labels, rows: 1, columns: 52, ...sumCells(cells), periodLabel: "近52周" };
};

const buildCumulativeView = (
  dailyTotals: TokenDailyTotal[],
  summary: TokenUsageSummary | null,
): ActivityView => {
  const currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const graphStart = addMonths(currentMonth, -11);
  const totalsByMonth = new Map<string, { tokens: number; calls: number }>();
  for (const item of dailyTotals) {
    const key = item.date.slice(0, 7);
    const current = totalsByMonth.get(key) ?? { tokens: 0, calls: 0 };
    current.tokens += item.totalTokens;
    current.calls += item.callCount;
    totalsByMonth.set(key, current);
  }

  const cells: ActivityCell[] = [];
  const labels: ActivityLabel[] = [];
  for (let column = 0; column < 12; column += 1) {
    const month = addMonths(graphStart, column);
    const key = monthKey(month);
    const total = totalsByMonth.get(key);
    cells.push({
      key,
      label: `${month.getFullYear()}年${month.getMonth() + 1}月`,
      tokens: total?.tokens ?? 0,
      calls: total?.calls ?? 0,
    });
    labels.push({ column, text: `${month.getMonth() + 1}月` });
  }

  return {
    cells,
    labels,
    rows: 1,
    columns: 12,
    totalTokens: summary?.totalTokens ?? 0,
    callCount: summary?.callCount ?? 0,
    periodLabel: "全部记录",
  };
};

/** 按分位数划分强度档位:非零格子升序后取 p40 / p75 / p92 三个阈值,
    tokens >= 对应阈值时进入 2 / 3 / 4 档。保证大部分日子落在浅色档,
    只有最高约 8% 的日子取最深色。 */
const computeLevelThresholds = (tokensList: number[]): readonly [number, number, number] => {
  const sorted = [...tokensList].sort((a, b) => a - b);
  const n = sorted.length;
  const pick = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
  return [pick(0.4), pick(0.75), pick(0.92)];
};

const intensityLevel = (tokens: number, thresholds: readonly [number, number, number] | null) => {
  if (tokens <= 0 || !thresholds) return 0;
  if (tokens >= thresholds[2]) return 4;
  if (tokens >= thresholds[1]) return 3;
  if (tokens >= thresholds[0]) return 2;
  return 1;
};

export function TokenActivityCard() {
  const [mode, setMode] = useState<TokenActivityMode>("daily");
  const [data, setData] = useState<TokenUsageSummary | null>(null);
  const [error, setError] = useState("");
  const [tooltip, setTooltip] = useState<ActivityTooltip | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const summary = await invoke<TokenUsageSummary>("list_token_usage");
        if (!active) return;
        setData(summary);
        setError("");
      } catch {
        if (active) setError("Token 统计暂时无法读取");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const view = useMemo(() => {
    const dailyTotals = data?.dailyTotals ?? [];
    if (mode === "weekly") return buildWeeklyView(dailyTotals);
    if (mode === "cumulative") return buildCumulativeView(dailyTotals, data);
    return buildDailyView(dailyTotals);
  }, [data, mode]);
  const levelThresholds = useMemo(() => {
    const nonzero = view.cells.map((cell) => cell.tokens).filter((tokens) => tokens > 0);
    return nonzero.length > 0 ? computeLevelThresholds(nonzero) : null;
  }, [view]);
  const chartStyle = {
    gridTemplateColumns: `repeat(${view.columns}, 12px)`,
    gridTemplateRows: `repeat(${view.rows}, 12px)`,
  };
  const labelStyle = { gridTemplateColumns: `repeat(${view.columns}, 12px)` };
  const showTooltip = (event: ReactPointerEvent<HTMLSpanElement>, cell: ActivityCell) => {
    if (cell.padding) return;
    const halfWidth = 112;
    setTooltip({
      label: cell.label,
      tokens: cell.tokens,
      calls: cell.calls,
      x: Math.min(window.innerWidth - halfWidth, Math.max(halfWidth, event.clientX)),
      y: event.clientY,
    });
  };

  return (
    <section className="settings-section token-activity-section" aria-label="Token 活动">
      <header className="settings-section-header token-activity-header">
        <div>
          <h2>Token 活动</h2>
          <p className="mcp-status-line">
            {error || (data ? `${view.periodLabel} · ${fmt(view.totalTokens)} Token · ${view.callCount} 次调用` : "正在读取统计数据...")}
          </p>
        </div>
        <div className="token-activity-tabs" role="tablist" aria-label="Token 统计周期">
          {(["daily", "weekly", "cumulative"] as const).map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={mode === item ? "is-active" : ""}
              key={item}
              onClick={() => setMode(item)}
            >
              {item === "daily" ? "每日" : item === "weekly" ? "每周" : "累计"}
            </button>
          ))}
        </div>
      </header>

      <div className="token-activity-scroll">
        <div className={`token-activity-chart is-${mode}`}>
          <div className="token-activity-months" style={labelStyle} aria-hidden="true">
            {view.labels.map((label) => (
              <span style={{ gridColumn: label.column + 1 }} key={`${label.column}-${label.text}`}>{label.text}</span>
            ))}
          </div>
          <div
            className="token-activity-grid"
            style={chartStyle}
            role="img"
            aria-label={`${view.periodLabel} Token 使用热力图`}
          >
            {view.cells.map((cell) => {
              const level = intensityLevel(cell.tokens, levelThresholds);
              return (
                <span
                  className={`token-activity-cell level-${level} ${cell.padding ? "is-padding" : ""}`}
                  key={cell.key}
                  aria-label={cell.padding
                    ? undefined
                    : `${cell.label}，${fmt(cell.tokens)} Token，${cell.calls} 次调用`}
                  aria-hidden={cell.padding || undefined}
                  onPointerEnter={(event) => showTooltip(event, cell)}
                  onPointerMove={(event) => showTooltip(event, cell)}
                  onPointerLeave={() => setTooltip(null)}
                />
              );
            })}
          </div>
        </div>
      </div>

      <footer className="token-activity-footer">
        <span>颜色越深表示 Token 使用越多</span>
        <span className="token-activity-legend" aria-label="Token 使用强度图例">
          少
          {[0, 1, 2, 3, 4].map((level) => <i className={`level-${level}`} key={level} />)}
          多
        </span>
      </footer>
      {tooltip ? (
        <div
          className="token-activity-tooltip"
          role="tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <strong>{tooltip.label}</strong>
          <span>
            <b>{fmt(tooltip.tokens)}</b> Token
            <i aria-hidden="true" />
            {tooltip.calls} 次调用
          </span>
        </div>
      ) : null}
    </section>
  );
}
