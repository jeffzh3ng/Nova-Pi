import json
import threading
import time
import unittest
from unittest import mock

import server


HEALTHCARE_MATRIX_TSV = (
    "数据分类\t\t\t\t\t\t数据分级\t\t\n"
    "一级类别（资源属性）\t二级类别\t三级类别\t四级类别\t数据范围及示例\t数据加工程度\t影响对象\t影响程度\t建议数据级别\n"
    "基础资源\t服务范围与对象\t患者\t患者信息\t患者姓名，生日，性别，民族\t原始数据\t个人\t严重危害\t一般数据3级\n"
    "\t\t\t患者敏感信息\t患者身份证号，联系方式，住址\t原始数据\t个人\t特别严重危害\t一般数据4级\n"
    "\t\t健康人\t个人信息\t姓名，生日，性别\t原始数据\t个人\t严重危害\t一般数据3级\n"
)


class DataClassificationMcpTests(unittest.TestCase):
    def test_parse_source_assets_captures_passthrough_and_samples(self):
        src = (
            "序号\t列名\t表名\tIP\t所属实例\t访问账号\t所属应用\t列描述\t业务描述\t是否是主数据\t数据特征\t举证 样例1\t举证 样例2\n"
            "1\tid_card\tpatient\t10.0.0.1\tDB\tacct\tHIS\t身份证号\t患者标识\t是\t证件\t110101\t120101\n"
        )
        assets = server.parse_source_assets(src)
        self.assertEqual(len(assets), 1)
        a = assets[0]
        self.assertEqual(a["assetId"], "1")
        self.assertEqual(a["fieldName"], "id_card")
        self.assertEqual(a["tableName"], "patient")
        self.assertEqual(a["ip"], "10.0.0.1")
        self.assertEqual(a["databaseInstance"], "DB")
        self.assertEqual(a["accessAccount"], "acct")
        self.assertEqual(a["sourceSystem"], "HIS")
        self.assertEqual(a["description"], "身份证号")
        self.assertEqual(a["businessDescription"], "患者标识")
        self.assertEqual(a["isMasterData"], "是")
        self.assertEqual(a["dataFeature"], "证件")
        self.assertEqual(a["sampleValues"], ["110101", "120101"])

    def test_parse_matrix_text_real_hierarchy_forward_fill(self):
        rows = server.parse_matrix_text(HEALTHCARE_MATRIX_TSV)
        self.assertEqual(len(rows), 3)
        for row in rows:
            self.assertEqual(row["categoryLevel1"], row["categoryPath"][0])
            self.assertEqual(row["categoryLevel2"], row["categoryPath"][1])
            self.assertEqual(row["categoryLevel3"], row["categoryPath"][2])
            self.assertEqual(row["categoryLevel4"], row["categoryPath"][3])
        # Row 2 inherits 一级/二级 from row 1 (merged cells), leaf is 患者敏感信息.
        self.assertEqual(rows[1]["categoryPath"], ["基础资源", "服务范围与对象", "患者", "患者敏感信息"])
        self.assertEqual(rows[1]["suggestedLevel"], "一般数据4级")
        # Row 3 changes 三级 to 健康人; leaf 个人信息.
        self.assertEqual(rows[2]["categoryPath"], ["基础资源", "服务范围与对象", "健康人", "个人信息"])
        self.assertEqual(rows[2]["suggestedLevel"], "一般数据3级")

    def test_builtin_matrix_healthcare_bundled(self):
        matrix = server.builtin_matrix("卫生健康")
        self.assertEqual(matrix["id"], "healthcare-baseline")
        self.assertGreater(len(matrix["rows"]), 100)
        self.assertTrue(all(row["categoryPath"] for row in matrix["rows"]))

    def test_builtin_matrix_finance_bundled(self):
        matrix = server.builtin_matrix("金融行业")
        self.assertEqual(matrix["id"], "finance-baseline")
        self.assertEqual(len(matrix["rows"]), 303)
        self.assertTrue(
            all(
                all(key in row for key in ("categoryLevel1", "categoryLevel2", "categoryLevel3", "categoryLevel4"))
                for row in matrix["rows"]
            )
        )
        self.assertTrue(
            any(
                row["categoryPath"][-1] == "个人身份传统鉴别信息"
                and row["suggestedLevel"] == "一般数据4级"
                for row in matrix["rows"]
            )
        )

    def test_resolve_matrix_respects_finance_builtin_id(self):
        matrix = server.resolve_matrix(
            {
                "customerIndustry": "通用行业",
                "matrixSelection": {"builtinMatrixId": "finance-baseline"},
            }
        )
        self.assertEqual(matrix["id"], "finance-baseline")

    def test_finance_local_rules_hit_sensitive_account_credentials(self):
        result = server.classify_data_assets_direct(
            {
                "sourceText": "序号\t列名\t表名\t列描述\n1\tbank_card_password\taccount\t银行卡密码\n",
                "customerIndustry": "金融行业",
            },
            {"llm": {"baseUrl": "", "apiKey": ""}},
        )
        self.assertEqual(result["matrixUsed"]["id"], "finance-baseline")
        asset = result["assetResults"][0]
        self.assertTrue(asset["categoryLevel1"])
        self.assertTrue(asset["categoryLevel2"])
        self.assertTrue(asset["categoryLevel3"])
        self.assertTrue(asset["categoryLevel4"])
        self.assertEqual(asset["categoryPath"][0], asset["categoryLevel1"])
        self.assertEqual(asset["categoryPath"][3], asset["categoryLevel4"])
        self.assertEqual(result["assetResults"][0]["dataLevel"], "一般数据4级")

    def test_normalize_model_result_keeps_four_category_levels(self):
        fallback = {
            "assetResults": [
                {
                    "assetId": "1",
                    "assetName": "A",
                    "categoryPath": ["B1", "B2", "B3", "B4"],
                    "categoryLevel1": "B1",
                    "categoryLevel2": "B2",
                    "categoryLevel3": "B3",
                    "categoryLevel4": "B4",
                    "dataCategory": "B4",
                    "dataLevel": "L3",
                    "classificationBasis": "base",
                    "accuracy": "medium",
                    "controls": [],
                    "reviewRequired": False,
                }
            ],
            "riskNotes": [],
        }
        model_content = json.dumps(
            {
                "overview": "ok",
                "confidence": "high",
                "assetResults": [
                    {
                        "assetId": "1",
                        "categoryLevel1": "L1",
                        "categoryLevel2": "",
                        "categoryLevel3": "L3",
                        "categoryLevel4": "L4",
                        "dataCategory": "L4",
                        "dataLevel": "L4",
                        "classificationBasis": "r",
                        "accuracy": "high",
                    }
                ],
            },
            ensure_ascii=False,
        )
        result = server.normalize_model_result(fallback, "m", model_content, None)
        item = result["assetResults"][0]
        self.assertEqual(item["categoryPath"], ["L1", "L3", "L4"])
        self.assertEqual(item["categoryLevel1"], "L1")
        self.assertEqual(item["categoryLevel2"], "")
        self.assertEqual(item["categoryLevel3"], "L3")
        self.assertEqual(item["categoryLevel4"], "L4")

    def test_build_model_context_uses_full_finance_matrix_by_default(self):
        request = {
            "sourceText": "序号\t列名\t表名\t列描述\n1\tbank_card_password\taccount\t银行卡密码\n",
            "customerIndustry": "金融行业",
            "matrixSelection": {"builtinMatrixId": "finance-baseline"},
        }
        assets = server.parse_source_assets(request["sourceText"])
        matrix = server.resolve_matrix(request)
        context = server.build_model_context(request, assets, matrix, server.DEFAULT_CONFIG)
        self.assertIn("矩阵共 303 行，已全量提供", context)
        self.assertIn("外部审计信息", context)
        self.assertNotIn("已按相关度取前", context)

    def test_build_model_context_can_still_limit_matrix_rows_when_configured(self):
        request = {
            "sourceText": "序号\t列名\t表名\t列描述\n1\tbank_card_password\taccount\t银行卡密码\n",
            "customerIndustry": "金融行业",
            "matrixSelection": {"builtinMatrixId": "finance-baseline"},
        }
        assets = server.parse_source_assets(request["sourceText"])
        matrix = server.resolve_matrix(request)
        context = server.build_model_context(
            request,
            assets,
            matrix,
            {"classification": {"maxMatrixRows": 2, "maxSamplesPerAsset": 3}},
        )
        self.assertIn("矩阵共 303 行，已按相关度取前 2 行", context)

    def test_deepseek_v4_max_tokens_floor_is_64k(self):
        self.assertEqual(
            server.resolve_max_tokens({"model": "deepseek-v4-pro", "maxTokens": 32768}),
            65536,
        )
        self.assertEqual(
            server.resolve_max_tokens({"model": "deepseek-v4-flash", "maxTokens": 131072}),
            131072,
        )
        self.assertEqual(
            server.resolve_max_tokens({"model": "gpt-4.1-mini", "maxTokens": 32768}),
            32768,
        )

    def test_normalize_model_result_matches_by_assetid_only(self):
        # Local fallback for 3 assets.
        assets = server.parse_source_assets(
            "序号\t列名\t表名\n1\tA\tT\n2\tB\tT\n3\tC\tT"
        )
        matrix = server.builtin_matrix("卫生健康")
        fallback = server.local_result({"customerIndustry": "卫生健康"}, assets, matrix)
        # Model returns asset 3 first, an unknown id 9 (must be ignored),
        # and asset 1 — but NOT asset 2 (must fall back to local + review).
        model_content = json.dumps(
            {
                "overview": "ok",
                "confidence": "高",
                "assetResults": [
                    {"assetId": "3", "dataCategory": "X", "dataLevel": "一般数据3级", "classificationBasis": "r3", "accuracy": "高"},
                    {"assetId": "9", "dataCategory": "BAD", "dataLevel": "一般数据1级", "classificationBasis": "bad", "accuracy": "高"},
                    {"assetId": "1", "dataCategory": "Y", "dataLevel": "一般数据2级", "classificationBasis": "r1", "accuracy": "高"},
                ],
            },
            ensure_ascii=False,
        )
        result = server.normalize_model_result(fallback, "m", model_content, None)
        ids = [a["assetId"] for a in result["assetResults"]]
        self.assertEqual(ids, ["1", "2", "3"])  # original order, no invented row
        self.assertEqual(result["assetResults"][0]["dataCategory"], "Y")  # asset 1 not cross-assigned
        self.assertEqual(result["assetResults"][2]["dataCategory"], "X")  # asset 3 correct
        self.assertTrue(result["assetResults"][1]["reviewRequired"])  # asset 2 missing -> review
        self.assertIn("模型未返回该资产", result["assetResults"][1]["classificationBasis"])

    def test_normalize_model_result_enum_and_nonempty(self):
        assets = server.parse_source_assets("序号\t列名\n1\tA\n")
        matrix = server.builtin_matrix("卫生健康")
        fallback = server.local_result({"customerIndustry": "卫生健康"}, assets, matrix)
        model_content = json.dumps(
            {
                "overview": "ok",
                "confidence": "最高",
                "assetResults": [
                    {
                        "assetId": "1",
                        "dataCategory": "",
                        "dataLevel": "核心数据",
                        "classificationBasis": "",
                        "accuracy": "极高",
                    }
                ],
            },
            ensure_ascii=False,
        )
        result = server.normalize_model_result(fallback, "m", model_content, None)
        a = result["assetResults"][0]
        self.assertEqual(a["dataLevel"], "核心数据")  # enum accepted
        self.assertEqual(a["accuracy"], "高")  # 极高 -> 高 (contains 高)
        self.assertEqual(a["dataCategory"], "待定")  # empty -> 待定
        self.assertEqual(a["classificationBasis"], "模型未给出明确依据。")  # empty -> fallback
        # accuracy 高, level 核心数据 (non-待定) -> review not forced
        self.assertFalse(a["reviewRequired"])

    def test_classify_direct_no_llm_returns_local(self):
        result = server.classify_data_assets_direct(
            {"sourceText": "序号\t列名\n1\tphone\tuser\n", "customerIndustry": "通用行业"},
            {"llm": {"baseUrl": "", "apiKey": ""}},
        )
        self.assertFalse(result["usedModel"])
        self.assertEqual(result["summary"]["totalAssets"], 1)
        self.assertIn("未配置大模型", result["riskNotes"][0])
        # 4 LLM fields must still be non-empty.
        a = result["assetResults"][0]
        self.assertTrue(a["dataCategory"] and a["dataLevel"] and a["classificationBasis"] and a["accuracy"])

    def test_classify_direct_merges_and_fills_missing(self):
        model_content = json.dumps(
            {
                "overview": "模型完成复核",
                "confidence": "高",
                "assetResults": [
                    {
                        "assetId": "1",
                        "dataCategory": "敏感个人信息",
                        "dataLevel": "一般数据4级",
                        "classificationBasis": "身份证号属于敏感个人信息。",
                        "accuracy": "高",
                    }
                ],
                "processingPlan": ["复核敏感项"],
                "riskNotes": [],
            },
            ensure_ascii=False,
        )
        with mock.patch("server.call_direct_llm", return_value=("deepseek-v4-pro", model_content)):
            result = server.classify_data_assets_direct(
                {
                    "sourceText": "序号\t列名\t表名\n1\tid_card\tpatient\n2\tpurchase_date\torder",
                    "customerIndustry": "卫生健康",
                },
                {"llm": {"baseUrl": "https://example.invalid/v1", "apiKey": "k", "model": "deepseek-v4-pro"}},
            )
        self.assertTrue(result["usedModel"])
        self.assertEqual(result["summary"]["totalAssets"], 2)
        self.assertEqual(result["assetResults"][0]["dataCategory"], "敏感个人信息")
        # passthrough preserved
        self.assertEqual(result["assetResults"][0]["fieldName"], "id_card")
        # missing asset 2 -> review + note
        self.assertTrue(result["assetResults"][1]["reviewRequired"])
        self.assertIn("模型未返回该资产", result["assetResults"][1]["classificationBasis"])

    def test_classify_direct_server_side_batching_preserves_order(self):
        src = "序号\t列名\n" + "\n".join(f"{i}\tCOL_{i}" for i in range(1, 6))
        # Mock returns all 5 ids each call; each batch keeps only its own.
        model_content = json.dumps(
            {
                "overview": "ok",
                "confidence": "高",
                "assetResults": [
                    {"assetId": str(i), "dataCategory": f"C{i}", "dataLevel": "一般数据2级", "classificationBasis": "r", "accuracy": "高"}
                    for i in range(1, 6)
                ],
            },
            ensure_ascii=False,
        )
        with mock.patch("server.call_direct_llm", return_value=("m", model_content)):
            result = server.classify_data_assets_direct(
                {"sourceText": src, "customerIndustry": "卫生健康"},
                {"llm": {"baseUrl": "http://x", "apiKey": "k", "model": "m"}, "classification": {"batchSize": 2}},
            )
        ids = [a["assetId"] for a in result["assetResults"]]
        self.assertEqual(ids, ["1", "2", "3", "4", "5"])
        self.assertEqual(result["summary"]["totalAssets"], 5)
        self.assertTrue(result["usedModel"])

    def test_classify_direct_runs_model_batches_concurrently(self):
        src = "序号\t列名\n" + "\n".join(f"{i}\tCOL_{i}" for i in range(1, 7))
        model_content = json.dumps(
            {
                "overview": "ok",
                "confidence": "高",
                "assetResults": [
                    {"assetId": str(i), "dataCategory": f"C{i}", "dataLevel": "一般数据3级", "classificationBasis": "r", "accuracy": "高"}
                    for i in range(1, 7)
                ],
            },
            ensure_ascii=False,
        )
        lock = threading.Lock()
        inflight = 0
        max_inflight = 0
        calls = 0

        def slow_call(_config, _messages):
            nonlocal inflight, max_inflight, calls
            with lock:
                inflight += 1
                calls += 1
                max_inflight = max(max_inflight, inflight)
            time.sleep(0.05)
            with lock:
                inflight -= 1
            return "m", model_content

        with mock.patch("server.call_direct_llm", side_effect=slow_call):
            result = server.classify_data_assets_direct(
                {"sourceText": src, "customerIndustry": "卫生健康"},
                {
                    "llm": {"baseUrl": "http://x", "apiKey": "k", "model": "m"},
                    "classification": {"batchSize": 1, "maxConcurrentBatches": 3},
                },
            )
        self.assertEqual(calls, 6)
        self.assertGreaterEqual(max_inflight, 2)
        self.assertLessEqual(max_inflight, 3)
        self.assertEqual([a["assetId"] for a in result["assetResults"]], ["1", "2", "3", "4", "5", "6"])
        self.assertEqual(result["summary"]["totalAssets"], 6)
        self.assertTrue(result["usedModel"])

    def test_classify_direct_large_multibatch_merge_is_not_the_bottleneck(self):
        src = "序号\t列名\n" + "\n".join(f"{i}\tCOL_{i}" for i in range(1, 451))
        model_content = json.dumps(
            {
                "overview": "ok",
                "confidence": "高",
                "assetResults": [
                    {"assetId": str(i), "dataCategory": f"C{i}", "dataLevel": "一般数据3级", "classificationBasis": "r", "accuracy": "高"}
                    for i in range(1, 451)
                ],
            },
            ensure_ascii=False,
        )

        started = time.monotonic()
        with mock.patch("server.call_direct_llm", return_value=("m", model_content)) as mocked_call:
            result = server.classify_data_assets_direct(
                {"sourceText": src, "customerIndustry": "卫生健康"},
                {
                    "llm": {"baseUrl": "http://x", "apiKey": "k", "model": "m"},
                    "classification": {"batchSize": 20, "maxConcurrentBatches": 4},
                },
            )

        self.assertEqual(mocked_call.call_count, 23)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(result["summary"]["totalAssets"], 450)
        self.assertEqual(result["assetResults"][0]["assetId"], "1")
        self.assertEqual(result["assetResults"][-1]["assetId"], "450")
        self.assertTrue(result["usedModel"])

    def test_classify_direct_model_error_falls_back_per_batch(self):
        src = "序号\t列名\n1\tA\n2\tB\n"
        with mock.patch("server.call_direct_llm", side_effect=RuntimeError("boom")):
            result = server.classify_data_assets_direct(
                {"sourceText": src, "customerIndustry": "卫生健康"},
                {"llm": {"baseUrl": "http://x", "apiKey": "k", "model": "m"}, "classification": {"batchSize": 5}},
            )
        self.assertFalse(result["usedModel"])
        self.assertEqual(result["summary"]["totalAssets"], 2)
        self.assertTrue(any("模型调用失败" in n for n in result["riskNotes"]))


if __name__ == "__main__":
    unittest.main()
