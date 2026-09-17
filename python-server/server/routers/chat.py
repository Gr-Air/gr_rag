"""POST /api/chat —— SSE 问答（Spec 038 P3）。

Presentation 层：请求解析 / 校验 / ChatStreamEvent → SSE 帧映射 / 错误映射。
业务流程在 rag.chat.chat_service（经 rag.bootstrap 组装）。
同步生成器由 Starlette 在线程池中迭代（embedding/SQLite/LanceDB/LLM 均为同步调用）。
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse, StreamingResponse

from ..rag.bootstrap import create_request_llm, get_chat_service, is_index_ready
from ..rag.chat.chat_service import ChatRequestOptions
from ..rag.chat.types import (
    ChatContextEvent,
    ChatDoneEvent,
    ChatErrorEvent,
    ChatMethodEvent,
    ChatNoLlmEvent,
    ChatTokenEvent,
)
from ..rag.types import scores_to_dict
from ..schemas import (
    ChatRequest,
    ContextEvent,
    DoneEvent,
    ErrorEvent,
    MethodEvent,
    NoLlmEvent,
    RetrievalResultDTO,
    TokenEvent,
)
from ._sse import sse_frame

router = APIRouter()

_RAW_PREFIX = re.compile(r"^Raw/")
_MD_SUFFIX = re.compile(r"\.md$")


def _result_dto(r) -> RetrievalResultDTO:
    path = r.chunk.doc_path
    doc_title = (
        _MD_SUFFIX.sub("", _RAW_PREFIX.sub("", path)) if path else r.chunk.doc_title
    )
    return RetrievalResultDTO(
        docTitle=doc_title,
        metadata=r.chunk.metadata or {},
        source=r.source,
        score=r.score,
        scores=scores_to_dict(r.scores),
        content=r.chunk.content,
        docPath=r.chunk.doc_path,
    )


@router.post("/api/chat")
def chat(req: ChatRequest):
    if not req.query or not req.query.strip():
        return PlainTextResponse("请提供问题", status_code=400)

    if not is_index_ready():
        return PlainTextResponse("索引尚未初始化完成，请稍后再试", status_code=503)

    # 按请求配置创建 LlmClient（无 key 时 NoopLlmClient → no-llm 降级）
    llm = create_request_llm(req.api_key, req.base_url, req.model)
    service = get_chat_service()
    options = ChatRequestOptions(
        top_k=req.top_k, session_id=req.session_id, llm=llm
    )
    query = req.query.strip()

    def frames() -> Iterator[str]:
        try:
            for event in service.chat(query, options):
                if isinstance(event, ChatMethodEvent):
                    yield sse_frame(
                        MethodEvent(
                            method=event.method,
                            matchedKeywords=event.matched_keywords,
                            entityDocsContent=event.entity_docs_content,
                            sessionId=event.session_id,
                            rewriteMethod=event.rewrite_method,
                            rewrittenQuery=event.rewritten_query,
                        )
                    )
                elif isinstance(event, ChatContextEvent):
                    yield sse_frame(
                        ContextEvent(
                            sessionId=event.session_id,
                            results=[_result_dto(r) for r in event.results],
                        )
                    )
                elif isinstance(event, ChatTokenEvent):
                    if event.content:
                        yield sse_frame(TokenEvent(content=event.content))
                elif isinstance(event, ChatNoLlmEvent):
                    yield sse_frame(
                        NoLlmEvent(results=[_result_dto(r) for r in event.results])
                    )
                elif isinstance(event, ChatErrorEvent):
                    if event.content:
                        yield sse_frame(ErrorEvent(content=event.content))
                elif isinstance(event, ChatDoneEvent):
                    yield sse_frame(DoneEvent(sessionId=event.session_id))
        except Exception as err:
            yield sse_frame(ErrorEvent(content=str(err)))

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
