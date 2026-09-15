"""RAG 问答引擎（逐字移植自 src/application/chat/ragEngine.ts）。

流程：[可选]混合检索 → context 事件（pre-rerank 全量）→ Rerank（仅影响 LLM prompt）
→ 构建 prompt → LLM 流式回答；无 LLM 时产出 no-llm 事件降级。
"""

from __future__ import annotations

from collections.abc import Generator
from dataclasses import dataclass

from ..retrieve.hybrid_search import HybridSearchOptions
from ..types import SearchQuery, SearchResult
from .prompt_template import BuildOptions, PromptTemplate
from .types import (
    RagContextEvent,
    RagDoneEvent,
    RagErrorEvent,
    RagNoLlmEvent,
    RagTokenEvent,
)

_prompt_template = PromptTemplate()


@dataclass
class RagChatOptions:
    llm: object | None = None
    top_k: int = 5
    pre_search_results: list[SearchResult] | None = None
    entity_docs_content: str | None = None
    conversation_context: str | None = None
    is_follow_up: bool = False
    matched_keywords: list[str] | None = None
    rerank_top_k: int = 5


def _build_rag_prompt(query: str, search_results: list[SearchResult], options: dict):
    """检索结果按 score 降序，拼 `### 文档 i: 标题 (元信息)` + chunk.content。"""
    sorted_results = sorted(search_results, key=lambda r: -r.score)
    context_parts: list[str] = []

    for i, result in enumerate(sorted_results):
        chunk = result.chunk
        meta = chunk.metadata or {}

        header = f"### 文档 {i + 1}: {chunk.doc_title}"
        meta_parts = []
        if meta.get("client"):
            meta_parts.append(f"客户: {meta['client']}")
        if meta.get("project"):
            meta_parts.append(f"项目: {meta['project']}")
        if meta.get("docType"):
            meta_parts.append(f"类型: {meta['docType']}")
        if meta.get("date"):
            meta_parts.append(f"日期: {meta['date']}")
        if meta_parts:
            header += f" ({' | '.join(meta_parts)})"

        context_parts.append(f"{header}\n{chunk.content}")

    context = "\n\n---\n\n".join(context_parts)

    return _prompt_template.build(
        BuildOptions(
            context=context,
            query=query,
            conversation_context=options.get("conversation_context"),
            is_follow_up=bool(options.get("is_follow_up")),
            intent=options.get("intent"),
            entity_docs_content=options.get("entity_docs_content"),
        )
    )


def create_rag_chat_stream(deps: dict):
    default_llm = deps["llm"]
    reranker_factory = deps["reranker_factory"]
    hybrid_search = deps["hybrid_search"]

    def rag_chat_stream(
        query: str,
        options: RagChatOptions | None = None,
    ) -> Generator:
        options = options or RagChatOptions()
        top_k = options.top_k or 5
        llm = options.llm or default_llm

        # Step 1: 检索（有预检索结果/实体文档则跳过）
        if options.pre_search_results:
            search_results = list(options.pre_search_results)
            print(f"[RAG] 使用预检索结果: {len(search_results)} 个文档块")
        elif options.entity_docs_content:
            search_results = []
            print("[RAG] 已加载实体关联文档，跳过语义检索")
        else:
            try:
                search_results = hybrid_search(
                    query,
                    top_k,
                    20,
                    20,
                    HybridSearchOptions(matched_keywords=options.matched_keywords),
                )
                print(f"[RAG] 检索到 {len(search_results)} 个相关文档块")
            except Exception as err:
                print(f"[RAG] 检索失败: {err}")
                yield RagErrorEvent(content="文档检索失败，请检查知识库索引是否已初始化")
                return

        if not search_results and not options.entity_docs_content:
            yield RagErrorEvent(content="未找到相关文档，请尝试更换查询关键词")
            return

        # pre-rerank 全量结果回传前端展示
        yield RagContextEvent(results=search_results)

        # Step 1.5: Rerank（仅影响 LLM prompt）
        rerank_top_k = options.rerank_top_k or 5
        prompt_results = search_results
        if len(search_results) > rerank_top_k:
            try:
                reranked = reranker_factory().rerank(
                    SearchQuery(query=query), search_results, rerank_top_k
                )
                if reranked:
                    print(
                        f"[RAG] Rerank 重排序: {len(search_results)} → "
                        f"{len(reranked)} 个文档块（仅影响 LLM prompt）"
                    )
                    prompt_results = reranked
            except Exception as err:
                print(f"[RAG] Rerank 失败，使用原始结果: {err}")

        # Step 2: 构建 prompt
        system_prompt, user_prompt = _build_rag_prompt(
            query,
            prompt_results,
            {
                "entity_docs_content": options.entity_docs_content,
                "conversation_context": options.conversation_context,
                "is_follow_up": options.is_follow_up,
            },
        )

        # Step 3: 流式回答（无 LLM → no-llm 降级，不产出 done）
        if not getattr(llm, "available", False):
            yield RagNoLlmEvent(results=search_results)
            return

        try:
            stream = llm.stream(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ]
            )
            for content in stream:
                if content:
                    yield RagTokenEvent(content=content)

            yield RagDoneEvent()
        except Exception as err:
            print(f"[RAG] LLM 调用失败: {err}")
            yield RagErrorEvent(
                content=f"LLM 调用失败: {str(err) or '未知错误'}"
            )

    return rag_chat_stream
