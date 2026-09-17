"""检索管线（移植自 src/application/search/pipeline.ts，Spec 029/031）。

固定编排：[VectorRetriever, BM25Retriever] → filteredChunkIds 过滤 → RRFFusion。
profile.use_struct=true 且注入 struct_retriever 时追加第三路。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from ..types import (
    QueryAnalysis,
    RetrievalFilter,
    RetrievalHit,
    RetrievalOptions,
    RetrievalRequest,
)
from .entity_strategy import adjust_topk_for_broad_query
from .profile import SearchProfile

# 检索路是 I/O 密集（HTTP Embedding / 列存扫描 / SQLite 查询），复用进程级线程池，
# 避免每个请求都创建销毁线程；单路异常已在 search_with_fallback 内兜住，不会串扰。
_MAX_RETRIEVAL_WORKERS = 4
_RETRIEVAL_POOL = ThreadPoolExecutor(
    max_workers=_MAX_RETRIEVAL_WORKERS, thread_name_prefix="retrieval"
)


@dataclass
class PipelineParams:
    top_k: int
    vector_top_n: int
    bm25_top_n: int
    profile: SearchProfile | None = None


@dataclass
class PipelineComponents:
    """固定活动路约定顺序 [vector, bm25]；struct 为可选第三路。"""

    retrievers: list[Any]
    fusion: Any
    struct_retriever: Any | None = None


def run_search_pipeline(
    request: RetrievalRequest,
    params: PipelineParams,
    components: PipelineComponents,
) -> list[RetrievalHit]:
    retrievers = components.retrievers
    fusion = components.fusion
    struct_retriever = components.struct_retriever
    profile = params.profile

    query = request.query
    analysis = request.analysis
    filter_: RetrievalFilter | None = request.filter
    matched_keywords = analysis.matched_keywords if analysis else None
    is_entity_query = bool(matched_keywords)

    # 实体干预开关（fusion 向量路过滤 + assembler 实体查询分支共用；struct 路 keywords 不受影响）
    entity_filter_enabled = True if profile is None else profile.use_entity_filter

    active_retrievers = list(retrievers)
    if profile is not None and profile.use_struct and struct_retriever is not None:
        active_retrievers.append(struct_retriever)

    profile_id = profile.id if profile else "baseline"
    print(f'[Hybrid] 查询: "{query.query}", topK={params.top_k}, profile={profile_id}')

    top_k = adjust_topk_for_broad_query(query.query, params.top_k)

    # 实体查询保持原召回量；非实体查询翻倍召回
    effective_vector_top_n = (
        params.vector_top_n if is_entity_query else params.vector_top_n * 2
    )
    effective_bm25_top_n = params.bm25_top_n if is_entity_query else params.bm25_top_n * 2

    def top_n_for(name: str) -> int:
        if name == "bm25":
            return effective_bm25_top_n
        return effective_vector_top_n  # vector / struct

    def search_with_fallback(retriever, top_n: int) -> list[RetrievalHit]:
        try:
            options = RetrievalOptions(
                top_n=top_n, filter=filter_, keywords=matched_keywords
            )
            return retriever.search(query, options)
        except Exception as err:
            print(f"[Hybrid] {retriever.name} 检索失败: {err}")
            return []

    # 并行检索（单路抛错按空结果继续，维持降级语义）
    futures = [
        _RETRIEVAL_POOL.submit(search_with_fallback, r, top_n_for(r.name))
        for r in active_retrievers
    ]
    hit_lists = [f.result() for f in futures]

    print(
        "[Hybrid] 各路召回: "
        + ", ".join(
            f"{r.name}={len(hit_lists[i]) if i < len(hit_lists) else 0}"
            for i, r in enumerate(active_retrievers)
        )
    )

    # filteredChunkIds 过滤（docType 白名单，来自 LLM 改写）
    filtered_chunk_ids = filter_.filtered_chunk_ids if filter_ else None
    if filtered_chunk_ids:
        filter_set = set(filtered_chunk_ids)
        hit_lists = [[h for h in lst if h.chunk_id in filter_set] for lst in hit_lists]

    # 全空提前返回，不调 fusion
    if all(len(lst) == 0 for lst in hit_lists):
        print("[Hybrid] 所有检索路均无结果")
        return []

    fusion_top_k = top_k if is_entity_query else top_k * 3
    analysis_for_fusion = QueryAnalysis(
        matched_keywords=matched_keywords if entity_filter_enabled else None
    )
    fused = fusion.fuse(hit_lists, analysis_for_fusion, fusion_top_k)

    print(f"[Hybrid] RRF 融合后 top{top_k}: {len(fused)} 条")
    return fused
