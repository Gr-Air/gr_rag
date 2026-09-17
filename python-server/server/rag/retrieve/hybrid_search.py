"""混合检索 Use Case（移植自 src/application/search/hybridSearch.ts）。

管线（pipeline.py）做检索 + 过滤 + 融合；Assembler 做 chunk 附着/聚合/归一化。
依赖通过工厂注入（ChunkStore + Retrievers + Fusion），由 bootstrap 组装。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ..types import (
    QueryAnalysis,
    RetrievalFilter,
    RetrievalRequest,
    SearchQuery,
    SearchResult,
)
from .assembler import SearchResultAssembler
from .pipeline import PipelineComponents, PipelineParams, run_search_pipeline

HybridSearchFn = Callable[..., list[SearchResult]]


@dataclass
class HybridSearchOptions:
    matched_keywords: list[str] | None = None
    filtered_chunk_ids: list[str] | None = None
    profile: Any | None = None


@dataclass
class HybridSearchDeps:
    chunk_store: Any
    retrievers: list[Any]
    fusion: Any
    struct_retriever: Any | None = None


def create_hybrid_search(deps: HybridSearchDeps) -> HybridSearchFn:
    assembler = SearchResultAssembler(deps.chunk_store)

    def hybrid_search(
        query: str,
        top_k: int = 10,
        vector_top_n: int = 20,
        bm25_top_n: int = 20,
        options: HybridSearchOptions | None = None,
    ) -> list[SearchResult]:
        profile = options.profile if options else None
        matched_keywords = options.matched_keywords if options else None
        filtered_chunk_ids = options.filtered_chunk_ids if options else None

        search_query = SearchQuery(query=query)
        analysis = QueryAnalysis(matched_keywords=matched_keywords)
        filter_ = (
            RetrievalFilter(filtered_chunk_ids=filtered_chunk_ids)
            if filtered_chunk_ids
            else None
        )
        request = RetrievalRequest(query=search_query, analysis=analysis, filter=filter_)

        # profile topN 覆盖位置参数
        effective_vector_top_n = profile.vector_top_n if profile else vector_top_n
        effective_bm25_top_n = profile.bm25_top_n if profile else bm25_top_n

        hits = run_search_pipeline(
            request,
            PipelineParams(
                top_k=top_k,
                vector_top_n=effective_vector_top_n,
                bm25_top_n=effective_bm25_top_n,
                profile=profile,
            ),
            PipelineComponents(
                retrievers=deps.retrievers,
                fusion=deps.fusion,
                struct_retriever=deps.struct_retriever,
            ),
        )

        # assembler 实体查询分支与 fusion 实体过滤共用同一开关
        effective_analysis = QueryAnalysis(
            matched_keywords=(
                None
                if profile is not None and profile.use_entity_filter is False
                else analysis.matched_keywords
            )
        )
        return assembler.assemble(hits, search_query, effective_analysis, top_k)

    return hybrid_search
