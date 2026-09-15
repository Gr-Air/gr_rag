"""检索结果缓存（移植自 src/infrastructure/cache/searchCache.ts，Spec 030）。

进程内 LRU 语义缓存，只缓存 hybridSearch 输出（pre-rerank SearchResult[]）。
两级匹配：
  精确：trim().lower()|kbVersion|policyVersion|sorted(entities)
  语义：同版本条目中 COSINE ≥ 0.92
kbVersion 来自 index_manifest.json 的 builtAt，索引重建后自动整体失效。
"""

from __future__ import annotations

import math
from collections import OrderedDict
from dataclasses import dataclass

from ...config import get_settings
from ...indexing.manifest import read_manifest
from ..types import SearchResult

SIMILARITY_THRESHOLD = 0.92
_MAX_ENTRIES = 200


@dataclass
class CacheContext:
    entities: list[str]
    policy_version: str


@dataclass
class CacheEntry:
    key: str
    query: str
    embedding: list[float]
    results: list[SearchResult]
    kb_version: str
    policy_version: str
    entities_hash: str


_cache: OrderedDict[str, CacheEntry] = OrderedDict()
_cached_kb_version: str | None = None


def _read_kb_version() -> str:
    """测试可 monkeypatch 本函数模拟索引重建。"""
    manifest = read_manifest(get_settings().data_dir)
    return manifest["builtAt"] if manifest else "unknown"


def _get_kb_version() -> str:
    global _cached_kb_version
    current = _read_kb_version()
    if _cached_kb_version is not None and _cached_kb_version != current:
        print(f"[Cache] kbVersion 变化（{_cached_kb_version} → {current}），清空缓存")
        _cache.clear()
    _cached_kb_version = current
    return current


def _exact_key(query: str, entities: list[str], kb_version: str, policy_version: str) -> str:
    entities_hash = ",".join(sorted(entities))
    return f"{query.strip().lower()}|{kb_version}|{policy_version}|{entities_hash}"


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for i in range(min(len(a), len(b))):
        dot += a[i] * b[i]
        norm_a += a[i] * a[i]
        norm_b += b[i] * b[i]
    denom = math.sqrt(norm_a) * math.sqrt(norm_b)
    return dot / denom if denom else 0.0


def lookup(
    query: str,
    embedding: list[float],
    ctx: CacheContext,
) -> list[SearchResult] | None:
    try:
        kb_version = _get_kb_version()
        key = _exact_key(query, ctx.entities, kb_version, ctx.policy_version)

        exact = _cache.get(key)
        if exact is not None:
            _cache.move_to_end(key)  # LRU 提升
            print(f'[Cache] 精确命中: "{query[:30]}..."')
            return exact.results

        best_entry: CacheEntry | None = None
        best_sim = 0.0
        for entry in _cache.values():
            if entry.kb_version != kb_version or entry.policy_version != ctx.policy_version:
                continue
            sim = _cosine_similarity(embedding, entry.embedding)
            if sim >= SIMILARITY_THRESHOLD and sim > best_sim:
                best_sim = sim
                best_entry = entry

        if best_entry is not None:
            _cache.move_to_end(best_entry.key)
            print(f'[Cache] 语义命中: "{query[:30]}..." (COSINE={best_sim:.4f})')
            return best_entry.results
        return None
    except Exception as err:
        print(f"[Cache] 查询失败，降级: {err}")
        return None


def save(
    query: str,
    embedding: list[float],
    results: list[SearchResult],
    ctx: CacheContext,
) -> None:
    try:
        kb_version = _get_kb_version()
        key = _exact_key(query, ctx.entities, kb_version, ctx.policy_version)
        entities_hash = ",".join(sorted(ctx.entities))
        _cache[key] = CacheEntry(
            key=key,
            query=query,
            embedding=list(embedding),
            results=results,
            kb_version=kb_version,
            policy_version=ctx.policy_version,
            entities_hash=entities_hash,
        )
        while len(_cache) > _MAX_ENTRIES:
            _cache.popitem(last=False)
    except Exception as err:
        print(f"[Cache] 写入失败: {err}")


def clear_cache() -> None:
    global _cached_kb_version
    _cache.clear()
    _cached_kb_version = None


def get_cache_size() -> int:
    return len(_cache)


class LruSearchCache:
    """应用层 Port 适配（P3 chat 路径注入）。"""

    @staticmethod
    def lookup(query: str, embedding: list[float], ctx: CacheContext):
        return lookup(query, embedding, ctx)

    @staticmethod
    def save(query: str, embedding: list[float], results: list[SearchResult], ctx: CacheContext):
        save(query, embedding, results, ctx)

    @staticmethod
    def clear_cache():
        clear_cache()

    @staticmethod
    def get_cache_size() -> int:
        return get_cache_size()
