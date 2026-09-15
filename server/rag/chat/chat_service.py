"""Chat Use Case（逐字移植自 src/application/chat/chatService.ts）。

会话管理 → query 改写 → 缓存检查 → 实体关联文档 / 语义检索
→ RAG 流式回答 → 会话记录。Presentation 层只做 SSE 事件映射。
Python 侧同步生成器；对话压缩以守护线程触发，不阻塞当前请求。
"""

from __future__ import annotations

import threading
from collections.abc import Generator
from dataclasses import dataclass

from ..retrieve.cache import CacheContext
from ..retrieve.entity_strategy import POLICY_VERSION
from ..retrieve.hybrid_search import HybridSearchOptions
from .entity_docs import filter_chunks_by_doc_types, load_entity_docs_content
from .query_rewriter import SmartRewriteOptions
from .rag_engine import RagChatOptions
from .sessions import (
    add_message,
    compress_conversation,
    get_conversation_context,
    get_last_search_results,
    get_or_create_session,
    is_follow_up_query,
    save_last_search_results,
)
from .types import (
    ChatContextEvent,
    ChatDoneEvent,
    ChatErrorEvent,
    ChatMethodEvent,
    ChatNoLlmEvent,
    ChatTokenEvent,
    RagContextEvent,
    RagDoneEvent,
    RagErrorEvent,
    RagNoLlmEvent,
    RagTokenEvent,
)


@dataclass
class ChatRequestOptions:
    top_k: int = 10
    session_id: str | None = None
    llm: object | None = None


def _fire_compress(session_id: str, llm) -> None:
    """异步触发压缩（对齐 TS `compressConversation(...).catch(() => {})`）。"""

    def run() -> None:
        try:
            compress_conversation(session_id, llm)
        except Exception as err:
            print(f"[Chat] 对话压缩异常: {err}")

    threading.Thread(target=run, daemon=True).start()


class ChatService:
    def __init__(self, deps: dict) -> None:
        self._llm = deps["llm"]
        self._embed_query = deps["embed_query"]
        self._prewarm_query = deps["prewarm_query"]
        self._cache_lookup = deps["cache_lookup"]
        self._cache_save = deps["cache_save"]
        self._chunk_store = deps["chunk_store"]
        self._struct_query = deps["struct_query"]
        self._file_store = deps["file_store"]
        self._hybrid_search = deps["hybrid_search"]
        self._smart_rewriter = deps["smart_rewriter"]
        self._rag_chat_stream = deps["rag_chat_stream"]

    def chat(
        self,
        query: str,
        options: ChatRequestOptions | None = None,
    ) -> Generator:
        options = options or ChatRequestOptions()
        top_k = options.top_k or 10
        client_llm = options.llm or self._llm

        # 多轮对话：获取或创建会话
        session = get_or_create_session(options.session_id)

        # 对话压缩（异步触发，不阻塞当前请求）
        _fire_compress(session.id, client_llm)

        # 对话历史（在写入本轮 user 消息之前取，与 TS 顺序一致）
        history_text = get_conversation_context(session.id).history_text

        add_message(session.id, "user", query)

        # 0. Query Rewriting + 统一路由决策
        last = get_last_search_results(session.id)
        rewrite_result = self._smart_rewriter.rewrite(
            query,
            SmartRewriteOptions(
                llm=client_llm,
                previous_query=last.query if last else None,
            ),
        )
        matched = rewrite_result.entities
        rewritten_query = rewrite_result.rewritten_query

        if rewrite_result.route_decision is not None:
            is_follow_up = rewrite_result.route_decision.is_follow_up
        else:
            is_follow_up = is_follow_up_query(query)

        # 0.5 检索结果缓存检查（非追问 && LLM 改写 && 非实体路径）
        cached_results = None
        query_embedding = None
        if not is_follow_up and rewrite_result.method == "llm":
            try:
                query_embedding = self._embed_query(rewritten_query)
                cached_results = self._cache_lookup(
                    rewritten_query,
                    query_embedding,
                    CacheContext(entities=matched, policy_version=POLICY_VERSION),
                )
            except Exception:
                # embedding 生成失败，跳过缓存
                pass

        # 追问补充上下文
        enriched_query = query
        if is_follow_up:
            last_results = get_last_search_results(session.id)
            if last_results:
                enriched_query = f'[上文: 用户之前问"{last_results.query}"] {query}'
                print(f'[Chat] 检测到追问，补充上下文: "{last_results.query}"')

        # 1. 实体关联文档优先；无命中走语义检索
        results = []
        entity_docs_content = None
        search_method = "rrf"

        if matched:
            entity_result = load_entity_docs_content(
                self._struct_query, self._file_store, matched
            )
            if entity_result is not None:
                entity_docs_content = entity_result.docs_content
                search_method = "entity"
                print(
                    f"[Chat] 实体关联命中: [{', '.join(matched)}] "
                    f"({rewrite_result.method})，跳过语义检索"
                )

        if not entity_docs_content:
            if cached_results is not None:
                print("[Chat] 检索缓存命中，跳过 hybridSearch")
                results = cached_results
            else:
                search_query = (
                    rewritten_query
                    if rewrite_result.method == "llm"
                    else enriched_query
                )
                print(
                    f'[Chat] 无实体关联结果，降级为语义检索（向量+BM25），'
                    f'query="{search_query[:50]}"'
                )
                filtered_chunk_ids = None
                if rewrite_result.relevant_doc_types:
                    filtered_chunk_ids = filter_chunks_by_doc_types(
                        self._chunk_store, rewrite_result.relevant_doc_types
                    )
                results = self._hybrid_search(
                    search_query,
                    top_k,
                    20,
                    20,
                    HybridSearchOptions(
                        matched_keywords=matched or None,
                        filtered_chunk_ids=filtered_chunk_ids,
                    ),
                )
                # 缓存写入（LLM 改写 + 非追问 + embedding 已就绪）
                if query_embedding and rewrite_result.method == "llm" and not is_follow_up:
                    self._cache_save(
                        rewritten_query,
                        query_embedding,
                        results,
                        CacheContext(
                            entities=matched, policy_version=POLICY_VERSION
                        ),
                    )
                    self._prewarm_query(
                        rewritten_query
                        if rewrite_result.method == "llm"
                        else enriched_query,
                        query_embedding,
                    )
            search_method = "rrf"

        # 保存检索结果（用于后续追问）
        save_last_search_results(session.id, query, results, search_method)

        yield ChatMethodEvent(
            method=search_method,
            session_id=session.id,
            rewrite_method=rewrite_result.method,
            matched_keywords=matched or None,
            entity_docs_content=entity_docs_content or None,
            rewritten_query=rewritten_query if rewrite_result.method == "llm" else None,
        )

        final_query = (
            rewritten_query if rewrite_result.method == "llm" else query
        )
        generator = self._rag_chat_stream(
            final_query,
            RagChatOptions(
                llm=client_llm,
                top_k=top_k,
                pre_search_results=results,
                entity_docs_content=entity_docs_content,
                conversation_context=history_text or None,
                is_follow_up=is_follow_up,
                matched_keywords=matched or None,
            ),
        )

        full_answer = ""
        for event in generator:
            if isinstance(event, RagContextEvent):
                yield ChatContextEvent(
                    session_id=session.id, results=event.results or []
                )
            elif isinstance(event, RagTokenEvent):
                full_answer += event.content or ""
                if event.content:
                    yield ChatTokenEvent(content=event.content)
            elif isinstance(event, RagNoLlmEvent):
                yield ChatNoLlmEvent(results=event.results or [])
            elif isinstance(event, RagErrorEvent):
                yield ChatErrorEvent(content=event.content)
            elif isinstance(event, RagDoneEvent):
                if full_answer:
                    add_message(session.id, "assistant", full_answer)
                yield ChatDoneEvent(session_id=session.id)


def create_chat_service(deps: dict) -> ChatService:
    return ChatService(deps)
