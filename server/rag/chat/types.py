"""chat 领域模型（dataclass）。

会话/消息是业务流程概念；事件为 chat_service / rag_engine 的产出，
由 routers/chat.py 映射为 SSE 帧。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..types import SearchResult  # noqa: F401（类型标注用）


# ============================================================
# 会话
# ============================================================

@dataclass
class ChatMessage:
    role: str  # 'user' | 'assistant' | 'system'
    content: str
    timestamp: int


@dataclass
class LastSearchResults:
    query: str
    results: list[SearchResult]
    method: str  # 'rrf' | 'entity'


@dataclass
class ChatSession:
    id: str
    messages: list[ChatMessage] = field(default_factory=list)
    summary: str | None = None
    last_search_results: LastSearchResults | None = None
    created_at: int = 0
    updated_at: int = 0


# ============================================================
# LLM
# ============================================================

@dataclass
class LlmMessage:
    role: str  # 'system' | 'user' | 'assistant'
    content: str


@dataclass
class LlmClientConfig:
    """由 Composition/Presentation 层绑定，Application 层不碰 env。"""

    api_key: str
    model: str
    base_url: str | None = None
    # 端点是否接受 temperature：严格推理模型（o3 / o1 / deepseek-r1 等）置 false
    supports_temperature: bool = True


# ============================================================
# rag_engine 内部事件
# ============================================================

@dataclass
class RagContextEvent:
    results: list[SearchResult]
    type: str = "context"


@dataclass
class RagTokenEvent:
    content: str | None = None
    type: str = "token"


@dataclass
class RagDoneEvent:
    type: str = "done"


@dataclass
class RagErrorEvent:
    content: str | None = None
    type: str = "error"


@dataclass
class RagNoLlmEvent:
    results: list[SearchResult] = field(default_factory=list)
    type: str = "no-llm"


# ============================================================
# chat_service 对外事件（router 映射为 SSE payload）
# ============================================================

@dataclass
class ChatMethodEvent:
    method: str  # 'rrf' | 'entity'
    session_id: str
    rewrite_method: str  # 'llm' | 'fallback'
    matched_keywords: list[str] | None = None
    entity_docs_content: str | None = None
    rewritten_query: str | None = None
    type: str = "method"


@dataclass
class ChatContextEvent:
    session_id: str
    results: list[SearchResult]
    type: str = "context"


@dataclass
class ChatTokenEvent:
    content: str | None = None
    type: str = "token"


@dataclass
class ChatErrorEvent:
    content: str | None = None
    type: str = "error"


@dataclass
class ChatNoLlmEvent:
    results: list[SearchResult] = field(default_factory=list)
    type: str = "no-llm"


@dataclass
class ChatDoneEvent:
    session_id: str
    type: str = "done"


ChatStreamEvent = Any  # 联合类型仅用于标注
