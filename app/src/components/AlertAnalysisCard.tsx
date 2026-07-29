import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HelpCircle,
  Info,
  Server,
  ShieldAlert,
} from "lucide-react";
import type { AlertAnalysisResult } from "../types";
import { normalizeAlertAnalysisResult, normalizeTextList } from "../services/alertAnalysisText";
import { showAppError } from "../services/appDialog";

/** Coerce untrusted findings into a safe array of finding objects. */
const asFindings = (value: unknown): { title?: string; severity?: string; evidence?: string; impact?: string }[] =>
  Array.isArray(value)
    ? value
        .map((item) =>
          item && typeof item === "object"
            ? item
            : { title: String(item ?? "") },
        )
        .filter((item) => item)
    : [];

const severityConfig: Record<
  string,
  { color: string; bg: string; icon: typeof AlertTriangle }
> = {
  "紧急": {
    color: "var(--color-danger, #dc2626)",
    bg: "rgba(220,38,38,0.1)",
    icon: ShieldAlert,
  },
  "高": {
    color: "var(--color-warning, #ea580c)",
    bg: "rgba(234,88,12,0.1)",
    icon: AlertTriangle,
  },
  "中": {
    color: "var(--color-caution, #ca8a04)",
    bg: "rgba(202,138,4,0.1)",
    icon: AlertTriangle,
  },
  "低": {
    color: "var(--color-info, #2563eb)",
    bg: "rgba(37,99,235,0.1)",
    icon: Info,
  },
  "待确认": {
    color: "var(--color-muted, #6b7280)",
    bg: "rgba(107,114,128,0.1)",
    icon: HelpCircle,
  },
};

const formatExportMarkdown = (input: AlertAnalysisResult) => {
  const result = normalizeAlertAnalysisResult(input);
  const affectedAssets = normalizeTextList(result.affectedAssets);
  const recommendedActions = normalizeTextList(result.recommendedActions);
  const questions = normalizeTextList(result.questions);
  const riskNotes = normalizeTextList(result.riskNotes);
  const lines = [
    `# 告警分析报告`,
    ``,
    `| 项目 | 内容 |`,
    `|------|------|`,
    `| 风险等级 | ${result.severity} |`,
    `| 可信度 | ${result.confidence} |`,
    `| 模型状态 | ${result.usedModel ? `已调用 ${result.model}` : `${result.model} 未完成调用，已生成初筛`} |`,
    `| 生成时间 | ${result.generatedAt ?? "-"} |`,
    ``,
    `## 研判结论`,
    ``,
    result.overview,
    ``,
  ];

  if (result.findings?.length) {
    lines.push(`## 关键发现`);
    lines.push(``);
    for (const [index, finding] of result.findings.entries()) {
      if (!finding.title && !finding.evidence && !finding.impact) continue;
      lines.push(`### ${index + 1}. ${finding.title || `发现 ${index + 1}`}${finding.severity ? `（${finding.severity}）` : ""}`);
      if (finding.evidence) lines.push(`- 证据：${finding.evidence}`);
      if (finding.impact) lines.push(`- 影响：${finding.impact}`);
      lines.push(``);
    }
  }

  if (affectedAssets.length) {
    lines.push(`## 受影响资产`);
    lines.push(``);
    for (const asset of affectedAssets) {
      lines.push(`- ${asset}`);
    }
    lines.push(``);
  }

  if (recommendedActions.length) {
    lines.push(`## 建议动作`);
    lines.push(``);
    for (const [index, action] of recommendedActions.entries()) {
      lines.push(`${index + 1}. ${action}`);
    }
    lines.push(``);
  }

  if (questions.length) {
    lines.push(`## 待确认问题`);
    lines.push(``);
    for (const [index, question] of questions.entries()) {
      lines.push(`${index + 1}. ${question}`);
    }
    lines.push(``);
  }

  if (riskNotes.length) {
    lines.push(`## 注意事项`);
    lines.push(``);
    for (const note of riskNotes) {
      lines.push(`- ${note}`);
    }
    lines.push(``);
  }

  if (result.rawModelOutput) {
    lines.push(`## 原始模型输出`);
    lines.push(``);
    lines.push("```");
    lines.push(result.rawModelOutput);
    lines.push("```");
    lines.push(``);
  }

  return lines.join("\n");
};

const handleExport = async (result: AlertAnalysisResult) => {
  try {
    const markdown = formatExportMarkdown(result);
    const tempPath = await invoke<string>("write_temp_text_file", {
      content: markdown,
      extension: "md",
    });
    const savedTo = await invoke<string>("save_file_as", { sourcePath: tempPath });
    if (savedTo) {
      // 另存为成功后打开导出的文件所在位置/文件
      invoke("open_file_path", { path: savedTo }).catch(() => {});
    }
  } catch (error) {
    const message = String(error);
    // 用户取消保存对话框（Rust rfd 返回"已取消"）属正常行为，不打扰。
    if (message === "已取消" || message.includes("已取消")) return;
    console.error("导出告警分析报告失败", error);
    // 不再静默吞掉：把真实错误弹给用户，便于排查。
    showAppError(message, "导出报告失败");
  }
};

export function AlertAnalysisCard({ result: input }: { result: AlertAnalysisResult }) {
  const result = normalizeAlertAnalysisResult(input);
  const findings = asFindings(result.findings);
  const recommendedActions = normalizeTextList(result.recommendedActions);
  const affectedAssets = normalizeTextList(result.affectedAssets);
  const riskNotes = normalizeTextList(result.riskNotes);
  const filteredFindings = findings.filter((f) => f.title || f.evidence || f.impact);

  const isTrivial =
    !result.usedModel && findings.length === 0 && recommendedActions.length === 0;

  if (isTrivial) {
    return (
      <div className="alert-analysis-card alert-analysis-card-minimal">
        <p>{result.overview}</p>
      </div>
    );
  }

  const sev = severityConfig[result.severity] ?? severityConfig["待确认"];
  const SevIcon = sev.icon;

  return (
    <div className="alert-analysis-card">
      {/* Header */}
      <div className="alert-card-header">
        <span
          className="alert-severity-badge"
          style={{ color: sev.color, background: sev.bg }}
        >
          <SevIcon size={15} />
          {result.severity}
        </span>
        <span className="alert-confidence">
          <CheckCircle2 size={13} />
          可信度：{result.confidence}
        </span>
        <span className="alert-model">
          {result.usedModel
            ? `模型：${result.model}`
            : `${result.model} 未调用，已生成初筛`}
        </span>
      </div>

      {/* Overview */}
      <p className="alert-overview">{result.overview}</p>

      {/* Findings */}
      {filteredFindings.length > 0 && (
        <div className="alert-section">
          <h4 className="alert-section-title">关键发现</h4>
          {filteredFindings.map((finding, index) => (
            <div key={index} className="alert-finding">
              <div className="alert-finding-head">
                <span className="alert-finding-index">{index + 1}</span>
                <span className="alert-finding-title">
                  {finding.title || `发现 ${index + 1}`}
                  {finding.severity ? `（${finding.severity}）` : ""}
                </span>
              </div>
              {finding.evidence ? (
                <div className="alert-finding-detail">
                  证据：{finding.evidence}
                </div>
              ) : null}
              {finding.impact ? (
                <div className="alert-finding-detail">
                  影响：{finding.impact}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Affected Assets */}
      {affectedAssets.length > 0 && (
        <div className="alert-section">
          <h4 className="alert-section-title">
            <Server size={13} /> 受影响资产
          </h4>
          <div className="alert-asset-chips">
            {affectedAssets.map((asset, index) => (
              <span key={index} className="alert-asset-chip">
                {asset}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recommended Actions */}
      {recommendedActions.length > 0 && (
        <div className="alert-section">
          <h4 className="alert-section-title">建议动作</h4>
          <ol className="alert-action-list">
            {recommendedActions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Risk Notes */}
      {riskNotes.length > 0 && (
        <div className="alert-section">
          <h4 className="alert-section-title">
            <AlertTriangle size={13} /> 注意事项
          </h4>
          <ul className="alert-risk-notes">
            {riskNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Raw model output (collapsed) */}
      {result.rawModelOutput ? (
        <details className="alert-raw-output">
          <summary>原始模型输出（调试用）</summary>
          <pre>{result.rawModelOutput}</pre>
        </details>
      ) : null}

      {/* Export button */}
      <button
        type="button"
        className="alert-export-btn"
        onClick={() => handleExport(result)}
      >
        <Download size={14} />
        导出报告
      </button>
    </div>
  );
}
