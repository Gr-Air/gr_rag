"""RRF 融合（移植自 src/infrastructure/search/fusion.ts，Spec 029/037）。

公式：RRF(d) = Σ_path 1/(k + rank_path(d))，k = 60。
实体过滤仅作用于向量路：被标记的 chunk 保留原始分但跳过其向量排名贡献。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..types import QueryAnalysis, RetrievalHit, Scores, Ranks
from .entity_strategy import build_vector_entity_filter

RRF_K = 60

RankKey = Literal["vector", "bm25", "struct"]
_RANK_KEYS: tuple[RankKey, ...] = ("vector", "bm25", "struct")


@dataclass
class RankingInput:
    key: RankKey
    hits: list[RetrievalHit]
    """该路中这些 chunkId 的排名不贡献 RRF（实体过滤，当前仅 vector 路使用）。"""

    skip_filter: set[str] | None = None


def _detect_rank_key(hits: list[RetrievalHit], fallback: RankKey) -> RankKey:
    if not hits:
        return fallback
    first = hits[0]
    if first.scores.vector is not None:
        return "vector"
    if first.scores.bm25 is not None:
        return "bm25"
    if first.scores.struct is not None:
        return "struct"
    return fallback


def fuse_rankings(rankings: list[RankingInput], top_k: int = 10) -> list[RetrievalHit]:
    fused: dict[str, RetrievalHit] = {}

    def get_or_create(chunk_id: str) -> RetrievalHit:
        hit = fused.get(chunk_id)
        if hit is None:
            hit = RetrievalHit(chunk_id=chunk_id, scores=Scores(), ranks=Ranks(), source="rrf")
            fused[chunk_id] = hit
        return hit

    for ranking in rankings:
        key = ranking.key
        effective_rank = 0
        for index, src_hit in enumerate(ranking.hits):
            rank = index + 1
            hit = get_or_create(src_hit.chunk_id)
            raw_score = getattr(src_hit.scores, key)
            if raw_score is not None:
                setattr(hit.scores, key, raw_score)
            # 被该路过滤：保留原始分但跳过排名贡献（ranks[key] 缺省）
            if ranking.skip_filter and src_hit.chunk_id in ranking.skip_filter:
                continue
            effective_rank += 1
            setattr(hit.ranks, key, rank)
            hit.scores.rrf = (hit.scores.rrf or 0.0) + 1 / (RRF_K + effective_rank)

    ranked = sorted(fused.values(), key=lambda h: -(h.scores.rrf or 0.0))
    return ranked[:top_k]


def rrf_fusion(
    vector_hits: list[RetrievalHit],
    bm25_hits: list[RetrievalHit],
    top_k: int = 10,
    vector_entity_filter: set[str] | None = None,
) -> list[RetrievalHit]:
    """两路 RRF 纯函数（兼容测试用）。"""
    return fuse_rankings(
        [
            RankingInput("vector", vector_hits, vector_entity_filter),
            RankingInput("bm25", bm25_hits),
        ],
        top_k,
    )


class RRFFusion:
    name = "rrf"

    def __init__(self, chunk_store=None) -> None:
        self._chunk_store = chunk_store

    def fuse(
        self,
        hit_lists: list[list[RetrievalHit]],
        analysis: QueryAnalysis,
        top_k: int = 10,
    ) -> list[RetrievalHit]:
        rankings: list[RankingInput] = []
        for i, hits in enumerate(hit_lists):
            fallback = _RANK_KEYS[i] if i < len(_RANK_KEYS) else "struct"
            rankings.append(RankingInput(_detect_rank_key(hits, fallback), hits))

        # 实体过滤仅向量路
        keywords = analysis.matched_keywords
        vector_ranking = next((r for r in rankings if r.key == "vector"), None)
        if (
            self._chunk_store is not None
            and keywords
            and vector_ranking is not None
            and vector_ranking.hits
        ):
            chunks = self._chunk_store.get_by_ids([h.chunk_id for h in vector_ranking.hits])
            content_map = {c.id: c.content for c in chunks}
            vector_filter = build_vector_entity_filter(vector_ranking.hits, keywords, content_map)
            if vector_filter:
                vector_ranking.skip_filter = vector_filter

        return fuse_rankings(rankings, top_k)
