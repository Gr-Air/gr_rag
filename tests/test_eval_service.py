"""EvalService 测试（evalService.ts 全 fake 移植验证）。

- 企业实体门禁：type=='entity' 且命中 ENTERPRISE_PATTERN；concept / struct 未就绪 /
  非企业词（Redis）一律走 rrf
- entity 路径：entityDocsContent 注入、sources/numResults 覆盖、context unshift 5000
- rrf 路径：hybridSearch 位置参数/profile/keywords、rag 流 token/context 收集
- 两个兜底文案、contexts/sources/resultScores 映射、未知 profile 回落 baseline
- relevantDocTypes → filteredChunkIds
"""

from __future__ import annotations

from server.rag.chat.query_rewriter import SmartRewriteResult
from server.rag.chat.types import RagContextEvent, RagTokenEvent
from server.rag.eval.eval_service import EvalRequestOptions, EvalService
from server.rag.retrieve.hybrid_search import HybridSearchOptions
from server.rag.types import DocChunk, Scores, SearchResult


# ------------------------------------------------------------
# Fakes
# ------------------------------------------------------------


class FakeStruct:
    def __init__(self, ready=True, known=None, script=None):
        self._ready = ready
        self._known = known or []
        self._script = list(script) if script is not None else None
        self.queries: list[tuple] = []

    def is_ready(self):
        return self._ready

    def get_known_entities(self):
        return list(self._known)

    def query(self, names, mode):
        self.queries.append((list(names), mode))
        if self._script is not None:
            return self._script.pop(0)
        return []


class FakeFileStore:
    def __init__(self, raw=None, wiki=None):
        self._raw = raw or {}
        self._wiki = wiki or {}

    def read_raw_doc(self, name):
        return self._raw.get(name)

    def read_wiki_doc(self, path):
        return self._wiki.get(path)


class FakeMeta:
    def __init__(self, doc_type):
        self.metadata = {"docType": doc_type} if doc_type else {}


class FakeChunkStore:
    def __init__(self, items):
        self._items = items

    def get_all(self):
        return dict(self._items)


class FakeRewriter:
    def __init__(self, result):
        self.result = result
        self.calls: list[tuple] = []

    def rewrite(self, query, options):
        self.calls.append((query, options))
        return self.result


class FakeHybrid:
    def __init__(self, results):
        self.results = results
        self.calls: list[tuple] = []

    def __call__(self, query, top_k, vector_top_n, bm25_top_n, options):
        self.calls.append((query, top_k, vector_top_n, bm25_top_n, options))
        return list(self.results)


class FakeRag:
    def __init__(self, events):
        self.events = events
        self.calls: list[tuple] = []

    def __call__(self, query, options):
        self.calls.append((query, options))
        return iter(list(self.events))


class FakeLlm:
    available = False


def _rewrite(entities=None, rewritten="改写问题", doc_types=None):
    return SmartRewriteResult(
        rewritten_query=rewritten,
        entities=entities or [],
        intent="other",
        method="fallback",
        route_decision=None,
        relevant_doc_types=doc_types or [],
    )


def _hit(chunk_id, title="文档", content="正文内容", score=0.9, scores=None):
    return SearchResult(
        chunk=DocChunk(
            id=chunk_id,
            doc_id=chunk_id.rsplit("_", 1)[0],
            doc_title=title,
            doc_path=f"Raw/{title}.md",
            chunk_index=0,
            content=content,
        ),
        score=score,
        scores=scores or Scores(rrf=0.02),
        source="rrf",
    )


def _entry(name, type_="entity", category="项目系统"):
    return {"name": name, "type": type_, "category": category}


def _struct_result(name, chunks, type_="entity", path=""):
    return {"entry": {"id": 1, "name": name, "type": type_,
                      "category": "客户企业", "frequency": 1, "path": path},
            "chunks": chunks}


def build_service(rewrite_result=None, hybrid_results=None, rag_events=None,
                  known=None, struct_script=None, struct_ready=True,
                  raw_docs=None, chunk_items=None):
    struct = FakeStruct(ready=struct_ready, known=known, script=struct_script)
    rewriter = FakeRewriter(rewrite_result if rewrite_result is not None else _rewrite())
    hybrid = FakeHybrid(hybrid_results or [])
    rag = FakeRag(rag_events if rag_events is not None else [RagContextEvent(results=[])])
    service = EvalService({
        "llm": FakeLlm(),
        "chunk_store": FakeChunkStore(chunk_items or {}),
        "struct_query": struct,
        "entity_repo": struct,
        "file_store": FakeFileStore(raw=raw_docs or {}),
        "hybrid_search": hybrid,
        "smart_rewriter": rewriter,
        "rag_chat_stream": rag,
    })
    return service, struct, rewriter, hybrid, rag


def _opts(query="万科集团怎么样", top_k=10, profile_id=None):
    return EvalRequestOptions(query=query, top_k=top_k, llm=FakeLlm(),
                              profile_id=profile_id)


# ------------------------------------------------------------
# 实体门禁
# ------------------------------------------------------------


def test_enterprise_entity_uses_entity_path():
    struct_script = [[_struct_result("万科集团", [{"chunk_id": "raw_万科_0"}])]]
    service, struct, _, hybrid, rag = build_service(
        rewrite_result=_rewrite(entities=["万科集团"]),
        known=[_entry("万科集团")],
        struct_script=struct_script,
        raw_docs={"万科": "# 万科\n\n万科企业简介内容。"},
    )

    result = service.evaluate(_opts())

    assert result.search_method == "entity"
    assert result.matched_entities == ["万科集团"]
    assert hybrid.calls == []  # 不走语义检索
    assert result.num_results == 1
    assert result.sources == ["万科"]
    # entity 内容截断后 unshift 到 contexts 首位
    assert result.contexts[0].startswith("### 万科（全文，")
    assert result.result_scores == []
    # rag 选项：实体内容有、preSearchResults 不传（results 为空）
    _, options = rag.calls[0]
    assert options.entity_docs_content is not None
    assert options.pre_search_results is None
    assert options.rerank_top_k == 5
    # answer：无 token → 兜底
    assert result.answer == "未能生成回答"


def test_non_enterprise_word_goes_rrf():
    service, struct, _, hybrid, _ = build_service(
        rewrite_result=_rewrite(entities=["Redis"], rewritten="Redis 架构"),
        known=[_entry("Redis", category="技术组件")],
        hybrid_results=[_hit("raw_x_0")],
        rag_events=[RagContextEvent(results=[_hit("raw_x_0")])],
    )
    result = service.evaluate(_opts(query="Redis 怎么样"))
    assert result.search_method == "rrf"
    assert struct.queries == []  # 门禁未过，不查 struct
    assert hybrid.calls[0][0] == "Redis 架构"
    assert hybrid.calls[0][1] == 10
    assert hybrid.calls[0][4].matched_keywords == ["Redis"]
    assert result.sources == ["文档"]


def test_concept_even_with_pattern_goes_rrf():
    service, *_ = build_service(
        rewrite_result=_rewrite(entities=["万科集团"]),
        known=[_entry("万科集团", type_="concept")],
        hybrid_results=[],
    )
    result = service.evaluate(_opts())
    assert result.search_method == "rrf"


def test_struct_not_ready_skips_entity_route():
    service, *_ = build_service(
        rewrite_result=_rewrite(entities=["万科集团"]),
        known=[_entry("万科集团")],
        struct_ready=False,
        hybrid_results=[],
    )
    result = service.evaluate(_opts())
    assert result.search_method == "rrf"


def test_entity_loader_none_falls_back_rrf():
    # 门禁通过但 struct 无关联文档（两次降级后仍空）→ 语义检索
    service, *_ = build_service(
        rewrite_result=_rewrite(entities=["万科集团"]),
        known=[_entry("万科集团")],
        struct_script=[
            [_struct_result("万科集团", [])],
            [_struct_result("万科集团", [])],
        ],
        hybrid_results=[_hit("raw_y_0")],
        rag_events=[RagContextEvent(results=[_hit("raw_y_0")])],
    )
    result = service.evaluate(_opts())
    assert result.search_method == "rrf"
    assert result.num_results == 1


# ------------------------------------------------------------
# rrf / 回答 / 映射
# ------------------------------------------------------------


def test_no_results_message_and_no_rag_call():
    service, *_, rag = build_service(hybrid_results=[])
    result = service.evaluate(_opts(query="无关问题"))
    assert result.answer == "未检索到相关资料，请尝试其他关键词。"
    assert rag.calls == []
    assert result.contexts == [] and result.sources == []
    assert result.num_results == 0


def test_token_accumulation():
    events = [
        RagContextEvent(results=[_hit("raw_x_0")]),
        RagTokenEvent(content="你"),
        RagTokenEvent(content="好"),
    ]
    service, *_ = build_service(
        hybrid_results=[_hit("raw_x_0")], rag_events=events
    )
    result = service.evaluate(_opts())
    assert result.answer == "你好"


def test_contexts_sources_scores_respect_topk_and_filter_empty():
    results = [
        _hit("raw_a_0", title="甲", content="甲内容", score=0.9, scores=Scores(rrf=0.03)),
        _hit("raw_b_0", title="乙", content="", score=0.1, scores=Scores(vector=0.5)),
    ]
    service, *_ = build_service(
        hybrid_results=results,
        rag_events=[RagContextEvent(results=results)],
    )
    result = service.evaluate(_opts(top_k=1))
    assert result.contexts == ["甲内容"]
    assert result.sources == ["甲"]
    assert result.num_results == 2  # finalResults.length 不受 topK 截断
    assert result.result_scores == [{"score": 0.9, "scores": {"rrf": 0.03}}]


def test_entity_context_unshift_after_slice_and_truncate_5000():
    # 两篇短文档全文（每篇 4200 中文字 ≈ 2800 token < 3000），拼接后超 5000
    body = "字" * 4200
    service, *_ = build_service(
        rewrite_result=_rewrite(entities=["万科集团"]),
        known=[_entry("万科集团")],
        struct_script=[[_struct_result("万科集团", [
            {"chunk_id": "raw_甲_0"}, {"chunk_id": "raw_乙_0"},
        ])]],
        raw_docs={"甲": body, "乙": body},
    )
    result = service.evaluate(_opts())
    assert result.search_method == "entity"
    assert len(result.contexts[0]) == 5000
    assert result.contexts[0] == (
        f"### 甲（全文，2800 token）\n\n{body}\n\n---\n\n### 乙（全文，2800 token）\n\n{body}"
    )[:5000]


def test_entity_sources_override_num_results():
    script = [[_struct_result("万科集团", [
        {"chunk_id": "raw_甲_0"}, {"chunk_id": "raw_乙_0"},
    ])]]
    service, *_ = build_service(
        rewrite_result=_rewrite(entities=["万科集团"]),
        known=[_entry("万科集团")],
        struct_script=script,
        raw_docs={"甲": "甲内容。", "乙": "乙内容。"},
    )
    result = service.evaluate(_opts())
    assert result.search_method == "entity"
    assert result.sources == ["甲", "乙"]
    assert result.num_results == 2


def test_unknown_profile_falls_back_baseline():
    service, _struct, _rewriter, hybrid, _rag = build_service(
        hybrid_results=[],
    )
    result = service.evaluate(_opts(profile_id="weird"))
    assert result.profile_id == "baseline"
    assert hybrid.calls[0][4].profile.id == "baseline"


def test_struct_profile_passes_through():
    service, _struct, _rewriter, hybrid, _rag = build_service(hybrid_results=[])
    service.evaluate(_opts(profile_id="struct"))
    assert hybrid.calls[0][4].profile.id == "struct"


def test_doc_type_filter_passes_chunk_ids():
    service, _struct, _rewriter, hybrid, _rag = build_service(
        rewrite_result=_rewrite(doc_types=["技术方案"]),
        chunk_items={
            "raw_a_0": FakeMeta("技术方案"),
            "raw_b_0": FakeMeta("需求规格说明书"),
        },
        hybrid_results=[],
    )
    service.evaluate(_opts())
    options: HybridSearchOptions = hybrid.calls[0][4]
    assert options.filtered_chunk_ids == ["raw_a_0"]


def test_query_trimmed_and_rewrite_passthrough():
    service, _, rewriter, hybrid, _ = build_service(
        rewrite_result=_rewrite(rewritten="", entities=[]),  # 空改写 → 用 trim 后原 query
        hybrid_results=[],
    )
    result = service.evaluate(EvalRequestOptions(query="  原始问题  "))
    assert result.query == "原始问题"
    assert rewriter.calls[0][0] == "原始问题"
    assert hybrid.calls[0][0] == "原始问题"
