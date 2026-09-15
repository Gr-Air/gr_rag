"""query_rewriter 测试（译自 test/queryRewriter.test.ts + 补 LLM 路径用例）。"""

from __future__ import annotations

import json

from server.rag.chat.query_rewriter import (
    SmartRewriter,
    SmartRewriteOptions,
    fallback_route,
)
from server.rag.chat.types import LlmMessage


# ------------------------------------------------------------
# fallback_route（逐字翻译自 queryRewriter.test.ts）
# ------------------------------------------------------------


class TestFallbackRoute:
    def test_empty_entities(self):
        result = fallback_route("微服务架构的核心设计原则是什么", [])
        assert result.matched_entries == []
        assert "未匹配" in result.reason

    def test_complex_query_no_entity(self):
        result = fallback_route("如何配置 Nginx 反向代理", [])
        assert result.matched_entries == []

    def test_single_entity(self):
        result = fallback_route("国家电网", ["国家电网"])
        assert result.matched_entries == ["国家电网"]
        assert "国家电网" in result.reason

    def test_multiple_entities(self):
        result = fallback_route("对比 MySQL 和 Redis", ["MySQL", "Redis"])
        assert result.matched_entries == ["MySQL", "Redis"]
        assert "MySQL" in result.reason
        assert "Redis" in result.reason

    def test_empty_query(self):
        assert fallback_route("", []).matched_entries == []

    def test_numeric_query(self):
        assert fallback_route("12345", []).matched_entries == []

    def test_special_chars_query(self):
        assert fallback_route("@#$%", []).matched_entries == []

    def test_returns_copy_of_entries(self):
        entries = ["测试"]
        result = fallback_route("测试查询", entries)
        assert result.matched_entries == ["测试"]
        result.matched_entries.append("其他")
        assert entries == ["测试"]

    def test_result_fields(self):
        result = fallback_route("测试查询", ["测试"])
        assert isinstance(result.matched_entries, list)
        assert isinstance(result.reason, str)


# ------------------------------------------------------------
# SmartRewriter LLM 路径
# ------------------------------------------------------------


class FakeEntityRepo:
    def __init__(self, entities=None):
        self._entities = entities or [
            {"name": "华润置地", "type": "entity", "category": "客户企业"},
            {"name": "国家电网", "type": "entity", "category": "客户企业"},
            {"name": "Redis", "type": "entity", "category": "技术组件"},
            {"name": "微服务", "type": "concept", "category": "技术组件"},
        ]

    def get_known_entities(self):
        return list(self._entities)


class FakeLlm:
    def __init__(self, content=None, available=True, raise_exc=None):
        self.available = available
        self._content = content
        self._raise_exc = raise_exc
        self.calls: list[dict] = []

    def complete(self, messages, temperature=None, max_tokens=None):
        self.calls.append(
            {
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
        )
        if self._raise_exc:
            raise self._raise_exc
        return self._content

    def stream(self, messages, **kwargs):
        yield ""


def _json_response(payload: dict) -> str:
    return "好的，结果如下：\n```json\n" + json.dumps(payload, ensure_ascii=False) + "\n```"


class TestSmartRewriterLlm:
    def test_llm_success_known_and_unknown_entities(self):
        payload = {
            "rewritten": "华润置地的项目验收流程",
            "entities": ["华润置地", "某某未知公司"],
            "intent": "fact",
            "isFollowUp": False,
            "relevantDocTypes": ["客户项目验收"],
            "reason": "测试",
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())

        result = rewriter.rewrite("华润置地验收", SmartRewriteOptions())

        assert result.method == "llm"
        assert result.rewritten_query == "华润置地的项目验收流程"
        assert result.intent == "fact"
        assert "华润置地" in result.entities
        assert "某某未知公司" in result.entities
        assert result.route_decision is not None
        assert result.route_decision.is_follow_up is False
        assert result.route_decision.relevant_doc_types == ["客户项目验收"]
        assert result.relevant_doc_types == ["客户项目验收"]

    def test_decompose_unknown_entity(self):
        payload = {
            "rewritten": "q",
            "entities": ["华润置地华东大区项目"],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())

        result = rewriter.rewrite("x")

        # 未知实体保留，且分解出子串已知实体
        assert "华润置地华东大区项目" in result.entities
        assert "华润置地" in result.entities
        # 去重且保序
        assert len(result.entities) == len(set(result.entities))

    def test_doctype_whitelist_filter(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": ["客户项目验收", "非法类型", "技术方案", 123],
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())

        result = rewriter.rewrite("x")

        assert result.relevant_doc_types == ["客户项目验收", "技术方案"]

    def test_doctype_non_list(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": "技术方案",
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())
        assert rewriter.rewrite("x").relevant_doc_types == []

    def test_invalid_intent_becomes_other(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "not_a_valid_intent",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())
        assert rewriter.rewrite("x").intent == "other"

    def test_missing_rewritten_falls_back_to_original_query(self):
        payload = {
            "entities": [],
            "intent": "fact",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())
        result = rewriter.rewrite("原始查询")
        assert result.rewritten_query == "原始查询"

    def test_followup_true(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": True,
            "relevantDocTypes": [],
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())
        result = rewriter.rewrite("详细说说")
        assert result.route_decision is not None
        assert result.route_decision.is_follow_up is True

    def test_non_string_entities_skipped(self):
        payload = {
            "rewritten": "q",
            "entities": ["Redis", 123, None, {"a": 1}],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        rewriter = SmartRewriter(FakeLlm(_json_response(payload)), FakeEntityRepo())
        assert rewriter.rewrite("x").entities == ["Redis"]

    def test_previous_query_in_user_prompt(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": True,
            "relevantDocTypes": [],
        }
        llm = FakeLlm(_json_response(payload))
        rewriter = SmartRewriter(llm, FakeEntityRepo())
        rewriter.rewrite("详细说说", SmartRewriteOptions(previous_query="国家电网简介"))
        user_content = llm.calls[0]["messages"][1].content
        assert "国家电网简介" in user_content

    def test_llm_called_with_zero_temperature(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        llm = FakeLlm(_json_response(payload))
        SmartRewriter(llm, FakeEntityRepo()).rewrite("x")
        assert llm.calls[0]["temperature"] == 0
        assert llm.calls[0]["max_tokens"] == 300
        assert isinstance(llm.calls[0]["messages"][0], LlmMessage)
        assert llm.calls[0]["messages"][0].role == "system"


class TestSmartRewriterFallback:
    def test_no_llm_available_uses_dict_match(self):
        rewriter = SmartRewriter(FakeLlm(available=False), FakeEntityRepo())
        result = rewriter.rewrite("国家电网是什么")

        assert result.method == "fallback"
        assert result.entities == ["国家电网"]
        assert result.rewritten_query == "国家电网是什么"
        assert result.intent == "other"
        assert result.route_decision is None
        assert result.relevant_doc_types == []

    def test_no_llm_no_match(self):
        rewriter = SmartRewriter(FakeLlm(available=False), FakeEntityRepo())
        result = rewriter.rewrite("完全不相关的问题xyz")
        assert result.method == "fallback"
        assert result.entities == []

    def test_fallback_only_uses_entity_type(self):
        # concept 类型词条不进降级字典
        rewriter = SmartRewriter(FakeLlm(available=False), FakeEntityRepo())
        result = rewriter.rewrite("微服务架构")
        assert "微服务" not in result.entities

    def test_llm_empty_content_falls_back(self):
        rewriter = SmartRewriter(FakeLlm(content=""), FakeEntityRepo())
        result = rewriter.rewrite("国家电网")
        assert result.method == "fallback"
        assert result.entities == ["国家电网"]

    def test_llm_invalid_json_falls_back(self):
        rewriter = SmartRewriter(FakeLlm(content="抱歉，我不知道如何输出 JSON"), FakeEntityRepo())
        result = rewriter.rewrite("国家电网")
        assert result.method == "fallback"
        assert result.entities == ["国家电网"]

    def test_llm_raises_falls_back(self):
        rewriter = SmartRewriter(
            FakeLlm(raise_exc=RuntimeError("network down")),
            FakeEntityRepo(),
        )
        result = rewriter.rewrite("国家电网")
        assert result.method == "fallback"
        assert result.entities == ["国家电网"]

    def test_option_llm_overrides_default(self):
        payload = {
            "rewritten": "由请求级 LLM 改写",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        default_llm = FakeLlm(available=False)
        request_llm = FakeLlm(_json_response(payload))
        rewriter = SmartRewriter(default_llm, FakeEntityRepo())

        result = rewriter.rewrite("x", SmartRewriteOptions(llm=request_llm))

        assert result.method == "llm"
        assert result.rewritten_query == "由请求级 LLM 改写"
        assert default_llm.calls == []
