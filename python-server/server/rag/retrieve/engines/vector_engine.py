"""向量检索引擎（移植自 src/infrastructure/vector/vectorEngine.ts）。

- LanceDB IVF_PQ 余弦索引，分数 = 1 - _distance
- query embedding 走 get_query_embedding（text_type=query，带缓存）
- 无向量索引时报错降级为全量暴力 cosine（Arrow 列 → numpy 向量化）
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
        """无向量索引时的降级路径：Arrow 列直接转 numpy，一次性算完整余弦。

        不走 to_pandas()，避免引入未在 requirements.txt 声明的 pandas 依赖。
        """
        print("[vectorSearch] 使用暴力搜索（无向量索引）")
        try:
            arrow_table = table.to_arrow()
            chunk_ids = arrow_table.column("id").to_pylist()
            if not chunk_ids:
                return []
            parent_ids = arrow_table.column("parentDocId").to_pylist()

            matrix = _vectors_to_matrix(arrow_table.column("vector"), len(chunk_ids))
            if matrix is None:
                # 向量列不是规整的定长数组：退回逐行 python 计算
                return _brute_force_search_rowwise(
                    chunk_ids,
                    arrow_table.column("vector").to_pylist(),
                    parent_ids,
                    query_vec,
                    top_k,
                )

            scores = _cosine_scores(matrix, query_vec)
            # stable：分数并列时保持表内自然顺序（与逐行排序的稳定性一致）
            order = scores.argsort(kind="stable")[::-1][:top_k]
            return [
                {
                    "chunkId": chunk_ids[i],
                    "score": float(scores[i]),
                    "parentDocId": parent_ids[i] or None,
                }
                for i in order
            ]
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


def _vectors_to_matrix(vector_column: Any, row_count: int) -> Any | None:
    """FixedSizeList 向量列 → (row_count, dim) float32 矩阵。

    结构不规整（列长不一致 / 非定长列表）时返回 None，由调用方退回逐行计算。
    """
    try:
        import numpy as np

        flattened = np.asarray(vector_column.combine_chunks().flatten(), dtype=np.float32)
    except Exception:
        return None

    if row_count <= 0 or flattened.size % row_count != 0:
        return None
    dim = flattened.size // row_count
    if dim <= 0:
        return None
    return flattened.reshape(row_count, dim)


def _cosine_scores(matrix: Any, query_vec: list[float]) -> Any:
    """批量余弦相似度；任一侧范数为 0 时该行记 0（与逐行实现语义一致）。"""
    import numpy as np

    query = np.asarray(query_vec, dtype=np.float32)
    dim = min(matrix.shape[1], query.size)
    if dim <= 0:
        return np.zeros(matrix.shape[0], dtype=np.float32)

    query = query[:dim]
    denom = np.linalg.norm(matrix[:, :dim], axis=1) * float(np.linalg.norm(query))
    dots = matrix[:, :dim] @ query
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.divide(dots, denom, out=np.zeros_like(dots), where=denom > 0)


def _brute_force_search_rowwise(
    chunk_ids: list[str],
    vectors: list[Any],
    parent_ids: list[Any],
    query_vec: list[float],
    top_k: int,
) -> list[dict]:
    results = [
        {
            "chunkId": chunk_id,
            "score": _cosine_similarity(query_vec, list(vectors[i]) if vectors[i] else []),
            "parentDocId": parent_ids[i] or None,
        }
        for i, chunk_id in enumerate(chunk_ids)
    ]
    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:top_k]


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
