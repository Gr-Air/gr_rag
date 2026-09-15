"""向量检索引擎（移植自 src/infrastructure/vector/vectorEngine.ts）。

- LanceDB IVF_PQ 余弦索引，分数 = 1 - _distance
- query embedding 走 get_query_embedding（text_type=query，带缓存）
- 无向量索引时报错降级为全量暴力 cosine
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import lancedb

from ....config import get_settings
from . import embedding as embedding_mod


class VectorEngine:
    def __init__(self, lance_dir: Path | None = None) -> None:
        settings = get_settings()
        self._lance_dir = lance_dir or (settings.data_dir / "lancedb")
        self._db: Any = None
        self._table: Any = None

    # ------------------------------------------------------------
    # 连接管理
    # ------------------------------------------------------------

    def _get_table(self) -> Any:
        if self._table is not None:
            try:
                self._table.count_rows()
                return self._table
            except Exception:
                self._table = None

        self._db = lancedb.connect(str(self._lance_dir))
        if "chunks" not in self._db.table_names():
            return None
        self._table = self._db.open_table("chunks")
        return self._table

    # ------------------------------------------------------------
    # 检索
    # ------------------------------------------------------------

    def search(self, query: str, top_k: int = 20) -> list[dict]:
        """返回 [{chunkId, score, parentDocId?}]。"""
        table = self._get_table()
        if table is None:
            print("[vectorSearch] LanceDB 索引未构建，请先运行索引构建 CLI")
            return []

        try:
            query_vec = get_query_embedding_cached(query)
        except Exception as e:
            print(f"[vectorSearch] Embedding API 调用失败，跳过向量检索: {e}")
            return []

        try:
            rows = (
                table.search(query_vec, vector_column_name="vector")
                .metric("cosine")
                .limit(top_k)
                .select(["id", "docId", "docTitle", "docPath", "content", "parentDocId"])
                .to_list()
            )
            results = []
            for row in rows:
                distance = row.get("_distance")
                fallback_score = row.get("score") or 0
                parent = row.get("parentDocId") or None
                results.append(
                    {
                        "chunkId": row["id"],
                        "score": 1 - distance if distance is not None else fallback_score,
                        "parentDocId": parent,
                    }
                )
            return results
        except Exception as err:
            msg = str(err)
            if "no vector index" in msg or "not indexed" in msg:
                return self._brute_force_search(table, query_vec, top_k)
            print(f"[vectorSearch] LanceDB 检索失败: {msg}")
            return []

    def _brute_force_search(self, table: Any, query_vec: list[float], top_k: int) -> list[dict]:
        print("[vectorSearch] 使用暴力搜索（无向量索引）")
        try:
            import pandas as pd  # noqa: F401

            df = table.to_pandas(columns=["id", "vector", "parentDocId"])
            results = []
            for _, row in df.iterrows():
                vec = list(row["vector"]) if row["vector"] is not None else []
                results.append(
                    {
                        "chunkId": row["id"],
                        "score": _cosine_similarity(query_vec, vec),
                        "parentDocId": row["parentDocId"] or None,
                    }
                )
            results.sort(key=lambda r: r["score"], reverse=True)
            return results[:top_k]
        except Exception as err:
            print(f"[vectorSearch] 暴力搜索失败: {err}")
            return []

    def is_ready(self) -> bool:
        try:
            table = self._get_table()
            if table is None:
                return False
            return table.count_rows() > 0
        except Exception:
            return False


def get_query_embedding_cached(query: str) -> list[float]:
    """模块级包装，便于测试 monkeypatch（与 vectorEngine.ts 的缓存语义一致）。"""
    return embedding_mod.get_query_embedding(query)


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = 0.0
    mag_a = 0.0
    mag_b = 0.0
    for i in range(min(len(a), len(b))):
        dot += a[i] * b[i]
        mag_a += a[i] * a[i]
        mag_b += b[i] * b[i]
    denom = math.sqrt(mag_a) * math.sqrt(mag_b)
    return dot / denom if denom > 0 else 0.0
