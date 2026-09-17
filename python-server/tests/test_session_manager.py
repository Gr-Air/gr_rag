"""会话管理测试（翻译自 test/sessionManager.test.ts）。"""

import re

import pytest

from server.rag.chat import sessions
from server.rag.chat.sessions import (
    add_message,
    clear_all_sessions,
    compress_conversation,
    create_session,
    delete_session,
    get_active_session_count,
    get_conversation_context,
    get_last_search_results,
    get_or_create_session,
    get_session,
    is_follow_up_query,
    save_last_search_results,
)
from server.rag.types import DocChunk, Scores, SearchResult


@pytest.fixture(autouse=True)
def _isolate():
    clear_all_sessions()
    yield
    clear_all_sessions()


def make_result():
    return SearchResult(
        chunk=DocChunk(
            id="1",
            doc_id="doc_1",
            doc_title="Test",
            doc_path="Raw/doc_1.md",
            chunk_index=0,
            content="test",
        ),
        score=0.9,
        scores=Scores(rrf=0.0328),
        source="hybrid",
    )


# ---------- createSession ----------

def test_create_unique_ids():
    s1, s2 = create_session(), create_session()
    assert s1.id != s2.id
    assert re.match(r"^sess_", s1.id)


def test_session_default_fields():
    s = create_session()
    assert s.messages == []
    assert s.created_at > 0
    assert s.updated_at > 0
    assert get_session(s.id).id == s.id


# ---------- getOrCreateSession ----------

def test_get_or_create_existing():
    s = create_session()
    assert get_or_create_session(s.id).id == s.id


def test_get_or_create_unknown_creates_new():
    s = get_or_create_session("nonexistent")
    assert s.id != "nonexistent"


def test_get_or_create_none_creates_new():
    assert re.match(r"^sess_", get_or_create_session().id)


# ---------- addMessage ----------

def test_add_messages():
    s = create_session()
    add_message(s.id, "user", "什么是微服务")
    add_message(s.id, "assistant", "微服务是一种架构风格...")

    retrieved = get_session(s.id)
    assert len(retrieved.messages) == 2
    assert retrieved.messages[0].role == "user"
    assert retrieved.messages[0].content == "什么是微服务"
    assert retrieved.messages[1].role == "assistant"


def test_message_timestamp():
    s = create_session()
    add_message(s.id, "user", "test")
    assert get_session(s.id).messages[0].timestamp > 0


def test_add_message_unknown_session_no_throw():
    add_message("nonexistent", "user", "test")  # 不抛异常即可


# ---------- lastSearchResults ----------

def test_save_and_get_last_results():
    s = create_session()
    save_last_search_results(s.id, "微服务", [make_result()], "rrf")

    saved = get_last_search_results(s.id)
    assert saved.query == "微服务"
    assert saved.method == "rrf"
    assert len(saved.results) == 1


def test_scores_round_trip():
    r = make_result()
    r.scores = Scores(vector=0.95, bm25=10, rrf=0.0328, rerank=0.92)
    s = create_session()
    save_last_search_results(s.id, "查询", [r], "rrf")

    saved = get_last_search_results(s.id).results[0]
    assert saved.scores.vector == 0.95
    assert saved.scores.bm25 == 10
    assert saved.scores.rrf == 0.0328
    assert saved.scores.rerank == 0.92


def test_get_last_results_unknown_session():
    assert get_last_search_results("nonexistent") is None


# ---------- isFollowUpQuery ----------

@pytest.mark.parametrize(
    "query",
    ["那第二个呢？", "详细说说", "还有呢", "它和Redis比呢", "上面提到的是什么",
     "继续说", "能详细说说吗", "什么意思"],
)
def test_followup_detected(query):
    assert is_follow_up_query(query) is True


@pytest.mark.parametrize(
    "query",
    ["微服务架构的核心设计原则是什么", "Redis是什么", "国家电网的项目有哪些", ""],
)
def test_followup_not_detected(query):
    assert is_follow_up_query(query) is False


# ---------- getConversationContext ----------

def test_context_empty_session():
    s = create_session()
    ctx = get_conversation_context(s.id)
    assert ctx.history_text == ""
    assert ctx.has_follow_up is False


def test_context_with_history():
    s = create_session()
    add_message(s.id, "user", "什么是微服务")
    add_message(s.id, "assistant", "微服务是一种架构风格")

    text = get_conversation_context(s.id).history_text
    assert "什么是微服务" in text
    assert "微服务是一种架构风格" in text


def test_context_has_followup_flag():
    s = create_session()
    add_message(s.id, "user", "什么是微服务")
    add_message(s.id, "assistant", "微服务是...")
    add_message(s.id, "user", "那它的优缺点呢")

    assert get_conversation_context(s.id).has_follow_up is True


def test_context_unknown_session():
    assert get_conversation_context("nonexistent").history_text == ""


def test_context_assistant_truncated_to_300():
    s = create_session()
    long_answer = "答" * 500
    add_message(s.id, "user", "问题")
    add_message(s.id, "assistant", long_answer)

    text = get_conversation_context(s.id).history_text
    assert "..." in text
    assert "答" * 500 not in text


# ---------- delete / count / clear ----------

def test_delete_session():
    s = create_session()
    delete_session(s.id)
    assert get_session(s.id) is None


def test_delete_unknown_no_throw():
    delete_session("nonexistent")


def test_active_count():
    assert get_active_session_count() == 0
    create_session()
    assert get_active_session_count() == 1
    create_session()
    create_session()
    assert get_active_session_count() == 3


def test_clear_all():
    create_session()
    create_session()
    clear_all_sessions()
    assert get_active_session_count() == 0


# ---------- compressConversation ----------

class FakeLlm:
    def __init__(self, summary=None):
        self.available = True
        self._summary = summary
        self.calls = []

    def complete(self, messages, temperature=None, max_tokens=None):
        self.calls.append(messages)
        return self._summary


def test_compress_below_threshold_skipped():
    llm = FakeLlm("摘要")
    s = create_session()
    add_message(s.id, "user", "a")
    assert compress_conversation(s.id, llm) is None
    assert llm.calls == []


def test_compress_no_llm_skipped():
    class NoLlm:
        available = False

    s = create_session()
    for i in range(6):
        add_message(s.id, "user", f"m{i}")
    assert compress_conversation(s.id, NoLlm()) is None


def test_compress_replaces_old_messages():
    llm = FakeLlm("这是摘要")
    s = create_session()
    for i in range(6):
        add_message(s.id, "user" if i % 2 == 0 else "assistant", f"m{i}")

    result = compress_conversation(s.id, llm)
    assert result == "这是摘要"
    assert get_session(s.id).summary == "这是摘要"
    assert len(get_session(s.id).messages) == 2


def test_compress_failure_returns_none():
    class BoomLlm:
        available = True

        def complete(self, *a, **k):
            raise RuntimeError("llm down")

    s = create_session()
    for i in range(6):
        add_message(s.id, "user", f"m{i}")
    assert compress_conversation(s.id, BoomLlm()) is None
    # 失败不影响原消息
    assert len(get_session(s.id).messages) == 6
