"""检索 Profile 测试（翻译自 test/search-profile.test.ts，Spec 037 Part A）。

- resolve_profile 解析/回落
- pipeline：useStruct 第三路开关、useEntityFilter 实体干预开关、topN 覆盖
- fuse_rankings：N 路（含 struct）RRF 融合
生产路径（无 profile）行为必须与 Spec 037 前一致。
"""

import dataclasses
import re

import pytest

from server.rag.retrieve.fusion import RRFFusion, RankingInput, fuse_rankings
from server.rag.retrieve.hybrid_search import HybridSearchDeps, HybridSearchOptions, create_hybrid_search
from server.rag.retrieve.pipeline import (
    PipelineComponents,
    PipelineParams,
    run_search_pipeline,
)
from server.rag.retrieve.profile import SEARCH_PROFILES, resolve_profile
from server.rag.types import (
    DocChunk,
    QueryAnalysis,
    RetrievalHit,
    RetrievalRequest,
    Scores,
    SearchQuery,
)

_TRAILING = re.compile(r"_\d+$")


def make_chunk(chunk_id: str) -> DocChunk:
    doc_id = _TRAILING.sub("", chunk_id)
    return DocChunk(
        id=chunk_id,
        doc_id=doc_id,
        doc_title=f"标题-{chunk_id}",
        doc_path=f"Raw/{doc_id}.md",
        chunk_index=0,
        content=f"内容-{chunk_id}",
    )


def hit(chunk_id: str, key: str, score: float) -> RetrievalHit:
    if key == "struct":
        return RetrievalHit(chunk_id=chunk_id, scores=Scores(struct=score), source="entity")
    if key == "bm25":
        return RetrievalHit(chunk_id=chunk_id, scores=Scores(bm25=score), source="bm25")
    return RetrievalHit(chunk_id=chunk_id, scores=Scores(vector=score), source="vector")


class FakeRetriever:
    def __init__(self, name, hits, seen=None):
        self.name = name
        self._hits = hits
        self.seen = seen if seen is not None else []
        self.call_count = 0

    def search(self, query, options):
        self.call_count += 1
        self.seen.append(options)
        return self._hits


class RecordingFusion:
    name = "mock-rrf"

    def __init__(self):
        self.calls = []

    def fuse(self, hit_lists, analysis, top_k=10):
        self.calls.append({"hit_lists": hit_lists, "analysis": analysis})
        return [h for lst in hit_lists for h in lst]


class EchoChunkStore:
    def get_by_ids(self, ids):
        return [make_chunk(i) for i in ids]

    def get_all(self):
        return {}


REQUEST = RetrievalRequest(query=SearchQuery(query="普通测试查询"))
ENTITY_REQUEST = RetrievalRequest(
    query=SearchQuery(query="徐峰负责什么项目"),
    analysis=QueryAnalysis(matched_keywords=["徐峰"]),
)


# ============================================================
# resolveProfile
# ============================================================

def test_resolve_profile_undefined_baseline():
    assert resolve_profile(None).id == "baseline"


def test_resolve_profile_known_ids():
    assert resolve_profile("struct").use_struct is True
    assert resolve_profile("no_entity_filter").use_entity_filter is False


def test_resolve_profile_unknown_fallback(capsys):
    assert resolve_profile("not-exist").id == "baseline"
    # 未知 id 打印告警（对齐 TS console.warn）
    captured = capsys.readouterr()
    assert "warn" in captured.out.lower() or "未知" in captured.out


def test_baseline_matches_legacy_defaults():
    p = SEARCH_PROFILES["baseline"]
    assert (p.use_struct, p.use_entity_filter, p.use_hyde) == (False, True, False)
    assert (p.vector_top_n, p.bm25_top_n, p.rerank_top_k) == (20, 20, 5)


# ============================================================
# pipeline useStruct 开关
# ============================================================

def test_pipeline_no_profile_struct_not_called():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [hit("v1", "vector", 0.9)])
    bm25 = FakeRetriever("bm25", [hit("b1", "bm25", 10)])
    struct = FakeRetriever("struct", [hit("s1", "struct", 3)])

    run_search_pipeline(
        REQUEST,
        PipelineParams(top_k=5, vector_top_n=20, bm25_top_n=20),
        PipelineComponents(
            retrievers=[vector, bm25], struct_retriever=struct, fusion=fusion
        ),
    )

    assert struct.call_count == 0
    assert len(fusion.calls[0]["hit_lists"]) == 2


def test_pipeline_struct_profile_three_paths():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [hit("v1", "vector", 0.9)])
    bm25 = FakeRetriever("bm25", [hit("b1", "bm25", 10)])
    struct = FakeRetriever("struct", [hit("s1", "struct", 3)])

    run_search_pipeline(
        REQUEST,
        PipelineParams(top_k=5, vector_top_n=20, bm25_top_n=20,
                       profile=SEARCH_PROFILES["struct"]),
        PipelineComponents(
            retrievers=[vector, bm25], struct_retriever=struct, fusion=fusion
        ),
    )

    assert struct.call_count == 1
    assert len(fusion.calls[0]["hit_lists"]) == 3
    third = fusion.calls[0]["hit_lists"][2]
    assert len(third) == 1
    assert third[0].chunk_id == "s1"


def test_pipeline_struct_profile_without_retriever_degrades():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [hit("v1", "vector", 0.9)])
    bm25 = FakeRetriever("bm25", [hit("b1", "bm25", 10)])

    hits = run_search_pipeline(
        REQUEST,
        PipelineParams(top_k=5, vector_top_n=20, bm25_top_n=20,
                       profile=SEARCH_PROFILES["struct"]),
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    assert len(fusion.calls[0]["hit_lists"]) == 2
    assert len(hits) > 0


# ============================================================
# pipeline useEntityFilter 开关
# ============================================================

def test_baseline_entity_keywords_passthrough_to_fusion():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [hit("v1", "vector", 0.9)])
    bm25 = FakeRetriever("bm25", [hit("b1", "bm25", 10)])

    run_search_pipeline(
        ENTITY_REQUEST,
        PipelineParams(top_k=5, vector_top_n=20, bm25_top_n=20),
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    assert fusion.calls[0]["analysis"].matched_keywords == ["徐峰"]


def test_no_entity_filter_fusion_gets_none():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [hit("v1", "vector", 0.9)])
    bm25 = FakeRetriever("bm25", [hit("b1", "bm25", 10)])

    run_search_pipeline(
        ENTITY_REQUEST,
        PipelineParams(top_k=5, vector_top_n=20, bm25_top_n=20,
                       profile=SEARCH_PROFILES["no_entity_filter"]),
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    assert fusion.calls[0]["analysis"].matched_keywords is None


def test_struct_keywords_unaffected_by_entity_filter():
    struct_options = []
    vector = FakeRetriever("vector", [hit("v1", "vector", 0.9)])
    bm25 = FakeRetriever("bm25", [hit("b1", "bm25", 10)])
    struct = FakeRetriever("struct", [hit("s1", "struct", 3)], struct_options)

    run_search_pipeline(
        ENTITY_REQUEST,
        PipelineParams(top_k=5, vector_top_n=20, bm25_top_n=20,
                       profile=SEARCH_PROFILES["struct"]),
        PipelineComponents(
            retrievers=[vector, bm25], struct_retriever=struct,
            fusion=RecordingFusion(),
        ),
    )

    # struct profile 的 use_entity_filter=true，keywords 必传
    assert struct_options[0].keywords == ["徐峰"]


# ============================================================
# profile topN（经 hybridSearch 覆盖位置参数）
# ============================================================

def test_profile_topn_overrides_positional_args():
    vector_options = []
    bm25_options = []
    vector = FakeRetriever("vector", [hit("v1", "vector", 0.9)], vector_options)
    bm25 = FakeRetriever("bm25", [hit("b1", "bm25", 10)], bm25_options)
    chunk_store = EchoChunkStore()

    hybrid_search = create_hybrid_search(
        HybridSearchDeps(
            chunk_store=chunk_store,
            retrievers=[vector, bm25],
            fusion=RRFFusion(chunk_store),
        )
    )

    custom = dataclasses.replace(
        SEARCH_PROFILES["baseline"], id="custom", vector_top_n=7, bm25_top_n=9
    )
    # 位置参数 20/20 被 profile 覆盖为 7/9；实体查询不翻倍
    hybrid_search(
        "徐峰负责什么项目", 5, 20, 20,
        HybridSearchOptions(matched_keywords=["徐峰"], profile=custom),
    )

    assert vector_options[0].top_n == 7
    assert bm25_options[0].top_n == 9


# ============================================================
# fuseRankings N 路融合
# ============================================================

def test_fuse_rankings_struct_only_chunk():
    result = fuse_rankings(
        [
            RankingInput("vector", [hit("A", "vector", 0.9), hit("B", "vector", 0.8)]),
            RankingInput("bm25", [hit("C", "bm25", 10)]),
            RankingInput("struct", [hit("S", "struct", 3)]),
        ],
        10,
    )

    by_id = {h.chunk_id: h for h in result}
    assert set(by_id) == {"A", "B", "C", "S"}
    assert by_id["S"].ranks.struct == 1
    assert by_id["S"].scores.struct == 3
    assert by_id["S"].scores.rrf == pytest.approx(1 / 61, abs=1e-9)


def test_fuse_rankings_three_path_accumulation():
    result = fuse_rankings(
        [
            RankingInput("vector", [hit("A", "vector", 0.9)]),
            RankingInput("bm25", [hit("A", "bm25", 10)]),
            RankingInput("struct", [hit("A", "struct", 3)]),
        ],
        10,
    )

    assert len(result) == 1
    assert result[0].scores.rrf == pytest.approx(3 / 61, abs=1e-9)
    assert result[0].ranks.vector == 1
    assert result[0].ranks.bm25 == 1
    assert result[0].ranks.struct == 1


def test_fuse_rankings_skip_filter_keeps_raw_score():
    result = fuse_rankings(
        [
            RankingInput("vector", [hit("A", "vector", 0.9)], {"A"}),
            RankingInput("struct", [hit("A", "struct", 3)]),
        ],
        10,
    )

    assert result[0].scores.vector == 0.9
    assert result[0].ranks.vector is None
    assert result[0].scores.rrf == pytest.approx(1 / 61, abs=1e-9)


def test_rrf_fusion_class_three_lists():
    fusion = RRFFusion()
    fused = fusion.fuse(
        [
            [hit("A", "vector", 0.9)],
            [hit("B", "bm25", 10)],
            [hit("S", "struct", 3)],
        ],
        QueryAnalysis(),
        10,
    )

    by_id = {h.chunk_id: h for h in fused}
    assert set(by_id) == {"A", "B", "S"}
    assert by_id["S"].ranks.struct == 1
