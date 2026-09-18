"""Tantivy BM25 检索引擎（Spec 038 升级：替换自研 BM25）。

设计要点：
- 复用项目 jieba 分词（tokenize_all_filtered / tokenize_filtered），保证"两侧同口径"
- 用空格 join 中文 token 后喂给 tantivy，tantivy 走 default tokenizer 按空格切
- 既用上 tantivy 的 BM25 + 倒排 + 持久化 + mmap，又保住 98 条 custom_words 词典约束
- 索引路径：{data_dir}/tantivy_bm25/

BM25 公式：Lucene 同款（k1=1.2, b=0.75，tantivy 0.26 默认值）。
原自研 bm25_engine.py 用 k1=1.5, b=0.75；tantivy Python 绑定 0.26 未暴露 BM25 调参接口，
故统一走 tantivy 默认（与 Lucene/Elasticsearch 默认一致）。

接口形态完全兼容 BM25Engine.search(query, top_k) → [{chunkId, score}]
"""

from __future__ import annotations

import shutil
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import tantivy

from ....config import get_settings
from .tokenizer import tokenize_all_filtered, tokenize_filtered


# Schema 字段名（Schema 一旦建好不能再改字段名）
_FIELD_CONTENT = "content"   # 索引字段：jieba 切好后空格 join 的文本
_FIELD_CHUNK_ID = "chunk_id" # 索引字段：chunk 的唯一标识（stored，不分词）


# ============================================================
# Schema 工厂
# ============================================================

def _make_schema() -> tantivy.Schema:
    """创建 Schema：content 走 default 分词（按空格切），chunk_id 不分词原样存。"""
    builder = tantivy.SchemaBuilder()
    builder.add_text_field(_FIELD_CONTENT, stored=False)  # 不存原始文本，省空间
    builder.add_text_field(_FIELD_CHUNK_ID, stored=True, tokenizer_name="raw")
    return builder.build()


# ============================================================
# 索引构建（离线，P1 / build_index 阶段调用）
# ============================================================

def build_tantivy_index(
    chunks: Iterable[dict],
    content_key: str = "content",
    chunk_id_key: str = "id",
    tantivy_dir: Path | None = None,
    overwrite: bool = True,
    heap_size: int = 128_000_000,
) -> "TantivyBM25Engine":
    """从 chunk 列表构建 tantivy BM25 索引。

    Args:
        chunks: 每个元素需有 chunk_id_key + content_key 两个字段
        content_key: 文本内容字段名
        chunk_id_key: chunk ID 字段名
        tantivy_dir: 索引目录（默认 {data_dir}/tantivy_bm25）
        overwrite: True=删旧重建；False=保留并增量写入
        heap_size: writer 堆内存（字节），默认 128MB

    Returns:
        TantivyBM25Engine 实例
    """
    settings = get_settings()
    tantivy_dir = tantivy_dir or (settings.data_dir / "tantivy_bm25")

    if overwrite and tantivy_dir.exists():
        shutil.rmtree(tantivy_dir)
    tantivy_dir.mkdir(parents=True, exist_ok=True)

    schema = _make_schema()
    index = tantivy.Index(schema, path=str(tantivy_dir))

    writer = index.writer(heap_size=heap_size)

    doc_count = 0
    for chunk in chunks:
        content = chunk[content_key]
        if not content:
            continue
        # 关键：用 jieba 切好词、空格 join 后再喂 tantivy
        tokens = tokenize_all_filtered(content)
        indexed_text = " ".join(tokens)

        writer.add_document(
            tantivy.Document(
                **{_FIELD_CONTENT: indexed_text, _FIELD_CHUNK_ID: str(chunk[chunk_id_key])}
            )
        )
        doc_count += 1

    writer.commit()
    writer.wait_merging_threads()
    index.reload()

    engine = TantivyBM25Engine(tantivy_dir)
    engine._index = index
    engine._doc_count = doc_count
    return engine


# ============================================================
# 检索引擎
# ============================================================

class TantivyBM25Engine:
    """Tantivy BM25 引擎（接口与自研 BM25Engine.search 完全兼容）。

    使用示例：
        # 离线构建（indexing/cli.py 阶段）：
        engine = build_tantivy_index(all_chunks)

        # 运行时（多进程单例）：
        engine = get_tantivy_bm25_engine()
        results = engine.search("微服务架构", top_k=10)
        # → [{"chunkId": "abc-123", "score": 1.488}, ...]
    """

    def __init__(self, tantivy_dir: Path | None = None) -> None:
        settings = get_settings()
        self._dir = tantivy_dir or (settings.data_dir / "tantivy_bm25")
        self._index: tantivy.Index | None = None
        self._doc_count: int = 0

    def _ensure_loaded(self) -> tantivy.Index:
        """懒加载索引（首次 search 时才打开磁盘）。"""
        if self._index is not None:
            return self._index
        if not self._dir.exists():
            return None  # type: ignore[return-value]
        schema = _make_schema()
        self._index = tantivy.Index(schema, path=str(self._dir))
        return self._index

    def search(self, query: str, top_k: int = 20) -> list[dict]:
        """BM25 检索。返回 [{"chunkId": str, "score": float}, ...]。

        查询侧：jieba 切词 + 空格 join → tantivy.parse_query，保证与索引构建侧同口径。
        """
        index = self._ensure_loaded()
        if index is None:
            return []

        searcher = index.searcher()

        # === 查询侧：jieba 切词 + 空格 join（与索引侧"同口径"）===
        query_tokens = tokenize_filtered(query)
        if not query_tokens:
            return []
        query_text = " ".join(query_tokens)
        # ============================================================

        parsed = index.parse_query(query_text, [_FIELD_CONTENT])
        results_obj = searcher.search(parsed, limit=top_k)

        results: list[dict] = []
        for score, doc_address in results_obj.hits:
            doc = searcher.doc(doc_address)
            chunk_ids = doc[_FIELD_CHUNK_ID]  # list[str]
            if not chunk_ids:
                continue
            results.append({"chunkId": chunk_ids[0], "score": float(score)})
        return results

    def is_ready(self) -> bool:
        return self._dir.exists()

    @property
    def doc_count(self) -> int:
        return self._doc_count


# ============================================================
# 进程内单例（与原 BM25Engine.get_bm25_engine 对齐）
# ============================================================

@lru_cache(maxsize=1)
def get_tantivy_bm25_engine() -> TantivyBM25Engine:
    return TantivyBM25Engine()