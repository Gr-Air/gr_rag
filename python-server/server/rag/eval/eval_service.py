"""Eval Use Case（逐字移植自 src/application/eval/evalService.ts）。

query 改写 → 企业实体门禁 → 实体关联文档（eval 变体，含 Wiki）/ 语义检索
→ RAG 回答收集 → answer/contexts/sources/逐条分数链路。

与 chat 的差异：无 session、无缓存、无追问、无对话历史；
ragChatStream 只传 {llm, topK, rerankTopK, entityDocsContent, preSearchResults}。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..chat.entity_docs import (
    filter_chunks_by_doc_types,
    load_entity_docs_content_for_eval,
)
from ..chat.query_rewriter import SmartRewriteOptions
from ..chat.rag_engine import RagChatOptions
from ..chat.types import RagContextEvent, RagTokenEvent
from ..retrieve.hybrid_search import HybridSearchOptions
from ..retrieve.profile import resolve_profile
from ..types import scores_to_dict

# 客户企业特征正则（判断是否走结构化检索，逐字搬运，勿"补全"）
ENTERPRISE_PATTERN = re.compile(
    r"集团|公司|银行|证券|电力|保险|能源|通信|钢铁|船舶|置地|宝武|中车|中化|中钢|"
    r"招商局|华润|中信|浦发|招商|万科|中粮|南方电网|国家电网|中国移动|中国联通|"
    r"中国电信|中国银行|建设银行|农业银行|工商银行|交通银行|国泰君安|华泰|光大|"
    r"民生|平安|太平洋|新华|人寿"
)


@dataclass
class EvalRequestOptions:
    query: str
    top_k: int = 10
    llm: object | None = None
    profile_id: str | None = None


@dataclass
class EvalResult:
    query: str
    answer: str
    contexts: list[str]
    sources: list[str]
    search_method: str  # 'rrf' | 'entity'
    num_results: int
    matched_entities: list[str] = field(default_factory=list)
    profile_id: str = "baseline"
    result_scores: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "query": self.query,
            "answer": self.answer,
            "contexts": self.contexts,
            "sources": self.sources,
            "searchMethod": self.search_method,
            "numResults": self.num_results,
            "matchedEntities": self.matched_entities,
            "profileId": self.profile_id,
            "resultScores": self.result_scores,
        }


class EvalService:
    def __init__(self, deps: dict) -> None:
        self._default_llm = deps["llm"]
        self._chunk_store = deps["chunk_store"]
        self._struct_query = deps["struct_query"]
        self._entity_repo = deps["entity_repo"]
        self._file_store = deps["file_store"]
        self._hybrid_search = deps["hybrid_search"]
        self._smart_rewriter = deps["smart_rewriter"]
        self._rag_chat_stream = deps["rag_chat_stream"]

    def _extract_enterprise_entities(self, matched_entities: list[str]) -> list[str]:
        if not self._struct_query.is_ready():
            return []

        entity_map = {
            e["name"].lower(): {"type": e.get("type"), "category": e.get("category", "")}
            for e in self._entity_repo.get_known_entities()
        }

        results: list[str] = []
        for entity in matched_entities:
            info = entity_map.get(entity.lower())
            if (
                info
                and info["type"] == "entity"
                and ENTERPRISE_PATTERN.search(entity)
            ):
                results.append(entity)
        return results

    def _should_use_structured_search(self, matched_entities: list[str]) -> bool:
        return len(self._extract_enterprise_entities(matched_entities)) > 0

    def evaluate(self, req: EvalRequestOptions) -> EvalResult:
        client_llm = req.llm or self._default_llm
        top_k = req.top_k or 10
        profile = resolve_profile(req.profile_id)
        trimmed_query = req.query.strip()

        rewrite_result = self._smart_rewriter.rewrite(
            trimmed_query,
            SmartRewriteOptions(llm=client_llm, previous_query=None),
        )
        matched = rewrite_result.entities
        rewritten_query = rewrite_result.rewritten_query

        results = []
        entity_docs_content: str | None = None
        entity_sources: list[str] = []
        search_method = "rrf"

        # 实体关联文档（eval 完整策略：Wiki 词条 + 短文档全文/长文档片段）
        if matched and self._should_use_structured_search(matched):
            entity_result = load_entity_docs_content_for_eval(
                self._struct_query, self._file_store, matched
            )
            if entity_result:
                entity_docs_content = entity_result.docs_content
                entity_sources = entity_result.sources
                search_method = "entity"

        # 降级语义检索
        if not entity_docs_content:
            if rewrite_result.relevant_doc_types:
                filtered_chunk_ids = filter_chunks_by_doc_types(
                    self._chunk_store, rewrite_result.relevant_doc_types, "[Eval]"
                )
            else:
                filtered_chunk_ids = None
            results = self._hybrid_search(
                rewritten_query or trimmed_query,
                top_k,
                20,
                20,
                HybridSearchOptions(
                    matched_keywords=matched if matched else None,
                    filtered_chunk_ids=filtered_chunk_ids,
                    profile=profile,
                ),
            )
            search_method = "rrf"

        answer = ""
        final_results = results

        if results or entity_docs_content:
            generator = self._rag_chat_stream(
                trimmed_query,
                RagChatOptions(
                    llm=client_llm,
                    top_k=top_k,
                    rerank_top_k=profile.rerank_top_k,
                    entity_docs_content=entity_docs_content,
                    pre_search_results=results if results else None,
                ),
            )

            full_answer = ""
            for event in generator:
                if isinstance(event, RagTokenEvent) and event.content:
                    full_answer += event.content
                elif isinstance(event, RagContextEvent):
                    final_results = event.results
            answer = full_answer or "未能生成回答"
        else:
            answer = "未检索到相关资料，请尝试其他关键词。"

        context_chunks = [
            r.chunk.content
            for r in final_results[:top_k]
            if r.chunk and r.chunk.content
        ]
        context_sources = [
            r.chunk.doc_title or "unknown" if r.chunk else "unknown"
            for r in final_results[:top_k]
        ]
        context_sources = [s for s in context_sources if s]

        # 实体文档内容作为首要上下文（先 slice 再 unshift，截断 5000 字符）
        if entity_docs_content:
            context_chunks = [entity_docs_content[:5000]] + context_chunks

        final_num_results = len(final_results)
        final_sources = context_sources
        if search_method == "entity" and entity_sources:
            final_num_results = len(entity_sources)
            final_sources = entity_sources

        return EvalResult(
            query=trimmed_query,
            answer=answer,
            contexts=context_chunks,
            sources=final_sources,
            search_method=search_method,
            num_results=final_num_results,
            matched_entities=matched,
            profile_id=profile.id,
            result_scores=[
                {"score": r.score, "scores": scores_to_dict(r.scores)}
                for r in final_results[:top_k]
            ],
        )


def create_eval_service(deps: dict) -> EvalService:
    return EvalService(deps)
