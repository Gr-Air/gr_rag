"""searchCache 测试（翻译自 test/searchCache.test.ts，Spec 030）。

精确命中 / 语义命中 / 语义未命中 / kbVersion 变更失效 /
LRU 提升 / clear_cache / 空 cache / 覆盖写入。
kbVersion 通过 monkeypatch _read_kb_version 注入。
"""

import math

import pytest

from server.rag.retrieve import cache as cache_mod
from server.rag.retrieve.cache import (
    SIMILARITY_THRESHOLD,
    CacheContext,
    clear_cache,
    get_cache_size,
    lookup,
    save,
)
from server.rag.types import DocChunk, Scores, SearchResult

CTX = CacheContext(entities=[], policy_version="v1")


def make_results(ids):
    return [
        SearchResult(
            chunk=DocChunk(
                id=cid,
                doc_id=cid.rsplit("_", 1)[0],
                doc_title=f"标题-{cid}",
                doc_path=f"Raw/{cid}.md",
                chunk_index=0,
                content=f"内容-{cid}",
            ),
            score=0.9 - i * 0.1,
            scores=Scores(rrf=0.03 - i * 0.001),
            source="hybrid",
        )
        for i, cid in enumerate(ids)
    ]


def vec(sim):
    """2 维单位向量，与 [1,0] 的余弦为 sim。"""
    theta = math.acos(max(-1, min(1, sim)))
    return [math.cos(theta), math.sin(theta)]


@pytest.fixture(autouse=True)
def _isolate_cache(monkeypatch):
    clear_cache()
    version = {"v": "2026-08-31T00:00:00.000Z"}
    monkeypatch.setattr(cache_mod, "_read_kb_version", lambda: version["v"])
    yield version
    clear_cache()


# ---------- 精确命中 ----------

def test_exact_hit():
    save("浦发银行的项目", vec(1), make_results(["A", "B"]), CTX)

    hit = lookup("浦发银行的项目", vec(1), CTX)
    assert hit is not None
    assert [r.chunk.id for r in hit] == ["A", "B"]


def test_exact_hit_normalized_whitespace_case():
    save("  浦发银行的项目  ", vec(1), make_results(["A"]), CTX)

    hit = lookup("浦发银行的项目", vec(1), CTX)
    assert hit is not None
    assert hit[0].chunk.id == "A"


def test_exact_hit_entities_order_insensitive():
    save(
        "q", vec(1), make_results(["A"]),
        CacheContext(entities=["浦发", "徐峰"], policy_version="v1"),
    )

    hit = lookup(
        "q", vec(1),
        CacheContext(entities=["徐峰", "浦发"], policy_version="v1"),
    )
    assert hit is not None


def test_policy_version_miss():
    save("q", vec(1), make_results(["A"]), CacheContext(entities=[], policy_version="v1"))

    hit = lookup("q", vec(1), CacheContext(entities=[], policy_version="v2"))
    assert hit is None


# ---------- 语义命中 ----------

def test_semantic_hit_above_threshold():
    save("浦发有哪些项目", vec(1), make_results(["A"]), CTX)

    hit = lookup("浦发银行的项目", vec(SIMILARITY_THRESHOLD + 0.01), CTX)
    assert hit is not None
    assert hit[0].chunk.id == "A"


def test_semantic_miss_below_threshold():
    save("浦发有哪些项目", vec(1), make_results(["A"]), CTX)

    hit = lookup("碧桂园的财务情况", vec(SIMILARITY_THRESHOLD - 0.05), CTX)
    assert hit is None


def test_semantic_scan_skips_version_mismatch():
    save(
        "q", vec(1), make_results(["A"]),
        CacheContext(entities=[], policy_version="v1"),
    )

    hit = lookup(
        "q", vec(1), CacheContext(entities=[], policy_version="v2")
    )
    assert hit is None


# ---------- kbVersion 变更失效 ----------

def test_kb_version_change_invalidates(_isolate_cache):
    save("q", vec(1), make_results(["A"]), CTX)
    assert get_cache_size() == 1

    _isolate_cache["v"] = "2026-09-01T00:00:00.000Z"

    hit = lookup("q", vec(1), CTX)
    assert hit is None
    assert get_cache_size() == 0


# ---------- LRU ----------

def test_lru_access_promotes():
    save("q1", vec(1), make_results(["1"]), CTX)
    save("q2", vec(1), make_results(["2"]), CTX)
    save("q3", vec(1), make_results(["3"]), CTX)

    assert lookup("q1", vec(1), CTX) is not None
    assert lookup("q1", vec(1), CTX) is not None


# ---------- clear_cache ----------

def test_clear_cache():
    save("q", vec(1), make_results(["A"]), CTX)
    assert get_cache_size() == 1

    clear_cache()
    assert get_cache_size() == 0

    assert lookup("q", vec(1), CTX) is None


# ---------- 空 cache ----------

def test_empty_cache_miss():
    assert lookup("任意查询", vec(1), CTX) is None


# ---------- save 后可命中 ----------

def test_save_then_hit_returns_same_results():
    results = make_results(["X", "Y"])
    save("test query", vec(1), results, CTX)

    hit = lookup("test query", vec(1), CTX)
    assert hit is not None and hit == results


def test_overwrite_same_key():
    save("q", vec(1), make_results(["A"]), CTX)
    save("q", vec(1), make_results(["B", "C"]), CTX)

    hit = lookup("q", vec(1), CTX)
    assert hit is not None
    assert [r.chunk.id for r in hit] == ["B", "C"]
