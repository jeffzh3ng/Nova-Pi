"""Data classification MCP service.

Runs a standard Python FastMCP server for external MCP clients. Nova connects
through the same MCP stdio or Streamable HTTP transports as other clients.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parent
LOCAL_CONFIG_PATH = ROOT / "config.local.json"
EXAMPLE_CONFIG_PATH = ROOT / "config.example.json"
RUNTIME_LOG_PATH = ROOT / "classification_runtime.log"
RUNTIME_LOG_LOCK = threading.Lock()
CLASSIFICATION_MIN_OUTPUT_TOKENS = 32768
DEEPSEEK_V4_MIN_OUTPUT_TOKENS = 65536
DEFAULT_MODEL = "gpt-4.1-mini"

DEFAULT_CONFIG: dict[str, Any] = {
    "server": {"host": "127.0.0.1", "port": 8766},
    "llm": {
        "mode": "direct",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "DATA_CLASSIFICATION_LLM_API_KEY",
        "apiKey": "",
        "model": DEFAULT_MODEL,
        "timeoutSeconds": 120,
        "maxTokens": CLASSIFICATION_MIN_OUTPUT_TOKENS,
        "temperature": 0.1,
    },
    "classification": {
        "batchSize": 20,
        "maxConcurrentBatches": 8,
        "maxSamplesPerAsset": 3,
        # 0 means send the complete matrix to the model. DeepSeek V4's 1M
        # context can hold the bundled industry matrices without truncation.
        "maxMatrixRows": 0,
    },
}

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SYSTEM_PROMPT = """你是数据安全分类分级专家。
你需要根据用户提供的行业、信息系统、分类分级矩阵和数据资产清单，逐条给出分类分级结论。

要求：
1. 只输出 JSON，不要输出 Markdown 或代码块。
2. assetResults 必须覆盖每一个输入 assetId。
3. dataCategory、dataLevel、classificationBasis、accuracy 不允许为空。
4. 当本地提示、样例值、字段描述或矩阵规则冲突时，以语义分析为准，并在 classificationBasis 中说明依据。
5. 无法确定的项目必须标记 reviewRequired=true。
6. 分类分级矩阵只作为判定依据，不要在输出中回传矩阵原文、完整规则或无关规则列表。

JSON 格式：
{
  "overview": "整体结论摘要",
  "confidence": "高|中|低",
  "assetResults": [
    {
      "assetId": "源资产ID",
      "categoryLevel1": "一级分类",
      "categoryLevel2": "二级分类",
      "categoryLevel3": "三级分类",
      "categoryLevel4": "四级分类",
      "dataCategory": "数据分类",
      "dataLevel": "数据等级",
      "classificationBasis": "分类分级依据",
      "accuracy": "高|中|低",
      "categoryPath": ["一级分类", "二级分类"],
      "matchedMatrixRule": "命中的规则",
      "controls": ["管控建议"],
      "reviewRequired": true,
      "confidence": "高|中|低"
    }
  ],
  "processingPlan": ["后续建议"],
  "riskNotes": ["风险提示"]
}
"""


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict) and value:
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(path: str | None = None) -> dict[str, Any]:
    config = deepcopy(DEFAULT_CONFIG)
    configured_path = (path or os.environ.get("DATA_CLASSIFICATION_MCP_CONFIG", "")).strip()
    selected_path = Path(configured_path) if configured_path else None
    if not selected_path and LOCAL_CONFIG_PATH.exists():
        selected_path = LOCAL_CONFIG_PATH
    if selected_path and selected_path.exists() and selected_path.is_file():
        try:
            config = deep_merge(config, json.loads(selected_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError as exc:
            raise ValueError(f"配置文件 {selected_path} 不是有效的 JSON：{exc}") from exc

    env_overrides = {
        "llm": {
            "baseUrl": os.environ.get("DATA_CLASSIFICATION_LLM_BASE_URL", ""),
            "model": os.environ.get("DATA_CLASSIFICATION_LLM_MODEL", ""),
        },
        "classification": {
            "batchSize": os.environ.get("DATA_CLASSIFICATION_BATCH_SIZE", ""),
            "maxConcurrentBatches": os.environ.get("DATA_CLASSIFICATION_MAX_CONCURRENT_BATCHES", ""),
            "maxSamplesPerAsset": os.environ.get("DATA_CLASSIFICATION_MAX_SAMPLES", ""),
            "maxMatrixRows": os.environ.get("DATA_CLASSIFICATION_MAX_MATRIX_ROWS", ""),
        },
    }
    clean_overrides = {
        section: {key: value for key, value in values.items() if value}
        for section, values in env_overrides.items()
    }
    return deep_merge(config, {k: v for k, v in clean_overrides.items() if v})


def start_config_watcher(config: dict[str, Any], path: Path | None, interval: float = 2.0) -> None:
    """后台守护线程：监测 config 文件 mtime 变化，变化时原地刷新 config dict。

    工具函数通过闭包捕获 ``config`` 对象（create_mcp_server(config)），这里用
    ``config.clear() + config.update(...)`` 原地替换内容，让所有持有该引用的工具
    自动看到新值，无需重启进程或改 create_mcp_server 签名。

    - 文件被删除/不存在：跳过本次，等待重新出现。
    - 解析失败：打印告警并保留旧 config，避免坏配置把服务打挂。
    - 原子写（编辑器先写临时文件再 rename）：mtime 会更新，正常触发。
    """
    if path is None or not path.exists():
        return
    last_mtime = path.stat().st_mtime

    def watch() -> None:
        nonlocal last_mtime
        while True:
            time.sleep(interval)
            try:
                if not path.exists():
                    continue
                current_mtime = path.stat().st_mtime
            except OSError:
                continue
            if current_mtime == last_mtime:
                continue
            last_mtime = current_mtime
            try:
                fresh = load_config(str(path))
            except Exception as exc:  # noqa: BLE001
                print(f"[config-watcher] 重载 {path} 失败，保留旧配置：{exc}", file=sys.stderr)
                continue
            config.clear()
            config.update(fresh)
            print(f"[config-watcher] 已重载 {path.name}", file=sys.stderr)

    thread = threading.Thread(target=watch, name="config-watcher", daemon=True)
    thread.start()


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log_runtime_event(message: str) -> None:
    if str(os.environ.get("DATA_CLASSIFICATION_DISABLE_RUNTIME_LOG") or "").strip() in {"1", "true", "yes"}:
        return
    line = f"{now_text()} {message}\n"
    try:
        with RUNTIME_LOG_LOCK:
            with RUNTIME_LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(line)
    except OSError:
        # Logging must never break the MCP JSON-RPC response path.
        pass


def split_line(line: str) -> list[str]:
    if "\t" in line:
        return [part.strip() for part in line.split("\t")]
    if "," in line:
        return [part.strip() for part in line.split(",")]
    if "，" in line:
        return [part.strip() for part in line.split("，")]
    if "|" in line:
        return [part.strip() for part in line.split("|")]
    return [line.strip()]


def key_text(value: str) -> str:
    return re.sub(r"[\s_\-（）()：:]+", "", value.strip().lower())


def find_column(headers: list[str], aliases: list[str]) -> int | None:
    normalized = [key_text(header) for header in headers]
    alias_keys = [key_text(alias) for alias in aliases]
    for index, header in enumerate(normalized):
        for alias in alias_keys:
            if len(alias) <= 2:
                if header == alias:
                    return index
            elif alias in header:
                return index
    return None


def cell(cells: list[str], index: int | None) -> str | None:
    if index is None or index >= len(cells):
        return None
    value = cells[index].strip()
    return value or None


def find_sample_columns(headers: list[str]) -> list[int]:
    """Return indices of all sample-value columns (举证样例1..N / 样例 / 示例 / sample)."""
    out: list[int] = []
    for idx, header in enumerate(headers):
        kh = key_text(header)
        if any(tag in kh for tag in ("样例", "示例", "样本", "sample", "example")):
            out.append(idx)
    return out


def parse_source_assets(source_text: str) -> list[dict[str, Any]]:
    lines = [ln for ln in source_text.splitlines() if ln.strip()]
    if not lines:
        return []

    headers = split_line(lines[0])
    header_joined = "".join(headers)
    table_like = len(headers) > 1 and bool(
        re.search(r"序号|字段|列名|表名|数据库|所属|描述|field|column|table", header_joined, re.I)
    )

    if not table_like:
        return [
            {
                "assetId": f"asset-{index}",
                "assetName": line[:80],
                "fieldName": None,
                "tableName": None,
                "ip": None,
                "databaseInstance": None,
                "accessAccount": None,
                "sourceSystem": None,
                "description": line,
                "businessDescription": None,
                "dataFeature": None,
                "sampleValues": [],
                "rawRow": line,
                "isMasterData": None,
            }
            for index, line in enumerate(lines, start=1)
        ]

    data_lines = lines[1:]
    if not data_lines:
        return []

    col_id = find_column(headers, ["序号", "编号", "id", "assetId"])
    col_field = find_column(headers, ["列名", "字段名", "字段", "field", "column", "columnName"])
    col_table = find_column(headers, ["表名", "数据表", "table", "tableName"])
    col_ip = find_column(headers, ["IP", "地址", "host"])
    col_db = find_column(headers, ["所属实例", "数据库实例", "数据库", "实例", "库名", "database", "instance"])
    col_account = find_column(headers, ["访问账号", "账号", "账户", "accessAccount", "account"])
    col_system = find_column(headers, ["所属应用", "所属系统", "应用", "系统", "sourceSystem", "system"])
    col_desc = find_column(headers, ["列描述", "字段描述", "描述", "description", "comment"])
    col_biz = find_column(headers, ["业务描述", "业务含义", "business"])
    col_feature = find_column(headers, ["数据特征", "特征", "dataFeature"])
    col_master = find_column(headers, ["是否是主数据", "主数据", "master"])
    sample_cols = find_sample_columns(headers)

    assets: list[dict[str, Any]] = []
    for index, raw_line in enumerate(data_lines, start=1):
        cells = split_line(raw_line)
        if not any(cells):
            continue
        field_name = cell(cells, col_field)
        description = cell(cells, col_desc)
        asset_name = field_name or description or cells[0].strip() or f"asset-{index}"
        source_id = cell(cells, col_id)
        sample_values = [cell(cells, c) for c in sample_cols]
        sample_values = [v for v in sample_values if v]
        assets.append(
            {
                "assetId": source_id or f"asset-{index}",
                "assetName": asset_name,
                "fieldName": field_name,
                "tableName": cell(cells, col_table),
                "ip": cell(cells, col_ip),
                "databaseInstance": cell(cells, col_db),
                "accessAccount": cell(cells, col_account),
                "sourceSystem": cell(cells, col_system),
                "description": description,
                "businessDescription": cell(cells, col_biz),
                "dataFeature": cell(cells, col_feature),
                "sampleValues": sample_values,
                "rawRow": raw_line,
                "isMasterData": cell(cells, col_master),
            }
        )
    return assets


def category_levels_from_path(path: list[Any] | None) -> dict[str, str]:
    values = [str(item or "").strip() for item in (path or [])]
    values = [item for item in values if item]
    return {
        "categoryLevel1": values[0] if len(values) > 0 else "",
        "categoryLevel2": values[1] if len(values) > 1 else "",
        "categoryLevel3": values[2] if len(values) > 2 else "",
        "categoryLevel4": values[3] if len(values) > 3 else "",
    }


def category_path_from_levels(item: dict[str, Any]) -> list[str]:
    explicit = [
        str(item.get("categoryLevel1") or "").strip(),
        str(item.get("categoryLevel2") or "").strip(),
        str(item.get("categoryLevel3") or "").strip(),
        str(item.get("categoryLevel4") or "").strip(),
    ]
    if any(explicit):
        return [value for value in explicit if value]
    path = item.get("categoryPath") or []
    if not isinstance(path, list):
        return []
    return [str(value or "").strip() for value in path if str(value or "").strip()]


def category_levels_from_item(item: dict[str, Any]) -> dict[str, str]:
    explicit = {
        "categoryLevel1": str(item.get("categoryLevel1") or "").strip(),
        "categoryLevel2": str(item.get("categoryLevel2") or "").strip(),
        "categoryLevel3": str(item.get("categoryLevel3") or "").strip(),
        "categoryLevel4": str(item.get("categoryLevel4") or "").strip(),
    }
    if any(explicit.values()):
        return explicit
    path = item.get("categoryPath") or []
    if isinstance(path, list):
        return category_levels_from_path(path)
    return category_levels_from_path([])


def leaf_category_from_levels(levels: dict[str, str]) -> str:
    for key in ("categoryLevel4", "categoryLevel3", "categoryLevel2", "categoryLevel1"):
        value = levels.get(key, "").strip()
        if value:
            return value
    return "待定"


def load_bundled_matrix(name: str) -> dict[str, Any] | None:
    """Load a bundled industry matrix JSON shipped with the service."""
    path = ROOT / "matrices" / f"{name}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def bundled_matrix_name_for_id(matrix_id: str | None) -> str | None:
    normalized = key_text(matrix_id or "")
    if normalized in {"healthcare", "healthcarebaseline", "卫生健康", "医疗"}:
        return "healthcare"
    if normalized in {"finance", "financebaseline", "金融", "金融行业", "银行", "保险", "证券"}:
        return "finance"
    return None


def bundled_matrix_name_for_industry(industry: str) -> str | None:
    lowered = industry.lower()
    if "卫" in industry or "医" in industry or "health" in lowered:
        return "healthcare"
    if (
        "金融" in industry
        or "银行" in industry
        or "保险" in industry
        or "证券" in industry
        or "finance" in lowered
        or "bank" in lowered
        or "insurance" in lowered
        or "securities" in lowered
    ):
        return "finance"
    return None


def builtin_matrix(industry: str, matrix_id: str | None = None) -> dict[str, Any]:
    bundled_name = bundled_matrix_name_for_id(matrix_id) or bundled_matrix_name_for_industry(industry)
    if bundled_name:
        bundled = load_bundled_matrix(bundled_name)
        if bundled:
            return bundled
    # Generic baseline (used when no bundled industry matrix is available).
    rows = [
        {
            **category_levels_from_path(["个人信息", "基础身份信息"]),
            "categoryPath": ["个人信息", "基础身份信息"],
            "dataExamples": "姓名, 手机号, 电话, 邮箱, 地址, user_name, phone, email",
            "suggestedLevel": "一般数据3级",
            "impactTarget": "个人",
            "impactDegree": "中",
            "source": "内置个人信息规则",
        },
        {
            **category_levels_from_path(["个人信息", "敏感个人信息"]),
            "categoryPath": ["个人信息", "敏感个人信息"],
            "dataExamples": "身份证, 证件号, 银行账号, 信用卡, 密码, 生物识别, GPS, id_card, ssn, bank_account, credit_card, password",
            "suggestedLevel": "一般数据4级",
            "impactTarget": "个人",
            "impactDegree": "高",
            "source": "内置敏感个人信息规则",
        },
        {
            **category_levels_from_path(["业务数据", "交易与财务数据"]),
            "categoryPath": ["业务数据", "交易与财务数据"],
            "dataExamples": "交易, 订单, 合同, 金额, 发票, 工资, 收入, transaction, order, invoice, salary, amount",
            "suggestedLevel": "一般数据3级",
            "impactTarget": "组织",
            "impactDegree": "中",
            "source": "内置业务数据规则",
        },
        {
            **category_levels_from_path(["系统运行", "日志与审计"]),
            "categoryPath": ["系统运行", "日志与审计"],
            "dataExamples": "日志, 审计, 登录, IP, token, access_log, audit, login",
            "suggestedLevel": "一般数据2级",
            "impactTarget": "组织",
            "impactDegree": "低",
            "source": "内置系统运行规则",
        },
    ]
    return {
        "id": "national-baseline",
        "name": "内置通用分类分级矩阵",
        "description": "由工作台内置规则提供的基础矩阵，用于本地初筛和模型提示。该行业暂未提供专用矩阵，建议上传对应行业规则表以提升准确率。",
        "rows": rows,
        "sources": [{"name": "内置分类分级规则", "url": "nova://builtin-matrix"}],
    }


def _find_col_substr(headers: list[str], needles: list[str]) -> int | None:
    """Return the first header index whose normalized text contains any needle."""
    normalized = [key_text(h) for h in headers]
    needle_keys = [key_text(n) for n in needles]
    for idx, header in enumerate(normalized):
        for nk in needle_keys:
            if nk and nk in header:
                return idx
    return None


def parse_matrix_text(matrix_text: str) -> list[dict[str, Any]]:
    """Parse a custom matrix (TSV/CSV text from an uploaded xlsx) into rule rows.

    Handles the real industry matrix layout: a leading grouping header row,
    then a column header row (一级类别/二级类别/三级类别/四级类别, 数据范围及示例,
    影响对象, 影响程度, 建议数据级别), then data rows with merged-cell blanks in
    the parent hierarchy columns (forward-filled). Also tolerates a single
    `分类路径` column with `/`/`>`/`|` separators.
    """
    lines = [ln for ln in matrix_text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return []

    # Locate the real header row (skip a grouping row like "数据分类,...,数据分级").
    header_idx = 0
    for i in range(min(5, len(lines))):
        joined = key_text("".join(split_line(lines[i])))
        if "一级类别" in joined or "分类路径" in joined or "category" in joined:
            header_idx = i
            break
    headers = split_line(lines[header_idx])

    col_l1 = _find_col_substr(headers, ["一级类别", "一级分类"])
    col_l2 = _find_col_substr(headers, ["二级类别", "二级分类"])
    col_l3 = _find_col_substr(headers, ["三级类别", "三级分类"])
    col_l4 = _find_col_substr(headers, ["四级类别", "四级分类"])
    col_path = _find_col_substr(headers, ["分类路径", "categorypath"])
    col_example = _find_col_substr(headers, ["数据范围及示例", "数据范围", "数据示例", "示例", "关键词", "examples"])
    col_level = _find_col_substr(headers, ["建议数据级别", "建议级别", "级别", "等级", "suggestedlevel"])
    col_target = _find_col_substr(headers, ["影响对象", "impacttarget"])
    col_degree = _find_col_substr(headers, ["影响程度", "impactdegree"])

    has_levels = any(c is not None for c in (col_l1, col_l2, col_l3, col_l4))
    if not has_levels and col_path is None:
        return []
    if col_level is None:
        return []

    rows: list[dict[str, Any]] = []
    last_levels = ["", "", "", ""]
    for line in lines[header_idx + 1 :]:
        cells = split_line(line)
        if has_levels:
            raw_levels = [cell(cells, c) or "" for c in (col_l1, col_l2, col_l3, col_l4)]
            # forward-fill parent hierarchy columns (merged-cell blanks);
            # the leaf (4th level) is never forward-filled.
            for li in range(3):
                if raw_levels[li]:
                    last_levels[li] = raw_levels[li]
            levels = [last_levels[0], last_levels[1], last_levels[2], raw_levels[3]]
            path = [p for p in levels if p]
        else:
            raw_path = cell(cells, col_path) or ""
            path = [part.strip() for part in re.split(r"[>/／|]", raw_path) if part.strip()]

        level = cell(cells, col_level) or ""
        if not path or not level:
            continue
        levels = category_levels_from_path(path)
        rows.append(
            {
                **levels,
                "categoryPath": path,
                "dataExamples": cell(cells, col_example) or "、".join(path),
                "suggestedLevel": level,
                "impactTarget": cell(cells, col_target),
                "impactDegree": cell(cells, col_degree),
                "source": "用户自定义分类分级矩阵",
            }
        )
    return rows


def resolve_matrix(request: dict[str, Any]) -> dict[str, Any]:
    matrix_selection = request.get("matrixSelection") or {}
    custom_rows = matrix_selection.get("customMatrixRows") or []
    if custom_rows:
        return {
            "id": "custom-matrix",
            "name": matrix_selection.get("customMatrixName") or "用户自定义分类分级矩阵",
            "description": "用户上传或传入的分类分级矩阵。",
            "rows": custom_rows,
            "sources": [{"name": "用户自定义矩阵", "url": "nova://custom-matrix"}],
        }
    custom_text = (matrix_selection.get("customMatrixText") or "").strip()
    if custom_text:
        rows = parse_matrix_text(custom_text)
        if not rows:
            raise ValueError("自定义分类分级矩阵无法解析，请检查是否包含分类路径和建议级别。")
        return {
            "id": "custom-matrix",
            "name": matrix_selection.get("customMatrixName") or "用户自定义分类分级矩阵",
            "description": "用户上传或传入的分类分级矩阵。",
            "rows": rows,
            "sources": [{"name": "用户自定义矩阵", "url": "nova://custom-matrix"}],
        }
    return builtin_matrix(effective_industry(request), matrix_selection.get("builtinMatrixId"))


def effective_industry(request: dict[str, Any]) -> str:
    return (request.get("customerIndustry") or request.get("industry") or "通用行业").strip()


def asset_search_text(asset: dict[str, Any]) -> str:
    return " ".join(
        str(asset.get(key) or "")
        for key in (
            "assetName",
            "fieldName",
            "tableName",
            "sourceSystem",
            "description",
            "businessDescription",
            "sampleData",
            "rawRow",
        )
    ).lower()


def tokenize_keywords(text: str) -> list[str]:
    raw = re.split(r"[,，、;；\s]+", text.lower())
    return [item.strip() for item in raw if len(item.strip()) >= 2]


def keyword_hit_score(asset_text: str, examples: str) -> int:
    score = 0
    normalized = asset_text.lower()
    for keyword in tokenize_keywords(examples):
        if re.fullmatch(r"[a-z0-9_]+", keyword):
            pattern = r"(?<![a-z0-9])" + re.escape(keyword.replace("_", " ")) + r"(?![a-z0-9])"
            loose = keyword.replace("_", " ")
            if keyword in normalized or loose in normalized or re.search(pattern, normalized):
                score += 2
        elif keyword in normalized:
            score += 2
    return score


def classify_asset(asset: dict[str, Any], matrix: dict[str, Any]) -> dict[str, Any]:
    text = asset_search_text(asset)
    best_row: dict[str, Any] | None = None
    best_score = 0
    for row in matrix["rows"]:
        score = keyword_hit_score(text, row.get("dataExamples", ""))
        if score > best_score:
            best_score = score
            best_row = row

    if best_row is None:
        best_row = {
            **category_levels_from_path(["待定"]),
            "categoryPath": ["待定"],
            "dataExamples": "未命中明确规则",
            "suggestedLevel": "待定",
            "source": "本地规则未命中",
        }

    category_levels = category_levels_from_item(best_row)
    category_path = category_path_from_levels(best_row) or ["待定"]
    category = leaf_category_from_levels(category_levels)
    level = best_row.get("suggestedLevel") or "待定"
    high_risk = any(
        word in text
        for word in [
            "身份证",
            "证件",
            "id_card",
            "ssn",
            "password",
            "密码",
            "诊断",
            "病历",
            "处方",
            "bank_account",
            "credit_card",
            "银行卡",
            "gps",
            "生物识别",
        ]
    )
    review_required = best_score == 0 or high_risk or level == "待定"
    accuracy = "高" if best_score >= 4 else "中" if best_score > 0 else "低"
    basis = (
        f"本地规则命中：{best_row.get('source') or matrix['name']}；"
        f"关键词/示例匹配分={best_score}；建议级别={level}。"
    )
    if best_score == 0:
        basis = "未命中明确分类矩阵规则，保留待定结果并要求人工复核。"
    return {
        "assetId": asset["assetId"],
        "assetName": asset["assetName"],
        "fieldName": asset.get("fieldName"),
        "tableName": asset.get("tableName"),
        "ip": asset.get("ip"),
        "databaseInstance": asset.get("databaseInstance"),
        "accessAccount": asset.get("accessAccount"),
        "sourceSystem": asset.get("sourceSystem"),
        "description": asset.get("description"),
        "businessDescription": asset.get("businessDescription"),
        "isMasterData": asset.get("isMasterData"),
        **category_levels,
        "categoryPath": category_path,
        "dataCategory": category,
        "dataLevel": level,
        "rationale": basis,
        "classificationBasis": basis,
        "accuracy": accuracy,
        "matchedMatrixRule": best_row.get("dataExamples") or "未命中明确规则",
        "controls": controls_for(level, category),
        "confidence": accuracy,
        "reviewRequired": review_required,
    }


def _level_rank(level: str) -> int:
    """Extract the numeric grade from a level string (一般数据3级 -> 3).
    重要数据 -> 5, 核心数据 -> 6, 待定 -> 0."""
    text = str(level or "")
    if "核心" in text:
        return 6
    if "重要" in text:
        return 5
    m = re.search(r"(\d+)", text)
    return int(m.group(1)) if m else 0


def controls_for(level: str, category: str) -> list[str]:
    controls = ["按最小权限授权访问", "保留访问和导出审计记录"]
    rank = _level_rank(level)
    if rank >= 4 or "敏感" in category or "医疗" in category:
        controls.extend(["加密存储和传输", "展示和导出前进行脱敏处理", "纳入人工复核清单"])
    elif rank == 0 and "待定" in str(level):
        controls.append("补充业务语义后重新评估")
    return controls


def summarize(asset_results: list[dict[str, Any]]) -> dict[str, Any]:
    by_level = Counter(item["dataLevel"] for item in asset_results)
    by_category = Counter(item["dataCategory"] for item in asset_results)
    return {
        "totalAssets": len(asset_results),
        "byLevel": dict(sorted(by_level.items())),
        "byCategory": dict(sorted(by_category.items())),
        "reviewRequiredCount": sum(1 for item in asset_results if item.get("reviewRequired")),
    }


def local_result(request: dict[str, Any], assets: list[dict[str, Any]], matrix: dict[str, Any]) -> dict[str, Any]:
    asset_results = [classify_asset(asset, matrix) for asset in assets]
    categories = []
    seen_categories = set()
    for row in matrix["rows"]:
        category_path = category_path_from_levels(row)
        if not category_path:
            continue
        name = category_path[-1]
        if name in seen_categories:
            continue
        seen_categories.add(name)
        categories.append(
            {
                "name": name,
                "description": f"来自分类矩阵路径：{' / '.join(category_path)}",
                "examples": tokenize_keywords(row.get("dataExamples", ""))[:8],
            }
        )
    return {
        "module": "data-classification",
        "model": "local-rules",
        "usedModel": False,
        "customerIndustry": effective_industry(request),
        "informationSystem": request.get("informationSystem"),
        "matrixUsed": {
            "id": matrix["id"],
            "name": matrix["name"],
            "description": matrix["description"],
            "rowCount": len(matrix["rows"]),
        },
        "overview": f"已完成 {len(asset_results)} 条数据资产的本地分类分级初筛。",
        "confidence": "中" if asset_results else "低",
        "categories": categories,
        "assetResults": asset_results,
        "levels": [
            {
                "asset": item["assetName"],
                "category": item["dataCategory"],
                "level": item["dataLevel"],
                "rationale": item["classificationBasis"],
                "controls": item["controls"],
            }
            for item in asset_results
        ],
        "summary": summarize(asset_results),
        "processingPlan": [
            "复核待定和高敏感数据项",
            "补充缺失的业务描述、样例值和使用场景",
            "根据最终等级落实访问控制、加密、脱敏和审计要求",
        ],
        "riskNotes": ["当前包含本地规则初筛结果；未配置或调用大模型失败时会返回该结果。"],
        "evidenceSources": matrix["sources"],
        "generatedAt": now_text(),
        "rawModelOutput": None,
    }


def _matrix_row_relevance(row: dict[str, Any], asset_texts: list[str]) -> int:
    examples = row.get("dataExamples") or ""
    score = 0
    for text in asset_texts:
        score += keyword_hit_score(text, examples)
    return score


def configured_max_matrix_rows(config: dict[str, Any]) -> int:
    cls_cfg = config.get("classification") or {}
    raw = cls_cfg.get("maxMatrixRows", 0)
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def configured_batch_size(config: dict[str, Any]) -> int:
    cls_cfg = config.get("classification") or {}
    raw = cls_cfg.get("batchSize", DEFAULT_CONFIG["classification"]["batchSize"])
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return int(DEFAULT_CONFIG["classification"]["batchSize"])


def configured_max_concurrent_batches(config: dict[str, Any]) -> int:
    cls_cfg = config.get("classification") or {}
    raw = cls_cfg.get("maxConcurrentBatches", DEFAULT_CONFIG["classification"]["maxConcurrentBatches"])
    try:
        return max(1, min(20, int(raw)))
    except (TypeError, ValueError):
        return int(DEFAULT_CONFIG["classification"]["maxConcurrentBatches"])


def build_model_context(
    request: dict[str, Any],
    assets: list[dict[str, Any]],
    matrix: dict[str, Any],
    config: dict[str, Any],
) -> str:
    cls_cfg = config.get("classification") or {}
    max_matrix_rows = configured_max_matrix_rows(config)
    max_samples = int(cls_cfg.get("maxSamplesPerAsset", 3) or 3)

    system = request.get("informationSystem") or {}
    policy_basis = request.get("policyBasis") or []
    supplement = (request.get("supplementalPrompt") or "").strip()

    # Matrix rows: default to the full bundled matrix. If a positive
    # maxMatrixRows is configured for a smaller-context model, keep the most
    # relevant rows within that explicit budget.
    all_matrix_rows = matrix.get("rows") or []
    if max_matrix_rows > 0 and len(all_matrix_rows) > max_matrix_rows:
        asset_texts = [asset_search_text(a) for a in assets]
        matrix_rows = sorted(
            all_matrix_rows,
            key=lambda r: _matrix_row_relevance(r, asset_texts),
            reverse=True,
        )[:max_matrix_rows]
    else:
        matrix_rows = all_matrix_rows
    truncated = len(all_matrix_rows) - len(matrix_rows)

    lines = [
        "# 数据安全分类分级任务",
        "",
        "## 任务背景",
        f"目标客户行业：{effective_industry(request)}",
        f"业务场景：{request.get('businessScenario') or '数据安全分类分级'}",
        f"信息系统名称：{system.get('name') or '未提供'}",
        f"数据库/实例：{system.get('databaseName') or '未提供'}",
        f"信息系统功能描述：{system.get('functionDescription') or '未提供'}",
    ]
    if policy_basis:
        lines.append("政策与制度依据：" + "；".join(str(p) for p in policy_basis))
    if supplement:
        lines.append(f"用户补充说明：{supplement}")
    lines.extend(
        [
            "",
            "## 分类分级矩阵",
            f"矩阵名称：{matrix.get('name') or '未提供'}",
            f"矩阵说明：{matrix.get('description') or '未提供'}",
        ]
    )
    for index, row in enumerate(matrix_rows, start=1):
        levels = category_levels_from_item(row)
        lines.append(
            f"{index}. 一级分类={levels['categoryLevel1']}；二级分类={levels['categoryLevel2']}；"
            f"三级分类={levels['categoryLevel3']}；四级分类={levels['categoryLevel4']}；"
            f"示例={row.get('dataExamples') or ''}；"
            f"影响对象={row.get('impactTarget') or ''}；影响程度={row.get('impactDegree') or ''}；"
            f"建议级别={row.get('suggestedLevel') or ''}"
        )
    if truncated > 0:
        lines.append(f"（矩阵共 {len(matrix.get('rows') or [])} 行，已按相关度取前 {len(matrix_rows)} 行）")
    else:
        lines.append(f"（矩阵共 {len(all_matrix_rows)} 行，已全量提供）")

    lines.extend(["", "## 待分类数据资产"])
    for asset in assets:
        sample_values = (asset.get("sampleValues") or [])[:max_samples]
        lines.append(
            json.dumps(
                {
                    "assetId": asset["assetId"],
                    "assetName": asset.get("assetName"),
                    "fieldName": asset.get("fieldName"),
                    "tableName": asset.get("tableName"),
                    "ip": asset.get("ip"),
                    "databaseInstance": asset.get("databaseInstance"),
                    "accessAccount": asset.get("accessAccount"),
                    "sourceSystem": asset.get("sourceSystem"),
                    "description": asset.get("description"),
                    "businessDescription": asset.get("businessDescription"),
                    "isMasterData": asset.get("isMasterData"),
                    "dataFeature": asset.get("dataFeature"),
                    "sampleValues": sample_values,
                },
                ensure_ascii=False,
            )
        )

    lines.extend(
        [
            "",
            "## 输出要求（必须严格遵守）",
            "1. 只输出一个 JSON 对象，不要输出 Markdown、代码块或解释。",
            "2. assetResults 数组必须与上面待分类数据资产一一对应，每条输入资产对应一条输出，不得增加、删除或合并行。",
            "3. 每条输出包含以下字段：序号(assetId)、列名(fieldName)、表名(tableName)、IP(ip)、所属实例(databaseInstance)、访问账号(accessAccount)、所属应用(sourceSystem)、列描述(description)、业务描述(businessDescription)、是否是主数据(isMasterData)、一级分类(categoryLevel1)、二级分类(categoryLevel2)、三级分类(categoryLevel3)、四级分类(categoryLevel4)、数据分类(dataCategory)、数据等级(dataLevel)、分类分级依据(classificationBasis)、准确率(accuracy)。",
            "4. 前 10 个字段（序号、列名、表名、IP、所属实例、访问账号、所属应用、列描述、业务描述、是否是主数据）必须原样回填自对应输入资产，不得修改、臆造或留空。",
            "5. 一级/二级/三级/四级分类必须尽量与分类分级矩阵对应；矩阵没有对应层级时填空字符串；dataCategory 填最末级非空分类。",
            "6. 准确率只能是：高、中、低。证据充分且与矩阵规则明确匹配为高；部分匹配或需结合语义推断为中；证据不足或无法判定为低。",
            "7. 数据等级参考矩阵建议级别，常见取值：一般数据1级、一般数据2级、一般数据3级、一般数据4级、重要数据、核心数据。",
            "8. 当无法判定时：数据等级填“待定”，准确率填“低”，分类分级依据说明证据不足的原因，但不得留空。",
            "9. 分类分级依据应简述命中的一级/二级/三级/四级分类、规则来源和判定理由。",
            "10. 分类分级矩阵仅用于判定，不要在输出中回传矩阵原文、完整规则、候选规则列表或与资产无关的规则内容。",
            "",
            "JSON 格式：",
            json.dumps(
                {
                    "overview": "整体结论摘要",
                    "confidence": "高|中|低",
                    "assetResults": [
                        {
                            "assetId": "源资产ID",
                            "fieldName": "原样回填",
                            "tableName": "原样回填",
                            "ip": "原样回填",
                            "databaseInstance": "原样回填",
                            "accessAccount": "原样回填",
                            "sourceSystem": "原样回填",
                            "description": "原样回填",
                            "businessDescription": "原样回填",
                            "isMasterData": "原样回填",
                            "categoryLevel1": "一级分类",
                            "categoryLevel2": "二级分类",
                            "categoryLevel3": "三级分类",
                            "categoryLevel4": "四级分类",
                            "dataCategory": "数据分类",
                            "dataLevel": "数据等级",
                            "classificationBasis": "分类分级依据",
                            "accuracy": "高|中|低",
                        }
                    ],
                    "processingPlan": ["后续建议"],
                    "riskNotes": ["风险提示"],
                },
                ensure_ascii=False,
                indent=2,
            ),
        ]
    )
    return "\n".join(lines)


def _dedup_preserve_order(items: list[Any]) -> list[Any]:
    seen: set[str] = set()
    out: list[Any] = []
    for item in items:
        key = json.dumps(item, ensure_ascii=False, sort_keys=True) if not isinstance(item, str) else item
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _empty_result(reason: str) -> dict[str, Any]:
    return {
        "module": "data-classification",
        "model": DEFAULT_MODEL,
        "usedModel": False,
        "overview": reason,
        "confidence": "低",
        "assetResults": [],
        "levels": [],
        "summary": {"totalAssets": 0, "byLevel": {}, "byCategory": {}, "reviewRequiredCount": 0},
        "riskNotes": [reason],
        "generatedAt": now_text(),
        "rawModelOutput": None,
    }


def classify_data_assets_direct(request: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_config()
    assets = parse_source_assets(request.get("sourceText") or "")
    if not assets:
        return _empty_result("未解析到可分类的数据资产，请检查原始数据是否包含字段清单或有效数据行。")

    matrix = resolve_matrix(request)
    batch_size = configured_batch_size(config)
    max_concurrent_batches = configured_max_concurrent_batches(config)

    llm = config.get("llm") or {}
    base_url = str(llm.get("baseUrl") or "").strip()
    try:
        api_key = configured_api_key(llm) if base_url else ""
    except RuntimeError:
        api_key = ""

    # No LLM configured: return local-rules result for all assets.
    if not base_url or not api_key:
        local = local_result(request, assets, matrix)
        local["riskNotes"] = [
            "未配置大模型或未提供 API Key，已使用本地规则初筛结果（准确率偏低，建议配置大模型后重新运行）。",
            *local.get("riskNotes", []),
        ]
        return local

    model_name = str(llm.get("model") or DEFAULT_MODEL)
    batches = [assets[i : i + batch_size] for i in range(0, len(assets), batch_size)]
    batch_results: list[dict[str, Any] | None] = [None] * len(batches)
    extra_risk_notes: list[str] = []
    used_model = False
    job_id = datetime.now().strftime("%Y%m%d%H%M%S%f")
    job_started = time.monotonic()
    log_runtime_event(
        f"job={job_id} start assets={len(assets)} batches={len(batches)} "
        f"batch_size={batch_size} concurrent={max_concurrent_batches} "
        f"matrix_id={matrix.get('id')} matrix_rows={len(matrix.get('rows') or [])} model={model_name}"
    )

    def run_model_batch(index: int, batch: list[dict[str, Any]]) -> tuple[int, dict[str, Any], str | None, bool]:
        batch_started = time.monotonic()
        log_runtime_event(f"job={job_id} batch={index + 1}/{len(batches)} start assets={len(batch)}")
        fallback = local_result(request, batch, matrix)
        prompt = build_model_context(request, batch, matrix, config)
        try:
            called_model, model_content = call_direct_llm(
                config,
                [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
            )
            batch_result = normalize_model_result(fallback, called_model, model_content, None)
            log_runtime_event(
                f"job={job_id} batch={index + 1}/{len(batches)} done "
                f"seconds={time.monotonic() - batch_started:.1f} used_model=true "
                f"assets={len(batch_result.get('assetResults') or [])}"
            )
            return index, batch_result, None, True
        except Exception as exc:  # noqa: BLE001
            batch_result = normalize_model_result(fallback, model_name, None, str(exc))
            note = f"第 {index + 1}/{len(batches)} 批模型调用失败，已用本地初筛结果。"
            log_runtime_event(
                f"job={job_id} batch={index + 1}/{len(batches)} error "
                f"seconds={time.monotonic() - batch_started:.1f} error={str(exc)[:300]}"
            )
            return index, batch_result, note, False

    workers = min(max_concurrent_batches, len(batches))
    if workers <= 1:
        for index, batch in enumerate(batches):
            result_index, batch_result, risk_note, batch_used_model = run_model_batch(index, batch)
            batch_results[result_index] = batch_result
            if risk_note:
                extra_risk_notes.append(risk_note)
            used_model = used_model or batch_used_model
    else:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(run_model_batch, index, batch): index
                for index, batch in enumerate(batches)
            }
            for future in as_completed(futures):
                result_index, batch_result, risk_note, batch_used_model = future.result()
                batch_results[result_index] = batch_result
                if risk_note:
                    extra_risk_notes.append(risk_note)
                used_model = used_model or batch_used_model

    completed_batch_results = [item for item in batch_results if item is not None]

    # Aggregate batch results, preserving the original asset order.
    merged_assets: list[dict[str, Any]] = []
    for br in completed_batch_results:
        merged_assets.extend(br.get("assetResults") or [])
    order = {asset["assetId"]: i for i, asset in enumerate(assets)}
    merged_assets.sort(key=lambda item: order.get(item["assetId"], 10**9))

    base = completed_batch_results[0]
    confidence = "低"
    if used_model:
        if all(br.get("confidence") == "高" for br in completed_batch_results):
            confidence = "高"
        else:
            confidence = "中"

    result = dict(base)
    result["model"] = model_name
    result["usedModel"] = used_model
    result["overview"] = (
        f"已完成 {len(merged_assets)} 条数据资产的分类分级"
        + (f"（共分 {len(batches)} 批处理并汇总）。" if len(batches) > 1 else "。")
    )
    result["confidence"] = confidence
    result["assetResults"] = merged_assets
    result["levels"] = [
        {
            "asset": item["assetName"],
            "category": item["dataCategory"],
            "level": item["dataLevel"],
            "rationale": item["classificationBasis"],
            "controls": item["controls"],
        }
        for item in merged_assets
    ]
    result["summary"] = summarize(merged_assets)
    result["riskNotes"] = _dedup_preserve_order(
        extra_risk_notes + [n for br in completed_batch_results for n in (br.get("riskNotes") or [])]
    )
    result["generatedAt"] = now_text()
    result["rawModelOutput"] = None
    log_runtime_event(
        f"job={job_id} finish seconds={time.monotonic() - job_started:.1f} "
        f"assets={len(merged_assets)} used_model={str(used_model).lower()} risk_notes={len(result['riskNotes'])}"
    )
    return result


def openai_chat_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def configured_api_key(llm_config: dict[str, Any]) -> str:
    explicit = str(llm_config.get("apiKey") or "").strip()
    if explicit:
        return explicit
    env_name = str(llm_config.get("apiKeyEnv") or "DATA_CLASSIFICATION_LLM_API_KEY").strip()
    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(
            f"未配置 LLM API 密钥。请在 config.local.json 的 llm.apiKey 字段设置密钥，"
            f"或设置环境变量 {env_name}。"
    )
    return value


def minimum_output_tokens_for_model(model: str) -> int:
    normalized = key_text(model)
    if "deepseekv4" in normalized:
        return DEEPSEEK_V4_MIN_OUTPUT_TOKENS
    return CLASSIFICATION_MIN_OUTPUT_TOKENS


def resolve_max_tokens(llm_config: dict[str, Any]) -> int:
    model = str(llm_config.get("model") or DEFAULT_MODEL).strip()
    minimum = minimum_output_tokens_for_model(model)
    try:
        configured = int(llm_config.get("maxTokens", minimum))
    except (ValueError, TypeError):
        raise RuntimeError(f"LLM maxTokens 配置无效：{llm_config.get('maxTokens')}") from None
    return max(configured, minimum)


def call_direct_llm(config: dict[str, Any], messages: list[dict[str, str]]) -> tuple[str, str]:
    llm = config.get("llm") or {}
    mode = str(llm.get("mode") or "direct").lower()
    base_url = str(llm.get("baseUrl") or "").strip()
    api_key = configured_api_key(llm)
    model = str(llm.get("model") or DEFAULT_MODEL).strip()
    if mode not in {"direct", "openai-compatible", "openai"}:
        raise RuntimeError("LLM mode is not direct")
    if not base_url or not model:
        raise RuntimeError("LLM baseUrl and model must be configured")

    timeout_raw = llm.get("timeoutSeconds", 120)
    try:
        timeout = max(float(timeout_raw), 1.0)
    except (ValueError, TypeError):
        raise RuntimeError(f"LLM timeoutSeconds 配置无效：{timeout_raw}") from None

    response_format = llm.get("responseFormat")
    if response_format is None:
        response_format = {"type": "json_object"}

    max_tokens = resolve_max_tokens(llm)

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": float(llm.get("temperature", 0.1)),
        "max_tokens": max_tokens,
    }
    if response_format:
        payload["response_format"] = response_format

    response = requests.post(
        openai_chat_url(base_url),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(
            f"LLM 返回了非预期的响应格式（缺少 choices[0].message.content）："
            f"{json.dumps(data, ensure_ascii=False)[:500]}"
        ) from exc
    return model, content


def parse_model_json(content: str) -> dict[str, Any]:
    text = content.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    start = text.find("{")
    if start < 0:
        raise ValueError("模型输出未包含有效的 JSON 对象")

    # Brace-depth scan that ignores braces inside JSON strings, so a `}` in a
    # string value does not prematurely close the object.
    depth = 0
    in_string = False
    escape = False
    end = -1
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break

    if end < start:
        raise ValueError("模型输出的 JSON 对象不完整（花括号不匹配）")

    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("模型返回 JSON，但不是对象")
    return parsed


def normalize_accuracy(value: Any) -> str:
    text = str(value or "").strip()
    if text in ("高", "中", "低"):
        return text
    if "高" in text:
        return "高"
    if "低" in text:
        return "低"
    return "低"


DATA_LEVEL_VALUES = (
    "一般数据1级",
    "一般数据2级",
    "一般数据3级",
    "一般数据4级",
    "重要数据",
    "核心数据",
    "待定",
)


def normalize_data_level(value: Any) -> str:
    """Enforce the data-level enum; unknown/empty values fall back to 待定."""
    text = str(value or "").strip()
    if text in DATA_LEVEL_VALUES:
        return text
    norm = text.replace(" ", "").replace("　", "")
    for level in DATA_LEVEL_VALUES:
        if norm == level.replace(" ", ""):
            return level
    if "核心" in text:
        return "核心数据"
    if "重要" in text:
        return "重要数据"
    if not text or "待定" in text:
        return "待定"
    match = re.search(r"(\d+)", text)
    if match:
        n = int(match.group(1))
        if 1 <= n <= 4:
            return f"一般数据{n}级"
    return "待定"


def normalize_model_result(
    fallback: dict[str, Any],
    model_name: str,
    model_content: str | None,
    model_error: str | None,
) -> dict[str, Any]:
    if model_error or not model_content:
        result = json.loads(json.dumps(fallback, ensure_ascii=False))
        result["model"] = model_name or DEFAULT_MODEL
        result["usedModel"] = False
        result["riskNotes"] = [
            f"大模型调用失败（{model_error or '无模型输出'}），已使用本地规则初筛结果。",
            *result.get("riskNotes", []),
        ]
        result["generatedAt"] = now_text()
        return result

    try:
        model_output = parse_model_json(model_content)
    except Exception as exc:  # noqa: BLE001
        result = json.loads(json.dumps(fallback, ensure_ascii=False))
        result["model"] = model_name or DEFAULT_MODEL
        result["usedModel"] = False
        result["riskNotes"] = [f"模型返回解析失败：{exc}", *result.get("riskNotes", [])]
        result["generatedAt"] = now_text()
        result["rawModelOutput"] = model_content
        return result

    fallback_items = fallback.get("assetResults") or []
    by_id = {str(item["assetId"]): item for item in fallback_items}
    merged_items: list[dict[str, Any]] = []
    used_ids = set()

    for model_item in model_output.get("assetResults") or []:
        model_id = str(model_item.get("assetId") or "")
        base = by_id.get(model_id)
        if base is None:
            # Model returned an unknown assetId — ignore (do not invent rows).
            continue
        merged = dict(base)  # passthrough fields preserved from base
        model_levels = category_levels_from_item(model_item)
        base_levels = category_levels_from_item(base)
        model_path = category_path_from_levels(model_item)
        base_path = category_path_from_levels(base)
        category_path = model_path or base_path or ["待定"]
        category_levels = model_levels if any(model_levels.values()) else base_levels
        if not any(category_levels.values()):
            category_levels = category_levels_from_path(category_path)
        data_category = str(model_item.get("dataCategory") or "").strip() or leaf_category_from_levels(category_levels)
        data_level = normalize_data_level(model_item.get("dataLevel") or base.get("dataLevel"))
        classification_basis = (
            str(model_item.get("classificationBasis") or model_item.get("rationale") or "").strip()
            or "模型未给出明确依据。"
        )
        accuracy = normalize_accuracy(model_item.get("accuracy") or base.get("accuracy"))
        model_review = model_item.get("reviewRequired")
        if model_review is None:
            # Model did not specify: derive from level/accuracy.
            review_required = ("待定" in data_level) or (accuracy == "低")
        else:
            review_required = bool(model_review)
            if ("待定" in data_level) or (accuracy == "低"):
                review_required = True
        merged.update(
            {
                **category_levels,
                "categoryPath": category_path,
                "dataCategory": data_category,
                "dataLevel": data_level,
                "classificationBasis": classification_basis,
                "rationale": classification_basis,
                "accuracy": accuracy,
                "matchedMatrixRule": str(model_item.get("matchedMatrixRule") or "").strip()
                or base.get("matchedMatrixRule")
                or "",
                "controls": model_item.get("controls") or base.get("controls")
                or controls_for(data_level, data_category),
                "confidence": normalize_accuracy(model_item.get("confidence") or accuracy or base.get("confidence")),
                "reviewRequired": review_required,
            }
        )
        merged_items.append(merged)
        used_ids.add(base["assetId"])

    # Assets the model did not return: keep local fallback, force review.
    for item in fallback_items:
        if item["assetId"] not in used_ids:
            missed = dict(item)
            missed["reviewRequired"] = True
            missed["classificationBasis"] = (
                f"{missed.get('classificationBasis', '')} 模型未返回该资产，沿用本地初筛并要求复核。"
            ).strip()
            missed["rationale"] = missed["classificationBasis"]
            merged_items.append(missed)

    order = {item["assetId"]: index for index, item in enumerate(fallback_items)}
    merged_items.sort(key=lambda item: order.get(item["assetId"], 10**9))

    result = dict(fallback)
    result["model"] = model_name or DEFAULT_MODEL
    result["usedModel"] = True
    result["overview"] = model_output.get("overview") or f"已完成 {len(merged_items)} 条数据资产的模型复核分类分级。"
    result["confidence"] = normalize_accuracy(model_output.get("confidence") or "中")
    result["assetResults"] = merged_items
    result["levels"] = [
        {
            "asset": item["assetName"],
            "category": item["dataCategory"],
            "level": item["dataLevel"],
            "rationale": item["classificationBasis"],
            "controls": item["controls"],
        }
        for item in merged_items
    ]
    result["summary"] = summarize(merged_items)
    result["processingPlan"] = model_output.get("processingPlan") or result.get("processingPlan") or []
    result["riskNotes"] = model_output.get("riskNotes") or result.get("riskNotes") or []
    result["generatedAt"] = now_text()
    result["rawModelOutput"] = model_content
    return result


def create_mcp_server(config: dict[str, Any]):
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:
        raise RuntimeError("Install MCP dependencies first: python -m pip install -r requirements.txt") from exc

    mcp = FastMCP("Data Classification MCP")

    @mcp.tool()
    def classify_data_assets(
        sourceText: str,
        customerIndustry: str | None = None,
        businessScenario: str | None = None,
        informationSystem: dict[str, Any] | None = None,
        matrixSelection: dict[str, Any] | None = None,
        policyBasis: list[str] | None = None,
        supplementalPrompt: str | None = None,
    ) -> dict[str, Any]:
        return classify_data_assets_direct(
            {
                "sourceText": sourceText,
                "customerIndustry": customerIndustry,
                "businessScenario": businessScenario,
                "informationSystem": informationSystem,
                "matrixSelection": matrixSelection,
                "policyBasis": policyBasis,
                "supplementalPrompt": supplementalPrompt,
            },
            config,
        )

    return mcp


def main() -> int:
    parser = argparse.ArgumentParser(description="Data Classification MCP service")
    parser.add_argument("--transport", choices=["stdio", "streamable-http"], default="stdio")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--config", default=None)
    args = parser.parse_args()

    config = load_config(args.config)
    server_cfg = config.get("server") or {}
    if args.host:
        server_cfg["host"] = args.host
    if args.port:
        server_cfg["port"] = args.port

    # 监测 config 文件变化并原地热重载，让工具闭包自动看到新值。
    watch_path_str = (args.config or os.environ.get("DATA_CLASSIFICATION_MCP_CONFIG", "")).strip()
    watch_path = Path(watch_path_str) if watch_path_str else LOCAL_CONFIG_PATH
    start_config_watcher(config, watch_path)

    mcp = create_mcp_server(config)

    if hasattr(mcp, "settings"):
        mcp.settings.host = server_cfg.get("host") or "127.0.0.1"
        raw_port = server_cfg.get("port")
        mcp.settings.port = int(raw_port) if raw_port is not None else 8766

    mcp.run(transport=args.transport)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
