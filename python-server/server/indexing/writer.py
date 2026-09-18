"""索引写入器（移植自 scripts/lib/indexWriter.cjs + buildIndex.cjs 的 LanceDB 段）。

输出：
- chunks_meta/shard_*.json + config.json
- tantivy_bm25/  Tantivy 自有持久化目录
- parents/parents.json
- vectors/config.json
- lancedb/chunks.lance（+ 按规模选择的向量索引：小数据跳过索引走暴力检索，
  中等规模 HNSW(SQ)，大规模 IVF_PQ；训练失败时降级暴力搜索）
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from typing import Any

import lancedb
from lancedb.index import HnswSq, IvfPq

from ..rag.retrieve.engines.bm25_tantivy import build_tantivy_index
from .chunker import Chunk

# --- 向量索引策略阈值（按向量条数分档）---
# 低于 BRUTE_FORCE_MAX：不建 ANN 索引，检索走精确暴力余弦（规模小、更快且召回 100%）
# BRUTE_FORCE_MAX ~ HNSW_MAX：HNSW + 标量量化，低延迟高召回、内存约为满向量的 1/4
# 高于 HNSW_MAX：IVF_PQ，PQ 压缩最省内存（代价是精度略降）
BRUTE_FORCE_MAX = 10_000
HNSW_MAX = 100_000


def _dump_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def _cleanup_extra_shards(d: Path, shard_count: int) -> None:
    if not d.exists():
        return
    for f in d.iterdir():
        if f.name.startswith("shard_") and f.name.endswith(".json"):
            idx = int(f.name.removeprefix("shard_").removesuffix(".json"))
            if idx >= shard_count:
                f.unlink()


def write_chunks_meta(chunks: list[Chunk], data_dir: Path, shard_size: int = 2000) -> int:
    meta_dir = data_dir / "chunks_meta"
    meta_dir.mkdir(parents=True, exist_ok=True)

    shard_idx = 0
    for i in range(0, len(chunks), shard_size):
        shard: dict[str, dict[str, Any]] = {}
        for c in chunks[i : i + shard_size]:
            shard[c.id] = {
                "docId": c.doc_id,
                "docTitle": c.doc_title,
                "docPath": c.doc_path,
                "metadata": c.metadata,
                "content": c.content[:3000],
                "wikiLinks": c.wiki_links,
                "parentDocId": c.parent_doc_id,
            }
        _dump_json(meta_dir / f"shard_{shard_idx}.json", shard)
        shard_idx += 1

    _cleanup_extra_shards(meta_dir, shard_idx)
    _dump_json(
        meta_dir / "config.json",
        {"totalChunks": len(chunks), "shardSize": shard_size, "totalShards": shard_idx},
    )
    print(f"  ✅ chunks_meta: {len(chunks)} 条记录, {shard_idx} 个分片")
    return shard_idx


def write_tantivy_bm25(chunks: list[Chunk], data_dir: Path) -> int:
    """用 tantivy-py 构建 BM25 倒排索引。

    替代原自研 write_bm25_index：tantivy 内部维护倒排 + 持久化，
    无需手写 shard_*.json / meta.json / doc_lengths.json。

    两侧分词口径仍走项目 jieba + 98 条 custom_words（bm25_tantivy.build_tantivy_index）。

    Returns:
        写入的 chunk 数
    """
    engine = build_tantivy_index(
        [{"id": c.id, "content": c.content} for c in chunks],
        content_key="content",
        chunk_id_key="id",
        tantivy_dir=data_dir / "tantivy_bm25",
        overwrite=True,
    )
    print(f"  ✅ Tantivy BM25: {engine.doc_count} 个 chunk（倒排 + BM25 由 tantivy 持久化）")
    return engine.doc_count


def write_parents(parents: dict[str, dict[str, Any]], data_dir: Path) -> None:
    parents_dir = data_dir / "parents"
    parents_dir.mkdir(parents=True, exist_ok=True)
    _dump_json(parents_dir / "parents.json", parents)
    print(f"  ✅ parents: {len(parents)} 个父文档")


def write_vector_config(total_chunks: int, dim: int, data_dir: Path, index_type: str) -> None:
    """落盘向量配置。index_type 为实际索引类型（BRUTE_FORCE / HNSW_SQ / IVF_PQ）。"""
    vec_dir = data_dir / "vectors"
    vec_dir.mkdir(parents=True, exist_ok=True)
    _dump_json(
        vec_dir / "config.json",
        {
            "totalChunks": total_chunks,
            "dim": dim,
            "engine": "lancedb",
            "indexType": index_type,
            "totalShards": 1,
        },
    )
    print(f"  ✅ vectors/config: {total_chunks} chunk, dim={dim}")


def write_lancedb(
    chunks: list[Chunk],
    vectors: list[list[float]],
    dim: int,
    data_dir: Path,
) -> str:
    """建表 + 按规模选择余弦索引（详见 _create_vector_index），返回实际索引类型。"""
    lance_dir = data_dir / "lancedb"
    if lance_dir.exists():
        print("  清空旧 LanceDB 数据...")
        shutil.rmtree(lance_dir, ignore_errors=True)
    lance_dir.mkdir(parents=True, exist_ok=True)

    db = lancedb.connect(str(lance_dir))
    records = []
    for c, vec in zip(chunks, vectors):
        records.append(
            {
                "id": c.id,
                "docId": c.doc_id,
                "docTitle": c.doc_title,
                "docPath": c.doc_path,
                "chunkIndex": c.chunk_index,
                "content": c.content[:3000],
                "vector": vec,
                "metadata_client": c.metadata.get("client", ""),
                "metadata_project": c.metadata.get("project", ""),
                "metadata_docType": c.metadata.get("docType", ""),
                "metadata_date": c.metadata.get("date", ""),
                "wikiLinks": json.dumps(c.wiki_links or [], ensure_ascii=False),
                "parentDocId": c.parent_doc_id or "",
            }
        )

    table = db.create_table("chunks", data=records, mode="overwrite")
    print(f"  ✅ LanceDB 表已创建: {len(records)} 条记录")

    return _create_vector_index(table, len(records), dim)


def _create_vector_index(table: Any, count: int, dim: int) -> str:
    """按向量条数选择索引策略，统一走 LanceDB 新版 unified API。返回实际索引类型。

    新版 API 形如 ``create_index("vector", config=IvfPq(distance_type="cosine"))``，
    替代已弃用的 ``metric= / num_partitions= / index_type=`` 老写法
    （老写法在 lancedb>=0.20 起会抛 DeprecationWarning）。训练失败时降级暴力搜索。
    """
    if count < BRUTE_FORCE_MAX:
        print(f"  ℹ️ {count} 条向量 < {BRUTE_FORCE_MAX}，低于 ANN 有效规模，跳过建索引（检索走暴力余弦，精确且更快）")
        return "BRUTE_FORCE"

    if count < HNSW_MAX:
        # 中等规模：图结构保证高召回，标量量化把内存压到约 1/4
        config = HnswSq(distance_type="cosine")
        desc = "HNSW(SQ)"
        index_type = "HNSW_SQ"
    else:
        # 大规模：IVF 聚类 + PQ 压缩，内存开销最小
        num_partitions = min(max(math.floor(count / 20), 4), 256)
        num_sub_vectors = min(int(dim / 8), 64)
        config = IvfPq(
            distance_type="cosine",
            num_partitions=num_partitions,
            num_sub_vectors=num_sub_vectors,
            max_iterations=50,
        )
        desc = f"IVF_PQ(partitions={num_partitions}, sub_vectors={num_sub_vectors})"
        index_type = "IVF_PQ"

    try:
        print(f"  创建 {desc} 向量索引...")
        table.create_index("vector", config=config, replace=True)
        print(f"  ✅ {desc} 向量索引创建完成")
        return index_type
    except Exception as e:
        print(f"  ⚠️ {desc} 向量索引创建失败（将使用暴力搜索）: {e}")
        return "BRUTE_FORCE"
