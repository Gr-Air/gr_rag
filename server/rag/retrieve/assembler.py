"""SearchResultAssembler（移植自 src/application/search/assembler.ts，Spec 031）。

RetrievalHit[] → SearchResult[]：
  chunk 附着 → 文档聚合 → 实体加成 → 排序截断 → 归一化 → 高亮 → 组装
"""

from __future__ import annotations

import math
import re

from ..types import (
    DocChunk,
    QueryAnalysis,
    RetrievalHit,
    SearchQuery,
    SearchResult,
)
from .entity_strategy import apply_entity_match_boost, generate_highlight

_TRAILING_INDEX = re.compile(r"_\d+$")


def _round4(value: float) -> float:
    """对齐 JS Math.round(x*10000)/10000（四舍五入到 4 位，非银行家舍入）。"""
    return math.floor(value * 10000 + 0.5) / 10000


class SearchResultAssembler:
    def __init__(self, chunk_store) -> None:
        self._chunk_store = chunk_store

    def assemble(
        self,
        hits: list[RetrievalHit],
        query: SearchQuery,
        analysis: QueryAnalysis,
        top_k: int,
    ) -> list[SearchResult]:
        matched_keywords = analysis.matched_keywords
        is_entity_query = bool(matched_keywords)

        # Step 1: chunk 附着
        chunks = self._chunk_store.get_by_ids([h.chunk_id for h in hits])
        chunk_map: dict[str, DocChunk] = {c.id: c for c in chunks}

        # Step 2: 文档聚合
        max_chunks_per_doc = 1 if is_entity_query else 5
        doc_chunks: dict[str, list[tuple[DocChunk, RetrievalHit]]] = {}
        seen_chunk_ids: set[str] = set()

        for f in hits:
            chunk = chunk_map.get(f.chunk_id)
            if chunk is None or f.chunk_id in seen_chunk_ids:
                continue
            seen_chunk_ids.add(f.chunk_id)

            doc_id = chunk.doc_id or _TRAILING_INDEX.sub("", f.chunk_id)
            existing = doc_chunks.setdefault(doc_id, [])

            if len(existing) < max_chunks_per_doc:
                chunk_title = (chunk.content.split("\n")[0] or "").strip()
                has_same_title = any(
                    (e[0].content.split("\n")[0] or "").strip() == chunk_title for e in existing
                )
                if not has_same_title:
                    existing.append((chunk, f))

        # Step 3: 实体匹配度加成
        apply_entity_match_boost(doc_chunks, matched_keywords)

        # Step 4: 排序 + 截断
        all_chunks = [item for entries in doc_chunks.values() for item in entries]
        final_top_k = top_k if is_entity_query else top_k * 2
        sorted_docs = sorted(all_chunks, key=lambda item: -(item[1].scores.rrf or 0.0))[
            :final_top_k
        ]

        # Step 5: 归一化（RRF 原始值映射到 0.05~0.95）
        max_rrf = sorted_docs[0][1].scores.rrf if sorted_docs else None
        if max_rrf is None:
            max_rrf = 0.001
        min_rrf = sorted_docs[-1][1].scores.rrf if sorted_docs else None
        if min_rrf is None:
            min_rrf = 0.0

        # Step 6: 高亮 + 组装
        results: list[SearchResult] = []
        for chunk, hit in sorted_docs:
            source = "hybrid"
            if hit.ranks.vector is not None and hit.ranks.bm25 is None:
                source = "vector"
            if hit.ranks.bm25 is not None and hit.ranks.vector is None:
                source = "bm25"

            if max_rrf > min_rrf:
                normalized = (
                    0.05 + (((hit.scores.rrf or 0.0) - min_rrf) / (max_rrf - min_rrf)) * 0.90
                )
            else:
                normalized = 0.50

            results.append(
                SearchResult(
                    chunk=chunk,
                    score=_round4(normalized),
                    scores=hit.scores,
                    source=source,
                    highlight=generate_highlight(chunk.content, query.query),
                )
            )
        return results
