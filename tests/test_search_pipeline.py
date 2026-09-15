"""检索管线测试（翻译自 test/search-pipeline.test.ts Part 1 + Part 3）。

Part 1: 固定编排（顺序 / 单路失败降级 / keywords 透传 / filteredChunkIds / 空结果提前返回）
Part 3: StructRetriever hit 组装（去重 / 截断 / 无 keywords / 异常吞掉）
reranker 部分见 test_reranker.py。
"""

from server.rag.retrieve.pipeline import (
    PipelineComponents,
    PipelineParams,
    run_search_pipeline,
)
from server.rag.retrieve.retrievers import StructRetriever
from server.rag.types import (
    QueryAnalysis,
    RetrievalFilter,
    RetrievalHit,
    RetrievalOptions,
    RetrievalRequest,
    Scores,
    SearchQuery,
)

BASE_PARAMS = PipelineParams(top_k=5, vector_top_n=20, bm25_top_n=20)


def vhit(chunk_id: str, score: float) -> RetrievalHit:
    return RetrievalHit(chunk_id=chunk_id, scores=Scores(vector=score), source="vector")


def bhit(chunk_id: str, score: float) -> RetrievalHit:
    return RetrievalHit(chunk_id=chunk_id, scores=Scores(bm25=score), source="bm25")


class FakeRetriever:
    """返回固定 hits 或抛错；记录每次收到的 options。"""

    def __init__(self, name, hits_or_error, seen=None):
        self.name = name
        self._hits_or_error = hits_or_error
        self.seen = seen if seen is not None else []
        self.call_count = 0

    def search(self, query, options):
        self.call_count += 1
        self.seen.append(options)
        if isinstance(self._hits_or_error, Exception):
            raise self._hits_or_error
        return self._hits_or_error


class RecordingFusion:
    """记录调用参数，拍平 hitLists 原样返回（pipeline 不组装）。"""

    name = "mock-rrf"

    def __init__(self):
        self.calls = []

    def fuse(self, hit_lists, analysis, top_k):
        self.calls.append({"hit_lists": hit_lists, "analysis": analysis, "top_k": top_k})
        return [hit for lst in hit_lists for hit in lst]


def _request(query="测试查询", matched=None, filtered=None):
    return RetrievalRequest(
        query=SearchQuery(query=query),
        analysis=QueryAnalysis(matched_keywords=matched),
        filter=RetrievalFilter(filtered_chunk_ids=filtered) if filtered else None,
    )


# ============================================================
# Part 1: 固定编排
# ============================================================

def test_pipeline_order_and_doubled_topn():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [vhit("v1", 0.9)])
    bm25 = FakeRetriever("bm25", [bhit("b1", 10)])

    hits = run_search_pipeline(
        _request(),
        BASE_PARAMS,
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    # 非实体查询各路 topN ×2
    assert vector.seen[0].top_n == 40
    assert bm25.seen[0].top_n == 40
    # fusion 收到 [vectorHits, bm25Hits] + analysis + topK*3
    assert len(fusion.calls) == 1
    assert [[h.chunk_id for h in lst] for lst in fusion.calls[0]["hit_lists"]] == [
        ["v1"], ["b1"]
    ]
    assert fusion.calls[0]["analysis"].matched_keywords is None
    assert fusion.calls[0]["top_k"] == 15
    assert [h.chunk_id for h in hits] == ["v1", "b1"]


def test_pipeline_single_path_failure_fallback():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", RuntimeError("向量引擎挂了"))
    bm25 = FakeRetriever("bm25", [bhit("b1", 10)])

    hits = run_search_pipeline(
        _request(),
        BASE_PARAMS,
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    assert vector.call_count == 1
    assert fusion.calls[0]["hit_lists"][0] == []
    assert len(fusion.calls[0]["hit_lists"][1]) == 1
    assert [h.chunk_id for h in hits] == ["b1"]


def test_pipeline_keywords_passthrough_entity_no_doubling():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [vhit("v1", 0.9)])
    bm25 = FakeRetriever("bm25", [])

    run_search_pipeline(
        _request(query="徐峰的文档", matched=["徐峰"]),
        BASE_PARAMS,
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    assert vector.seen[0].top_n == 20
    assert vector.seen[0].keywords == ["徐峰"]
    assert bm25.seen[0].top_n == 20
    assert bm25.seen[0].keywords == ["徐峰"]
    assert fusion.calls[0]["analysis"].matched_keywords == ["徐峰"]
    # 实体查询 fusionTopK = topK
    assert fusion.calls[0]["top_k"] == 5


def test_pipeline_filtered_chunk_ids():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [vhit("v1", 0.9), vhit("v2", 0.8)])
    bm25 = FakeRetriever("bm25", [bhit("v2", 10)])

    hits = run_search_pipeline(
        _request(filtered=["v2"]),
        BASE_PARAMS,
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    assert [[h.chunk_id for h in lst] for lst in fusion.calls[0]["hit_lists"]] == [
        ["v2"], ["v2"]
    ]
    # mock fusion flat 后 v2 出现两次（真实 RRF 合并同 chunkId，去重在 assembler）
    assert [h.chunk_id for h in hits] == ["v2", "v2"]


def test_pipeline_empty_early_return():
    fusion = RecordingFusion()
    vector = FakeRetriever("vector", [])
    bm25 = FakeRetriever("bm25", [])

    hits = run_search_pipeline(
        _request(),
        BASE_PARAMS,
        PipelineComponents(retrievers=[vector, bm25], fusion=fusion),
    )

    assert hits == []
    assert fusion.calls == []


# ============================================================
# Part 3: StructRetriever hit 组装
# ============================================================

class FakeStructEngine:
    """记录 query 入参，返回固定结构或抛错。"""

    def __init__(self, results=None, error=None):
        self._results = results if results is not None else []
        self._error = error
        self.calls = []

    def query(self, names, mode="or"):
        self.calls.append(list(names))
        if self._error:
            raise self._error
        return self._results


def _struct_result(entry_id, name, frequency, chunk_ids):
    return {
        "entry": {
            "id": entry_id,
            "name": name,
            "type": "entity",
            "category": "person",
            "frequency": frequency,
            "path": "Raw/x.md",
        },
        "chunks": [
            {"entry_id": entry_id, "chunk_id": cid, "context": ""} for cid in chunk_ids
        ],
    }


def test_struct_retriever_assembles_hits():
    engine = FakeStructEngine(
        [_struct_result(1, "徐峰", 37, ["c1", "c2"])]
    )
    retriever = StructRetriever(engine)

    hits = retriever.search(
        SearchQuery(query="徐峰"),
        RetrievalOptions(top_n=10, keywords=["徐峰"]),
    )

    assert engine.calls == [["徐峰"]]
    assert [h.chunk_id for h in hits] == ["c1", "c2"]
    assert all(h.scores.struct == 37 for h in hits)
    assert all(h.source == "entity" for h in hits)


def test_struct_retriever_dedup_and_topn():
    engine = FakeStructEngine(
        [
            _struct_result(1, "徐峰", 37, ["c1"]),
            _struct_result(2, "浦发银行", 20, ["c1", "c3"]),
        ]
    )
    retriever = StructRetriever(engine)

    hits = retriever.search(
        SearchQuery(query="徐峰 浦发银行"),
        RetrievalOptions(top_n=1, keywords=["徐峰", "浦发银行"]),
    )

    assert [(h.chunk_id, h.scores.struct) for h in hits] == [("c1", 37)]


def test_struct_retriever_no_keywords_skips_query():
    engine = FakeStructEngine()
    retriever = StructRetriever(engine)

    hits = retriever.search(
        SearchQuery(query="宽泛查询"),
        RetrievalOptions(top_n=10),
    )
    assert hits == []
    assert engine.calls == []


def test_struct_retriever_error_returns_empty():
    engine = FakeStructEngine(error=RuntimeError("db 挂了"))
    retriever = StructRetriever(engine)

    hits = retriever.search(
        SearchQuery(query="q"),
        RetrievalOptions(top_n=10, keywords=["徐峰"]),
    )
    assert hits == []
