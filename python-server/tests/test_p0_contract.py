"""P0 契约冒烟测试：5 个桩接口的形状与状态码。

运行（server/ 目录下）：pytest
"""

from fastapi.testclient import TestClient

from server.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_chat_empty_query_400():
    r = client.post("/api/chat", json={"query": "   "})
    assert r.status_code == 400


def test_chat_sse_event_sequence(monkeypatch):
    """P3：chat 内核用 fake 注入，路由负责 SSE 帧映射（六类事件）。"""
    import json

    import server.routers.chat as chat_module
    from server.rag.chat.types import (
        ChatDoneEvent,
        ChatMethodEvent,
        ChatTokenEvent,
    )

    class FakeChatService:
        def chat(self, query, options):
            assert query == "测试问题" and options.top_k == 10
            yield ChatMethodEvent(
                method="rrf", session_id="s1", rewrite_method="fallback"
            )
            yield ChatTokenEvent(content="答案片段")
            yield ChatDoneEvent(session_id="s1")

    class FakeLlm:
        available = False

    monkeypatch.setattr(chat_module, "is_index_ready", lambda: True)
    monkeypatch.setattr(chat_module, "get_chat_service", lambda: FakeChatService())
    monkeypatch.setattr(chat_module, "create_request_llm", lambda *a, **k: FakeLlm())

    r = client.post("/api/chat", json={"query": "测试问题", "sessionId": "s1"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")

    frames = [line for line in r.text.splitlines() if line.startswith("data: ")]
    payloads = [json.loads(line[6:]) for line in frames]
    assert [p["type"] for p in payloads] == ["method", "token", "done"]
    assert payloads[0]["sessionId"] == "s1"
    assert payloads[0]["rewriteMethod"] == "fallback"
    # exclude_none：undefined 字段不上线（与 JSON.stringify 一致）
    assert "matchedKeywords" not in payloads[0]
    assert payloads[1] == {"type": "token", "content": "答案片段"}


def test_chat_503_when_index_not_ready(monkeypatch):
    import server.routers.chat as chat_module

    monkeypatch.setattr(chat_module, "is_index_ready", lambda: False)
    r = client.post("/api/chat", json={"query": "测试"})
    assert r.status_code == 503
    assert "索引尚未初始化" in r.text


def test_search_validation_and_shape(monkeypatch):
    import server.routers.search as search_module
    from server.rag.types import DocChunk, Scores, SearchResult
    from server.rag.retrieve.entity_search import RoutedSearchResult

    assert client.get("/api/search?q=").status_code == 400

    fake_hit = SearchResult(
        chunk=DocChunk(
            id="doc1_0",
            doc_id="doc1",
            doc_title="测试文档",
            doc_path="测试文档.md",
            chunk_index=0,
            content="内容",
        ),
        score=0.9,
        scores=Scores(rrf=0.02),
        source="rrf",
    )

    class FakeEntitySearch:
        def routed_search(self, query, top_k, force_method=None):
            assert query == "测试" and top_k == 10
            return RoutedSearchResult(
                results=[fake_hit], method="rrf", matched_keywords=None
            )

    monkeypatch.setattr(search_module, "is_index_ready", lambda: True)
    monkeypatch.setattr(
        search_module, "get_entity_search", lambda: FakeEntitySearch()
    )

    r = client.get("/api/search?q=%E6%B5%8B%E8%AF%95&topK=10")
    body = r.json()
    assert body["query"] == "测试"
    assert body["method"] == "rrf"
    assert body["total"] == 1
    assert body["results"][0]["id"] == "doc1_0"
    assert body["results"][0]["scores"] == {"rrf": 0.02}
    assert "matchedKeywords" not in body


def test_search_503_when_index_not_ready(monkeypatch):
    import server.routers.search as search_module

    monkeypatch.setattr(search_module, "is_index_ready", lambda: False)
    r = client.get("/api/search?q=测试")
    assert r.status_code == 503
    assert "索引尚未初始化" in r.json()["error"]


def test_stats_shape(monkeypatch):
    import server.routers.stats as stats_module

    class FakeKbInfo:
        def get_wiki_stats(self):
            return {
                "totalDocs": 3,
                "totalChunks": 9,
                "totalConcepts": 2,
                "totalEntities": 1,
                "totalClients": 1,
                "totalProjects": 1,
                "totalDocTypes": 1,
                "topConcepts": [],
                "topEntities": [],
                "clients": ["客户"],
                "projects": ["项目"],
                "docTypes": ["类型"],
            }

    monkeypatch.setattr(stats_module, "get_kb_info", lambda: FakeKbInfo())
    monkeypatch.setattr(stats_module, "is_index_ready", lambda: True)
    monkeypatch.setattr(stats_module, "is_struct_db_ready", lambda: True)
    monkeypatch.setattr(
        stats_module,
        "get_struct_engine",
        lambda: type("S", (), {"get_struct_stats": lambda self: {"totalEntries": 1}})(),
    )
    monkeypatch.setattr(
        stats_module,
        "read_manifest",
        lambda p: {"indexVersion": 7, "builtAt": "T", "buildMode": "full"},
    )

    stats = client.get("/api/stats").json()
    assert stats["totalDocs"] == 3
    assert stats["indexReady"] is True
    assert stats["structDbReady"] is True
    assert stats["structStats"] == {"totalEntries": 1}
    assert stats["indexVersion"] == 7
    assert isinstance(stats["indexVersion"], int)
    assert stats["indexBuiltAt"] == "T"


def test_stats_500_on_error(monkeypatch):
    import server.routers.stats as stats_module

    class BoomKb:
        def get_wiki_stats(self):
            raise RuntimeError("磁盘故障")

    monkeypatch.setattr(stats_module, "get_kb_info", lambda: BoomKb())
    r = client.get("/api/stats")
    assert r.status_code == 500
    assert r.json() == {"error": "磁盘故障"}


def test_eval_400_empty_query():
    r = client.post("/api/eval", json={"query": "   "})
    assert r.status_code == 400
    assert r.json() == {"error": "请提供问题"}


def test_eval_503_when_index_not_ready(monkeypatch):
    import server.routers.eval as eval_module

    monkeypatch.setattr(eval_module, "is_index_ready", lambda: False)
    r = client.post("/api/eval", json={"query": "问题"})
    assert r.status_code == 503
    assert r.json() == {"error": "索引尚未初始化完成"}


def test_eval_success_shape(monkeypatch):
    import server.routers.eval as eval_module
    from server.rag.eval.eval_service import EvalResult

    class FakeLlm:
        available = False

    class FakeEvalService:
        def evaluate(self, options):
            assert options.query == "问题" and options.top_k == 5
            return EvalResult(
                query="问题",
                answer="未能生成回答",
                contexts=["ctx"],
                sources=["doc"],
                search_method="rrf",
                num_results=1,
                matched_entities=[],
                profile_id="struct",
                result_scores=[{"score": 0.5, "scores": {"rrf": 0.02}}],
            )

    monkeypatch.setattr(eval_module, "is_index_ready", lambda: True)
    monkeypatch.setattr(eval_module, "get_eval_service", lambda: FakeEvalService())
    monkeypatch.setattr(eval_module, "create_request_llm", lambda *a, **k: FakeLlm())

    r = client.post("/api/eval", json={"query": "问题", "topK": 5, "profileId": "struct"})
    assert r.status_code == 200
    body = r.json()
    assert body["searchMethod"] == "rrf"
    assert body["profileId"] == "struct"
    assert body["resultScores"] == [{"score": 0.5, "scores": {"rrf": 0.02}}]


def test_eval_500_full_error_body(monkeypatch):
    import server.routers.eval as eval_module

    class BoomEval:
        def evaluate(self, options):
            raise RuntimeError("检索爆炸")

    monkeypatch.setattr(eval_module, "is_index_ready", lambda: True)
    monkeypatch.setattr(eval_module, "get_eval_service", lambda: BoomEval())

    r = client.post("/api/eval", json={"query": "  问题  "})
    assert r.status_code == 500
    assert r.json() == {
        "query": "问题",
        "answer": "",
        "contexts": [],
        "sources": [],
        "searchMethod": "error",
        "numResults": 0,
        "matchedEntities": [],
        "error": "检索爆炸",
    }
