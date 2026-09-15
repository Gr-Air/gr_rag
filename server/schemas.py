"""全部对外 DTO（Pydantic v2）。

字段名与 TS 版 API/SSE 契约严格一致（Spec 038 §1），
保证前端零改动。P0 为桩定义，后续阶段补齐内核类型。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ============================================================
# 请求
# ============================================================

class ChatRequest(BaseModel):
    query: str
    top_k: int = Field(default=10, alias="topK")
    api_key: str | None = Field(default=None, alias="apiKey")
    base_url: str | None = Field(default=None, alias="baseURL")
    model: str | None = None
    session_id: str | None = Field(default=None, alias="sessionId")

    model_config = {"populate_by_name": True}


class SearchParams:
    """GET /api/search 的 query 参数（在路由内用 Query 声明，此处仅文档化）。"""


class EvalRequest(BaseModel):
    # query 缺省给空串：对齐 TS（缺字段也走 400 {error:'请提供问题'}，而非校验层 422）
    query: str = ""
    top_k: int = Field(default=10, alias="topK")
    api_key: str | None = Field(default=None, alias="apiKey")
    base_url: str | None = Field(default=None, alias="baseURL")
    model: str | None = None
    # None/未知 id → resolve_profile 回落 baseline（与 TS 一致）
    profile_id: str | None = Field(default=None, alias="profileId")

    model_config = {"populate_by_name": True}


# ============================================================
# SSE 事件（帧格式：data: {json}\\n\\n，ensure_ascii=False）
# ============================================================

class RetrievalResultDTO(BaseModel):
    """context / no-llm 事件中的单条结果（与 chat route 映射后的结构一致）。"""

    docTitle: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    source: str
    score: float
    scores: dict[str, Any] = Field(default_factory=dict)
    content: str
    docPath: str


class SearchResultItemDTO(BaseModel):
    """GET /api/search 的单条结果。"""

    id: str
    docId: str
    docTitle: str
    docPath: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    score: float
    scores: dict[str, Any] = Field(default_factory=dict)
    source: str
    highlight: str | None = None


class MethodEvent(BaseModel):
    type: Literal["method"] = "method"
    method: Literal["rrf", "entity"]
    matchedKeywords: list[str] | None = None
    entityDocsContent: str | None = None
    sessionId: str
    rewriteMethod: Literal["llm", "fallback"]
    rewrittenQuery: str | None = None


class ContextEvent(BaseModel):
    type: Literal["context"] = "context"
    sessionId: str
    results: list[RetrievalResultDTO] = Field(default_factory=list)


class TokenEvent(BaseModel):
    type: Literal["token"] = "token"
    content: str


class NoLlmEvent(BaseModel):
    type: Literal["no-llm"] = "no-llm"
    results: list[RetrievalResultDTO] = Field(default_factory=list)


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    content: str


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    sessionId: str


# ============================================================
# 普通 JSON 响应
# ============================================================

class SearchResponse(BaseModel):
    query: str
    matchedKeywords: list[str] | None = None
    method: Literal["rrf", "entity"]
    total: int
    results: list[SearchResultItemDTO] = Field(default_factory=list)
