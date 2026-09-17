"""query_rewriter 测试（译自 test/queryRewriter.test.ts + 补 LLM 路径用例）。

新形态：SmartRewriter 经 Agently 边界打桩 —— FakeAgent 记录链式调用，
FakeLlm 仅持有 available 标志与 _config，不再提供 complete()/stream()。
"""

from __future__ import annotations

from typing import Any

from server.rag.chat.query_rewriter import (
    SmartRewriter,
    SmartRewriteOptions,
    fallback_route,
)


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
# Agently 边界替身
# ------------------------------------------------------------


class FakeExecution:
    """Agently AgentExecution 的最小替身：仅暴露 .get_data()。"""

    def __init__(self, value: Any) -> None:
        self._value = value
        self.last_data_kwargs: dict[str, Any] = {}

    def get_data(self, **kwargs: Any) -> Any:
        self.last_data_kwargs = kwargs
        return self._value

    def get_text(self) -> str:  # pragma: no cover - 兼容接口
        return "" if self._value is None else str(self._value)


class FakeAgent:
    """Agently Agent 的链式替身：记录每个方法调用并返回预设的 dict。"""

    def __init__(self, value: Any) -> None:
        self._value = value
        self.calls: list[tuple[str, Any]] = []

    # 链式方法
    def set_settings(self, settings):
        self.calls.append(("set_settings", settings))
        return self

    def options(self, opts):
        self.calls.append(("options", opts))
        return self

    def system(self, content):
        self.calls.append(("system", content))
        return self

    def input(self, content):
        self.calls.append(("input", content))
        return self

    def output(self, schema):
        self.calls.append(("output", schema))
        return self

    def set_chat_history(self, history):
        self.calls.append(("set_chat_history", history))
        return self

    # 执行
    def get_result(self):
        self.calls.append(("get_result", None))
        self._execution = FakeExecution(self._value)
        return self._execution

    @property
    def last_execution(self) -> "FakeExecution | None":
        return getattr(self, "_execution", None)

    # 便捷查询
    def call(self, name: str) -> tuple[str, Any]:
        for n, arg in self.calls:
            if n == name:
                return n, arg
        raise AssertionError(f"FakeAgent 未调用 {name}, 实际调用: {[n for n, _ in self.calls]}")


def _make_agent(value: Any):
    """工厂函数：每次调用创建新 FakeAgent（保留首次 calls，便于多调用方测试）。"""
    return FakeAgent(value)


# ------------------------------------------------------------
# FakeLlm：仅作"是否可用 + 配置来源"的占位
# ------------------------------------------------------------


class FakeLlmConfig:
    def __init__(self, api_key: str = "test-key", model: str = "test-model", base_url: str | None = None):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url


class FakeLlm:
    """新版仅供 available 判断 + _config 抽取，complete/stream 不再被调用。"""

    def __init__(self, available: bool = True, config: FakeLlmConfig | None = None) -> None:
        self.available = available
        self._config = config or FakeLlmConfig()


def _fake_settings_factory(llm):
    """从 FakeLlm 抽取 settings（生产路径由 _default_settings_factory 提供）。"""
    from agently.types.settings import OpenAICompatibleSettings
    cfg = llm._config
    return OpenAICompatibleSettings(
        base_url=(cfg.base_url or "").rstrip("/") or None,
        api_key=cfg.api_key,
        model=cfg.model,
    )


def _build(value, available: bool = True):
    """构造 SmartRewriter：注入 FakeAgent 工厂 + settings 抽取工厂。"""
    return SmartRewriter(
        FakeLlm(available=available),
        FakeEntityRepo(),
        agent_factory=lambda: _make_agent(value),
        settings_factory=_fake_settings_factory,
    )


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
        rewriter = _build(payload)

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
        rewriter = _build(payload)

        result = rewriter.rewrite("x", SmartRewriteOptions())

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
        rewriter = _build(payload)

        result = rewriter.rewrite("x", SmartRewriteOptions())

        assert result.relevant_doc_types == ["客户项目验收", "技术方案"]

    def test_doctype_non_list(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": "技术方案",
        }
        rewriter = _build(payload)
        assert rewriter.rewrite("x", SmartRewriteOptions()).relevant_doc_types == []

    def test_invalid_intent_becomes_other(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "not_a_valid_intent",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        rewriter = _build(payload)
        assert rewriter.rewrite("x", SmartRewriteOptions()).intent == "other"

    def test_missing_rewritten_falls_back_to_original_query(self):
        payload = {
            "entities": [],
            "intent": "fact",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        rewriter = _build(payload)
        result = rewriter.rewrite("原始查询", SmartRewriteOptions())
        assert result.rewritten_query == "原始查询"

    def test_followup_true(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": True,
            "relevantDocTypes": [],
        }
        rewriter = _build(payload)
        result = rewriter.rewrite("详细说说", SmartRewriteOptions())
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
        rewriter = _build(payload)
        assert rewriter.rewrite("x", SmartRewriteOptions()).entities == ["Redis"]

    def test_previous_query_in_user_prompt(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": True,
            "relevantDocTypes": [],
        }
        # 抓取首次调用的 FakeAgent
        captured: dict[str, FakeAgent] = {}

        def factory():
            agent = FakeAgent(payload)
            captured["agent"] = agent
            return agent

        rewriter = SmartRewriter(
            FakeLlm(),
            FakeEntityRepo(),
            agent_factory=factory,
            settings_factory=_fake_settings_factory,
        )
        rewriter.rewrite("详细说说", SmartRewriteOptions(previous_query="国家电网简介"))
        _, input_content = captured["agent"].call("input")
        assert "国家电网简介" in input_content

    def test_llm_called_with_zero_temperature(self):
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        captured: dict[str, FakeAgent] = {}

        def factory():
            agent = FakeAgent(payload)
            captured["agent"] = agent
            return agent

        rewriter = SmartRewriter(
            FakeLlm(),
            FakeEntityRepo(),
            agent_factory=factory,
            settings_factory=_fake_settings_factory,
        )
        rewriter.rewrite("x", SmartRewriteOptions())
        _, opts = captured["agent"].call("options")
        assert opts == {"temperature": 0, "max_tokens": 300}

    def test_schema_passed_to_agently_output(self):
        """验证 _REWRITE_SCHEMA 6 个字段都被 .output() 注入，且 get_data 触发 ensure_keys 重试。"""
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        captured: dict[str, FakeAgent] = {}

        def factory():
            agent = FakeAgent(payload)
            captured["agent"] = agent
            return agent

        rewriter = SmartRewriter(
            FakeLlm(),
            FakeEntityRepo(),
            agent_factory=factory,
            settings_factory=_fake_settings_factory,
        )
        rewriter.rewrite("x", SmartRewriteOptions())
        _, schema = captured["agent"].call("output")
        assert set(schema.keys()) == {
            "rewritten", "entities", "intent", "relevantDocTypes", "isFollowUp", "reason",
        }
        assert schema["isFollowUp"][0] is bool
        assert schema["rewritten"][0] is str
        # get_data 必须带 ensure_keys，触发 Agently schema 不匹配时的自动重试
        exec_ = captured["agent"].last_execution
        assert exec_ is not None
        assert "ensure_keys" in exec_.last_data_kwargs
        assert set(exec_.last_data_kwargs["ensure_keys"]) == set(schema.keys())

    def test_chain_order(self):
        """验证链式调用顺序：set_settings → options → system → input → output → get_result。"""
        payload = {
            "rewritten": "q",
            "entities": [],
            "intent": "other",
            "isFollowUp": False,
            "relevantDocTypes": [],
        }
        captured: dict[str, FakeAgent] = {}

        def factory():
            agent = FakeAgent(payload)
            captured["agent"] = agent
            return agent

        rewriter = SmartRewriter(
            FakeLlm(),
            FakeEntityRepo(),
            agent_factory=factory,
            settings_factory=_fake_settings_factory,
        )
        rewriter.rewrite("x", SmartRewriteOptions())
        names = [n for n, _ in captured["agent"].calls]
        assert names == ["set_settings", "options", "system", "input", "output", "get_result"]

    def test_non_dict_response_falls_back(self):
        """Agently 偶发返回非 dict（schema 不严格遵守）→ 降级。"""
        rewriter = _build("not a dict")
        result = rewriter.rewrite("x", SmartRewriteOptions())
        assert result.method == "fallback"


class TestSmartRewriterFallback:
    def test_no_llm_available_uses_dict_match(self):
        rewriter = SmartRewriter(
            FakeLlm(available=False),
            FakeEntityRepo(),
            agent_factory=_make_agent,
            settings_factory=_fake_settings_factory,
        )
        result = rewriter.rewrite("国家电网是什么", SmartRewriteOptions())

        assert result.method == "fallback"
        assert result.entities == ["国家电网"]
        assert result.rewritten_query == "国家电网是什么"
        assert result.intent == "other"
        assert result.route_decision is None
        assert result.relevant_doc_types == []

    def test_no_llm_no_match(self):
        rewriter = SmartRewriter(
            FakeLlm(available=False),
            FakeEntityRepo(),
            agent_factory=_make_agent,
            settings_factory=_fake_settings_factory,
        )
        result = rewriter.rewrite("完全不相关的问题xyz", SmartRewriteOptions())
        assert result.method == "fallback"
        assert result.entities == []

    def test_fallback_only_uses_entity_type(self):
        # concept 类型词条不进降级字典
        rewriter = SmartRewriter(
            FakeLlm(available=False),
            FakeEntityRepo(),
            agent_factory=_make_agent,
            settings_factory=_fake_settings_factory,
        )
        result = rewriter.rewrite("微服务架构", SmartRewriteOptions())
        assert "微服务" not in result.entities

    def test_llm_empty_content_falls_back(self):
        rewriter = _build("")
        result = rewriter.rewrite("国家电网", SmartRewriteOptions())
        assert result.method == "fallback"
        assert result.entities == ["国家电网"]

    def test_llm_invalid_payload_falls_back(self):
        """Agently schema 校验失败 / 返回非 dict → 降级。"""
        rewriter = _build("抱歉我不知道如何输出结构化结果")
        result = rewriter.rewrite("国家电网", SmartRewriteOptions())
        assert result.method == "fallback"
        assert result.entities == ["国家电网"]

    def test_llm_raises_falls_back(self):
        def boom_factory():
            raise RuntimeError("network down")

        rewriter = SmartRewriter(
            FakeLlm(),
            FakeEntityRepo(),
            agent_factory=boom_factory,
            settings_factory=_fake_settings_factory,
        )
        result = rewriter.rewrite("国家电网", SmartRewriteOptions())
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
        # 默认 LLM 不可用；请求级 LLM 可用且配置不同
        default_llm = FakeLlm(available=False, config=FakeLlmConfig(api_key="default-key"))
        request_llm = FakeLlm(
            available=True,
            config=FakeLlmConfig(api_key="request-key", model="request-model"),
        )

        rewriter = SmartRewriter(
            default_llm,
            FakeEntityRepo(),
            agent_factory=lambda: _make_agent(payload),
            settings_factory=_fake_settings_factory,
        )

        result = rewriter.rewrite("x", SmartRewriteOptions(llm=request_llm))

        assert result.method == "llm"
        assert result.rewritten_query == "由请求级 LLM 改写"

    def test_settings_factory_returns_none_falls_back(self):
        """settings 抽取失败（llm 没 _config）→ 降级。"""
        class NoConfigLlm:
            available = True
            # 故意没有 _config

        rewriter = SmartRewriter(
            NoConfigLlm(),
            FakeEntityRepo(),
            agent_factory=_make_agent,
            settings_factory=lambda llm: None,
        )
        result = rewriter.rewrite("国家电网", SmartRewriteOptions())
        assert result.method == "fallback"
        assert result.entities == ["国家电网"]