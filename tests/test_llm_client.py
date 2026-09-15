"""llm_client 测试（对应 TS openaiClient 行为）。

- Noop 降级 / 工厂选择
- complete 请求体（推理模型省略 temperature/max_tokens）与响应解析
- stream SSE 解析（[DONE] / 坏行 / 空 choices）
"""

from __future__ import annotations

import json

import httpx
import pytest

from server.rag.chat import llm_client as llm_mod
from server.rag.chat.llm_client import (
    NoopLlmClient,
    OpenAiLlmClient,
    create_llm_client,
    is_reasoning_model,
)
from server.rag.chat.types import LlmClientConfig, LlmMessage


# ------------------------------------------------------------
# 假 httpx
# ------------------------------------------------------------


class FakeResponse:
    def __init__(self, status_code=200, data=None):
        self.status_code = status_code
        self._data = data if data is not None else {}

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("POST", "http://test/v1/chat/completions")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)


class FakeStreamContext:
    def __init__(self, lines, status_code=200):
        self._lines = lines
        self._status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def raise_for_status(self):
        if self._status_code >= 400:
            request = httpx.Request("POST", "http://test/v1/chat/completions")
            response = httpx.Response(self._status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)

    def iter_lines(self):
        return iter(self._lines)


class FakeHttpxClient:
    posts: list[dict] = []
    streams: list[dict] = []
    complete_response: FakeResponse | None = None
    stream_lines: list[str] = []
    stream_status: int = 200

    def __init__(self, timeout=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, headers=None, json=None):
        FakeHttpxClient.posts.append(
            {"url": url, "headers": headers, "json": json}
        )
        return FakeHttpxClient.complete_response

    def stream(self, method, url, headers=None, json=None):
        FakeHttpxClient.streams.append(
            {"method": method, "url": url, "headers": headers, "json": json}
        )
        return FakeStreamContext(FakeHttpxClient.stream_lines, FakeHttpxClient.stream_status)


@pytest.fixture(autouse=True)
def _fake_httpx(monkeypatch):
    FakeHttpxClient.posts = []
    FakeHttpxClient.streams = []
    FakeHttpxClient.complete_response = FakeResponse()
    FakeHttpxClient.stream_lines = []
    FakeHttpxClient.stream_status = 200
    monkeypatch.setattr(llm_mod.httpx, "Client", FakeHttpxClient)
    yield FakeHttpxClient


def _config(model="qwen3.7-max", base_url="https://api.example.com/v1/"):
    return LlmClientConfig(api_key="test-key", model=model, base_url=base_url)


# ------------------------------------------------------------
# is_reasoning_model
# ------------------------------------------------------------


class TestIsReasoningModel:
    @pytest.mark.parametrize(
        "model",
        ["qwen3.7-max", "gpt-4o", "qwen-plus", "deepseek-v3"],
    )
    def test_regular_models(self, model):
        assert is_reasoning_model(model) is False

    @pytest.mark.parametrize(
        "model",
        ["deepseek-r1", "deepseek-r1-distill-qwen", "o3-reasoning", "REASONING-X"],
    )
    def test_reasoning_models(self, model):
        assert is_reasoning_model(model) is True


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
        client = create_llm_client(_config())
        assert isinstance(client, OpenAiLlmClient)


# ------------------------------------------------------------
# complete
# ------------------------------------------------------------


class TestComplete:
    def test_parses_content(self, _fake_httpx):
        _fake_httpx.complete_response = FakeResponse(
            data={"choices": [{"message": {"content": "你好"}}]}
        )
        client = OpenAiLlmClient(_config())
        assert client.complete(
            [LlmMessage(role="user", content="hi")]
        ) == "你好"

        post = _fake_httpx.posts[0]
        assert post["url"] == "https://api.example.com/v1/chat/completions"
        assert post["headers"]["Authorization"] == "Bearer test-key"
        body = post["json"]
        assert body["model"] == "qwen3.7-max"
        assert body["messages"] == [{"role": "user", "content": "hi"}]

    def test_base_url_trailing_slashes_stripped(self, _fake_httpx):
        client = OpenAiLlmClient(_config(base_url="https://api.example.com/v1///"))
        client.complete([LlmMessage(role="user", content="hi")])
        assert _fake_httpx.posts[0]["url"] == "https://api.example.com/v1/chat/completions"

    def test_temperature_and_max_tokens_for_regular_model(self, _fake_httpx):
        OpenAiLlmClient(_config()).complete(
            [LlmMessage(role="user", content="hi")],
            temperature=0,
            max_tokens=300,
        )
        body = _fake_httpx.posts[0]["json"]
        assert body["temperature"] == 0
        assert body["max_tokens"] == 300

    def test_reasoning_model_omits_temperature_and_max_tokens(self, _fake_httpx):
        OpenAiLlmClient(_config(model="deepseek-r1-distill-qwen")).complete(
            [LlmMessage(role="user", content="hi")],
            temperature=0,
            max_tokens=300,
        )
        body = _fake_httpx.posts[0]["json"]
        assert "temperature" not in body
        assert "max_tokens" not in body

    def test_none_temperature_omitted_regular_model(self, _fake_httpx):
        OpenAiLlmClient(_config()).complete(
            [LlmMessage(role="user", content="hi")]
        )
        body = _fake_httpx.posts[0]["json"]
        assert "temperature" not in body
        assert "max_tokens" not in body

    def test_dict_messages_passed_through(self, _fake_httpx):
        OpenAiLlmClient(_config()).complete(
            [{"role": "system", "content": "s"}, LlmMessage(role="user", content="u")]
        )
        body = _fake_httpx.posts[0]["json"]
        assert body["messages"] == [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "u"},
        ]

    def test_empty_choices_returns_none(self, _fake_httpx):
        _fake_httpx.complete_response = FakeResponse(data={"choices": []})
        assert OpenAiLlmClient(_config()).complete(
            [LlmMessage(role="user", content="hi")]
        ) is None

    def test_empty_content_returns_none(self, _fake_httpx):
        _fake_httpx.complete_response = FakeResponse(
            data={"choices": [{"message": {"content": ""}}]}
        )
        assert OpenAiLlmClient(_config()).complete(
            [LlmMessage(role="user", content="hi")]
        ) is None

    def test_not_available_short_circuits(self, _fake_httpx):
        client = OpenAiLlmClient(
            LlmClientConfig(api_key="", model="qwen3.7-max", base_url="http://x")
        )
        assert client.complete([LlmMessage(role="user", content="hi")]) is None
        assert _fake_httpx.posts == []

    def test_http_error_propagates(self, _fake_httpx):
        _fake_httpx.complete_response = FakeResponse(status_code=500)
        with pytest.raises(httpx.HTTPStatusError):
            OpenAiLlmClient(_config()).complete(
                [LlmMessage(role="user", content="hi")]
            )


# ------------------------------------------------------------
# stream
# ------------------------------------------------------------


def _sse(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False)


def _token_line(content: str) -> str:
    return _sse({"choices": [{"delta": {"content": content}}]})


class TestStream:
    def test_parses_sse_tokens(self, _fake_httpx):
        _fake_httpx.stream_lines = [
            "",
            ": comment line",
            _token_line("你"),
            _token_line("好"),
            "data: [DONE]",
            _token_line("不应出现"),
        ]
        client = OpenAiLlmClient(_config())
        tokens = list(client.stream([LlmMessage(role="user", content="hi")]))

        assert tokens == ["你", "好"]
        stream = _fake_httpx.streams[0]
        assert stream["method"] == "POST"
        assert stream["url"] == "https://api.example.com/v1/chat/completions"
        body = stream["json"]
        assert body["stream"] is True
        assert body["temperature"] == 0.3

    def test_custom_temperature(self, _fake_httpx):
        _fake_httpx.stream_lines = [_token_line("x"), "data: [DONE]"]
        list(
            OpenAiLlmClient(_config()).stream(
                [LlmMessage(role="user", content="hi")], temperature=0.7
            )
        )
        assert _fake_httpx.streams[0]["json"]["temperature"] == 0.7

    def test_reasoning_model_omits_temperature(self, _fake_httpx):
        _fake_httpx.stream_lines = [_token_line("x"), "data: [DONE]"]
        list(
            OpenAiLlmClient(_config(model="deepseek-r1")).stream(
                [LlmMessage(role="user", content="hi")]
            )
        )
        body = _fake_httpx.streams[0]["json"]
        assert "temperature" not in body

    def test_skips_bad_lines(self, _fake_httpx):
        _fake_httpx.stream_lines = [
            "data: not-json",
            _sse({"choices": []}),
            _sse({"choices": [{"delta": {}}]}),
            _sse({"choices": [{"delta": {"content": ""}}]}),
            _token_line("保留"),
            "data: [DONE]",
        ]
        tokens = list(
            OpenAiLlmClient(_config()).stream([LlmMessage(role="user", content="hi")])
        )
        assert tokens == ["保留"]

    def test_not_available_yields_nothing(self, _fake_httpx):
        client = OpenAiLlmClient(
            LlmClientConfig(api_key="", model="qwen3.7-max", base_url="http://x")
        )
        assert list(client.stream([LlmMessage(role="user", content="hi")])) == []
        assert _fake_httpx.streams == []

    def test_http_error_propagates(self, _fake_httpx):
        _fake_httpx.stream_status = 500
        with pytest.raises(httpx.HTTPStatusError):
            list(
                OpenAiLlmClient(_config()).stream(
                    [LlmMessage(role="user", content="hi")]
                )
            )
