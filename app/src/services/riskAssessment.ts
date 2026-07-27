import { invoke } from "@tauri-apps/api/core";
import type { RiskAssessmentResult, RiskAssessmentJob } from "../types";
import { callMcpTool } from "./mcpClient";
import {
  DATA_RISK_ASSESSMENT_MCP_SERVICE,
  DATA_RISK_CANCEL_TOOL,
  DATA_RISK_GET_STATUS_TOOL,
  DATA_RISK_LIST_MATRICES_TOOL,
  DATA_RISK_SUBMIT_TOOL,
  DATA_RISK_UPLOAD_TOOL,
} from "./mcpSettings";

export type RemoteRiskMaterial = {
  materialId: string;
  fileName: string;
  fileCount: number;
  totalSize: number;
  sha256: string;
};

export type RiskTaskStatus = {
  taskId: string;
  materialId: string;
  matrixName: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  progress?: string;
  progressPct: number;
  result?: Record<string, unknown>;
  error?: string;
  resultFileId?: string;
  downloadAvailable: boolean;
  outputFile?: string;
};

export type DownloadedRiskResult = {
  path: string;
  fileName: string;
};

const parseRecord = (raw: unknown): Record<string, unknown> => {
  let value = raw;
  for (let depth = 0; depth < 2; depth += 1) {
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value as Record<string, unknown>).length === 1
      && "result" in (value as Record<string, unknown>)
    ) {
      value = (value as Record<string, unknown>).result;
    }
    if (typeof value !== "string") break;
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(typeof value === "string" && value ? value : "MCP 返回了无效结果。");
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) {
      throw new Error(record.error);
    }
    return record;
  }
  throw new Error("MCP 返回了无效结果。");
};

const requiredString = (record: Record<string, unknown>, key: string, label: string) => {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MCP 结果缺少${label}。`);
  }
  return value.trim();
};

export async function listRiskAssessmentMatrices(): Promise<string[]> {
  const raw = await callMcpTool<unknown>(
    DATA_RISK_ASSESSMENT_MCP_SERVICE,
    DATA_RISK_LIST_MATRICES_TOOL,
    { export_xlsx: false },
    { timeoutSecs: 30 },
  );
  const record = parseRecord(raw);
  const matrices = Array.isArray(record.matrices) ? record.matrices : [];
  return matrices
    .map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>).name : undefined,
    )
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

export async function pickAndUploadRemoteRiskMaterial(
  sourcePath?: string,
): Promise<RemoteRiskMaterial> {
  return await invoke<RemoteRiskMaterial>("upload_risk_assessment_material", {
    serviceId: DATA_RISK_ASSESSMENT_MCP_SERVICE,
    sourcePath,
  });
}

export async function uploadLocalRiskMaterial(
  zipPath: string,
): Promise<RemoteRiskMaterial> {
  const raw = await callMcpTool<unknown>(
    DATA_RISK_ASSESSMENT_MCP_SERVICE,
    DATA_RISK_UPLOAD_TOOL,
    { zip_path: zipPath },
    { timeoutSecs: 30 * 60 },
  );
  const record = parseRecord(raw);
  return {
    materialId: requiredString(record, "material_id", " material_id"),
    fileName:
      typeof record.zip_filename === "string" && record.zip_filename.trim()
        ? record.zip_filename
        : "materials.zip",
    fileCount: typeof record.file_count === "number" ? record.file_count : 0,
    totalSize: typeof record.total_size === "number" ? record.total_size : 0,
    sha256: typeof record.sha256 === "string" ? record.sha256 : "",
  };
}

export async function submitRiskAssessment(
  materialId: string,
  matrixName: string,
): Promise<RiskTaskStatus> {
  const raw = await callMcpTool<unknown>(
    DATA_RISK_ASSESSMENT_MCP_SERVICE,
    DATA_RISK_SUBMIT_TOOL,
    { material_id: materialId, matrix_name: matrixName },
    { timeoutSecs: 60 },
  );
  return normalizeTaskStatus(parseRecord(raw));
}

export async function getRiskAssessmentStatus(
  taskId: string,
): Promise<RiskTaskStatus> {
  const raw = await callMcpTool<unknown>(
    DATA_RISK_ASSESSMENT_MCP_SERVICE,
    DATA_RISK_GET_STATUS_TOOL,
    { task_id: taskId },
    { timeoutSecs: 30 },
  );
  return normalizeTaskStatus(parseRecord(raw));
}

export async function cancelRiskAssessment(taskId: string): Promise<RiskTaskStatus> {
  const raw = await callMcpTool<unknown>(
    DATA_RISK_ASSESSMENT_MCP_SERVICE,
    DATA_RISK_CANCEL_TOOL,
    { task_id: taskId },
    { timeoutSecs: 30 },
  );
  return normalizeTaskStatus(parseRecord(raw));
}

export async function downloadRiskAssessmentResult(
  taskId: string,
  sourcePath?: string,
): Promise<DownloadedRiskResult> {
  return await invoke<DownloadedRiskResult>("download_risk_assessment_result", {
    serviceId: DATA_RISK_ASSESSMENT_MCP_SERVICE,
    taskId,
    sourcePath,
  });
}

const normalizeTaskStatus = (record: Record<string, unknown>): RiskTaskStatus => {
  const status = requiredString(record, "status", " status") as RiskTaskStatus["status"];
  if (!["pending", "running", "completed", "failed", "canceled"].includes(status)) {
    throw new Error(`MCP 返回了未知任务状态：${status}`);
  }
  const result =
    record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : undefined;
  return {
    taskId: requiredString(record, "task_id", " task_id"),
    materialId: requiredString(record, "material_id", " material_id"),
    matrixName: requiredString(record, "matrix_name", " matrix_name"),
    status,
    progress: typeof record.progress === "string" ? record.progress : undefined,
    progressPct: typeof record.progress_pct === "number" ? record.progress_pct : 0,
    result,
    error: typeof record.error === "string" && record.error.trim() ? record.error : undefined,
    resultFileId:
      typeof record.result_file_id === "string" && record.result_file_id.trim()
        ? record.result_file_id
        : undefined,
    downloadAvailable: record.download_available === true,
    outputFile:
      typeof record.output_file === "string" && record.output_file.trim()
        ? record.output_file
        : undefined,
  };
};

export function normalizeRiskAssessmentResult(
  raw: Record<string, unknown>,
  localOutputPath?: string,
): RiskAssessmentResult {
  const statusCounts =
    raw.status_counts && typeof raw.status_counts === "object" && !Array.isArray(raw.status_counts)
      ? (raw.status_counts as Record<string, unknown>)
      : {};
  const itemCount = typeof raw.item_count === "number" ? raw.item_count : undefined;
  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((note): note is string => typeof note === "string")
    : [];
  const matrixName = typeof raw.matrix_name === "string" ? raw.matrix_name : "";
  const statusLines = Object.entries(statusCounts)
    .filter(([, count]) => typeof count === "number")
    .map(([status, count]) => `- ${status}：${count} 项`)
    .join("\n");
  const overview = [
    `已基于矩阵「${matrixName || "默认"}」完成 ${itemCount ?? ""} 项评估。`,
    statusLines ? `\n**评估结果统计：**\n${statusLines}` : "",
    notes.length ? `\n**说明：**\n${notes.map((note) => `- ${note}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    module: "data-risk-assessment",
    overview,
    detail: JSON.stringify(raw, null, 2),
    raw,
    outputFile: localOutputPath,
  };
}

export function contextFromMessages(messages: Array<{ riskAssessmentJob?: RiskAssessmentJob }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const job = messages[index].riskAssessmentJob;
    if (job?.materialId) return job;
  }
  return undefined;
}
