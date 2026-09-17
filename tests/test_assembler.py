"""SearchResultAssembler 测试（翻译自 test/assembler.test.ts，Spec 031）。

chunk 附着 / 文档聚合 / 归一化 / 高亮 / source 判定。
"""

import re

from server.rag.retrieve.assembler import SearchResultAssembler
from server.rag.types import (
    DocChunk,
    QueryAnalysis,
    Ranks,
    RetrievalHit,
    Scores,
    SearchQuery,
)

_TRAILING = re.compile(r"_\d+$")


def make_chunk(chunk_id: str, content: str, doc_id: str | None = None) -> DocChunk:
    resolved_doc = doc_id if doc_id is not None else _TRAILING.sub("", chunk_id)
    return DocChunk(
        id=chunk_id,
        doc_id=resolved_doc,
        doc_title=f"标题-{resolved_doc}",
        doc_path=f"Raw/{resolved_doc}.md",
        chunk_index=0,
        content=content,
    )


def make_hit(chunk_id: str, rrf: float, ranks: Ranks | None = None) -> RetrievalHit:
    return RetrievalHit(
        chunk_id=chunk_id,
        scores=Scores(rrf=rrf),
        ranks=ranks or Ranks(),
        source="rrf",
    )


class FakeChunkStore:
    """按 content_map 构建 get_by_ids；get_all 恒空。"""

    def __init__(self, content_map: dict[str, str]) -> None:
        self._content_map = content_map

    def get_by_ids(self, ids: list[str]) -> list[DocChunk]:
        result = []
        for chunk_id in ids:
            if chunk_id in self._content_map:
                result.append(make_chunk(chunk_id, self._content_map[chunk_id]))
        return result

    def get_all(self) -> dict:
        return {}


def q(query: str) -> SearchQuery:
    return SearchQuery(query=query)


def a(matched_keywords: list[str] | None = None) -> QueryAnalysis:
    return QueryAnalysis(matched_keywords=matched_keywords)


# ---------- chunk 附着 ----------

def test_only_existing_chunks_appear():
    assembler = SearchResultAssembler(
        FakeChunkStore({"A": "内容A", "B": "内容B"})
    )
    hits = [make_hit("A", 0.03), make_hit("B", 0.02), make_hit("X", 0.01)]

    results = assembler.assemble(hits, q("q"), a(), 10)

    assert [r.chunk.id for r in results] == ["A", "B"]


# ---------- 文档聚合 ----------

def test_broad_query_max_5_chunks_per_doc():
    store = FakeChunkStore(
        {
            "A_0": "标题A\n内容0", "A_1": "标题A\n内容1", "A_2": "标题A\n内容2",
            "A_3": "标题A\n内容3", "A_4": "标题A\n内容4", "A_5": "标题A\n内容5",
            "B_0": "标题B\n内容0",
        }
    )
    assembler = SearchResultAssembler(store)
    hits = [
        make_hit("A_0", 0.03), make_hit("A_1", 0.029), make_hit("A_2", 0.028),
        make_hit("A_3", 0.027), make_hit("A_4", 0.026), make_hit("A_5", 0.025),
        make_hit("B_0", 0.024),
    ]

    results = assembler.assemble(hits, q("宽泛查询"), a(), 10)

    doc_a = [r for r in results if r.chunk.doc_id == "A"]
    assert len(doc_a) <= 5
    assert any(r.chunk.id == "B_0" for r in results)


def test_entity_query_one_chunk_per_doc():
    store = FakeChunkStore({"A_0": "内容0", "A_1": "内容1", "A_2": "内容2"})
    assembler = SearchResultAssembler(store)
    hits = [make_hit("A_0", 0.03), make_hit("A_1", 0.029), make_hit("A_2", 0.028)]

    results = assembler.assemble(hits, q("实体查询"), a(["徐峰"]), 10)

    assert len(results) == 1
    assert results[0].chunk.id == "A_0"


def test_same_title_chunks_skipped():
    store = FakeChunkStore(
        {
            "A_0": "相同标题\n内容0", "A_1": "相同标题\n内容1",
            "B_0": "不同标题\n内容0",
        }
    )
    assembler = SearchResultAssembler(store)
    hits = [make_hit("A_0", 0.03), make_hit("A_1", 0.029), make_hit("B_0", 0.028)]

    results = assembler.assemble(hits, q("宽泛查询"), a(), 10)

    doc_a = [r for r in results if r.chunk.doc_id == "A"]
    assert len(doc_a) == 1


# ---------- 归一化 ----------

def test_normalize_range():
    store = FakeChunkStore({"A": "内容A", "B": "内容B", "C": "内容C"})
    assembler = SearchResultAssembler(store)
    hits = [make_hit("A", 0.03), make_hit("B", 0.02), make_hit("C", 0.01)]

    results = assembler.assemble(hits, q("q"), a(), 10)

    assert results[0].score == 0.95
    assert results[-1].score == 0.05
    for r in results:
        assert 0.05 <= r.score <= 0.95


def test_equal_scores_midpoint():
    assembler = SearchResultAssembler(FakeChunkStore({"A": "内容A"}))
    results = assembler.assemble([make_hit("A", 0.03)], q("q"), a(), 10)
    assert results[0].score == 0.5


# ---------- source 判定 ----------

def test_source_vector_only():
    assembler = SearchResultAssembler(FakeChunkStore({"A": "内容A"}))
    hits = [
        RetrievalHit(
            chunk_id="A",
            scores=Scores(rrf=0.03, vector=0.9),
            ranks=Ranks(vector=1),
            source="rrf",
        )
    ]
    results = assembler.assemble(hits, q("q"), a(), 10)
    assert results[0].source == "vector"


def test_source_bm25_only():
    assembler = SearchResultAssembler(FakeChunkStore({"A": "内容A"}))
    hits = [
        RetrievalHit(
            chunk_id="A",
            scores=Scores(rrf=0.03, bm25=10),
            ranks=Ranks(bm25=1),
            source="rrf",
        )
    ]
    results = assembler.assemble(hits, q("q"), a(), 10)
    assert results[0].source == "bm25"


def test_source_hybrid():
    assembler = SearchResultAssembler(FakeChunkStore({"A": "内容A"}))
    hits = [
        RetrievalHit(
            chunk_id="A",
            scores=Scores(rrf=0.03, vector=0.9, bm25=10),
            ranks=Ranks(vector=1, bm25=1),
            source="rrf",
        )
    ]
    results = assembler.assemble(hits, q("q"), a(), 10)
    assert results[0].source == "hybrid"


# ---------- 高亮 ----------

def test_highlight_present():
    assembler = SearchResultAssembler(FakeChunkStore({"A": "这是徐峰的文档内容"}))
    results = assembler.assemble([make_hit("A", 0.03)], q("徐峰"), a(), 10)
    assert results[0].highlight is not None
    assert "徐峰" in results[0].highlight


# ---------- 空输入 ----------

def test_empty_hits():
    assembler = SearchResultAssembler(FakeChunkStore({}))
    assert assembler.assemble([], q("q"), a(), 10) == []
