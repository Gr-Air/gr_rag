"""chat_service 集成测试（对应 TS chatService.ts 编排）。

手写全部 deps fake，验证：
- fallback / llm 两条改写路径与缓存读写、prewarm
- 实体文档优先、AND/OR 失败降级 rrf、docType 过滤
- 追问 enriched query / 本地追问检测 / previous_query 透传
- 事件顺序、assistant 落库、no-llm / error 不写 assistant、请求级 LLM 覆盖
"""

from __future__ import annotations

import pytest

from server.rag.chat import chat_service as cs_mod
from server.rag.chat.chat_service import ChatRequestOptions, ChatService
from server.rag.chat.query_rewriter import (
    LlmRouteDecision,
    SmartRewriteResult,
)
from server.rag.chat.sessions import clear_all_sessions, get_session
from server.rag.chat.types import (
    ChatContextEvent,
    ChatDoneEvent,
    ChatErrorEvent,
    ChatMethodEvent,
    ChatNoLlmEvent,
    ChatTokenEvent,
    RagContextEvent,
    RagDoneEvent,
    RagErrorEvent,
    RagNoLlmEvent,
    RagTokenEvent,
)
from server.rag.retrieve.entity_strategy import POLICY_VERSION
from server.rag.retrieve.hybrid_search import HybridSearchOptions
from server.rag.types import DocChunk, Scores, SearchResult


# ------------------------------------------------------------
# fakes
# ------------------------------------------------------------


def make_result(cid: str, score: float = 0.9) -> SearchResult:
    return SearchResult(
        chunk=DocChunk(
            id=cid,
            doc_id=f"doc_{cid}",
            doc_title=f"标题{cid}",
            doc_path=f"Raw/{cid}.md",
            chunk_index=0,
            content=f"文档{cid}正文",
        ),
        score=score,
        scores=Scores(rrf=0.01, vector=0.8),
        source="hybrid",
    )


class FakeLlm:
    def __init__(self, available=True):
        self.available = available
        self.complete_calls: list = []

    def complete(self, messages, temperature=None, max_tokens=None):
        self.complete_calls.append((messages, temperature, max_tokens))
        return "摘要"

    def stream(self, messages, **kwargs):
        yield "不应直接被 service 消费"


class FakeRewriter:
    def __init__(self, script=None, fixed=None):
        # script: list 按调用次序返回；fixed: 固定结果；都没有则 fallback 空实体
        self._script = list(script or [])
        self._fixed = fixed
        self.calls: list[tuple[str, object]] = []

    def rewrite(self, query, options=None):
        self.calls.append((query, options))
        if self._script:
            return self._script.pop(0)
        if self._fixed is not None:
            return self._fixed
        return SmartRewriteResult(
            rewritten_query=query,
            entities=[],
            intent="other",
            method="fallback",
            route_decision=None,
            relevant_doc_types=[],
        )


class FakeHybrid:
    def __init__(self, results=None, raise_exc=None):
        self._results = results if results is not None else [make_result("H1")]
        self._raise = raise_exc
        self.calls: list[tuple] = []

    def __call__(self, query, top_k, vec_k, bm25_k, options=None):
        self.calls.append((query, top_k, vec_k, bm25_k, options))
        if self._raise:
            raise self._raise
        return list(self._results)


class FakeStructQuery:
    def __init__(self, ready=True, results=None):
        self._ready = ready
        self._results = (
            results
            if results is not None
            else [{"chunks": [{"chunk_id": "raw_华润置地_0"}]}]
        )
        self.calls: list[tuple] = []

    def is_ready(self):
        return self._ready

    def query(self, names, mode):
        self.calls.append((list(names), mode))
        return self._results


class FakeFileStore:
    def __init__(self, docs=None):
        self._docs = docs or {}

    def read_raw_doc(self, name):
        return self._docs.get(name)


class FakeMeta:
    def __init__(self, metadata):
        self.metadata = metadata


class FakeChunkStore:
    def __init__(self, items=None):
        self._items = items or {}

    def get_all(self):
        return dict(self._items)


class FakeCache:
    def __init__(self, hit=None):
        self._hit = hit
        self.lookup_calls: list[tuple] = []
        self.save_calls: list[tuple] = []

    def lookup(self, query, embedding, ctx):
        self.lookup_calls.append((query, embedding, ctx))
        return self._hit

    def save(self, query, embedding, results, ctx):
        self.save_calls.append((query, embedding, results, ctx))


class FakeRagStream:
    """记录入参，按脚本产出 Rag* 事件。"""

    def __init__(self, script=None):
        self._script = script or [
            RagContextEvent(results=[make_result("H1")]),
            RagTokenEvent(content="答案"),
            RagDoneEvent(),
        ]
        self.calls: list[tuple] = []

    def __call__(self, query, options=None):
        self.calls.append((query, options))
        for event in self._script:
            yield event


def llm_result(rewritten="改写后的查询", entities=None, followup=False,
               doc_types=None) -> SmartRewriteResult:
    return SmartRewriteResult(
        rewritten_query=rewritten,
        entities=entities or [],
        intent="fact",
        method="llm",
        route_decision=LlmRouteDecision(
            is_follow_up=followup, relevant_doc_types=doc_types or []
        ),
        relevant_doc_types=doc_types or [],
    )


def build_service(
    *,
    rewriter=None,
    hybrid=None,
    struct=None,
    file_store=None,
    chunk_store=None,
    cache=None,
    rag=None,
    llm=None,
    embed_raises=False,
):
    llm = llm or FakeLlm(available=True)
    embed_calls: list[str] = []
    prewarm_calls: list[tuple] = []

    def embed_query(text):
        embed_calls.append(text)
        if embed_raises:
            raise RuntimeError("embedding down")
        return [0.1, 0.2, 0.3]

    def prewarm_query(text, emb):
        prewarm_calls.append((text, emb))

    deps = {
        "llm": llm,
        "embed_query": embed_query,
        "prewarm_query": prewarm_query,
        "cache_lookup": (cache or FakeCache()).lookup,
        "cache_save": (cache or FakeCache()).save,
        "chunk_store": chunk_store or FakeChunkStore(),
        "struct_query": struct or FakeStructQuery(ready=False),
        "file_store": file_store or FakeFileStore(),
        "hybrid_search": hybrid or FakeHybrid(),
        "smart_rewriter": rewriter or FakeRewriter(),
        "rag_chat_stream": rag or FakeRagStream(),
    }
    service = ChatService(deps)
    return service, deps, embed_calls, prewarm_calls


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    clear_all_sessions()
    # 压缩线程在单测中不跑（压缩行为由 test_session_manager 覆盖）
    monkeypatch.setattr(cs_mod, "_fire_compress", lambda sid, llm: None)
    yield
    clear_all_sessions()


def run(service, query="问题", **opts):
    return list(service.chat(query, ChatRequestOptions(**opts)))


# ------------------------------------------------------------
# fallback 路径
# ------------------------------------------------------------


class TestFallbackPath:
    def test_no_entity_uses_hybrid_rrf(self):
        rag = FakeRagStream()
        hybrid = FakeHybrid(results=[make_result("H1", 0.9), make_result("H2", 0.5)])
        service, deps, embed_calls, _ = build_service(hybrid=hybrid, rag=rag)

        events = run(service, "微服务架构原则", top_k=10)

        method = events[0]
        assert isinstance(method, ChatMethodEvent)
        assert method.method == "rrf"
        assert method.rewrite_method == "fallback"
        assert method.matched_keywords is None
        assert method.entity_docs_content is None
        assert method.rewritten_query is None

        # 事件顺序：method → context → token → done
        assert [type(e) for e in events] == [
            ChatMethodEvent, ChatContextEvent, ChatTokenEvent, ChatDoneEvent
        ]
        assert events[2].content == "答案"
        assert events[3].session_id == method.session_id

        # fallback 直接用原 query 检索，固定召回参数 20/20
        q, top_k, vec_k, bm25_k, options = hybrid.calls[0]
        assert q == "微服务架构原则"
        assert (top_k, vec_k, bm25_k) == (10, 20, 20)
        assert isinstance(options, HybridSearchOptions)
        assert options.matched_keywords is None
        assert options.filtered_chunk_ids is None

        # fallback 不查缓存
        assert embed_calls == []

        # rag 入参：原 query + 预检索结果 + 会话历史
        final_query, rag_opts = rag.calls[0]
        assert final_query == "微服务架构原则"
        assert [r.chunk.id for r in rag_opts.pre_search_results] == ["H1", "H2"]
        assert rag_opts.is_follow_up is False

        # user/assistant 均落库
        session = get_session(method.session_id)
        assert [m.role for m in session.messages] == ["user", "assistant"]
        assert session.messages[0].content == "微服务架构原则"
        assert session.messages[1].content == "答案"
        assert session.last_search_results.method == "rrf"

    def test_local_followup_detection_with_route_none(self):
        hybrid = FakeHybrid()
        rag = FakeRagStream(script=[RagContextEvent(results=[make_result("H1")]),
                                    RagDoneEvent()])
        service, _, _, _ = build_service(hybrid=hybrid, rag=rag)

        # 第一轮建立 last_search_results
        first = run(service, "国家电网简介")
        sid = first[0].session_id
        # 第二轮：route_decision=None，本地追问正则命中
        run(service, "详细说说", session_id=sid)

        q = hybrid.calls[1][0]
        assert q == '[上文: 用户之前问"国家电网简介"] 详细说说'
        _, rag_opts = rag.calls[1]
        assert rag_opts.is_follow_up is True
        # 历史在本轮 user 写入前生成，应包含上一轮
        assert "国家电网简介" in (rag_opts.conversation_context or "")


# ------------------------------------------------------------
# 实体路径
# ------------------------------------------------------------


class TestEntityPath:
    def test_entity_docs_skip_hybrid(self):
        struct = FakeStructQuery()
        file_store = FakeFileStore(docs={"华润置地": "# 华润置地\n[[链接]] 正文内容"})
        hybrid = FakeHybrid()
        cache = FakeCache()
        rag = FakeRagStream(script=[RagContextEvent(results=[]), RagTokenEvent(content="x"),
                                    RagDoneEvent()])
        rewriter = FakeRewriter(fixed=SmartRewriteResult(
            rewritten_query="华润置地",
            entities=["华润置地"],
            intent="other",
            method="fallback",
            route_decision=None,
        ))
        service, _, embed_calls, _ = build_service(
            rewriter=rewriter, struct=struct, file_store=file_store,
            hybrid=hybrid, cache=cache, rag=rag,
        )

        events = run(service, "华润置地")

        method = events[0]
        assert method.method == "entity"
        assert method.matched_keywords == ["华润置地"]
        assert "华润置地" in method.entity_docs_content
        assert "全文" in method.entity_docs_content
        assert "链接" in method.entity_docs_content  # wiki link 已清除 [[]]
        assert "[[链接]]" not in method.entity_docs_content
        assert hybrid.calls == []
        assert cache.lookup_calls == [] and cache.save_calls == []
        assert embed_calls == []

        _, rag_opts = rag.calls[0]
        assert rag_opts.entity_docs_content == method.entity_docs_content
        assert rag_opts.pre_search_results == []

    def test_struct_not_ready_falls_back_rrf(self):
        struct = FakeStructQuery(ready=False)
        hybrid = FakeHybrid()
        rewriter = FakeRewriter(fixed=SmartRewriteResult(
            rewritten_query="华润置地", entities=["华润置地"], intent="other",
            method="fallback", route_decision=None,
        ))
        service, _, _, _ = build_service(struct=struct, hybrid=hybrid, rewriter=rewriter)

        events = run(service, "华润置地")
        assert events[0].method == "rrf"
        assert hybrid.calls and hybrid.calls[0][0] == "华润置地"
        # matched_keywords 仍透传给 hybrid
        assert hybrid.calls[0][4].matched_keywords == ["华润置地"]

    def test_struct_empty_results_falls_back_rrf(self):
        struct = FakeStructQuery(results=[])
        hybrid = FakeHybrid()
        rewriter = FakeRewriter(fixed=SmartRewriteResult(
            rewritten_query="q", entities=["华润置地"], intent="other",
            method="fallback", route_decision=None,
        ))
        service, _, _, _ = build_service(struct=struct, hybrid=hybrid, rewriter=rewriter)
        events = run(service, "q")
        assert events[0].method == "rrf"
        assert hybrid.calls

    def test_multi_entity_and_then_or(self):
        class AndOrStruct(FakeStructQuery):
            def query(self, names, mode):
                self.calls.append((list(names), mode))
                if mode == "and":
                    return []
                return [{"chunks": [{"chunk_id": "raw_Redis_0"}]}]

        struct = AndOrStruct()
        file_store = FakeFileStore(docs={"Redis": "Redis 短文档内容"})
        rewriter = FakeRewriter(fixed=SmartRewriteResult(
            rewritten_query="q", entities=["Redis", "MySQL"], intent="other",
            method="fallback", route_decision=None,
        ))
        service, _, _, _ = build_service(
            struct=struct, file_store=file_store, rewriter=rewriter
        )
        events = run(service, "q")
        assert struct.calls == [(["Redis", "MySQL"], "and"), (["Redis", "MySQL"], "or")]
        assert events[0].method == "entity"


# ------------------------------------------------------------
# LLM 路径 / 缓存
# ------------------------------------------------------------


class TestLlmPathCache:
    def test_cache_hit_skips_hybrid(self):
        cached = [make_result("C1")]
        cache = FakeCache(hit=cached)
        hybrid = FakeHybrid()
        rag = FakeRagStream()
        service, _, embed_calls, prewarm = build_service(
            rewriter=FakeRewriter(fixed=llm_result("改写后的查询")),
            cache=cache, hybrid=hybrid, rag=rag,
        )

        events = run(service, "原查询")

        assert events[0].method == "rrf"
        assert events[0].rewrite_method == "llm"
        assert events[0].rewritten_query == "改写后的查询"
        assert hybrid.calls == []
        assert embed_calls == ["改写后的查询"]
        # 命中不写缓存、不 prewarm
        assert cache.save_calls == []
        assert prewarm == []

        _, emb, ctx = cache.lookup_calls[0]
        assert emb == [0.1, 0.2, 0.3]
        assert ctx.entities == []
        assert ctx.policy_version == POLICY_VERSION

        final_query, rag_opts = rag.calls[0]
        assert final_query == "改写后的查询"
        assert rag_opts.pre_search_results == cached

    def test_cache_miss_saves_and_prewarms(self):
        cache = FakeCache(hit=None)
        hybrid = FakeHybrid(results=[make_result("H9")])
        service, _, _, prewarm = build_service(
            rewriter=FakeRewriter(fixed=llm_result("改写q", entities=["国家电网"])),
            cache=cache, hybrid=hybrid,
        )

        run(service, "原q")

        q, emb, results, ctx = cache.save_calls[0]
        assert q == "改写q"
        assert emb == [0.1, 0.2, 0.3]
        assert [r.chunk.id for r in results] == ["H9"]
        assert ctx.entities == ["国家电网"]
        assert ctx.policy_version == POLICY_VERSION
        assert prewarm == [("改写q", [0.1, 0.2, 0.3])]

    def test_embed_failure_skips_cache_still_searches(self):
        hybrid = FakeHybrid()
        service, _, _, _ = build_service(
            rewriter=FakeRewriter(fixed=llm_result("改写q")),
            hybrid=hybrid, embed_raises=True,
        )
        events = run(service, "原q")
        assert events[0].method == "rrf"
        assert hybrid.calls  # 照常检索

    def test_doctype_filter_passed_to_hybrid(self):
        chunk_store = FakeChunkStore({
            "c1": FakeMeta({"docType": "技术方案"}),
            "c2": FakeMeta({}),
            "c3": FakeMeta({"docType": "技术方案"}),
        })
        hybrid = FakeHybrid()
        service, _, _, _ = build_service(
            rewriter=FakeRewriter(fixed=llm_result(doc_types=["技术方案"])),
            chunk_store=chunk_store, hybrid=hybrid,
        )
        run(service, "q")
        options = hybrid.calls[0][4]
        assert options.filtered_chunk_ids == ["c1", "c3"]

    def test_doctype_no_match_filter_none(self):
        chunk_store = FakeChunkStore({"c1": FakeMeta({"docType": "来往账目"})})
        hybrid = FakeHybrid()
        service, _, _, _ = build_service(
            rewriter=FakeRewriter(fixed=llm_result(doc_types=["技术方案"])),
            chunk_store=chunk_store, hybrid=hybrid,
        )
        run(service, "q")
        assert hybrid.calls[0][4].filtered_chunk_ids is None


# ------------------------------------------------------------
# 追问
# ------------------------------------------------------------


class TestFollowUp:
    def _two_turn(self, second_rewrite, second_query="详细说说"):
        hybrid = FakeHybrid()
        rag = FakeRagStream(script=[RagContextEvent(results=[make_result("H1")]),
                                    RagDoneEvent()])
        rewriter = FakeRewriter(script=[llm_result("第一轮改写"), second_rewrite])
        cache = FakeCache()
        service, _, embed_calls, _ = build_service(
            rewriter=rewriter, hybrid=hybrid, rag=rag, cache=cache,
        )
        first = run(service, "国家电网简介")
        sid = first[0].session_id
        second = run(service, second_query, session_id=sid)
        return sid, hybrid, rag, rewriter, cache, embed_calls, second

    def test_followup_skips_cache_uses_rewritten_query(self):
        sid, hybrid, rag, rewriter, cache, embed_calls, second = self._two_turn(
            llm_result("详细说说", followup=True)
        )
        # 第二轮不查缓存：embed 只在第一轮发生
        assert embed_calls == ["第一轮改写"]
        assert len(cache.lookup_calls) == 1

        # LLM 路径检索用 rewrittenQuery（enrichedQuery 仅 fallback 路径使用）
        assert hybrid.calls[1][0] == "详细说说"

        _, opts2 = rag.calls[1]
        assert opts2.is_follow_up is True
        assert opts2.llm is not None

        # previous_query 透传给改写器
        prev = rewriter.calls[1][1].previous_query
        assert prev == "国家电网简介"

        assert second[0].session_id == sid

    def test_llm_says_not_followup_uses_rewritten_query(self):
        _, hybrid, _, _, _, _, _ = self._two_turn(
            llm_result("改写后的追问", followup=False),
            second_query="还有其他内容吗",
        )
        # LLM 决策优先于本地正则（"还有...吗"不命中本地正则也不影响）
        assert hybrid.calls[1][0] == "改写后的追问"


# ------------------------------------------------------------
# 降级事件 / 消息落库
# ------------------------------------------------------------


class TestRagEvents:
    def test_no_llm_event_no_done_no_assistant_message(self):
        rag = FakeRagStream(script=[
            RagContextEvent(results=[make_result("H1")]),
            RagNoLlmEvent(results=[make_result("H1")]),
        ])
        service, _, _, _ = build_service(rag=rag)

        events = run(service, "q")
        assert [type(e) for e in events] == [
            ChatMethodEvent, ChatContextEvent, ChatNoLlmEvent
        ]
        assert [r.chunk.id for r in events[2].results] == ["H1"]
        sid = events[0].session_id
        session = get_session(sid)
        assert [m.role for m in session.messages] == ["user"]

    def test_error_event_no_done(self):
        rag = FakeRagStream(script=[
            RagContextEvent(results=[]),
            RagErrorEvent(content="LLM 调用失败: x"),
        ])
        service, _, _, _ = build_service(rag=rag)
        events = run(service, "q")
        assert isinstance(events[-1], ChatErrorEvent)
        assert "LLM 调用失败" in events[-1].content
        assert not any(isinstance(e, ChatDoneEvent) for e in events)
        sid = events[0].session_id
        assert [m.role for m in get_session(sid).messages] == ["user"]

    def test_empty_tokens_not_forwarded(self):
        rag = FakeRagStream(script=[
            RagContextEvent(results=[make_result("H1")]),
            RagTokenEvent(content=""),
            RagTokenEvent(content="有效"),
            RagDoneEvent(),
        ])
        service, _, _, _ = build_service(rag=rag)
        events = run(service, "q")
        tokens = [e for e in events if isinstance(e, ChatTokenEvent)]
        assert [e.content for e in tokens] == ["有效"]
        sid = events[0].session_id
        # 仅非空累计写库
        assert get_session(sid).messages[-1].content == "有效"

    def test_context_results_mapped(self):
        rag = FakeRagStream(script=[
            RagContextEvent(results=[make_result("A"), make_result("B")]),
            RagDoneEvent(),
        ])
        service, _, _, _ = build_service(rag=rag)
        events = run(service, "q")
        ctx = next(e for e in events if isinstance(e, ChatContextEvent))
        assert [r.chunk.id for r in ctx.results] == ["A", "B"]


# ------------------------------------------------------------
# 请求级 LLM 覆盖
# ------------------------------------------------------------


class TestRequestLlmOverride:
    def test_options_llm_used_for_rewrite_and_rag(self):
        default_llm = FakeLlm(available=False)
        request_llm = FakeLlm(available=True)
        rewriter = FakeRewriter()
        rag = FakeRagStream(script=[RagContextEvent(results=[]), RagDoneEvent()])
        service, _, _, _ = build_service(
            llm=default_llm, rewriter=rewriter, rag=rag
        )

        run(service, "q", llm=request_llm)

        _, opts = rewriter.calls[0]
        assert opts.llm is request_llm
        _, rag_opts = rag.calls[0]
        assert rag_opts.llm is request_llm
        assert default_llm.complete_calls == []
