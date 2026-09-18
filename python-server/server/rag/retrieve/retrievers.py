"""检索器实现（移植自 src/infrastructure/search/retrievers.ts）。

每个 Retriever 包装底层引擎，输出统一 RetrievalHit。引擎由 bootstrap 注入。
StructRetriever 默认不进管线（profile.use_struct=true 时启用），查询异常内部吞掉。
"""

from __future__ import annotations

from ..types import RetrievalHit, RetrievalOptions, Scores, SearchQuery
from .engines.bm25_tantivy import TantivyBM25Engine
from .engines.struct_engine import StructEngine
from .engines.vector_engine import VectorEngine


class VectorRetriever:
    name = "vector"

    def __init__(self, engine: VectorEngine) -> None:
        self._engine = engine

    def search(self, query: SearchQuery, options: RetrievalOptions) -> list[RetrievalHit]:
        results = self._engine.search(query.query, options.top_n)
        return [
            RetrievalHit(chunk_id=r["chunkId"], scores=Scores(vector=r["score"]), source="vector")
            for r in results
        ]


class BM25Retriever:
    name = "bm25"

    def __init__(self, engine: TantivyBM25Engine) -> None:
        self._engine = engine

    def search(self, query: SearchQuery, options: RetrievalOptions) -> list[RetrievalHit]:
        results = self._engine.search(query.query, options.top_n)
        return [
            RetrievalHit(chunk_id=r["chunkId"], scores=Scores(bm25=r["score"]), source="bm25")
            for r in results
        ]


class StructRetriever:
    name = "struct"

    def __init__(self, struct_engine: StructEngine) -> None:
        self._engine = struct_engine

    def search(self, _query: SearchQuery, options: RetrievalOptions) -> list[RetrievalHit]:
        try:
            entries = options.keywords or []
            if not entries:
                return []

            results = self._engine.query(entries)

            hits: list[RetrievalHit] = []
            seen: set[str] = set()
            for r in results:
                for c in r["chunks"]:
                    chunk_id = c["chunk_id"]
                    if chunk_id in seen:
                        continue
                    seen.add(chunk_id)
                    hits.append(
                        RetrievalHit(
                            chunk_id=chunk_id,
                            scores=Scores(struct=r["entry"]["frequency"]),
                            source="entity",
                        )
                    )
            return hits[: options.top_n]
        except Exception as err:
            print(f"[StructRetriever] 结构化检索失败: {err}")
            return []
