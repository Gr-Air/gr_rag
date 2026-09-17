"""BM25 检索引擎（移植自 src/infrastructure/bm25/bm25Engine.ts）。

读取 P1 写出的 bm25/{meta.json,doc_lengths.json,shard_*.json}（JSON 格式与 TS 一致）。

公式（与 TS 严格对齐）：
    idf   = ln(1 + (N - df + 0.5) / (df + 0.5))
    score = idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen / avgDocLen))
    k1 = 1.5, b = 0.75
查询分词用 tokenize_filtered（去重保序）；缺 docLen 用 avgDocLen；按分降序取 topK。
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

from ....config import get_settings
from .tokenizer import tokenize_filtered

_K1 = 1.5
_B = 0.75


class BM25Engine:
    def __init__(self, bm25_dir: Path | None = None) -> None:
        settings = get_settings()
        self._dir = bm25_dir or (settings.data_dir / "bm25")
        self._meta: dict | None = None
        self._doc_lengths: dict[str, int] | None = None
        self._shards: dict[int, dict] = {}

    # ------------------------------------------------------------
    # 索引加载（懒加载 + 分片缓存）
    # ------------------------------------------------------------

    def _get_meta(self) -> dict | None:
        if self._meta is not None:
            return self._meta
        meta_path = self._dir / "meta.json"
        if not meta_path.exists():
            return None
        self._meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return self._meta

    def _get_doc_lengths(self) -> dict[str, int] | None:
        if self._doc_lengths is not None:
            return self._doc_lengths
        path = self._dir / "doc_lengths.json"
        if not path.exists():
            return None
        self._doc_lengths = json.loads(path.read_text(encoding="utf-8"))
        return self._doc_lengths

    def _load_shard(self, shard_idx: int) -> dict | None:
        if shard_idx in self._shards:
            return self._shards[shard_idx]
        path = self._dir / f"shard_{shard_idx}.json"
        if not path.exists():
            return None
        shard = json.loads(path.read_text(encoding="utf-8"))
        self._shards[shard_idx] = shard
        return shard

    # ------------------------------------------------------------
    # 检索
    # ------------------------------------------------------------

    def search(self, query: str, top_k: int = 20) -> list[dict]:
        """返回 [{chunkId, score}]。"""
        meta = self._get_meta()
        lengths = self._get_doc_lengths()
        if not meta or not lengths:
            return []

        tokens = tokenize_filtered(query)
        scores: dict[str, float] = {}

        for token in tokens:
            postings: list[dict] | None = None
            for s in range(meta["totalShards"]):
                shard = self._load_shard(s)
                if shard and token in shard:
                    postings = postings or []
                    postings.extend(shard[token])

            if not postings:
                continue

            df = len(postings)
            idf = math.log(1 + (meta["docCount"] - df + 0.5) / (df + 0.5))

            for posting in postings:
                doc_len = lengths.get(posting["chunkId"]) or meta["avgDocLen"]
                tf = posting["tf"]
                numerator = tf * (_K1 + 1)
                denominator = tf + _K1 * (1 - _B + _B * (doc_len / meta["avgDocLen"]))
                score = idf * (numerator / denominator)
                scores[posting["chunkId"]] = scores.get(posting["chunkId"], 0.0) + score

        # JS sort 稳定：同分保持首次出现（dict 插入）顺序
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
        return [{"chunkId": chunk_id, "score": score} for chunk_id, score in ranked]

    def is_ready(self) -> bool:
        return self._get_meta() is not None


# 模块级单例（Spec 033 前与 TS 模块函数等价）
@lru_cache(maxsize=1)
def get_bm25_engine() -> BM25Engine:
    return BM25Engine()
