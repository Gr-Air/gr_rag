"""hybridSearch 测试（翻译自 test/hybridSearch.test.ts）。

Part 1: rrf_fusion 纯函数
Part 2: hybrid_search 集成（真实管线 + 真实 Assembler + mock 检索引擎，分数链路）
Part 3: 宽泛查询识别与 topK 调整
"""

import re

import pytest

from server.rag.retrieve.entity_strategy import (
    BROAD_QUERY_TOPK,
    adjust_topk_for_broad_query,
    is_broad_query,
)
from server.rag.retrieve.fusion import RRFFusion, rrf_fusion
from server.rag.retrieve.hybrid_search import HybridSearchDeps, HybridSearchOptions, create_hybrid_search
from server.rag.retrieve.retrievers import BM25Retriever, VectorRetriever
from server.rag.types import DocChunk, RetrievalHit, Scores

_TRAILING = re.compile(r"_\d+$")


def make_chunk(chunk_id: str, content: str) -> DocChunk:
    doc_id = _TRAILING.sub("", chunk_id)
    return DocChunk(
        id=chunk_id,
        doc_id=doc_id,
        doc_title=f"标题-{chunk_id}",
        doc_path=f"Raw/{doc_id}.md",
        chunk_index=0,
        content=content,
    )


def vhit(chunk_id: str, score: float) -> RetrievalHit:
    return RetrievalHit(chunk_id=chunk_id, scores=Scores(vector=score), source="vector")


def bhit(chunk_id: str, score: float) -> RetrievalHit:
    return RetrievalHit(chunk_id=chunk_id, scores=Scores(bm25=score), source="bm25")


# ============================================================
# Part 1: rrfFusion
# ============================================================

def test_rrf_two_independent_lists():
    result = rrf_fusion(
        [vhit("A", 0.95), vhit("B", 0.80)],
        [bhit("C", 10), bhit("D", 8)],
        10,
    )

    assert len(result) == 4
    assert result[0].scores.rrf == pytest.approx(1 / 61, abs=1e-9)
    assert result[-1].scores.rrf == pytest.approx(1 / 62, abs=1e-9)


def test_rrf_same_chunk_accumulates():
    result = rrf_fusion(
        [vhit("A", 0.95), vhit("B", 0.80)],
        [bhit("A", 10), bhit("C", 8)],
        10,
    )

    a = next(h for h in result if h.chunk_id == "A")
    assert a.ranks.vector == 1
    assert a.ranks.bm25 == 1
    assert a.scores.rrf == pytest.approx(2 / 61, abs=1e-9)


def test_rrf_bm25_only_vector_rank_absent():
    result = rrf_fusion([], [bhit("X", 10)], 10)

    assert len(result) == 1
    assert result[0].chunk_id == "X"
    assert result[0].ranks.vector is None
    assert result[0].ranks.bm25 == 1


def test_rrf_vector_only_bm25_rank_absent():
    result = rrf_fusion([vhit("Y", 0.95)], [], 10)

    assert len(result) == 1
    assert result[0].chunk_id == "Y"
    assert result[0].ranks.vector == 1
    assert result[0].ranks.bm25 is None


def test_rrf_topk_truncation():
    result = rrf_fusion(
        [vhit("A", 0.9), vhit("B", 0.8)],
        [bhit("C", 9), bhit("D", 8), bhit("E", 7)],
        3,
    )
    assert len(result) == 3


def test_rrf_fewer_than_topk():
    result = rrf_fusion([vhit("A", 0.9)], [], 10)
    assert len(result) == 1


def test_rrf_filtered_chunk_no_vector_rank():
    result = rrf_fusion(
        [vhit("A", 0.95), vhit("B", 0.80), vhit("C", 0.70)],
        [bhit("A", 10)],
        10,
        {"B"},
    )

    b = next(h for h in result if h.chunk_id == "B")
    assert b.ranks.vector is None
    assert b.ranks.bm25 is None
    assert b.scores.vector == 0.80

    a = next(h for h in result if h.chunk_id == "A")
    assert a.ranks.vector == 1
    assert a.scores.rrf == pytest.approx(2 / 61, abs=1e-9)


def test_rrf_multiple_filtered_chunks_ranks_skip():
    result = rrf_fusion(
        [
            vhit("A", 0.9), vhit("B", 0.8), vhit("C", 0.7),
            vhit("D", 0.6), vhit("E", 0.5),
        ],
        [],
        10,
        {"B", "D"},
    )

    by_id = {h.chunk_id: h for h in result}
    assert by_id["A"].scores.rrf == pytest.approx(1 / 61, abs=1e-9)
    assert by_id["C"].scores.rrf == pytest.approx(1 / 62, abs=1e-9)
    assert by_id["E"].scores.rrf == pytest.approx(1 / 63, abs=1e-9)
    assert by_id["B"].ranks.vector is None
    assert by_id["D"].ranks.vector is None


def test_rrf_filtered_chunk_keeps_bm25_rank():
    result = rrf_fusion(
        [vhit("A", 0.9)],
        [bhit("A", 10), bhit("B", 8)],
        10,
        {"A"},
    )

    a = next(h for h in result if h.chunk_id == "A")
    assert a.ranks.vector is None
    assert a.ranks.bm25 == 1
    assert a.scores.rrf == pytest.approx(1 / 61, abs=1e-9)


def test_rrf_scores_decrease_with_rank():
    result = rrf_fusion(
        [vhit("R1", 0.9), vhit("R2", 0.8), vhit("R3", 0.7)],
        [],
        10,
    )
    for i in range(len(result) - 1):
        assert result[i].scores.rrf > result[i + 1].scores.rrf


def test_rrf_empty_inputs():
    assert rrf_fusion([], [], 10) == []


def test_rrf_only_rank_matters_not_raw_score():
    r1 = rrf_fusion([vhit("A", 0.999)], [], 10)
    r2 = rrf_fusion([vhit("A", 0.001)], [], 10)
    assert r1[0].scores.rrf == r2[0].scores.rrf


def test_rrf_ranks_start_from_one():
    result = rrf_fusion([vhit("V1", 0.9)], [bhit("B1", 10)], 10)
    by_id = {h.chunk_id: h for h in result}
    assert by_id["V1"].ranks.vector == 1
    assert by_id["B1"].ranks.bm25 == 1


# ============================================================
# Part 2: hybrid_search 分数链路
# ============================================================

class FakeEngine:
    def __init__(self, rows):
        self._rows = rows

    def search(self, query, top_k):
        return list(self._rows)


class MapChunkStore:
    """get_by_ids 按 content_fn 造 chunk。"""

    def __init__(self, content_fn):
        self._content_fn = content_fn

    def get_by_ids(self, ids):
        return [make_chunk(i, self._content_fn(i)) for i in ids]

    def get_all(self):
        return {}


def build_hybrid(vector_rows, bm25_rows, content_fn=None):
    content_fn = content_fn or (lambda cid: f"{cid} 的内容")
    chunk_store = MapChunkStore(content_fn)
    return create_hybrid_search(
        HybridSearchDeps(
            chunk_store=chunk_store,
            retrievers=[
                VectorRetriever(FakeEngine(vector_rows)),
                BM25Retriever(FakeEngine(bm25_rows)),
            ],
            fusion=RRFFusion(chunk_store),
        )
    )


def test_hybrid_full_score_chain():
    hybrid_search = build_hybrid(
        [{"chunkId": "docA_0", "score": 0.95}, {"chunkId": "docB_0", "score": 0.80}],
        [{"chunkId": "docA_0", "score": 10}, {"chunkId": "docC_0", "score": 8}],
    )

    results = hybrid_search("测试查询", 5, 20, 20)

    for r in results:
        assert isinstance(r.score, float)

    doc_a = next(r for r in results if r.chunk.id == "docA_0")
    assert doc_a.scores.vector == 0.95
    assert doc_a.scores.bm25 == 10
    assert doc_a.scores.rrf == pytest.approx(2 / 61, abs=1e-9)

    doc_c = next(r for r in results if r.chunk.id == "docC_0")
    assert doc_c.scores.vector is None
    assert doc_c.scores.bm25 == 8
    assert doc_c.scores.rrf == pytest.approx(1 / 62, abs=1e-9)

    assert results[0].chunk.id == "docA_0"


def test_hybrid_entity_query_no_score_boost():
    hybrid_search = build_hybrid(
        [{"chunkId": "docA_0", "score": 0.95}, {"chunkId": "docB_0", "score": 0.80}],
        [],
        content_fn=lambda cid: "徐峰负责的项目文档内容" if cid == "docA_0" else "其他无关内容",
    )

    results = hybrid_search(
        "徐峰负责哪些项目", 5, 20, 20,
        HybridSearchOptions(matched_keywords=["徐峰"]),
    )

    doc_a = next(r for r in results if r.chunk.id == "docA_0")
    doc_b = next(r for r in results if r.chunk.id == "docB_0")

    # 已移除实体匹配度加成：docA 内容含"徐峰"，rrf 仅为向量路贡献 1/61，无 +0.2 bonus
    assert doc_a.scores.rrf == pytest.approx(1 / 61, abs=1e-9)
    # docB 不含关键词 → 向量排名被过滤且无 BM25 → 无 RRF，vector 原始分保留
    assert doc_b.scores.rrf is None
    assert doc_b.scores.vector == 0.80


def test_hybrid_entity_filter_preserves_vector_raw():
    hybrid_search = build_hybrid(
        [{"chunkId": "docA_0", "score": 0.95}, {"chunkId": "docB_0", "score": 0.80}],
        [{"chunkId": "docB_0", "score": 9}],
        content_fn=lambda cid: "无关内容" if cid == "docB_0" else "徐峰相关内容",
    )

    results = hybrid_search(
        "徐峰的文档", 5, 20, 20,
        HybridSearchOptions(matched_keywords=["徐峰"]),
    )

    doc_b = next(r for r in results if r.chunk.id == "docB_0")
    assert doc_b.scores.vector == 0.80
    assert doc_b.scores.rrf == pytest.approx(1 / 61, abs=1e-9)


# ============================================================
# Part 3: queryPolicy
# ============================================================

def test_is_broad_query_hits():
    assert is_broad_query("相关的项目文档有哪些") is True
    assert is_broad_query("有哪些项目") is True
    assert is_broad_query("哪些文档涉及数据中台") is True
    assert is_broad_query("知识库有多少文档") is True


def test_is_broad_query_specific_query():
    assert is_broad_query("项目经理是谁") is False
    assert is_broad_query("徐峰负责的工作") is False
    assert is_broad_query("预算金额是多少") is False


def test_adjust_topk_broad_shrinks():
    assert adjust_topk_for_broad_query("相关的项目文档有哪些", 10) == BROAD_QUERY_TOPK
    assert adjust_topk_for_broad_query("有哪些项目", 5) == BROAD_QUERY_TOPK


def test_adjust_topk_broad_already_small():
    assert adjust_topk_for_broad_query("相关的项目文档有哪些", 3) == 3
    assert adjust_topk_for_broad_query("相关的项目文档有哪些", 2) == 2


def test_adjust_topk_specific_unchanged():
    assert adjust_topk_for_broad_query("项目经理是谁", 10) == 10
    assert adjust_topk_for_broad_query("徐峰的文档", 5) == 5
