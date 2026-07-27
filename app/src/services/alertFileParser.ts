/**
 * 告警文件解析工具（从原 Nova agentRuntime.ts 拆出，仅保留附件流程需要的纯解析逻辑）。
 *
 * 新架构中，pi 的 agent loop 接管了研判编排，但前端附件上传时仍需把告警原文/截图 OCR
 * 解析成结构化字段，以便在输入框预填和提交时携带上下文。
 */

export type ParsedAlertFields = {
  sourceSystem?: string;
  sourceDevice?: string;
  occurredAt?: string;
  sourceIp?: string;
  destinationIp?: string;
  asset?: string;
  businessContext?: string;
  currentStatus?: string;
};

export type ParsedAlertFile = {
  alertText: string;
  fields: ParsedAlertFields;
};

const ALERT_FIELD_LABELS: Record<string, string[]> = {
  sourceSystem: ["来源系统", "sourceSystem", "source system", "来源", "告警来源"],
  sourceDevice: ["来源设备", "sourceDevice", "source device", "探针", "设备名称", "上报设备"],
  occurredAt: ["发生时间", "occurredAt", "occurred at", "告警时间", "时间", "触发时间", "检测时间"],
  sourceIp: ["源IP", "源ip", "sourceIp", "source ip", "源地址", "src_ip", "src ip", "来源IP", "攻击源IP"],
  destinationIp: ["目的IP", "目的ip", "destinationIp", "destination ip", "目的地址", "dst_ip", "dst ip", "目标IP", "受害IP"],
  asset: ["资产", "asset", "受影响资产", "业务系统", "主机", "主机名", "受影响主机"],
  businessContext: ["业务上下文", "businessContext", "business context", "业务背景", "资产重要性", "暴露面"],
  currentStatus: ["当前状态", "currentStatus", "current status", "处置状态", "当前处置", "已采取措施"],
};

const isAlertFieldLabel = (value: string): boolean =>
  Object.values(ALERT_FIELD_LABELS).some((labels) =>
    labels.some((label) => label.toLowerCase() === value.toLowerCase()),
  );

const extractLabeledAlertField = (text: string, labels: string[]): string | undefined => {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escaped}\\s*[:：]\\s*([^\\n,，;；]+)`, "i");
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = match[1].trim();
      if (value && !isAlertFieldLabel(value)) {
        return value;
      }
    }
  }
  return undefined;
};

/** 从自由文本中抽取结构化告警字段（用于把 OCR/原文里的标签字段带入研判）。 */
export function parseAlertFieldsFromText(
  text: string,
): { fields: ParsedAlertFields; cleanedText: string } {
  const fields: ParsedAlertFields = {};
  let cleanedText = text;
  for (const [key, labels] of Object.entries(ALERT_FIELD_LABELS)) {
    const value = extractLabeledAlertField(cleanedText, labels);
    if (value) {
      (fields as Record<string, string>)[key] = value;
      for (const label of labels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        cleanedText = cleanedText.replace(
          new RegExp(`${escaped}\\s*[:：]\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,;；，]*`, "i"),
          "",
        );
      }
    }
  }
  return { fields, cleanedText: cleanedText.trim() };
}

const tryParseJsonAlert = (text: string): ParsedAlertFile | null => {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

    const alertText = [
      obj.alert?.title || obj.alert?.name || obj.title || obj.name || obj.rule,
      obj.alert?.description || obj.description || obj.message || obj.detail,
    ]
      .filter(Boolean)
      .join("\n");

    if (!alertText) return null;

    return {
      alertText,
      fields: {
        sourceSystem: obj.source || obj.system || obj.sourceSystem,
        sourceDevice: obj.device || obj.sensor || obj.sourceDevice,
        occurredAt: obj.timestamp || obj.time || obj.occurredAt || obj.createdAt,
        sourceIp: obj.source?.ip || obj.src_ip || obj.sourceIp || obj.source?.address,
        destinationIp: obj.destination?.ip || obj.dst_ip || obj.destinationIp || obj.destination?.address,
        asset: obj.asset || obj.host || obj.hostname,
        businessContext: obj.businessContext || obj.context,
        currentStatus: obj.status || obj.currentStatus,
      },
    };
  } catch {
    return null;
  }
};

export function parseAlertFileContent(content: string): ParsedAlertFile {
  const jsonResult = tryParseJsonAlert(content);
  if (jsonResult) return jsonResult;

  const syslogMatch = content.match(
    /^<(\d+)>(\w+\s+\d+\s+\d+:\d+:\d+)\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.+)/m,
  );
  if (syslogMatch) {
    return {
      alertText: syslogMatch[6]?.trim() || content.slice(0, 500),
      fields: {
        occurredAt: syslogMatch[2],
        sourceDevice: syslogMatch[3],
      },
    };
  }

  return {
    alertText: content.slice(0, 2000).trim(),
    fields: {},
  };
}
