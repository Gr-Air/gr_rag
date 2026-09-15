"""entity_docs 测试（对应 TS entityDocs.ts chat 变体）。

- chunk_id 解析（去尾号 / raw_ 前缀 / 非 raw 忽略）
- 短文档全文注入、长文档片段提取、多文档分隔、文件缺失降级
- AND 空 → OR 降级；struct 未就绪 / 无结果 → None
- filter_chunks_by_doc_types
- FsDocumentFileStore 真实文件读取
"""

from __future__ import annotations

from server.rag.chat.document_store import FsDocumentFileStore
from server.rag.chat.entity_docs import (
    filter_chunks_by_doc_types,
    load_entity_docs_content,
)


class FakeStruct:
    def __init__(self, ready=True, script=None, fixed=None):
        self._ready = ready
        # script: 按调用次序返回；fixed: 固定返回
        self._script = script
        self._fixed = fixed
        self.calls: list[tuple] = []

    def is_ready(self):
        return self._ready

    def query(self, names, mode):
        self.calls.append((list(names), mode))
        if self._script is not None:
            return self._script.pop(0)
        return self._fixed if self._fixed is not None else []


class FakeFileStore:
    def __init__(self, docs=None):
        self._docs = docs or {}

    def read_raw_doc(self, name):
        return self._docs.get(name)


class FakeMeta:
    def __init__(self, metadata):
        self.metadata = metadata


class FakeChunkStore:
    def __init__(self, items):
        self._items = items

    def get_all(self):
        return dict(self._items)


# ------------------------------------------------------------
# load_entity_docs_content
# ------------------------------------------------------------


class TestLoadEntityDocs:
    def test_struct_not_ready_returns_none(self):
        assert load_entity_docs_content(
            FakeStruct(ready=False), FakeFileStore(), ["华润置地"]
        ) is None

    def test_no_results_returns_none(self):
        struct = FakeStruct(fixed=[])
        assert load_entity_docs_content(struct, FakeFileStore(), ["华润置地"]) is None
        assert struct.calls == [(["华润置地"], "or")]

    def test_and_empty_falls_back_to_or(self):
        struct = FakeStruct(script=[[], [{"chunks": [{"chunk_id": "raw_Redis_0"}]}]])
        store = FakeFileStore(docs={"Redis": "Redis 内容"})
        result = load_entity_docs_content(struct, store, ["Redis", "MySQL"])
        assert result is not None
        assert struct.calls == [(["Redis", "MySQL"], "and"), (["Redis", "MySQL"], "or")]
        assert "Redis" in result.docs_content

    def test_short_doc_full_text_with_cleaned_links(self):
        struct = FakeStruct(fixed=[{"chunks": [{"chunk_id": "raw_华润置地_3"}]}])
        store = FakeFileStore(docs={"华润置地": "# 华润置地\n详见[[集团组织]]架构。"})

        result = load_entity_docs_content(struct, store, ["华润置地"])

        assert result is not None
        assert result.docs_content.startswith("### 华润置地（全文，")
        assert "集团组织" in result.docs_content
        assert "[[" not in result.docs_content

    def test_non_raw_chunk_ids_ignored(self):
        struct = FakeStruct(fixed=[{"chunks": [{"chunk_id": "wiki_某概念_0"}]}])
        result = load_entity_docs_content(struct, FakeFileStore(), ["某概念"])
        assert result is None

    def test_mixed_raw_and_non_raw(self):
        struct = FakeStruct(fixed=[{
            "chunks": [
                {"chunk_id": "wiki_某概念_0"},
                {"chunk_id": "raw_华润置地_1"},
            ]
        }])
        store = FakeFileStore(docs={"华润置地": "短内容"})
        result = load_entity_docs_content(struct, store, ["x"])
        assert result is not None
        assert "华润置地" in result.docs_content
        assert "某概念" not in result.docs_content

    def test_missing_raw_file_returns_none(self):
        struct = FakeStruct(fixed=[{"chunks": [{"chunk_id": "raw_不存在_0"}]}])
        result = load_entity_docs_content(struct, FakeFileStore(docs={}), ["x"])
        assert result is None

    def test_multiple_docs_joined_with_separator(self):
        struct = FakeStruct(fixed=[{
            "chunks": [
                {"chunk_id": "raw_文档甲_0"},
                {"chunk_id": "raw_文档乙_0"},
            ]
        }])
        store = FakeFileStore(docs={"文档甲": "甲内容", "文档乙": "乙内容"})
        result = load_entity_docs_content(struct, store, ["x"])
        assert result is not None
        assert "### 文档甲（全文，" in result.docs_content
        assert "### 文档乙（全文，" in result.docs_content
        assert "\n\n---\n\n" in result.docs_content

    def test_long_doc_uses_snippets(self):
        # >3000 token：约 4500 CJK 字符；两处提及相距 >1100 字符形成两个片段
        content = (
            "开头铺垫"
            + "啊" * 500 + "华润置地"
            + "哦" * 2000 + "华润置地"
            + "尾" * 2000
        )
        struct = FakeStruct(fixed=[{"chunks": [{"chunk_id": "raw_长文档_0"}]}])
        store = FakeFileStore(docs={"长文档": content})

        result = load_entity_docs_content(struct, store, ["华润置地"])

        assert result is not None
        assert "长文档片段提取" in result.docs_content
        assert "全文" not in result.docs_content
        assert "片段 1" in result.docs_content
        assert "片段 2" in result.docs_content
        assert "华润置地" in result.docs_content

    def test_long_doc_without_keyword_mention_skipped(self):
        # 长文档但内容不含实体词，snippets 返回 None，整体 None
        content = "啊" * 5000
        struct = FakeStruct(fixed=[{"chunks": [{"chunk_id": "raw_长文档_0"}]}])
        store = FakeFileStore(docs={"长文档": content})
        result = load_entity_docs_content(struct, store, ["华润置地"])
        assert result is None


# ------------------------------------------------------------
# filter_chunks_by_doc_types
# ------------------------------------------------------------


class TestFilterByDocTypes:
    def test_empty_types_returns_none(self):
        assert filter_chunks_by_doc_types(FakeChunkStore({}), []) is None

    def test_matches(self):
        store = FakeChunkStore({
            "c1": FakeMeta({"docType": "技术方案"}),
            "c2": FakeMeta({"docType": "来往账目"}),
            "c3": FakeMeta({"docType": "技术方案"}),
            "c4": FakeMeta({}),
            "c5": FakeMeta({"docType": ""}),
        })
        assert filter_chunks_by_doc_types(store, ["技术方案"]) == ["c1", "c3"]

    def test_no_match_returns_none(self):
        store = FakeChunkStore({"c1": FakeMeta({"docType": "来往账目"})})
        assert filter_chunks_by_doc_types(store, ["技术方案"]) is None


# ------------------------------------------------------------
# FsDocumentFileStore
# ------------------------------------------------------------


class TestFsDocumentFileStore:
    def test_read_raw_doc(self, tmp_path):
        (tmp_path / "甲.md").write_text("# 甲\n内容", encoding="utf-8")
        store = FsDocumentFileStore(raw_dir=tmp_path, wiki_dir=tmp_path)
        assert store.read_raw_doc("甲") == "# 甲\n内容"

    def test_read_raw_missing_returns_none(self, tmp_path):
        store = FsDocumentFileStore(raw_dir=tmp_path, wiki_dir=tmp_path)
        assert store.read_raw_doc("不存在") is None

    def test_read_wiki_doc(self, tmp_path):
        sub = tmp_path / "子目录"
        sub.mkdir()
        (sub / "页.md").write_text("wiki 内容", encoding="utf-8")
        store = FsDocumentFileStore(raw_dir=tmp_path, wiki_dir=tmp_path)
        assert store.read_wiki_doc("子目录/页.md") == "wiki 内容"

    def test_read_wiki_missing_returns_none(self, tmp_path):
        store = FsDocumentFileStore(raw_dir=tmp_path, wiki_dir=tmp_path)
        assert store.read_wiki_doc("缺.md") is None
