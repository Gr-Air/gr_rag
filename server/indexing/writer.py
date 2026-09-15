"""索引写入器（移植自 scripts/lib/indexWriter.cjs + buildIndex.cjs 的 LanceDB 段）。

输出：
- chunks_meta/shard_*.json + config.json
- bm25/shard_*.json + meta.json + doc_lengths.json
- parents/parents.json
- vectors/config.json
- lancedb/chunks.lance（+ IVF_PQ 向量索引，失败降级暴力搜索）
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from typing import Any

import lancedb

from ..config import get_settings
from .chunker import Chunk


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
        shard: dict[str, dict] = {}
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


def write_bm25_index(
    inv_index: dict[str, list[dict]],
    doc_lengths: dict[str, int],
    data_dir: Path,
    shard_size: int = 5000,
) -> int:
    bm25_dir = data_dir / "bm25"
    bm25_dir.mkdir(parents=True, exist_ok=True)

    terms = list(inv_index.items())
    shard_idx = 0
    for i in range(0, len(terms), shard_size):
        shard = {term: postings for term, postings in terms[i : i + shard_size]}
        _dump_json(bm25_dir / f"shard_{shard_idx}.json", shard)
        shard_idx += 1

    _cleanup_extra_shards(bm25_dir, shard_idx)

    total_len = sum(doc_lengths.values())
    avg_doc_len = total_len / len(doc_lengths) if doc_lengths else 0
    _dump_json(
        bm25_dir / "meta.json",
        {
            "docCount": len(doc_lengths),
            "avgDocLen": avg_doc_len,
            "totalTerms": len(inv_index),
            "totalShards": shard_idx,
        },
    )
    _dump_json(bm25_dir / "doc_lengths.json", doc_lengths)
    print(f"  ✅ BM25: {len(doc_lengths)} chunk, {len(inv_index)} 词项, {shard_idx} 个分片")
    return shard_idx


def write_parents(parents: dict[str, dict], data_dir: Path) -> None:
    parents_dir = data_dir / "parents"
    parents_dir.mkdir(parents=True, exist_ok=True)
    _dump_json(parents_dir / "parents.json", parents)
    print(f"  ✅ parents: {len(parents)} 个父文档")


def write_vector_config(total_chunks: int, dim: int, data_dir: Path, index_type: str = "IVF_PQ") -> None:
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
) -> None:
    """建表 + IVF_PQ 余弦索引（失败降级暴力搜索）。"""
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

    try:
        num_partitions = min(max(math.floor(len(chunks) / 20), 4), 256)
        num_sub_vectors = min(int(dim / 8), 64)
        print(f"  创建 IVF_PQ 向量索引 (partitions={num_partitions}, sub_vectors={num_sub_vectors})...")
        table.create_index(
            metric="cosine",
            num_partitions=num_partitions,
            num_sub_vectors=num_sub_vectors,
            index_type="IVF_PQ",
            max_iterations=50,
            vector_column_name="vector",
            replace=True,
        )
        print("  ✅ IVF_PQ 向量索引创建完成")
    except Exception as e:
        print(f"  ⚠️ IVF_PQ 索引创建失败（将使用暴力搜索）: {e}")
