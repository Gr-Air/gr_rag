"""load_entity_docs_content_for_eval 测试（entityDocs.ts eval 变体）。

- 双向降级：多实体 AND 空→OR；单词条 OR 空也重试 AND
- 判据是 chunks 非空（struct_results 有条目但 chunks=[] 也要降级）
- wiki_ 前缀 chunk → wikiEntries（含 concept 条目补路径）
- parts 顺序：先 Wiki 全文后 Raw；sources = Raw 名 + Wiki 名
- 全部为空 / struct 未就绪 → None
"""

from __future__ import annotations

from server.rag.chat.entity_docs import load_entity_docs_content_for_eval


class FakeStruct:
    def __init__(self, ready=True, script=None):
        self._ready = ready
        self._script = list(script) if script is not None else None
        self.calls: list[tuple] = []

    def is_ready(self):
        return self._ready

    def query(self, names, mode):
        self.calls.append((list(names), mode))
        if self._script is not None:
            return self._script.pop(0)
        return []


class FakeFileStore:
    def __init__(self, raw=None, wiki=None):
        self._raw = raw or {}
        self._wiki = wiki or {}
        self.wiki_reads: list[str] = []

    def read_raw_doc(self, name):
        return self._raw.get(name)

    def read_wiki_doc(self, path):
        self.wiki_reads.append(path)
        return self._wiki.get(path)


def _entity(name="万科集团", path="", type_="entity"):
    return {"id": 1, "name": name, "type": type_, "category": "客户企业",
            "frequency": 1, "path": path}


def test_not_ready_returns_none():
    assert load_entity_docs_content_for_eval(
        FakeStruct(ready=False), FakeFileStore(), ["万科集团"]
    ) is None


def test_single_keyword_or_empty_retries_and():
    struct = FakeStruct(script=[
        [{"entry": _entity(), "chunks": []}],
        [{"entry": _entity(), "chunks": [{"chunk_id": "raw_万科_0"}]}],
    ])
    store = FakeFileStore(raw={"万科": "万科内容。"})
    result = load_entity_docs_content_for_eval(struct, store, ["万科集团"])
    assert result is not None
    assert struct.calls == [(["万科集团"], "or"), (["万科集团"], "and")]


def test_multi_keyword_and_empty_falls_back_or():
    struct = FakeStruct(script=[
        [],
        [{"entry": _entity(), "chunks": [{"chunk_id": "raw_万科_0"}]}],
    ])
    store = FakeFileStore(raw={"万科": "万科内容。"})
    result = load_entity_docs_content_for_eval(struct, store, ["万科集团", "华润置地"])
    assert result is not None
    assert struct.calls[0][1] == "and" and struct.calls[1][1] == "or"


def test_still_no_chunks_after_retry_returns_none():
    struct = FakeStruct(script=[
        [{"entry": _entity(), "chunks": []}],
        [{"entry": _entity(), "chunks": []}],
    ])
    assert load_entity_docs_content_for_eval(struct, FakeFileStore(), ["万科集团"]) is None


def test_wiki_before_raw_and_sources_order():
    struct = FakeStruct(script=[
        [
            {
                "entry": _entity(name="万科集团"),
                "chunks": [
                    {"chunk_id": "raw_万科文档_0"},
                    {"chunk_id": "wiki_万科词条_0"},
                ],
            },
            {
                "entry": _entity(name="华润", type_="concept", path="Wiki/concept/华润.md"),
                "chunks": [],
            },
        ]
    ])
    store = FakeFileStore(
        raw={"万科文档": "Raw 正文。"},
        wiki={"Wiki/concept/华润.md": "华润词条全文。"},
    )
    result = load_entity_docs_content_for_eval(struct, store, ["万科集团"])

    assert result is not None
    # readWikiDoc 按 wikiEntries 插入序调用；空 path 也照传（TS 同样拼 null）
    assert store.wiki_reads == ["", "Wiki/concept/华润.md"]
    # parts：先 Wiki 后 Raw
    wiki_pos = result.docs_content.index("### Wiki 词条：华润")
    raw_pos = result.docs_content.index("### 万科文档")
    assert wiki_pos < raw_pos
    # sources：先 Raw 名后 Wiki 词条名（entry.name，保序去重）
    assert result.sources == ["万科文档", "万科集团", "华润"]


def test_wiki_links_cleaned_in_wiki_part():
    struct = FakeStruct(script=[
        [{"entry": _entity(name="X"), "chunks": [{"chunk_id": "wiki_X_0"}]}],
    ])
    store = FakeFileStore(wiki={"": "含[[内部链接]]。"})
    # entry.path 为空串 → readWikiDoc("") 命中 fake
    result = load_entity_docs_content_for_eval(struct, store, ["X"])
    assert result is not None
    assert "内部链接" in result.docs_content and "[[" not in result.docs_content


def test_all_raw_missing_and_wiki_null_returns_none():
    struct = FakeStruct(script=[
        [{"entry": _entity(), "chunks": [{"chunk_id": "raw_缺失_0"}]}],
    ])
    # read_wiki_doc 默认返回 None；Raw 也没有
    assert load_entity_docs_content_for_eval(struct, FakeFileStore(), ["万科集团"]) is None
