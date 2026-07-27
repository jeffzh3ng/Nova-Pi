"""Threat analysis MCP service.

Runs a standard Python FastMCP server for external MCP clients. Nova connects
through the same MCP stdio or Streamable HTTP transports as other clients.
"""

from __future__ import annotations

import argparse
import csv
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import time
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parent
LOCAL_CONFIG_PATH = ROOT / "config.local.json"


def _ensure_system_ca_bundle() -> None:
    """Merge macOS system root certs into a CA bundle for the ``requests`` lib.

    In corporate networks a TLS-intercepting proxy re-signs HTTPS traffic with
    a root certificate trusted by the OS keychain but absent from Python's
    ``certifi`` bundle. Without this, ``requests`` calls to external APIs
    (deepseek, GLM OCR, ThreatBook) fail with CERTIFICATE_VERIFY_FAILED and the
    service silently degrades to "model not called, initial screening only".

    We export the System + login keychain roots, append them to certifi's
    bundle, and point ``REQUESTS_CA_BUNDLE`` / ``SSL_CERT_FILE`` at the merged
    file. Runs only on macOS and only when a merged bundle is missing/stale,
    so it stays cheap on every start. A pre-set REQUESTS_CA_BUNDLE is honored
    as-is (operator override).
    """
    if sys.platform != "darwin":
        return
    if os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE"):
        return  # operator already configured an explicit bundle

    try:
        import certifi
    except Exception:
        return

    base = certifi.where()
    merged = ROOT / ".cacert-merged.pem"
    certifi_mtime = Path(base).stat().st_mtime if Path(base).exists() else 0
    if merged.exists() and merged.stat().st_mtime >= certifi_mtime:
        os.environ["REQUESTS_CA_BUNDLE"] = str(merged)
        os.environ["SSL_CERT_FILE"] = str(merged)
        return

    try:
        system_roots = subprocess.run(
            [
                "security",
                "find-certificate",
                "-a",
                "-p",
                "/Library/Keychains/System.keychain",
                "/Library/Keychains/System.keychain",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        login_keychain = Path.home() / "Library" / "Keychains" / "login.keychain-db"
        login_roots = subprocess.run(
            ["security", "find-certificate", "-a", "-p", str(login_keychain)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        extra = system_roots.stdout + login_roots.stdout
        if "BEGIN CERTIFICATE" not in extra:
            return  # nothing to merge (no custom roots); leave certifi alone
        merged_bundle = Path(base).read_text()
        if extra.strip() not in merged_bundle:
            merged_bundle = merged_bundle.rstrip() + "\n" + extra
            merged.write_text(merged_bundle)
        os.environ["REQUESTS_CA_BUNDLE"] = str(merged)
        os.environ["SSL_CERT_FILE"] = str(merged)
    except Exception:
        # Never let CA-bundle housekeeping block service startup.
        return


_ensure_system_ca_bundle()

DEFAULT_MODEL = "gpt-4.1-mini"
DIRECT_LLM_MIN_OUTPUT_TOKENS = 4096
MAX_PROMPT_PCAP_CHARS = 5000

DEFAULT_CONFIG: dict[str, Any] = {
    "server": {"host": "127.0.0.1", "port": 8765},
    "llm": {
        "mode": "direct",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "ALERT_ANALYSIS_LLM_API_KEY",
        "apiKey": "",
        "model": DEFAULT_MODEL,
        "timeoutSeconds": 60,
        "maxTokens": DIRECT_LLM_MIN_OUTPUT_TOKENS,
        "temperature": 0.1,
    },
    "tools": {
        "tsharkPath": "",
        "capinfosPath": "",
        "tcpdumpPath": "tcpdump",
        "pcapTimeoutSeconds": 20,
        "maxPcapOutputChars": 50000,
        "maxPcapPackets": 200,
    },
    "ocr": {
        # glm-ocr：智谱专用 OCR 工具服务（/files/ocr）；tesseract：本地 OCR；auto：先 glm-ocr 后兜底
        "engine": "glm-ocr",
        "fallbackToTesseract": True,
        "toolType": "hand_write",
        "languageType": "CHN_ENG",
        # GLM OCR 独立 provider（与分析用的 llm 解耦，可单独配 key）
        "provider": {
            "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
            "apiKeyEnv": "GLM_OCR_API_KEY",
            "apiKey": "",
            "timeoutSeconds": 60,
        },
        "tesseractPath": "",
        "language": "chi_sim+eng",
        "pageSegmentationMode": 6,
        "timeoutSeconds": 60,
        "maxOutputChars": 12000,
    },
    "threatIntel": {
        "provider": "threatbook",
        "threatbookApiKeyEnv": "THREATBOOK_API_KEY",
        "threatbookApiKey": "",
        "requestIntervalSeconds": 1.0,
        "timeoutSeconds": 20,
    },
}

SYSTEM_PROMPT = """你是威胁研判分析数字员工，只输出严格 JSON，不输出 Markdown、代码块或额外解释。
要求：
1. 只输出一个 JSON 对象。
2. severity 只能是：紧急、高、中、低、待确认。
3. findings 每项包含 title、severity、evidence、impact。
4. recommendedActions 必须按优先级给出可执行动作。
5. questions 只列出需要人工确认的关键研判决策点，数量不超过 3 条。
6. 证据不足时必须标注待确认，不臆造事实。
"""


if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(path: str | None = None) -> dict[str, Any]:
    config = deepcopy(DEFAULT_CONFIG)
    configured_path = path or os.environ.get("ALERT_ANALYSIS_MCP_CONFIG", "")
    selected_path = Path(configured_path) if configured_path else None
    if not selected_path and LOCAL_CONFIG_PATH.exists():
        selected_path = LOCAL_CONFIG_PATH
    if selected_path and selected_path.exists():
        config = deep_merge(config, json.loads(selected_path.read_text(encoding="utf-8")))

    env_overrides = {
        "llm": {
            "baseUrl": os.environ.get("ALERT_ANALYSIS_LLM_BASE_URL", ""),
            "model": os.environ.get("ALERT_ANALYSIS_LLM_MODEL", ""),
        },
        "tools": {
            "tsharkPath": os.environ.get("TSHARK_PATH", ""),
            "capinfosPath": os.environ.get("CAPINFOS_PATH", ""),
            "tcpdumpPath": os.environ.get("TCPDUMP_PATH", ""),
        },
        "ocr": {
            "tesseractPath": os.environ.get("TESSERACT_PATH", ""),
            "language": os.environ.get("ALERT_IMAGE_OCR_LANGUAGE", ""),
            "engine": os.environ.get("ALERT_IMAGE_OCR_ENGINE", ""),
            "toolType": os.environ.get("ALERT_IMAGE_OCR_TOOL_TYPE", ""),
            "languageType": os.environ.get("ALERT_IMAGE_OCR_LANGUAGE_TYPE", ""),
            "provider": {
                "baseUrl": os.environ.get("GLM_OCR_BASE_URL", ""),
                "apiKey": os.environ.get("GLM_OCR_API_KEY", ""),
            },
        },
    }
    def strip_empty(value: Any) -> Any:
        """Recursively drop empty-string / empty-dict values so an unset env
        var (which yields '') never overwrites a real value loaded from the
        config file — critical for nested sections like ocr.provider."""
        if isinstance(value, dict):
            cleaned = {k: strip_empty(v) for k, v in value.items()}
            return {k: v for k, v in cleaned.items() if v not in ("", None, {})}
        return value

    clean_overrides = {
        section: {key: strip_empty(value) for key, value in values.items() if strip_empty(value)}
        for section, values in env_overrides.items()
    }
    return deep_merge(config, {k: v for k, v in clean_overrides.items() if v})


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _temp_root() -> Path:
    import tempfile

    return Path(tempfile.gettempdir())


# Directories the MCP tools are allowed to read from. The `nova-uploads` dir is
# where the Tauri host writes uploaded PCAP/image blobs; `nova-mcp-work` is the
# sandbox for MCP-produced outputs.
#
# Tauri 桌面壳现在把上传文件持久化到 app_data_dir/uploads（而非 $TMPDIR/nova-uploads），
# 通过 NOVA_PI_UPLOADS_DIR 环境变量把该路径注入子进程（见 app/src-tauri/src/lib.rs 的
# sync_mcp_config_to_sidecar）。这里把它追加进允许读根，与 nova-uploads/nova-mcp-work 并存，
# 避免两层路径白名单不一致导致 safe_resolve 误报「路径越界」。
def _allowed_read_roots() -> list[Path]:
    roots: list[Path] = [
        (_temp_root() / "nova-uploads").resolve(),
        (_temp_root() / "nova-mcp-work").resolve(),
    ]
    injected = os.environ.get("NOVA_PI_UPLOADS_DIR", "").strip()
    if injected:
        try:
            resolved = Path(injected).resolve(strict=False)
        except (OSError, ValueError):
            resolved = None
        if resolved is not None and not any(
            _same_path(resolved, existing) for existing in roots
        ):
            roots.append(resolved)
    return roots


def _same_path(left: Path, right: Path) -> bool:
    try:
        left.relative_to(right)
        return True
    except ValueError:
        try:
            right.relative_to(left)
            return True
        except ValueError:
            return False


def _allowed_write_root() -> Path:
    root = (_temp_root() / "nova-mcp-work").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def safe_resolve(
    path_value: str,
    *,
    mode: str = "read",
    must_exist: bool = False,
    allow_create: bool = False,
) -> Path:
    """Resolve `path_value` and confirm it stays inside an allowed root.

    Rejects UNC paths, `..` traversal, and symlinks that escape the sandbox.
    Relative paths are resolved under the write root. Absolute paths must
    already fall under an allowed root (read) or the write root (write).
    """
    raw = (path_value or "").strip()
    if not raw:
        raise ValueError("path is required")
    if raw.startswith("\\\\") or raw.startswith("//"):
        raise ValueError("不允许使用网络路径")

    candidate = Path(raw)
    if ".." in candidate.parts:
        raise ValueError("路径中不允许包含 .. ")

    if mode == "write":
        roots = [_allowed_write_root()]
        if not candidate.is_absolute():
            candidate = _allowed_write_root() / candidate
    else:
        roots = _allowed_read_roots()
        if not candidate.is_absolute():
            candidate = _allowed_write_root() / candidate

    resolved = candidate.resolve(strict=False)
    inside = False
    for root in roots:
        try:
            resolved.relative_to(root)
            inside = True
            break
        except ValueError:
            continue
    if not inside:
        raise ValueError("路径越界，只能访问允许目录内的文件")

    # If the file exists, also confirm the symlink-followed real path is inside
    # an allowed root — blocks symlink escapes.
    if resolved.exists():
        real = resolved.resolve(strict=False)
        if not any(_contains(root, real) for root in roots):
            raise ValueError("路径越界，只能访问允许目录内的文件")

    if must_exist and not resolved.exists():
        raise FileNotFoundError(f"文件不存在：{candidate}")
    if allow_create:
        resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def _contains(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def arg_string(arguments: dict[str, Any], key: str) -> str | None:
    value = arguments.get(key)
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def clip_chars(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return value[:max_chars] + "..."


def compact_whitespace(value: str) -> str:
    compacted = " ".join(value.split())
    return compacted or "未提供告警原文"


def contains_any(text: str, keywords: list[str]) -> bool:
    return any(keyword in text for keyword in keywords)


def is_trivial_alert_input(alert_text: str) -> bool:
    trimmed = alert_text.strip()
    if not trimmed:
        return True
    normalized = trimmed.lower()
    trivial_exact = {
        "hey",
        "hi",
        "hello",
        "yo",
        "ok",
        "okay",
        "yes",
        "no",
        "y",
        "n",
        "你好",
        "在吗",
        "哈喽",
        "哈啰",
        "嗯",
        "啊",
        "哦",
        "好的",
        "行",
        "可以",
        "收到",
        "明白",
        "知道了",
        "哦哦",
        "谢谢",
        "辛苦了",
        "test",
        "测试",
    }
    if normalized in trivial_exact:
        return True
    if len(trimmed) <= 2:
        security_hints = [
            "攻击",
            "告警",
            "扫描",
            "漏洞",
            "木马",
            "病毒",
            "入侵",
            "attack",
            "scan",
            "alert",
            "cve",
            "c2",
            "malware",
            "exploit",
            "ip",
        ]
        return not contains_any(normalized, security_hints)
    if all(ch.isspace() or ch in ".,;:!?，。；：！？-_/\\|()[]{}" for ch in normalized):
        return True
    if all(ch.isnumeric() or ch.isspace() for ch in normalized):
        return True
    return False


def infer_severity(alert_text: str) -> str:
    lower = alert_text.lower()
    if contains_any(
        lower,
        [
            "勒索",
            "ransomware",
            "横向",
            "lateral",
            "域控",
            "domain admin",
            "提权",
            "privilege escalation",
            "数据外泄",
            "exfiltration",
            "后门",
            "backdoor",
        ],
    ):
        return "紧急"
    if contains_any(
        lower,
        [
            "webshell",
            "恶意",
            "木马",
            "trojan",
            "c2",
            "外联",
            "暴力破解",
            "brute force",
            "sql注入",
            "sql injection",
            "命令执行",
            "rce",
            "漏洞利用",
            "exploit",
            "挖矿",
            "miner",
        ],
    ):
        return "高"
    if contains_any(lower, ["扫描", "scan", "登录失败", "failed login", "异常", "可疑", "suspicious", "告警", "alert"]):
        return "中"
    if len(alert_text) < 20:
        return "待确认"
    return "低"


def infer_confidence(alert_text: str, severity: str) -> str:
    if severity == "待确认" or len(alert_text) < 20:
        return "低"
    if len(alert_text) > 80:
        return "中"
    return "低"


def impact_for(severity: str) -> str:
    if severity == "紧急":
        return "可能存在业务中断、横向移动、权限失控或数据泄露风险。"
    if severity == "高":
        return "可能存在主机失陷、账号被滥用或攻击链继续扩展风险。"
    if severity == "中":
        return "可能存在异常访问、探测扫描或策略违规，需要进一步确认。"
    if severity == "低":
        return "当前证据偏弱，建议纳入观察并补充日志。"
    return "证据不足，暂不能判断实际影响。"


def recommended_actions(severity: str) -> list[str]:
    if severity == "紧急":
        return [
            "立即隔离疑似失陷主机或账号，保留磁盘、内存和关键日志证据。",
            "核查同网段、同账号、同源地址的横向移动和数据外传痕迹。",
            "启动应急响应流程，明确业务影响面和恢复优先级。",
        ]
    if severity == "高":
        return [
            "优先核查源/目的 IP、账号、进程、文件哈希和网络连接。",
            "对相关资产执行阻断、加固或临时访问控制。",
            "回溯至少 24 小时日志，确认是否存在攻击链前后置行为。",
        ]
    if severity == "中":
        return [
            "补充原始日志、命中规则详情和资产重要性信息。",
            "检查是否存在重复触发、误报条件或已知维护操作。",
            "根据复核结论调整监测规则或处置策略。",
        ]
    if severity == "低":
        return ["记录告警上下文并观察是否持续触发。", "补充来源设备、资产归属和业务窗口信息。"]
    return [
        "补充告警标题、时间、源/目的 IP、命中规则、日志原文和当前处置情况。",
        "确认受影响资产是否为核心业务、互联网暴露资产或高权限账号。",
    ]


def collect_affected_assets(arguments: dict[str, Any]) -> list[str]:
    assets: list[str] = []
    for key in ("asset", "sourceIp", "destinationIp", "sourceDevice"):
        value = arg_string(arguments, key)
        if value and value not in assets:
            assets.append(value)
    return assets


def timeline(arguments: dict[str, Any]) -> list[str]:
    occurred_at = arg_string(arguments, "occurredAt")
    return [f"{occurred_at}：告警触发"] if occurred_at else []


def build_trivial_input_response(arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "module": "alert-analysis",
        "model": "",
        "usedModel": False,
        "overview": "输入内容不包含有效的安全告警、攻击 IP 或威胁信息，无法进行研判。请提供告警标题、日志原文、PCAP 解析数据、安全事件描述或待查询 IP。",
        "severity": "待确认",
        "confidence": "低",
        "findings": [],
        "timeline": [],
        "affectedAssets": [],
        "recommendedActions": [],
        "questions": [],
        "processingPlan": [],
        "riskNotes": [],
        "generatedAt": now_text(),
        "alertSummary": {
            "alertName": clip_chars(compact_whitespace(arguments.get("alertText") or ""), 80),
            "sourceSystem": "",
            "sourceDevice": "",
            "occurredAt": "",
            "sourceIp": "",
            "destinationIp": "",
            "asset": "",
            "businessContext": "",
        },
        "rawModelOutput": None,
    }


def build_fallback_result(
    arguments: dict[str, Any],
    model_name: str,
    note: str | None = None,
    raw_model_output: str | None = None,
) -> dict[str, Any]:
    alert_text = arg_string(arguments, "alertText") or arg_string(arguments, "sourceText") or json.dumps(arguments, ensure_ascii=False)
    compact_alert = compact_whitespace(alert_text)
    severity = infer_severity(compact_alert)
    confidence = infer_confidence(compact_alert, severity)
    risk_notes = [
        "本结果基于已提供告警文本生成，证据不足时应结合原始日志、流量、终端进程和账号行为复核。",
        "未确认攻击链闭环前，不建议直接关闭告警。",
    ]
    if note:
        risk_notes.insert(0, note)
    return {
        "module": "alert-analysis",
        "model": model_name,
        "usedModel": False,
        "overview": f"告警初筛风险等级为{severity}，需结合原始日志和资产上下文继续确认。关键线索：{clip_chars(compact_alert, 120)}",
        "severity": severity,
        "confidence": confidence,
        "alertSummary": {
            "alertName": clip_chars(compact_alert, 80),
            "sourceSystem": arg_string(arguments, "sourceSystem"),
            "sourceDevice": arg_string(arguments, "sourceDevice"),
            "occurredAt": arg_string(arguments, "occurredAt"),
            "sourceIp": arg_string(arguments, "sourceIp"),
            "destinationIp": arg_string(arguments, "destinationIp"),
            "asset": arg_string(arguments, "asset"),
            "businessContext": arg_string(arguments, "businessContext"),
        },
        "findings": [
            {
                "title": "告警证据需要复核",
                "severity": severity,
                "evidence": clip_chars(compact_alert, 180),
                "impact": impact_for(severity),
            }
        ],
        "timeline": timeline(arguments),
        "affectedAssets": collect_affected_assets(arguments),
        "recommendedActions": recommended_actions(severity),
        "questions": [],
        "processingPlan": [
            "解析告警标题、规则命中和日志原文",
            "评估影响资产、源/目的地址和账号行为",
            "判断风险等级并生成处置动作",
            "列出继续研判需要补充的证据",
        ],
        "riskNotes": risk_notes,
        "generatedAt": now_text(),
        "rawModelOutput": raw_model_output,
    }


def truncate_pcap_data(arguments: dict[str, Any]) -> dict[str, Any]:
    pcap = arg_string(arguments, "pcapData")
    if not pcap or len(pcap) <= MAX_PROMPT_PCAP_CHARS:
        return dict(arguments)
    head = pcap[: MAX_PROMPT_PCAP_CHARS // 2]
    tail = pcap[-MAX_PROMPT_PCAP_CHARS // 2 :]
    truncated = dict(arguments)
    truncated["pcapData"] = (
        f"{head}\n\n... [pcapData 共 {len(pcap)} 字符，已截断，保留头尾各 {MAX_PROMPT_PCAP_CHARS // 2} 字符] ...\n\n{tail}"
    )
    return truncated


def build_analysis_prompt(arguments: dict[str, Any]) -> str:
    request = truncate_pcap_data(arguments)
    pcap_instructions = ""
    if request.get("pcapData"):
        pcap_instructions = """
## PCAP 数据包分析要求
7. 如果提供了 pcapData，需要进行协议分析：识别通信协议，提取五元组，统计包大小和时序。
8. 从数据包中识别可疑行为：异常大包、心跳 beacon、DNS 隧道、加密流量异常、横向移动、数据外传等。
9. findings 应基于 PCAP 数据提供协议层证据。
10. timeline 应基于数据包时间戳重建事件链。
"""
    context_block = ""
    if request.get("conversationContext"):
        context_block = f"## 对话上下文\n{request['conversationContext']}\n\n---\n"
    schema = {
        "module": "alert-analysis",
        "model": "",
        "usedModel": True,
        "overview": "一句话研判结论",
        "severity": "紧急/高/中/低/待确认",
        "confidence": "高/中/低",
        "alertSummary": {
            "alertName": "",
            "sourceSystem": "",
            "sourceDevice": "",
            "occurredAt": "",
            "sourceIp": "",
            "destinationIp": "",
            "asset": "",
            "businessContext": "",
        },
        "findings": [{"title": "", "severity": "", "evidence": "", "impact": ""}],
        "timeline": [],
        "affectedAssets": [],
        "recommendedActions": [],
        "questions": [],
        "processingPlan": [],
        "riskNotes": [],
        "generatedAt": "",
    }
    return (
        "请对下面的安全告警做威胁研判，输出严格 JSON。\n"
        "若输入不包含安全告警、攻击特征或异常行为，findings/recommendedActions/questions 返回空数组。\n"
        f"{pcap_instructions}\n{context_block}\nJSON 格式：{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n"
        f"告警输入：{json.dumps(request, ensure_ascii=False, indent=2)}"
    )


def parse_model_json(content: str) -> dict[str, Any]:
    text = content.strip()
    text = re.sub(r"^```(?:json)?", "", text, flags=re.I).strip()
    text = re.sub(r"```$", "", text).strip()
    start = text.find("{")
    if start < 0:
        raise ValueError("模型输出未包含有效的 JSON 对象")

    # Brace-depth scan so trailing `} ... {` blocks don't yield an invalid span
    # (the naive first-{/last-} approach grabs the wrong substring).
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
        raise ValueError("model returned JSON, but not an object")
    return parsed


def as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, str):
            if item.strip():
                result.append(item.strip())
        elif isinstance(item, dict):
            text = (
                item.get("question")
                or item.get("title")
                or item.get("action")
                or item.get("description")
                or item.get("text")
                or item.get("label")
                or item.get("name")
            )
            if str(text or "").strip():
                result.append(str(text).strip())
        elif item is not None:
            text = str(item).strip()
            if text:
                result.append(text)
    return result


SEVERITY_VALUES = ("紧急", "高", "中", "低", "待确认")
CONFIDENCE_VALUES = ("高", "中", "低")


def normalize_severity(value: Any) -> str:
    """Enforce the severity enum; unknown/missing values fall back to 待确认 so a
    prompt-injected or hallucinating model cannot smuggle in arbitrary labels."""
    text = str(value or "").strip()
    return text if text in SEVERITY_VALUES else "待确认"


def normalize_confidence(value: Any) -> str:
    text = str(value or "").strip()
    return text if text in CONFIDENCE_VALUES else "低"


def normalize_findings(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    findings: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, dict):
            findings.append(
                {
                    "title": str(item.get("title") or ""),
                    "severity": normalize_severity(item.get("severity")),
                    "evidence": str(item.get("evidence") or ""),
                    "impact": str(item.get("impact") or ""),
                }
            )
        elif item:
            findings.append({"title": str(item), "severity": "待确认", "evidence": "", "impact": ""})
    return findings


def normalize_model_result(
    fallback: dict[str, Any],
    model_name: str,
    model_content: str | None,
    model_error: str | None = None,
) -> dict[str, Any]:
    if model_error or not model_content:
        result = deepcopy(fallback)
        result["model"] = model_name or DEFAULT_MODEL
        result["usedModel"] = False
        result["riskNotes"] = [
            f"大模型调用失败（{model_error or '无模型输出'}），已使用本地初筛结果。",
            *result.get("riskNotes", []),
        ]
        result["generatedAt"] = now_text()
        return result

    try:
        model_output = parse_model_json(model_content)
    except Exception as exc:  # noqa: BLE001
        result = deepcopy(fallback)
        result["model"] = model_name or DEFAULT_MODEL
        result["usedModel"] = False
        result["riskNotes"] = [f"模型返回解析失败：{exc}", *result.get("riskNotes", [])]
        result["generatedAt"] = now_text()
        result["rawModelOutput"] = model_content
        return result

    result = deepcopy(fallback)
    result["module"] = "alert-analysis"
    result["model"] = model_name or DEFAULT_MODEL
    result["usedModel"] = True
    result["overview"] = str(model_output.get("overview") or result.get("overview") or "")
    result["severity"] = normalize_severity(model_output.get("severity") or result.get("severity"))
    result["confidence"] = normalize_confidence(model_output.get("confidence") or result.get("confidence"))
    if isinstance(model_output.get("alertSummary"), dict):
        result["alertSummary"] = model_output["alertSummary"]
    result["findings"] = normalize_findings(model_output.get("findings")) or result.get("findings", [])
    for key in ["timeline", "affectedAssets", "recommendedActions", "questions", "processingPlan", "riskNotes"]:
        normalized = as_string_list(model_output.get(key))
        if normalized or key in model_output:
            result[key] = normalized
    result["generatedAt"] = now_text()
    result["rawModelOutput"] = model_content
    return result


def openai_chat_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    # Already includes an API version segment: OpenAI /v1, Zhipu /v4, etc.
    if re.search(r"/v\d+$", base):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def configured_api_key(llm_config: dict[str, Any]) -> str:
    explicit = str(llm_config.get("apiKey") or "").strip()
    if explicit:
        return explicit
    env_name = str(llm_config.get("apiKeyEnv") or "ALERT_ANALYSIS_LLM_API_KEY").strip()
    return os.environ.get(env_name, "").strip()


def raise_for_status_with_body(response: requests.Response) -> None:
    """Like response.raise_for_status(), but appends the response body so
    provider errors (rate limits, invalid model, auth) surface clearly
    instead of a bare status code."""
    if response.status_code < 400:
        return
    body = (response.text or "").strip()
    snippet = clip_chars(body, 400) if body else "(空响应体)"
    raise RuntimeError(f"HTTP {response.status_code}：{snippet}")


def call_direct_llm(config: dict[str, Any], messages: list[dict[str, str]]) -> tuple[str, str]:
    llm = config.get("llm") or {}
    mode = str(llm.get("mode") or "host-managed").lower()
    base_url = str(llm.get("baseUrl") or "").strip()
    api_key = configured_api_key(llm)
    model = str(llm.get("model") or DEFAULT_MODEL).strip()
    if mode not in {"direct", "openai-compatible", "openai"}:
        raise RuntimeError("LLM mode is not direct")
    if not base_url or not api_key or not model:
        raise RuntimeError("LLM baseUrl, apiKey/apiKeyEnv, and model must be configured")

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": float(llm.get("temperature", 0.1)),
        "max_tokens": max(int(llm.get("maxTokens", DIRECT_LLM_MIN_OUTPUT_TOKENS)), DIRECT_LLM_MIN_OUTPUT_TOKENS),
        "response_format": {"type": "json_object"},
    }
    timeout = float(llm.get("timeoutSeconds", 60))
    response = requests.post(
        openai_chat_url(base_url),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=timeout,
    )
    raise_for_status_with_body(response)
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    return model, content


IMAGE_MIME_BY_EXT = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "bmp": "image/bmp",
    "webp": "image/webp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
}


def glm_ocr_url(base_url: str) -> str:
    """Build the Zhipu OCR tool endpoint from the configured base URL.

    baseUrl like https://open.bigmodel.cn/api/paas/v4 -> .../files/ocr."""
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return f"{base}/files/ocr"


def glm_ocr_provider(config: dict[str, Any]) -> tuple[str, str, float]:
    """Read the GLM OCR provider config (baseUrl/apiKey/timeout) from the
    dedicated ocr.provider section — intentionally decoupled from the analysis
    LLM (llm.*) so OCR can use a separate GLM account/key while analysis runs
    on DeepSeek."""
    ocr = config.get("ocr") or {}
    provider = ocr.get("provider") or {}
    base_url = str(provider.get("baseUrl") or "").strip()
    explicit_key = str(provider.get("apiKey") or "").strip()
    if explicit_key:
        api_key = explicit_key
    else:
        env_name = str(provider.get("apiKeyEnv") or "GLM_OCR_API_KEY").strip()
        api_key = os.environ.get(env_name, "").strip()
    timeout = float(provider.get("timeoutSeconds") or ocr.get("timeoutSeconds") or 60)
    return base_url, api_key, timeout


def call_glm_ocr(
    config: dict[str, Any],
    image_path: Path,
    tool_type: str,
    language_type: str | None,
) -> str:
    """Call the Zhipu OCR tool service (/files/ocr) and return concatenated
    recognized text. Uses ocr.provider credentials (separate GLM key), not the
    analysis LLM config."""
    base_url, api_key, timeout = glm_ocr_provider(config)
    if not base_url or not api_key:
        raise RuntimeError("GLM OCR 需要在 ocr.provider 中配置 baseUrl 与 apiKey/apiKeyEnv")

    ext = image_path.suffix.lower().lstrip(".")
    mime = IMAGE_MIME_BY_EXT.get(ext, "image/png")
    image_bytes = image_path.read_bytes()
    filename = image_path.name or f"alert-image.{ext or 'png'}"

    form_fields: dict[str, str] = {"tool_type": tool_type or "hand_write"}
    if language_type:
        form_fields["language_type"] = language_type
    form_fields["probability"] = "false"

    response = requests.post(
        glm_ocr_url(base_url),
        headers={"Authorization": f"Bearer {api_key}"},
        data=form_fields,
        files={"file": (filename, image_bytes, mime)},
        timeout=timeout,
    )
    raise_for_status_with_body(response)
    payload = response.json()

    status = str(payload.get("status") or "").lower()
    if status == "failed":
        message = payload.get("message") or "OCR 任务失败"
        raise RuntimeError(f"GLM OCR 任务失败：{message}")

    words_result = payload.get("words_result") or []
    lines = [str(item.get("words") or "").strip() for item in words_result if isinstance(item, dict)]
    text = "\n".join(line for line in lines if line)
    if not text:
        raise RuntimeError("GLM OCR 未识别到可用文本，请确认截图清晰或改用 Tesseract 兜底。")
    return text


def analyze_security_alert_direct(arguments: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_config()
    pcap_path = arg_string(arguments, "pcapFilePath")
    if pcap_path and not arg_string(arguments, "pcapData"):
        try:
            pcap_result = parse_pcap_file_tool({"path": pcap_path}, config)
            arguments = {**arguments, "pcapData": pcap_result["text"]}
        except Exception as exc:  # noqa: BLE001
            arguments = {**arguments, "pcapData": f"PCAP 解析失败：{exc}"}

    alert_text = arg_string(arguments, "alertText") or ""
    if is_trivial_alert_input(alert_text):
        return build_trivial_input_response(arguments)

    fallback = build_fallback_result(arguments, str(config.get("llm", {}).get("model") or DEFAULT_MODEL))
    try:
        model_name, model_content = call_direct_llm(
            config,
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": build_analysis_prompt(arguments)}],
        )
        return normalize_model_result(fallback, model_name, model_content)
    except Exception as exc:  # noqa: BLE001
        return normalize_model_result(fallback, str(config.get("llm", {}).get("model") or DEFAULT_MODEL), None, str(exc))


def resolve_executable(candidates: list[str]) -> str:
    for candidate in candidates:
        if not candidate:
            continue
        if Path(candidate).exists():
            return candidate
    for candidate in candidates:
        if candidate:
            return candidate
    return ""


def command_failure_text(program: str, completed: subprocess.CompletedProcess[str]) -> str:
    detail = (completed.stderr or completed.stdout or "").strip()
    if detail:
        return f"{program} 失败：{clip_chars(detail, 200)}"
    return f"{program} 退出码：{completed.returncode}"


def run_command(program: str, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [program, *args],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def parse_pcap_file_tool(arguments: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_config()
    tools = config.get("tools") or {}
    raw_path = arg_string(arguments, "path")
    if not raw_path:
        raise ValueError("path is required")
    path = safe_resolve(raw_path, mode="read", must_exist=True)
    ext = path.suffix.lower().lstrip(".")
    if ext not in {"pcap", "pcapng", "cap"}:
        raise ValueError("仅支持 pcap、pcapng、cap 文件")

    timeout = float(tools.get("pcapTimeoutSeconds", 20))
    max_packets = int(arguments.get("maxPackets") or tools.get("maxPcapPackets", 200))
    max_chars = int(tools.get("maxPcapOutputChars", 50000))
    path_text = str(path)
    errors: list[str] = []

    tshark = resolve_executable(
        [
            str(tools.get("tsharkPath") or ""),
            r"C:\Program Files\Wireshark\tshark.exe",
            r"C:\Program Files (x86)\Wireshark\tshark.exe",
            "tshark",
        ]
    )
    if tshark:
        stats = run_command(tshark, ["-r", path_text, "-q", "-z", "io,stat,0", "-z", "conv,tcp", "-z", "conv,udp"], timeout)
        if stats.returncode == 0:
            packets = run_command(tshark, ["-r", path_text, "-c", str(max_packets)], timeout)
            packet_text = packets.stdout if packets.returncode == 0 else command_failure_text(tshark, packets)
            text = f"=== PCAP 统计信息 ===\n{stats.stdout}\n\n=== 数据包列表（最多 {max_packets} 条）===\n{packet_text}"
            return {"module": "pcap-parser", "text": clip_chars(text, max_chars), "tool": "tshark", "generatedAt": now_text()}
        errors.append(command_failure_text(tshark, stats))

    capinfos = resolve_executable(
        [
            str(tools.get("capinfosPath") or ""),
            r"C:\Program Files\Wireshark\capinfos.exe",
            r"C:\Program Files (x86)\Wireshark\capinfos.exe",
            "capinfos",
        ]
    )
    if capinfos:
        info = run_command(capinfos, [path_text], timeout)
        if info.returncode == 0:
            return {"module": "pcap-parser", "text": clip_chars(info.stdout, max_chars), "tool": "capinfos", "generatedAt": now_text()}
        errors.append(command_failure_text(capinfos, info))

    tcpdump = str(tools.get("tcpdumpPath") or "tcpdump")
    try:
        tcp = run_command(tcpdump, ["-r", path_text, "-n", "-c", str(max_packets)], timeout)
    except FileNotFoundError as exc:
        raise RuntimeError(f"未找到 tcpdump：{exc}") from exc
    if tcp.returncode == 0:
        return {"module": "pcap-parser", "text": clip_chars(tcp.stdout, max_chars), "tool": "tcpdump", "generatedAt": now_text()}
    errors.append(command_failure_text(tcpdump, tcp))

    detail = "；".join(item for item in errors if item)[:500]
    raise RuntimeError(
        "无法解析 PCAP 文件：需要安装 Wireshark (tshark/capinfos) 或 tcpdump。"
        f"{' 解析错误：' + detail if detail else ''}"
    )


def resolve_ocr_executable(candidates: list[str]) -> str:
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.exists():
            return str(path)
    for candidate in candidates:
        if not candidate:
            continue
        found = shutil.which(candidate)
        if found:
            return found
    return ""


def extract_alert_image_glm_ocr(
    path: Path,
    config: dict[str, Any],
    ocr: dict[str, Any],
    max_chars: int,
) -> dict[str, Any]:
    tool_type = str(ocr.get("toolType") or "hand_write").strip() or "hand_write"
    language_type = str(ocr.get("languageType") or "").strip() or None
    text = call_glm_ocr(config, path, tool_type, language_type)
    return {
        "module": "alert-image-ocr",
        "text": clip_chars(text, max_chars),
        "tool": "glm-ocr",
        "language": language_type or "",
        "generatedAt": now_text(),
    }


def extract_alert_image_tesseract(
    path: Path,
    arguments: dict[str, Any],
    ocr: dict[str, Any],
    max_chars: int,
) -> dict[str, Any]:
    tesseract = resolve_ocr_executable(
        [
            str(ocr.get("tesseractPath") or ""),
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            "tesseract",
        ]
    )
    if not tesseract:
        raise RuntimeError(
            "未找到 Tesseract OCR。请安装 Tesseract，或在 config.local.json 的 ocr.tesseractPath 中配置路径。"
        )

    language = arg_string(arguments, "language") or str(ocr.get("language") or "chi_sim+eng")
    psm = int(arguments.get("pageSegmentationMode") or ocr.get("pageSegmentationMode") or 6)
    timeout = float(ocr.get("timeoutSeconds", 30))
    args = [str(path), "stdout", "--psm", str(psm)]
    if language:
        args.extend(["-l", language])

    try:
        completed = run_command(tesseract, args, timeout)
    except FileNotFoundError as exc:
        raise RuntimeError(f"无法启动 Tesseract OCR：{exc}") from exc

    if completed.returncode != 0:
        raise RuntimeError(command_failure_text(tesseract, completed))

    text = completed.stdout.strip()
    if not text:
        raise RuntimeError("OCR 未识别到可用文本，请确认截图清晰、方向正确，或换用更适合的 OCR 引擎。")

    return {
        "module": "alert-image-ocr",
        "text": clip_chars(text, max_chars),
        "tool": "tesseract",
        "language": language,
        "generatedAt": now_text(),
    }


def extract_alert_image_tool(arguments: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_config()
    ocr = config.get("ocr") or {}
    raw_path = arg_string(arguments, "path")
    if not raw_path:
        raise ValueError("path is required")
    path = safe_resolve(raw_path, mode="read", must_exist=True)
    ext = path.suffix.lower().lstrip(".")
    if ext not in {"png", "jpg", "jpeg", "bmp", "webp", "tif", "tiff"}:
        raise ValueError("仅支持 png、jpg、jpeg、bmp、webp、tif、tiff 告警截图")

    engine = str(ocr.get("engine") or "glm-ocr").strip().lower()
    max_chars = int(ocr.get("maxOutputChars", 12000))
    fallback = bool(ocr.get("fallbackToTesseract", True))

    # glm-ocr / auto：优先用智谱专用 OCR 工具服务（/files/ocr）
    if engine in {"glm-ocr", "auto"}:
        try:
            return extract_alert_image_glm_ocr(path, config, ocr, max_chars)
        except Exception as ocr_exc:  # noqa: BLE001
            if engine != "auto" and not fallback:
                raise
            # 兜底到本地 Tesseract
            try:
                return extract_alert_image_tesseract(path, arguments, ocr, max_chars)
            except Exception as tess_exc:  # noqa: BLE001
                raise RuntimeError(
                    f"GLM OCR 识别失败（{ocr_exc}），且 Tesseract 兜底失败（{tess_exc}）。"
                    "请在 config.local.json 配置有效的 GLM apiKey，或安装 Tesseract OCR。"
                ) from tess_exc

    if engine == "tesseract":
        return extract_alert_image_tesseract(path, arguments, ocr, max_chars)

    raise RuntimeError(f"暂不支持 OCR 引擎：{engine}（可选：glm-ocr / auto / tesseract）")


def normalize_ip_list(ip_list: Any) -> list[str]:
    if isinstance(ip_list, str):
        parts = re.split(r"[\s,;，；]+", ip_list)
    elif isinstance(ip_list, list):
        parts = [str(item) for item in ip_list]
    else:
        raise ValueError("ipList must be a string or array")
    ips: list[str] = []
    for item in parts:
        value = item.strip()
        if not value:
            continue
        ipaddress.ip_address(value)
        if value not in ips:
            ips.append(value)
    if not ips:
        raise ValueError("ipList does not contain a valid IP")
    return ips


def threatbook_api_key(config: dict[str, Any]) -> str:
    """ThreatBook API key from config/env only. Caller-supplied keys are never
    accepted — the threat-intel key is an operator secret that must not be
    overridable by an MCP client."""
    threat = config.get("threatIntel") or {}
    configured = str(threat.get("threatbookApiKey") or "").strip()
    if configured:
        return configured
    env_name = str(threat.get("threatbookApiKeyEnv") or "THREATBOOK_API_KEY")
    return os.environ.get(env_name, "").strip()


def scrub_url_from_error(text: str) -> str:
    """Strip `apikey=...` query parameters from exception text so the secret is
    never echoed back to MCP clients in risk notes."""
    return re.sub(r"(?i)(apikey=)[^&\s]+", r"\1***", text)


def risk_level_from_record(record: dict[str, Any]) -> str:
    judgments = record.get("judgments") or []
    tags_classes = record.get("tags_classes") or []
    asn_rank = str((record.get("asn") or {}).get("rank") or "")
    if judgments or "高" in asn_rank or "high" in asn_rank.lower():
        return "高"
    if tags_classes or "中" in asn_rank or "medium" in asn_rank.lower():
        return "中"
    return "低"


def normalize_threatbook_record(ip: str, record: dict[str, Any]) -> dict[str, Any]:
    tags_classes = record.get("tags_classes") or []
    tags: list[str] = []
    for tag in tags_classes:
        raw_tags = tag.get("tags") if isinstance(tag, dict) else None
        if isinstance(raw_tags, list):
            tags.extend(str(item) for item in raw_tags if item)
        elif raw_tags:
            tags.append(str(raw_tags))
    asn = record.get("asn") or {}
    location = ((record.get("basic") or {}).get("location") or {})
    return {
        "ip": ip,
        "riskLevel": risk_level_from_record(record),
        "judgments": record.get("judgments") or [],
        "tags": tags,
        "asn": {
            "number": asn.get("number") or "",
            "info": asn.get("info") or "",
            "rank": asn.get("rank") or "",
        },
        "location": {
            "country": location.get("country") or "",
            "countryCode": location.get("country_code") or "",
            "province": location.get("province") or "",
            "city": location.get("city") or "",
            "lng": location.get("lng") or "",
            "lat": location.get("lat") or "",
        },
        "updateTime": record.get("update_time") or "",
    }


def write_ip_csv(path: str, rows: list[dict[str, Any]]) -> None:
    headers = ["IP地址", "威胁类型", "标签信息", "ASN编号", "ASN名称及注册信息", "ASN风险等级", "更新时间", "国家", "国家代码", "省", "城市", "经度", "纬度"]
    with open(path, "w", newline="", encoding="utf-8-sig") as file:
        writer = csv.writer(file)
        writer.writerow(headers)
        for item in rows:
            location = item.get("location") or {}
            asn = item.get("asn") or {}
            writer.writerow(
                [
                    item.get("ip") or "",
                    ",".join(item.get("judgments") or []),
                    "; ".join(item.get("tags") or []),
                    asn.get("number") or "",
                    asn.get("info") or "",
                    asn.get("rank") or "",
                    item.get("updateTime") or "",
                    location.get("country") or "",
                    location.get("countryCode") or "",
                    location.get("province") or "",
                    location.get("city") or "",
                    location.get("lng") or "",
                    location.get("lat") or "",
                ]
            )


def analyze_attack_ip_tool(arguments: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_config()
    ips = normalize_ip_list(arguments.get("ipList") or arguments.get("ip") or "")
    provider = str(arguments.get("provider") or (config.get("threatIntel") or {}).get("provider") or "threatbook").lower()
    if provider != "threatbook":
        raise ValueError(f"Unsupported threat-intel provider: {provider}")
    api_key = threatbook_api_key(config)
    if not api_key:
        return {
            "module": "ip-threat-analysis",
            "model": "threatbook",
            "usedModel": False,
            "overview": "未配置 ThreatBook API Key，无法查询攻击 IP 威胁情报。",
            "severity": "待确认",
            "confidence": "低",
            "alertSummary": {"alertName": f"攻击 IP 威胁分析：{', '.join(ips)}"},
            "findings": [],
            "timeline": [],
            "affectedAssets": ips,
            "recommendedActions": ["设置 THREATBOOK_API_KEY 或在 MCP 配置中填写 threatbookApiKey 后重试。"],
            "questions": [],
            "processingPlan": ["校验 IP 格式", "读取 ThreatBook API Key", "调用威胁情报接口"],
            "riskNotes": ["未发起外部查询，因为缺少 API Key。"],
            "results": [],
            "generatedAt": now_text(),
        }

    threat = config.get("threatIntel") or {}
    interval = float(threat.get("requestIntervalSeconds", 1.0))
    timeout = float(threat.get("timeoutSeconds", 20))
    url = "https://api.threatbook.cn/v3/ip/query"
    rows: list[dict[str, Any]] = []
    risk_notes: list[str] = []
    for ip in ips:
        try:
            resp = requests.get(
                url,
                params={"apikey": api_key, "resource": ip, "lang": "zh"},
                timeout=timeout,
                allow_redirects=False,
            )
            resp.raise_for_status()
            payload = resp.json()
            if payload.get("response_code") == 0:
                rows.append(normalize_threatbook_record(ip, ((payload.get("data") or {}).get(ip) or {})))
            else:
                risk_notes.append(f"{ip} 查询失败：{payload.get('verbose_msg') or payload.get('response_code')}")
        except Exception as exc:  # noqa: BLE001
            risk_notes.append(scrub_url_from_error(f"{ip} 查询失败：{exc}"))
        time.sleep(max(interval, 0))

    if arguments.get("outputCsv") and rows:
        csv_path = safe_resolve(str(arguments["outputCsv"]), mode="write", allow_create=True)
        write_ip_csv(str(csv_path), rows)

    highest = "低"
    if any(item.get("riskLevel") == "高" for item in rows):
        highest = "高"
    elif any(item.get("riskLevel") == "中" for item in rows):
        highest = "中"
    confidence = "中" if rows else "低"
    suspicious = [item for item in rows if item.get("riskLevel") in {"高", "中"}]
    overview = (
        f"已查询 {len(rows)}/{len(ips)} 个 IP，其中 {len(suspicious)} 个存在威胁标签或中高风险迹象。"
        if rows
        else "未获得有效 IP 威胁情报结果。"
    )
    findings = [
        {
            "title": f"{item['ip']} 风险等级：{item.get('riskLevel')}",
            "severity": item.get("riskLevel") or "待确认",
            "evidence": f"威胁类型：{', '.join(item.get('judgments') or []) or '无'}；标签：{', '.join(item.get('tags') or []) or '无'}",
            "impact": "若该 IP 出现在入站攻击、异常登录、C2 外联或数据外传链路中，应优先阻断并回溯关联资产。",
        }
        for item in rows
    ]
    used_model = len(rows) > 0
    return {
        "module": "ip-threat-analysis",
        "model": "threatbook",
        "usedModel": used_model,
        "overview": overview,
        "severity": highest,
        "confidence": confidence,
        "alertSummary": {"alertName": f"攻击 IP 威胁分析：{', '.join(ips)}"},
        "findings": findings,
        "timeline": [],
        "affectedAssets": ips,
        "recommendedActions": [
            "将中高风险 IP 与防火墙、WAF、EDR、NDR 和账号日志进行交叉验证。",
            "对命中威胁标签的 IP 执行临时阻断或限速，并保留处置证据。",
            "回溯该 IP 相关源/目的连接、认证失败、命令执行和数据传输行为。",
        ],
        "questions": [],
        "processingPlan": ["校验 IP 格式", "调用 ThreatBook IP 查询接口", "归一化威胁类型、标签、ASN 和地理信息", "生成处置建议"],
        "riskNotes": risk_notes,
        "results": rows,
        "generatedAt": now_text(),
    }


def create_mcp_server(config: dict[str, Any]):
    try:
        from mcp.server.fastmcp import FastMCP
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("Install MCP dependencies first: python -m pip install -r requirements.txt") from exc

    mcp = FastMCP("Threat Analysis MCP")

    @mcp.tool()
    def analyze_security_alert(
        alertText: str,
        sourceSystem: str | None = None,
        sourceDevice: str | None = None,
        occurredAt: str | None = None,
        sourceIp: str | None = None,
        destinationIp: str | None = None,
        asset: str | None = None,
        businessContext: str | None = None,
        currentStatus: str | None = None,
        analysisMode: str | None = None,
        pcapData: str | None = None,
        pcapFilePath: str | None = None,
        conversationContext: str | None = None,
    ) -> dict[str, Any]:
        return analyze_security_alert_direct(
            {
                "alertText": alertText,
                "sourceSystem": sourceSystem,
                "sourceDevice": sourceDevice,
                "occurredAt": occurredAt,
                "sourceIp": sourceIp,
                "destinationIp": destinationIp,
                "asset": asset,
                "businessContext": businessContext,
                "currentStatus": currentStatus,
                "analysisMode": analysisMode,
                "pcapData": pcapData,
                "pcapFilePath": pcapFilePath,
                "conversationContext": conversationContext,
            },
            config,
        )

    @mcp.tool()
    def analyze_attack_ip(ipList: str | list[str], provider: str | None = None, outputCsv: str | None = None) -> dict[str, Any]:
        return analyze_attack_ip_tool({"ipList": ipList, "provider": provider, "outputCsv": outputCsv}, config)

    @mcp.tool()
    def parse_pcap_file(path: str, maxPackets: int | None = None) -> dict[str, Any]:
        return parse_pcap_file_tool({"path": path, "maxPackets": maxPackets}, config)

    @mcp.tool()
    def extract_alert_image(
        path: str,
        language: str | None = None,
        pageSegmentationMode: int | None = None,
    ) -> dict[str, Any]:
        return extract_alert_image_tool(
            {
                "path": path,
                "language": language,
                "pageSegmentationMode": pageSegmentationMode,
            },
            config,
        )

    return mcp


def main() -> int:
    parser = argparse.ArgumentParser(description="Threat Analysis MCP service")
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
    mcp = create_mcp_server(config)

    # FastMCP exposes these settings for the streamable HTTP transport.
    if hasattr(mcp, "settings"):
        mcp.settings.host = server_cfg.get("host") or "127.0.0.1"
        mcp.settings.port = int(server_cfg.get("port") or 8765)

    mcp.run(transport=args.transport)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
