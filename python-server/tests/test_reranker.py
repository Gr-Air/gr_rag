"""reranker 测试（翻译自 test/reranker.test.ts + search-pipeline.test.ts Part 2）。

- rerank 分写入 scores.rerank，原始 RRF/vector 链路保留
- 阈值过滤后用未参与 API 的结果回补，回补项无 rerank 分
- 无 key 截断 / API 失败降级 / get_reranker 选择
"""

import pytest

from server.config import get_settings
from server.rag.retrieve import rerankers
from server.rag.retrieve.rerankers import NoopReranker, QwenReranker, get_reranker
from server.rag.types import DocChunk, Scores, SearchQuery, SearchResult


def make_result(cid: str, score: float, rrf: float) -> SearchResult:
    return SearchResult(
        chunk=DocChunk(
            id=cid,
            doc_id=f"doc_{cid}",
            doc_title=f"文档{cid}",
            doc_path=f"Raw/doc{cid}.md",
            chunk_index=0,
            content=f"文档{cid}的内容，长度足够参与重排序。",
        ),
        score=score,
        scores=Scores(rrf=rrf, vector=0.9),
        source="hybrid",
        highlight="test",
    )


class FakeResponse:
    def __init__(self, status_code=200, data=None, text=""):
        self.status_code = status_code
        self._data = data if data is not None else {}
        self.text = text

    def json(self):
        return self._data


class FakeHttpxClient:
    """记录 post 调用，返回预置 response。"""

    response: FakeResponse = FakeResponse()
    posts: list[dict] = []

    def __init__(self, timeout=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, headers=None, json=None):
        FakeHttpxClient.posts.append({"url": url, "headers": headers, "json": json})
        return FakeHttpxClient.response


@pytest.fixture(autouse=True)
def _fake_httpx(monkeypatch):
    FakeHttpxClient.posts = []
    FakeHttpxClient.response = FakeResponse()
    monkeypatch.setattr(rerankers.httpx, "Client", FakeHttpxClient)
    yield FakeHttpxClient


def test_rerank_writes_score_keeps_chain(_fake_httpx):
    _fake_httpx.response = FakeResponse(data={
        "results": [
            {"index": 0, "relevance_score": 0.92},
            {"index": 1, "relevance_score": 0.85},
        ],
    })

    output = QwenReranker(api_key="test-key").rerank(
        SearchQuery(query="查询"),
        [make_result("A", 0.90, 0.0328), make_result("B", 0.80, 0.0164),
         make_result("C", 0.70, 0.0082)],
        2,
    )

    a = next(r for r in output if r.chunk.id == "A")
    assert a.score == 0.92
    assert a.scores.rerank == 0.92
    assert a.scores.rrf == 0.0328
    assert a.scores.vector == 0.9


def test_rerank_threshold_filter_and_supplement(_fake_httpx):
    _fake_httpx.response = FakeResponse(data={
        "results": [
            {"index": 0, "relevance_score": 0.95},  # A 通过
            {"index": 1, "relevance_score": 0.30},  # B 低于 0.5 被过滤
        ],
    })

    output = QwenReranker(api_key="test-key").rerank(
        SearchQuery(query="查询"),
        [make_result("A", 0.90, 0.0328), make_result("B", 0.80, 0.0164),
         make_result("C", 0.70, 0.0082)],
        2,
    )

    assert len(output) == 2
    a = next(r for r in output if r.chunk.id == "A")
    assert a.scores.rerank == 0.95
    assert a.scores.rrf == 0.0328

    # B 被过滤且 index 已 used，不回补；回补未参与 rerank 的 C，分数链路不动
    assert not any(r.chunk.id == "B" for r in output)
    c = next(r for r in output if r.chunk.id == "C")
    assert c.score == 0.70
    assert c.scores.rerank is None
    assert c.scores.rrf == 0.0082


def test_no_api_key_skips_rerank_slices(_fake_httpx):
    output = QwenReranker(api_key="").rerank(
        SearchQuery(query="查询"),
        [make_result("A", 0.90, 0.0328), make_result("B", 0.80, 0.0164)],
        1,
    )

    assert len(output) == 1
    assert output[0].score == 0.90
    assert output[0].scores.rerank is None
    assert output[0].scores.rrf == 0.0328
    assert _fake_httpx.posts == []


def test_rerank_api_failure_fallback_sort(_fake_httpx):
    _fake_httpx.response = FakeResponse(status_code=500, text="server error")

    output = QwenReranker(api_key="test-key").rerank(
        SearchQuery(query="查询"),
        [make_result("A", 0.70, 0.0082), make_result("B", 0.90, 0.0328),
         make_result("C", 0.80, 0.0164)],
        2,
    )

    assert len(output) == 2
    assert output[0].chunk.id == "B"
    assert output[0].score == 0.90
    assert output[0].scores.rerank is None
    assert output[0].scores.rrf == 0.0328
    assert output[1].chunk.id == "C"


def test_noop_reranker_slices_in_order():
    results = [
        make_result(f"doc_{i}", 0.9 - i * 0.1, 0.03 - i * 0.001)
        for i in range(5)
    ]
    output = NoopReranker().rerank(SearchQuery(query="q"), results, 3)
    assert [r.chunk.id for r in output] == ["doc_0", "doc_1", "doc_2"]


def test_get_reranker_selection(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "dashscope_api_key", "")
    assert isinstance(get_reranker(), NoopReranker)

    monkeypatch.setattr(settings, "dashscope_api_key", "test-key")
    assert isinstance(get_reranker(), QwenReranker)
