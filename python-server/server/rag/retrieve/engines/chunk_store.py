"""ChunkStore 实现（移植自 src/infrastructure/document/jsonChunkStore.ts）。

基于 chunks_meta JSON 分片，懒加载全量到内存：
- get_by_ids：pipeline/assembler 批量附着 chunk，保序，未命中跳过
- get_all：entity 倒排索引 / 上下文用，返回 dict[chunkId, ChunkMeta]
"""

from __future__ import annotations

import json
from pathlib import Path

from ....config import get_settings
from ...types import ChunkMeta, DocChunk


class JsonChunkStore:
    def __init__(self, chunks_meta_dir: Path | None = None) -> None:
        settings = get_settings()
        self._dir = chunks_meta_dir or (settings.data_dir / "chunks_meta")
        self._cache: dict[str, ChunkMeta] | None = None

    def _load_all(self) -> dict[str, ChunkMeta]:
        if self._cache is not None:
            return self._cache

        result: dict[str, ChunkMeta] = {}
        config_path = self._dir / "config.json"
        if config_path.exists():
            config = json.loads(config_path.read_text(encoding="utf-8"))
            for s in range(config["totalShards"]):
                shard_path = self._dir / f"shard_{s}.json"
                if not shard_path.exists():
                    continue
                shard = json.loads(shard_path.read_text(encoding="utf-8"))
                for chunk_id, meta in shard.items():
                    result[chunk_id] = ChunkMeta(
                        doc_id=meta["docId"],
                        doc_title=meta["docTitle"],
                        doc_path=meta["docPath"],
                        metadata=meta.get("metadata") or {},
                        content=meta["content"],
                        wiki_links=meta.get("wikiLinks") or [],
                        parent_doc_id=meta.get("parentDocId"),
                    )
            print(f"[ChunkStore] 加载完成: {len(result)} 个 chunks")

        self._cache = result
        return result

    @staticmethod
    def _meta_to_chunk(chunk_id: str, meta: ChunkMeta) -> DocChunk:
        return DocChunk(
            id=chunk_id,
            doc_id=meta.doc_id,
            doc_title=meta.doc_title,
            doc_path=meta.doc_path,
            chunk_index=0,
            content=meta.content,
            metadata=meta.metadata,
            wiki_links=meta.wiki_links or [],
            parent_doc_id=meta.parent_doc_id,
        )

    def get_by_ids(self, ids: list[str]) -> list[DocChunk]:
        """保序返回命中的 chunks（未命中跳过）。"""
        all_chunks = self._load_all()
        result: list[DocChunk] = []
        for chunk_id in ids:
            meta = all_chunks.get(chunk_id)
            if meta is not None:
                result.append(self._meta_to_chunk(chunk_id, meta))
        return result

    def get_all(self) -> dict[str, ChunkMeta]:
        return self._load_all()


# 模块级单例（项目内共享；后续阶段如需再改构造注入）
_instance: JsonChunkStore | None = None


def get_chunk_store() -> JsonChunkStore:
    global _instance
    if _instance is None:
        _instance = JsonChunkStore()
    return _instance


def _reset_chunk_store_for_test() -> None:
    """测试用：重置单例（避免跨用例缓存污染）。"""
    global _instance
    _instance = None
