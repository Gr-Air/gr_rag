"""rag_engine 测试（对应 TS ragEngine.ts 行为）。

- 预检索结果 / 实体文档 / 实时混合检索三条入口
- context 事件发 pre-rerank 全量；rerank 仅影响 prompt
- 无 LLM 降级 no-llm（无 done）；检索/LLM 异常 error
"""

from __future__ import annotations

import pytest

from server.rag.chat.rag_engine import RagChatOptions, create_rag_chat_stream
from server.rag.chat.types import (
    RagContextEvent,
    RagDoneEvent,
    RagErrorEvent,
    RagNoLlmEvent,
    RagTokenEvent,
)
from server.rag.retrieve.hybrid_search import HybridSearchOptions
from server.rag.types import DocChunk, Scores, SearchResult


def make_result(cid: str, score: float, title: str | None = None, metadata=None,
                content: str | None = None) -> SearchResult:
    return SearchResult(
        chunk=DocChunk(
            id=cid,
            doc_id=f"doc_{cid}",
            doc_title=title or f"标题{cid}",
            doc_path=f"Raw/{cid}.md",
            chunk_index=0,
            content=content or f"文档{cid}的正文内容。",
            metadata=metadata or {},
        ),
        score=score,
        scores=Scores(rrf=0.01, vector=0.8),
        source="hybrid",
        highlight=None,
    )


class FakeLlm:
    def __init__(self, available=True, tokens=("回答",), raise_exc=None):
        self.available = available
        self._tokens = tokens
        self._raise_exc = raise_exc
        self.calls: list[list[dict]] = []

    def stream(self, messages, **kwargs):
        self.calls.append(messages)
        if self._raise_exc:
            raise self._raise_exc
        for t in self._tokens:
            yield t


class FakeReranker:
    def __init__(self, output=None, raise_exc=None):
        self._output = output or []
        self._raise_exc = raise_exc
        self.calls: list[dict] = []

    def rerank(self, query, results, top_n):
        self.calls.append({"query": query, "n": len(results), "top_n": top_n})
        if self._raise_exc:
            raise self._raise_exc
        return self._output


def make_stream(llm=None, reranker=None, hybrid=None):
    llm = llm if llm is not None else FakeLlm()
    reranker = reranker or FakeReranker()
    hybrid_calls: list[dict] = []

    def fake_hybrid(query, top_k, vec_k, bm25_k, options=None):
        hybrid_calls.append(
            {"query": query, "top_k": top_k, "vec_k": vec_k, "bm25_k": bm25_k,
             "options": options}
        )
        if hybrid is None:
            return []
        if isinstance(hybrid, Exception):
            raise hybrid
        return hybrid

    stream = create_rag_chat_stream(
        {
            "llm": llm,
            "reranker_factory": lambda: reranker,
            "hybrid_search": fake_hybrid,
        }
    )
    return stream, llm, reranker, hybrid_calls


def collect(generator):
    return list(generator)


# ------------------------------------------------------------
# 预检索结果入口
# ------------------------------------------------------------


class TestPreSearch:
    def test_context_event_emits_full_prerank_results(self):
        results = [make_result(f"C{i}", 0.9 - i * 0.1) for i in range(6)]
        reranker = FakeReranker(output=results[:2])
        stream, _, _, hybrid_calls = make_stream(reranker=reranker)

        events = collect(stream("问题", RagChatOptions(pre_search_results=results)))

        # 实时检索被跳过
        assert hybrid_calls == []
        ctx = events[0]
        assert isinstance(ctx, RagContextEvent)
        assert len(ctx.results) == 6
        # rerank 被触发（>5）
        assert reranker.calls and reranker.calls[0]["top_n"] == 5

    def test_rerank_only_affects_prompt(self):
        results = [make_result(f"C{i}", 0.9 - i * 0.1) for i in range(6)]
        top_two = [results[5], results[0]]  # rerank 改变顺序
        reranker = FakeReranker(output=top_two)
        stream, llm, _, _ = make_stream(reranker=reranker)

        events = collect(stream("问题", RagChatOptions(pre_search_results=results)))

        user_prompt = llm.calls[0][1]["content"]
        # prompt 只含 rerank 后的两篇，顺序按 rerank 输出再按 score 降序排序
        assert "标题C5" in user_prompt or "标题C0" in user_prompt
        assert "### 文档 1" in user_prompt
        assert "### 文档 3" not in user_prompt
        # token + done 正常
        assert isinstance(events[-1], RagDoneEvent)
        assert [type(e) for e in events[1:-1]] == [RagTokenEvent]

    def test_no_rerank_when_le_five_results(self):
        results = [make_result(f"C{i}", 0.9 - i * 0.1) for i in range(5)]
        reranker = FakeReranker()
        stream, _, _, _ = make_stream(reranker=reranker)

        collect(stream("问题", RagChatOptions(pre_search_results=results)))
        assert reranker.calls == []

    def test_rerank_failure_keeps_original_results(self):
        results = [make_result(f"C{i}", 0.9 - i * 0.1) for i in range(6)]
        reranker = FakeReranker(raise_exc=RuntimeError("rerank down"))
        stream, llm, _, _ = make_stream(reranker=reranker)

        events = collect(stream("问题", RagChatOptions(pre_search_results=results)))

        assert isinstance(events[-1], RagDoneEvent)
        user_prompt = llm.calls[0][1]["content"]
        assert "### 文档 6: 标题C5" in user_prompt

    def test_rerank_empty_output_keeps_original(self):
        results = [make_result(f"C{i}", 0.9 - i * 0.1) for i in range(6)]
        reranker = FakeReranker(output=[])
        stream, llm, _, _ = make_stream(reranker=reranker)
        collect(stream("问题", RagChatOptions(pre_search_results=results)))
        assert "### 文档 6: 标题C5" in llm.calls[0][1]["content"]


# ------------------------------------------------------------
# prompt 构造
# ------------------------------------------------------------


class TestPromptBuild:
    def test_headers_sorted_by_score_desc_with_metadata(self):
        results = [
            make_result("low", 0.3, title="低分文档",
                        metadata={"client": "客户A", "project": "项目X",
                                  "docType": "技术方案", "date": "2026-01"}),
            make_result("high", 0.9, title="高分文档",
                        metadata={"client": "客户B"}),
        ]
        stream, llm, _, _ = make_stream()

        collect(stream("查询", RagChatOptions(pre_search_results=results)))

        messages = llm.calls[0]
        assert messages[0]["role"] == "system"
        user = messages[1]["content"]
        assert user.index("高分文档") < user.index("低分文档")
        assert "### 文档 1: 高分文档 (客户: 客户B)" in user
        assert "客户: 客户A | 项目: 项目X | 类型: 技术方案 | 日期: 2026-01" in user
        assert "文档high的正文内容。" in user
        assert "查询" in user

    def test_entity_docs_content_in_prompt(self):
        stream, llm, _, _ = make_stream()
        collect(stream(
            "华润置地",
            RagChatOptions(entity_docs_content="### 华润置地（全文，100 token）\n\n全文内容"),
        ))
        user = llm.calls[0][1]["content"]
        assert "## 实体关联文档全文" in user
        assert "华润置地" in user
        # 纯实体路径无语义检索章节
        assert "## 语义检索文档内容" not in user

    def test_entity_docs_with_semantic_context(self):
        results = [make_result("C1", 0.9)]
        stream, llm, _, _ = make_stream()
        collect(stream(
            "华润置地验收",
            RagChatOptions(
                pre_search_results=results,
                entity_docs_content="实体文档内容",
            ),
        ))
        user = llm.calls[0][1]["content"]
        assert "## 实体关联文档全文" in user
        assert "## 语义检索文档内容" in user

    def test_conversation_context_appended_for_non_followup(self):
        results = [make_result("C1", 0.9)]
        stream, llm, _, _ = make_stream()
        collect(stream(
            "继续问",
            RagChatOptions(
                pre_search_results=results,
                conversation_context="历史：用户问过X，助手答了Y",
                is_follow_up=False,
            ),
        ))
        user = llm.calls[0][1]["content"]
        assert "## 对话历史" in user
        assert "历史：用户问过X，助手答了Y" in user


# ------------------------------------------------------------
# 降级 / 异常
# ------------------------------------------------------------


class TestFallbackAndErrors:
    def test_no_llm_emits_no_llm_without_done(self):
        results = [make_result("C1", 0.9)]
        stream = create_rag_chat_stream(
            {
                "llm": FakeLlm(available=False),
                "reranker_factory": lambda: FakeReranker(),
                "hybrid_search": lambda *a, **k: results,
            }
        )
        events = collect(stream("问题", RagChatOptions(pre_search_results=results)))

        assert isinstance(events[0], RagContextEvent)
        assert isinstance(events[1], RagNoLlmEvent)
        assert events[1].results == results
        assert len(events) == 2
        assert not any(isinstance(e, RagDoneEvent) for e in events)

    def test_empty_retrieval_no_entity_docs_errors(self):
        stream, _, _, _ = make_stream(hybrid=[])
        events = collect(stream("冷门问题", RagChatOptions(top_k=5)))

        assert len(events) == 1
        assert isinstance(events[0], RagErrorEvent)
        assert "未找到相关文档" in events[0].content

    def test_hybrid_exception_errors(self):
        stream, _, _, calls = make_stream(hybrid=RuntimeError("index missing"))
        events = collect(stream("问题"))

        assert len(events) == 1
        assert isinstance(events[0], RagErrorEvent)
        assert "文档检索失败" in events[0].content
        # 固定召回参数 20/20，top_k 透传
        assert calls[0]["top_k"] == 5
        assert calls[0]["vec_k"] == 20
        assert calls[0]["bm25_k"] == 20
        assert isinstance(calls[0]["options"], HybridSearchOptions)

    def test_hybrid_receives_matched_keywords(self):
        results = [make_result("C1", 0.9)]
        stream, _, _, calls = make_stream(hybrid=results)
        collect(stream("问题", RagChatOptions(matched_keywords=["华润置地"])))
        assert calls[0]["options"].matched_keywords == ["华润置地"]

    def test_llm_stream_exception_errors(self):
        results = [make_result("C1", 0.9)]
        llm = FakeLlm(raise_exc=RuntimeError("llm down"))
        stream = create_rag_chat_stream(
            {
                "llm": llm,
                "reranker_factory": lambda: FakeReranker(),
                "hybrid_search": lambda *a, **k: results,
            }
        )
        events = collect(stream("问题", RagChatOptions(pre_search_results=results)))

        assert isinstance(events[0], RagContextEvent)
        assert isinstance(events[1], RagErrorEvent)
        assert "LLM 调用失败" in events[1].content
        assert "llm down" in events[1].content

    def test_entity_docs_empty_results_does_not_error_with_no_llm(self):
        stream = create_rag_chat_stream(
            {
                "llm": FakeLlm(available=False),
                "reranker_factory": lambda: FakeReranker(),
                "hybrid_search": lambda *a, **k: pytest.fail("不应调用混合检索"),
            }
        )
        events = collect(stream(
            "华润置地",
            RagChatOptions(entity_docs_content="实体全文"),
        ))
        assert isinstance(events[0], RagContextEvent)
        assert events[0].results == []
        assert isinstance(events[1], RagNoLlmEvent)

    def test_empty_token_chunks_skipped(self):
        results = [make_result("C1", 0.9)]
        llm = FakeLlm(tokens=("", "有效", "", "结尾"))
        stream = create_rag_chat_stream(
            {
                "llm": llm,
                "reranker_factory": lambda: FakeReranker(),
                "hybrid_search": lambda *a, **k: results,
            }
        )
        events = collect(stream("问题", RagChatOptions(pre_search_results=results)))
        token_events = [e for e in events if isinstance(e, RagTokenEvent)]
        assert [e.content for e in token_events] == ["有效", "结尾"]
