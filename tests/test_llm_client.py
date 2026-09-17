"""llm_client 测试（Agently 版）。

- Noop 降级 / 工厂选择
- complete / stream 的消息映射（system→.system()，中间轮→chat_history，末条→.input()）
- options 传递（temperature 由 config.supports_temperature 显式控制）与响应解析
- delta 流消费与空段过滤

通过注入 FakeAgent 工厂在 Agently 边界打桩，不发真实请求。
"""

from __future__ import annotations

import pytest

from server.rag.chat.llm_client import (
    NoopLlmClient,
    OpenAiLlmClient,
    create_llm_client,
)
from server.rag.chat.types import LlmClientConfig, LlmMessage


# ------------------------------------------------------------
# Fake Agently 边界
# ------------------------------------------------------------


class FakeResult:
    def __init__(self, text: str = "", deltas: list[str] | None = None):
        self._text = text
        self._deltas = deltas or []

    def get_text(self) -> str:
        return self._text

    def get_generator(self, type=None, content=None):
        assert type == "delta"
        return iter(self._deltas)


class FakeAgent:
    """记录链式调用并按预设返回结果。"""

    def __init__(self, result: FakeResult):
        self.result = result
        self.calls: list[tuple] = []

    def set_settings(self, settings):
        self.calls.append(("set_settings", settings))
        return self

    def set_chat_history(self, history):
        self.calls.append(("chat_history", [dict(m) for m in history]))
        return self

    def options(self, opts):
        self.calls.append(("options", dict(opts)))
        return self

    def system(self, prompt):
        self.calls.append(("system", prompt))
        return self

    def input(self, content):
        self.calls.append(("input", content))
        return self

    def get_result(self):
        self.calls.append(("get_result",))
        return self.result


class FakeHarness:
    """收集每次调用创建的 agent。"""

    def __init__(self, result: FakeResult | None = None, error: Exception | None = None):
        self.agents: list[FakeAgent] = []
        self.result = result or FakeResult(text="收到")
        self.error = error

    def factory(self):
        def _create():
            if self.error:
                raise self.error
            agent = FakeAgent(self.result)
            self.agents.append(agent)
            return agent

        return _create


def _client(
    model="qwen3.7-max",
    base_url="https://api.example.com/v1/",
    harness=None,
    supports_temperature=True,
):
    config = LlmClientConfig(
        api_key="test-key",
        model=model,
        base_url=base_url,
        supports_temperature=supports_temperature,
    )
    factory = harness.factory() if harness else None
    return OpenAiLlmClient(config, agent_factory=factory)


def _call(agent, name):
    return next(call for call in agent.calls if call[0] == name)


def _has(agent, name):
    return any(call[0] == name for call in agent.calls)


def _opts_of(agent):
    return _call(agent, "options")[1]


# ------------------------------------------------------------
# Noop / 工厂
# ------------------------------------------------------------


class TestNoopAndFactory:
    def test_noop(self):
        client = NoopLlmClient()
        assert client.available is False
        assert client.complete([LlmMessage(role="user", content="hi")]) is None
        assert list(client.stream([LlmMessage(role="user", content="hi")])) == []

    def test_factory_no_key_returns_noop(self):
        client = create_llm_client(
            LlmClientConfig(api_key="", model="qwen3.7-max", base_url="http://x")
        )
        assert isinstance(client, NoopLlmClient)

    def test_factory_with_key_returns_openai(self):
        client = create_llm_client(
            LlmClientConfig(api_key="k", model="qwen3.7-max", base_url="http://x")
        )
        assert isinstance(client, OpenAiLlmClient)


# ------------------------------------------------------------
# complete
# ------------------------------------------------------------


class TestComplete:
    def test_parses_content(self):
        harness = FakeHarness(FakeResult(text="你好"))
        client = _client(harness=harness)
        assert client.complete([LlmMessage(role="user", content="hi")]) == "你好"

        agent = harness.agents[0]
        settings = _call(agent, "set_settings")[1]
        assert settings.model == "qwen3.7-max"
        assert settings.base_url == "https://api.example.com/v1"
        assert settings.api_key == "test-key"
        assert _call(agent, "input")[1] == "hi"

    def test_system_mapped_to_system_slot(self):
        harness = FakeHarness()
        _client(harness=harness).complete(
            [{"role": "system", "content": "s"}, LlmMessage(role="user", content="u")]
        )
        agent = harness.agents[0]
        assert _call(agent, "system")[1] == "s"
        assert _call(agent, "input")[1] == "u"

    def test_intermediate_messages_go_to_chat_history(self):
        harness = FakeHarness()
        _client(harness=harness).complete(
            [
                {"role": "system", "content": "s"},
                {"role": "user", "content": "q1"},
                {"role": "assistant", "content": "a1"},
                {"role": "user", "content": "q2"},
            ]
        )
        agent = harness.agents[0]
        assert _call(agent, "chat_history")[1] == [
            {"role": "user", "content": "q1"},
            {"role": "assistant", "content": "a1"},
        ]
        assert _call(agent, "input")[1] == "q2"

    def test_temperature_and_max_tokens_for_regular_model(self):
        harness = FakeHarness()
        _client(harness=harness).complete(
            [LlmMessage(role="user", content="hi")],
            temperature=0,
            max_tokens=300,
        )
        assert _opts_of(harness.agents[0]) == {"temperature": 0, "max_tokens": 300}

    def test_reasoning_model_still_receives_options(self):
        """不做模型名猜测：名字不参与判断，参数按显式配置下发。"""
        harness = FakeHarness()
        _client(model="deepseek-r1-distill-qwen", harness=harness).complete(
            [LlmMessage(role="user", content="hi")],
            temperature=0,
            max_tokens=300,
        )
        assert _opts_of(harness.agents[0]) == {"temperature": 0, "max_tokens": 300}

    def test_supports_temperature_false_omits_temperature_keeps_max_tokens(self):
        """supports_temperature=False：只摘 temperature，max_tokens 照常透传。"""
        harness = FakeHarness()
        _client(harness=harness, supports_temperature=False).complete(
            [LlmMessage(role="user", content="hi")],
            temperature=0,
            max_tokens=300,
        )
        assert _opts_of(harness.agents[0]) == {"max_tokens": 300}

    def test_supports_temperature_false_and_no_max_tokens_skips_options(self):
        harness = FakeHarness()
        _client(harness=harness, supports_temperature=False).complete(
            [LlmMessage(role="user", content="hi")], temperature=0.5
        )
        assert not _has(harness.agents[0], "options")

    def test_none_temperature_omitted_regular_model(self):
        harness = FakeHarness()
        _client(harness=harness).complete([LlmMessage(role="user", content="hi")])
        assert not _has(harness.agents[0], "options")

    def test_empty_text_returns_none(self):
        harness = FakeHarness(FakeResult(text=""))
        assert _client(harness=harness).complete(
            [LlmMessage(role="user", content="hi")]
        ) is None

    def test_not_available_short_circuits(self):
        harness = FakeHarness()
        client = OpenAiLlmClient(
            LlmClientConfig(api_key="", model="qwen3.7-max", base_url="http://x"),
            agent_factory=harness.factory(),
        )
        assert client.available is False
        assert client.complete([LlmMessage(role="user", content="hi")]) is None
        assert harness.agents == []

    def test_error_propagates(self):
        harness = FakeHarness(error=RuntimeError("boom"))
        with pytest.raises(RuntimeError, match="boom"):
            _client(harness=harness).complete([LlmMessage(role="user", content="hi")])


# ------------------------------------------------------------
# stream
# ------------------------------------------------------------


class TestStream:
    def test_yields_deltas(self):
        harness = FakeHarness(FakeResult(deltas=["你", "好"]))
        tokens = list(
            _client(harness=harness).stream([LlmMessage(role="user", content="hi")])
        )
        assert tokens == ["你", "好"]

    def test_default_temperature_0_3(self):
        harness = FakeHarness(FakeResult(deltas=["x"]))
        list(_client(harness=harness).stream([LlmMessage(role="user", content="hi")]))
        assert _opts_of(harness.agents[0]) == {"temperature": 0.3}

    def test_custom_temperature(self):
        harness = FakeHarness(FakeResult(deltas=["x"]))
        list(
            _client(harness=harness).stream(
                [LlmMessage(role="user", content="hi")], temperature=0.7
            )
        )
        assert _opts_of(harness.agents[0]) == {"temperature": 0.7}

    def test_reasoning_model_still_gets_default_temperature(self):
        """不做模型名猜测：流式默认 0.3 由显式配置控制。"""
        harness = FakeHarness(FakeResult(deltas=["x"]))
        list(
            _client(model="deepseek-r1", harness=harness).stream(
                [LlmMessage(role="user", content="hi")]
            )
        )
        assert _opts_of(harness.agents[0]) == {"temperature": 0.3}

    def test_supports_temperature_false_skips_default_temperature(self):
        """supports_temperature=False：不再注入 0.3，连 options 都不调用。"""
        harness = FakeHarness(FakeResult(deltas=["x"]))
        tokens = list(
            _client(harness=harness, supports_temperature=False).stream(
                [LlmMessage(role="user", content="hi")]
            )
        )
        assert tokens == ["x"]
        assert not _has(harness.agents[0], "options")

    def test_empty_deltas_filtered(self):
        harness = FakeHarness(FakeResult(deltas=["", "保留"]))
        tokens = list(
            _client(harness=harness).stream([LlmMessage(role="user", content="hi")])
        )
        assert tokens == ["保留"]

    def test_not_available_yields_nothing(self):
        harness = FakeHarness()
        client = OpenAiLlmClient(
            LlmClientConfig(api_key="", model="qwen3.7-max", base_url="http://x"),
            agent_factory=harness.factory(),
        )
        assert list(client.stream([LlmMessage(role="user", content="hi")])) == []
        assert harness.agents == []

    def test_error_propagates(self):
        harness = FakeHarness(error=RuntimeError("boom"))
        with pytest.raises(RuntimeError, match="boom"):
            list(_client(harness=harness).stream([LlmMessage(role="user", content="hi")]))
