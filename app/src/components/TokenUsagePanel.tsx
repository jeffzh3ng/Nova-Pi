import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, ArrowDown, ArrowUp, TrendingUp, Zap } from "lucide-react";

type TokenUsageData = {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  callCount: number;
  records: {
    id: number;
    model: string;
    agentName: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    createdAt: string;
  }[];
};

const fmt = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

type DailyTotals = Record<string, number>;

const computeDailyTrend = (records: TokenUsageData["records"], days = 7): DailyTotals => {
  const today = new Date();
  const trend: DailyTotals = {};
  // Initialize all days in range
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getMonth() + 1}/${d.getDate()}`;
    trend[key] = 0;
  }
  // Aggregate records by date
  for (const r of records) {
    const d = new Date(r.createdAt.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) continue;
    const delta = (today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    if (delta < days) {
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      trend[key] = (trend[key] ?? 0) + r.totalTokens;
    }
  }
  return trend;
};

export function TokenUsagePanel() {
  const [data, setData] = useState<TokenUsageData | null>(null);

  useEffect(() => {
    const fetch = () => invoke<TokenUsageData>("list_token_usage").then(setData).catch(console.error);
    fetch();
    const timer = setInterval(fetch, 30_000);
    return () => clearInterval(timer);
  }, []);

  const trend = useMemo(() => (data ? computeDailyTrend(data.records) : null), [data]);

  if (!data || data.callCount === 0) {
    return (
      <section className="usage-panel">
        <div className="usage-empty">
          <Zap size={28} />
          <p>暂无 Token 消耗记录</p>
        </div>
      </section>
    );
  }

  const trendEntries = trend ? Object.entries(trend) : [];
  const trendMax = Math.max(...trendEntries.map(([, v]) => v), 1);

  return (
    <section className="usage-panel">
      {/* ── 左侧：总计 + 趋势 ── */}
      <div className="usage-left">
        <div className="usage-hero">
          <div className="usage-hero-total">
            <span className="usage-hero-value">{fmt(data.totalTokens)}</span>
            <span className="usage-hero-label">Token 总消耗</span>
          </div>
          <div className="usage-hero-stats">
            <div className="usage-stat">
              <ArrowUp size={13} />
              <span>{fmt(data.totalPromptTokens)}</span>
            </div>
            <div className="usage-stat">
              <ArrowDown size={13} />
              <span>{fmt(data.totalCompletionTokens)}</span>
            </div>
            <div className="usage-stat">
              <Activity size={13} />
              <span>{data.callCount}次</span>
            </div>
          </div>
        </div>

        <div className="usage-trend-card">
          <div className="usage-trend-header">
            <TrendingUp size={16} />
            <span>使用趋势 (近 7 天)</span>
          </div>
          <div className="usage-trend-chart">
            {trendEntries.map(([date, value]) => {
              const height = value > 0 ? Math.max(4, (value / trendMax) * 120) : 2;
              return (
                <div className="usage-trend-bar-wrap" key={date}>
                  <span className="usage-trend-value">{value > 0 ? fmt(value) : ""}</span>
                  <div
                    className="usage-trend-bar"
                    style={{ height: `${height}px` }}
                    title={`${date}: ${fmt(value)}`}
                  />
                  <span className="usage-trend-date">{date}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── 右侧：调用记录 ── */}
      <div className="usage-right">
        <div className="usage-records">
          {data.records.slice(0, 20).map((r) => (
            <div className="usage-record" key={r.id}>
              <div className="usage-record-left">
                <span className="usage-record-agent">{r.agentName || r.model}</span>
                <span className="usage-record-meta">
                  {r.model} · {r.createdAt}
                </span>
              </div>
              <div className="usage-record-right">
                <span className="usage-record-total">{fmt(r.totalTokens)}</span>
                <span className="usage-record-detail">
                  入 {fmt(r.promptTokens)} · 出 {fmt(r.completionTokens)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
