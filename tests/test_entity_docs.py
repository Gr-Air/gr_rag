"""entity_docs 测试。

- filter_chunks_by_doc_types（docType → chunkId 白名单）
- FsDocumentFileStore 真实文件读取（repo-relative 前缀 / 路径逃逸防护）
- `load_entity_docs_content_for_eval` 见 test_eval_entity_docs.py
"""

from __future__ import annotations

from server.rag.chat.document_store import FsDocumentFileStore
from server.rag.chat.entity_docs import filter_chunks_by_doc_types


class FakeMeta:
    def __init__(self, metadata):
        self.metadata = metadata


class FakeChunkStore:
    def __init__(self, items):
        self._items = items

    def get_all(self):
        return dict(self._items)


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

    def test_read_wiki_doc_with_repo_relative_prefix(self, tmp_path):
        """struct_kb.db 里存的是 `Wiki/concept/x.md`，不得与 wiki_dir 拼成双前缀。"""
        wiki_root = tmp_path / "Wiki"
        concept = wiki_root / "concept"
        concept.mkdir(parents=True)
        (concept / "数据中台.md").write_text("词条全文", encoding="utf-8")

        store = FsDocumentFileStore(raw_dir=tmp_path / "Raw", wiki_dir=wiki_root)
        assert store.read_wiki_doc("Wiki/concept/数据中台.md") == "词条全文"
        assert store.read_wiki_doc("concept/数据中台.md") == "词条全文"

    def test_read_wiki_doc_rejects_path_escape(self, tmp_path):
        wiki_root = tmp_path / "Wiki"
        wiki_root.mkdir()
        (tmp_path / "secret.md").write_text("不该被读到", encoding="utf-8")
        store = FsDocumentFileStore(raw_dir=tmp_path / "Raw", wiki_dir=wiki_root)
        assert store.read_wiki_doc("../secret.md") is None
