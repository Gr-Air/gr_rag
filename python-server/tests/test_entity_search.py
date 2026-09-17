"""EntitySearch 路由测试（chat 与 /api/search 共用的实体路）。

覆盖：AND 优先 → OR → wikiLinks 倒排索引兜底；**只返回实体命中的 chunk**
（不用语义检索结果回填）；`force_method` 的语义（entity 如实返回空 / rrf 跳过实体路）。
"""

from __future__ import annotations

from server.rag.retrieve.entity_search import EntitySearchDeps, create_entity_search
from server.rag.types import DocChunk


class FakeStructQuery:
    """`by_mode` 按 and/or 分别返回；否则返回 `results`。"""

    def __init__(self, ready=True, results=None, by_mode=None):
        self._ready = ready
        self._results = results if results is not None else []
        self._by_mode = by_mode or {}
        self.calls: list[tuple] = []

    def is_ready(self):
        return self._ready

    def query(self, names, mode):
        self.calls.append((list(names), mode))
        if mode in self._by_mode:
            return self._by_mode[mode]
        return self._results


class FakeEntityRepo:
    def is_ready(self):
        return True

    def get_known_entities(self):
        return [
            {"name": "华润置地", "type": "entity"},
            {"name": "CRM", "type": "entity"},
        ]


class FakeChunkStore:
    def __init__(self, items=None):
        self._items = items or {}

    def get_all(self):
        return dict(self._items)


class FakeHybrid:
    def __init__(self):
        self.calls: list[tuple] = []

    def __call__(self, query, top_k, *args, **kwargs):
        self.calls.append((query, top_k))
        return []


def _chunk(chunk_id: str, content: str, wiki_links=None) -> DocChunk:
    doc_id = chunk_id.rsplit("_", 1)[0]
    return DocChunk(
        id=chunk_id,
        doc_id=doc_id,
        doc_title=doc_id,
        doc_path=f"{doc_id}.md",
        chunk_index=0,
        content=content,
        wiki_links=wiki_links or [],
    )


CHUNKS = {
    "raw_华润置地_0": _chunk(
        "raw_华润置地_0", "华润置地由集团总部直接管理，华润置地项目遍布全国。"
    )
}
HIT = [
    {
        "entry": {"name": "华润置地", "frequency": 100},
        "chunks": [{"chunk_id": "raw_华润置地_0"}],
    }
]


def build(struct=None, chunks=None, hybrid=None):
    return create_entity_search(
        EntitySearchDeps(
            chunk_store=FakeChunkStore(chunks),
            struct_query=struct or FakeStructQuery(ready=False),
            entity_repo=FakeEntityRepo(),
            hybrid_search=hybrid or FakeHybrid(),
        )
    )


class TestEntityRecall:
    def test_single_entity_uses_or_and_returns_context(self):
        struct = FakeStructQuery(results=HIT)
        routed = build(struct=struct, chunks=CHUNKS).routed_search("华润置地怎么样")

        assert routed.method == "entity"
        assert routed.matched_keywords == ["华润置地"]
        assert struct.calls == [(["华润置地"], "or")]

        hit = routed.results[0]
        assert hit.chunk.id == "raw_华润置地_0"
        assert hit.source == "entity"
        assert "**华润置地**" in hit.highlight

    def test_multi_entity_and_first_then_or(self):
        """多实体先 AND 精准（避免 "ERP" 短词误匹配），AND 无 chunk 才降级 OR。"""
        struct = FakeStructQuery(by_mode={"and": [], "or": HIT})
        routed = build(struct=struct, chunks=CHUNKS).routed_search("华润置地和 CRM")

        assert routed.method == "entity"
        assert struct.calls == [
            (["华润置地", "CRM"], "and"),
            (["华润置地", "CRM"], "or"),
        ]
        assert [r.chunk.id for r in routed.results] == ["raw_华润置地_0"]

    def test_wiki_chunk_is_recalled(self):
        """纯概念查询：struct 只给 wiki chunk 也能命中（旧 Raw 全文策略只认 raw_）。"""
        chunks = {"wiki_CRM_0": _chunk("wiki_CRM_0", "CRM 是客户关系管理系统。")}
        struct = FakeStructQuery(results=[
            {
                "entry": {"name": "CRM", "frequency": 12, "type": "concept"},
                "chunks": [{"chunk_id": "wiki_CRM_0"}],
            }
        ])
        routed = build(struct=struct, chunks=chunks).routed_search("CRM 是什么")

        assert routed.method == "entity"
        assert [r.chunk.id for r in routed.results] == ["wiki_CRM_0"]

    def test_respects_top_k(self):
        chunks = {
            f"raw_华润置地_{i}": _chunk(f"raw_华润置地_{i}", "华润置地 内容")
            for i in range(5)
        }
        struct = FakeStructQuery(results=[
            {
                "entry": {"name": "华润置地", "frequency": 100},
                "chunks": [{"chunk_id": cid} for cid in chunks],
            }
        ])
        routed = build(struct=struct, chunks=chunks).routed_search("华润置地", top_k=2)
        assert len(routed.results) == 2

    def test_inverted_index_fallback_when_struct_unavailable(self):
        chunks = {
            "raw_华润置地_0": _chunk(
                "raw_华润置地_0", "华润置地 内容", wiki_links=["华润置地"]
            )
        }
        routed = build(struct=FakeStructQuery(ready=False), chunks=chunks).routed_search(
            "华润置地"
        )
        assert routed.method == "entity"
        assert [r.chunk.id for r in routed.results] == ["raw_华润置地_0"]

    def test_missing_chunk_id_is_skipped(self):
        """struct 给了 chunk_id 但 chunk_store 里没有 → 跳过，不报错。"""
        struct = FakeStructQuery(results=[
            {
                "entry": {"name": "华润置地", "frequency": 100},
                "chunks": [{"chunk_id": "raw_不存在_0"}],
            }
        ])
        routed = build(struct=struct, chunks=CHUNKS).routed_search("华润置地")
        assert routed.results == []


class TestRoutingFallback:
    def test_no_entity_matched_uses_rrf(self):
        hybrid = FakeHybrid()
        routed = build(hybrid=hybrid).routed_search("随便问问")

        assert routed.method == "rrf"
        assert routed.matched_keywords is None
        assert hybrid.calls == [("随便问问", 10)]

    def test_entity_matched_but_empty_falls_back_to_rrf(self):
        """auto 路由：命中实体但召回为空 → 降级 RRF，并如实回传 matchedKeywords。"""
        struct = FakeStructQuery(results=[{"entry": {"name": "华润置地"}, "chunks": []}])
        hybrid = FakeHybrid()
        routed = build(struct=struct, hybrid=hybrid).routed_search("华润置地")

        assert routed.method == "rrf"
        assert routed.matched_keywords == ["华润置地"]
        assert len(hybrid.calls) == 1

    def test_force_entity_returns_empty_without_rrf(self):
        """强制实体：如实返回空，不用语义结果回填、也不改标 method。"""
        hybrid = FakeHybrid()
        routed = build(hybrid=hybrid).routed_search("华润置地", force_method="entity")

        assert routed.method == "entity"
        assert routed.results == []
        assert hybrid.calls == []

    def test_force_entity_without_matched_keywords(self):
        hybrid = FakeHybrid()
        routed = build(hybrid=hybrid).routed_search("随便问问", force_method="entity")

        assert routed.method == "entity"
        assert routed.results == []
        assert routed.matched_keywords is None
        assert hybrid.calls == []

    def test_force_rrf_skips_entity_path(self):
        struct = FakeStructQuery(results=HIT)
        hybrid = FakeHybrid()
        routed = build(struct=struct, chunks=CHUNKS, hybrid=hybrid).routed_search(
            "华润置地", force_method="rrf"
        )

        assert routed.method == "rrf"
        assert struct.calls == []
        assert len(hybrid.calls) == 1
