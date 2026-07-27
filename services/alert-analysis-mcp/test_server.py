from __future__ import annotations

import json
import unittest
from unittest import mock

import server


class AlertAnalysisMcpTests(unittest.TestCase):
    def test_direct_alert_analysis_uses_model_result(self):
        model_content = json.dumps(
            {
                "overview": "疑似 C2 外联，建议按高危处置。",
                "severity": "高",
                "confidence": "中",
                "findings": [
                    {
                        "title": "发现 C2 外联",
                        "severity": "高",
                        "evidence": "目的 IP 8.8.8.8",
                        "impact": "可能存在主机失陷风险",
                    }
                ],
                "recommendedActions": ["隔离主机", "回溯进程和网络日志"],
                "riskNotes": [],
            },
            ensure_ascii=False,
        )

        with mock.patch("server.call_direct_llm", return_value=("deepseek-v4-pro", model_content)):
            result = server.analyze_security_alert_direct(
                {
                    "alertText": "EDR 告警：主机 10.0.0.5 疑似 C2 外联，目的 IP 8.8.8.8，进程 powershell.exe",
                    "sourceIp": "10.0.0.5",
                    "destinationIp": "8.8.8.8",
                },
                {"llm": {"mode": "direct", "baseUrl": "https://example.invalid/v1", "apiKey": "test-key", "model": "deepseek-v4-pro"}},
            )

        self.assertTrue(result["usedModel"])
        self.assertEqual(result["model"], "deepseek-v4-pro")
        self.assertEqual(result["severity"], "高")
        self.assertEqual(result["findings"][0]["title"], "发现 C2 外联")

    def test_question_objects_are_normalized_to_question_text(self):
        model_content = json.dumps(
            {
                "overview": "发现扫描行为，需要补充上下文。",
                "severity": "待确认",
                "confidence": "中",
                "findings": [],
                "recommendedActions": [{"action": "核对扫描源主机归属"}],
                "questions": [
                    {
                        "id": "Q3",
                        "question": "扫描行为的时间范围是否集中，是否伴随其他恶意载荷？",
                        "context": "确认扫描是否为自动化工具所为，以及是否已发生进一步攻击。",
                    }
                ],
            },
            ensure_ascii=False,
        )

        result = server.normalize_model_result(
            {
                "module": "alert-analysis",
                "model": "local",
                "usedModel": False,
                "overview": "",
                "severity": "待确认",
                "confidence": "低",
                "findings": [],
                "recommendedActions": [],
                "questions": [],
                "processingPlan": [],
                "riskNotes": [],
            },
            "deepseek-v4-pro",
            model_content,
        )

        self.assertEqual(result["recommendedActions"], ["核对扫描源主机归属"])
        self.assertEqual(result["questions"], ["扫描行为的时间范围是否集中，是否伴随其他恶意载荷？"])

    def test_direct_alert_analysis_returns_fallback_without_llm_key(self):
        config = server.deep_merge(
            server.DEFAULT_CONFIG,
            {"llm": {"apiKey": "", "apiKeyEnv": "NOVA_TEST_MISSING_LLM_KEY"}},
        )
        with mock.patch.dict("os.environ", {"NOVA_TEST_MISSING_LLM_KEY": ""}, clear=False):
            result = server.analyze_security_alert_direct(
                {
                    "alertText": "发现 webshell 上传并执行命令",
                },
                config,
            )

        self.assertEqual(result["module"], "alert-analysis")
        self.assertFalse(result["usedModel"])
        self.assertEqual(result["severity"], "高")
        self.assertIn("LLM", result["riskNotes"][0])

    def test_trivial_input_returns_final_result(self):
        result = server.analyze_security_alert_direct({"alertText": "你好"})

        self.assertFalse(result["usedModel"])
        self.assertEqual(result["findings"], [])

    def test_missing_threatbook_key_returns_actionable_result(self):
        config = server.deep_merge(
            server.DEFAULT_CONFIG,
            {"threatIntel": {"threatbookApiKey": "", "threatbookApiKeyEnv": "NOVA_TEST_MISSING_THREATBOOK_KEY"}},
        )
        with mock.patch.dict("os.environ", {"NOVA_TEST_MISSING_THREATBOOK_KEY": ""}, clear=False):
            result = server.analyze_attack_ip_tool({"ipList": "8.8.8.8"}, config)

        self.assertEqual(result["module"], "ip-threat-analysis")
        self.assertEqual(result["severity"], "待确认")
        self.assertIn("THREATBOOK_API_KEY", result["recommendedActions"][0])
        self.assertEqual(result["results"], [])

    def test_threatbook_response_is_normalized(self):
        fake_response = mock.Mock()
        fake_response.raise_for_status.return_value = None
        fake_response.json.return_value = {
            "response_code": 0,
            "data": {
                "8.8.8.8": {
                    "judgments": ["远控"],
                    "tags_classes": [{"tags": ["C2", "botnet"]}],
                    "asn": {"number": "15169", "info": "GOOGLE", "rank": "高"},
                    "basic": {"location": {"country": "美国", "country_code": "US", "city": "Mountain View"}},
                    "update_time": "2026-06-29",
                }
            },
        }

        config = server.deep_merge(
            server.DEFAULT_CONFIG,
            {"threatIntel": {"threatbookApiKey": "test-key", "requestIntervalSeconds": 0}},
        )
        with mock.patch("server.requests.get", return_value=fake_response):
            result = server.analyze_attack_ip_tool({"ipList": ["8.8.8.8"]}, config)

        self.assertEqual(result["severity"], "高")
        self.assertEqual(result["results"][0]["judgments"], ["远控"])
        self.assertIn("C2", result["results"][0]["tags"])


if __name__ == "__main__":
    unittest.main()
