"""OpenAI 兼容 LLM 客户端（移植自 src/infrastructure/llm/openaiClient.ts）。

- complete：一次性补全（query 改写 / 会话压缩）
- stream：流式补全（RAG 回答），逐段产出 content
推理模型（deepseek-r1 / 名称含 reasoning）不兼容 temperature/max_tokens，统一省略。
配置在构造时绑定；无 api_key 时由工厂返回 NoopLlmClient。
"""

from __future__ import annotations

import json
from collections.abc import Generator

import httpx

from .types import LlmClientConfig, LlmMessage

_TIMEOUT = httpx.Timeout(300.0, connect=15.0)


def is_reasoning_model(model: str) -> bool:
    m = model.lower()
    return "reasoning" in m or "deepseek-r1" in m


def _messages_to_dicts(messages: list[LlmMessage | dict]) -> list[dict]:
    return [
        {"role": m.role, "content": m.content} if isinstance(m, LlmMessage) else dict(m)
        for m in messages
    ]


class NoopLlmClient:
    """无 API Key 降级：complete 返回 None，stream 不产出。"""

    available = False

    def complete(self, messages, temperature=None, max_tokens=None) -> None:
        return None

    def stream(self, messages, temperature=None) -> Generator[str, None, None]:
        # 空生成器，调用方据此降级
        yield from ()


class OpenAiLlmClient:
    def __init__(self, config: LlmClientConfig) -> None:
        self._config = config
        self.available = bool(config.api_key)

    @property
    def _url(self) -> str:
        return self._config.base_url.rstrip("/") + "/chat/completions"

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._config.api_key}",
            "Content-Type": "application/json",
        }

    def complete(self, messages, temperature=None, max_tokens=None) -> str | None:
        if not self.available:
            return None

        body: dict = {
            "model": self._config.model,
            "messages": _messages_to_dicts(messages),
        }
        if not is_reasoning_model(self._config.model):
            if temperature is not None:
                body["temperature"] = temperature
            if max_tokens is not None:
                body["max_tokens"] = max_tokens

        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(self._url, headers=self._headers(), json=body)
            resp.raise_for_status()
            data = resp.json()

        choices = data.get("choices") or []
        if not choices:
            return None
        content = (choices[0].get("message") or {}).get("content")
        return content if content else None

    def stream(self, messages, temperature=None) -> Generator[str, None, None]:
        if not self.available:
            return

        body: dict = {
            "model": self._config.model,
            "messages": _messages_to_dicts(messages),
            "stream": True,
        }
        if not is_reasoning_model(self._config.model):
            body["temperature"] = 0.3 if temperature is None else temperature

        with httpx.Client(timeout=_TIMEOUT) as client:
            with client.stream("POST", self._url, headers=self._headers(), json=body) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    content = delta.get("content")
                    if content:
                        yield content


def create_llm_client(config: LlmClientConfig):
    """无 apiKey 时返回 NoopLlmClient。"""
    if not config.api_key:
        return NoopLlmClient()
    return OpenAiLlmClient(config)
