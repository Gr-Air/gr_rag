"""Agently LLM 客户端（由 httpx 直连版改写）。

- complete：一次性补全（query 改写 / 会话压缩）→ ModelRequestResult.get_text()
- stream：流式补全（RAG 回答）→ get_generator(type="delta") 同步产出文本段
- 不做模型名猜测：temperature 是否下发由 config.supports_temperature 显式决定，max_tokens 原样透传。
- 同步接口契约保持不变：Agently 的 sync API（get_text / get_generator）天然适配。
- 每次调用新建 agent（无跨调用状态泄漏）；OpenAICompatibleSettings 复用同一实例。
- 无 api_key 时由工厂返回 NoopLlmClient。
"""

from __future__ import annotations

from collections.abc import Callable, Generator

from agently import Agently
from agently.types.settings import OpenAICompatibleSettings

from .types import LlmClientConfig, LlmMessage


def _to_pair(m: LlmMessage | dict) -> tuple[str, str]:
    if isinstance(m, LlmMessage):
        return m.role, m.content
    return m["role"], m["content"]


class NoopLlmClient:
    """无 API Key 降级：complete 返回 None，stream 不产出。"""

    available = False

    def complete(self, messages, temperature=None, max_tokens=None) -> None:
        return None

    def stream(self, messages, temperature=None) -> Generator[str, None, None]:
        # 空生成器，调用方据此降级
        yield from ()


class OpenAiLlmClient:
    def __init__(
        self,
        config: LlmClientConfig,
        agent_factory: Callable | None = None,
    ) -> None:
        self.available = bool(config.api_key)
        self._supports_temperature = config.supports_temperature
        self._agent_factory = agent_factory or Agently.create_agent
        base_url = (config.base_url or "").rstrip("/")
        self._settings = OpenAICompatibleSettings(
            base_url=base_url or None,
            api_key=config.api_key,
            model=config.model,
        )

    def _chain(self, messages, temperature, max_tokens):
        """把 messages 映射为 Agently 请求链：system→.system()，中间轮→chat_history，末条→.input()。"""
        agent = self._agent_factory().set_settings(self._settings)

        system_texts: list[str] = []
        history: list[dict[str, str]] = []
        last_content = ""
        for role, content in map(_to_pair, messages):
            if role == "system":
                system_texts.append(content)
            else:
                history.append({"role": role, "content": content})
        if history:
            last = history.pop()
            last_content = last["content"]
            if history:
                agent.set_chat_history(history)

        chain = agent
        opts: dict[str, float | int] = {}
        if temperature is not None and self._supports_temperature:
            opts["temperature"] = temperature
        if max_tokens is not None:
            opts["max_tokens"] = max_tokens
        if opts:
            chain = chain.options(opts)
        if system_texts:
            chain = chain.system("\n\n".join(system_texts))
        return chain.input(last_content)

    def complete(self, messages, temperature=None, max_tokens=None) -> str | None:
        if not self.available:
            return None

        result = self._chain(messages, temperature, max_tokens).get_result()
        text = result.get_text()
        return text if text else None

    def stream(self, messages, temperature=None) -> Generator[str, None, None]:
        if not self.available:
            return
        if temperature is None and self._supports_temperature:
            temperature = 0.3

        result = self._chain(messages, temperature, None).get_result()
        for delta in result.get_generator(type="delta"):
            if delta:
                yield delta


def create_llm_client(config: LlmClientConfig):
    """无 apiKey 时返回 NoopLlmClient。"""
    if not config.api_key:
        return NoopLlmClient()
    return OpenAiLlmClient(config)
