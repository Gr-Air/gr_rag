"""索引构建 CLI（移植自 scripts/buildIndex.cjs 四阶段 + buildStructDb.cjs）。

用法（server/ 目录下）：
    python -m server.indexing.cli full             # 全量重建（调用 embedding API）
    python -m server.indexing.cli full --dry-run   # 只扫描+分块+统计，不写文件不调 API
    python -m server.indexing.cli struct           # 结构化数据库（Wiki 词条 + wikiLinks）

full 阶段：1 扫描分块 → 2 embedding+LanceDB → 3 BM25/meta/parents/vectors
           → 4 提示 struct 子命令 → index_state + manifest
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from ..config import get_settings
from ..rag.retrieve.engines.embedding import get_embeddings_batch
from ..rag.retrieve.engines.tokenizer import tokenize_all_filtered
from . import hasher, manifest as manifest_mod
from .chunker import Chunk, chunk_document, extract_title, parse_filename
from .scanner import scan_all
from . import structdb, writer


def _stage_parse() -> tuple[list, list[Chunk], list]:
    raw_docs, wiki_entries = scan_all()
    chunks: list[Chunk] = []
    for i, doc in enumerate(raw_docs):
        filename = Path(doc.file).name
        meta = parse_filename(filename)
        title = extract_title(doc.content, filename)
        chunks.extend(
            chunk_document(
                doc.content,
                doc.key,
                title,
                doc.file,
                {
                    "client": meta["client"],
                    "project": meta["project"],
                    "docType": meta["docType"],
                    "date": meta["date"],
                },
            )
        )
        if (i + 1) % 20 == 0:
            print(f"  已解析 {i + 1}/{len(raw_docs)}")
    return raw_docs, chunks, wiki_entries


def _build_parents(raw_docs, chunks: list[Chunk]) -> dict[str, dict]:
    parents: dict[str, dict] = {}
    for doc in raw_docs:
        filename = Path(doc.file).name
        meta = parse_filename(filename)
        title = extract_title(doc.content, filename)
        parent_id = f"parent_{doc.key}"
        parents[doc.key] = {
            "doc_id": doc.key,
            "title": title,
            "path": doc.file,
            "metadata": {
                "client": meta["client"],
                "project": meta["project"],
                "docType": meta["docType"],
                "date": meta["date"],
            },
            "childChunkIds": [c.id for c in chunks if c.parent_doc_id == parent_id],
        }
    return parents


def _build_bm25(chunks: list[Chunk]) -> tuple[dict[str, list[dict]], dict[str, int]]:
    """构建倒排索引与文档长度表。

    索引侧与查询侧必须同口径：查询侧是 tokenize_filtered（过滤停用词 + 去重保序），
    因此索引侧用 tokenize_all_filtered（过滤停用词 + 保留词频）。
    两侧都过滤后，停用词既不进倒排、也不计入 docLen，长度归一化只反映实词数量。
    """
    inv_index: dict[str, list[dict]] = {}
    doc_lengths: dict[str, int] = {}
    for i, c in enumerate(chunks):
        tokens = tokenize_all_filtered(c.content)
        doc_lengths[c.id] = len(tokens)
        for term, freq in Counter(tokens).items():
            inv_index.setdefault(term, []).append({"chunkId": c.id, "tf": freq})
        if (i + 1) % 500 == 0:
            print(f"  已索引 {i + 1}/{len(chunks)}, {len(inv_index)} 词项")
    return inv_index, doc_lengths


def run_full(dry_run: bool = False) -> None:
    settings = get_settings()
    data_dir: Path = settings.data_dir
    print("========================================")
    print("  星辰Wiki 知识库索引构建 (Python / LanceDB)")
    print("========================================\n")

    # 阶段 1：解析分块
    print("[1/4] 解析文档并分块...")
    raw_docs, chunks, wiki_entries = _stage_parse()
    print(f"  ✅ 共 {len(chunks)} 个文档块（{len(raw_docs)} Raw 文档，{len(wiki_entries)} Wiki 词条）")

    if dry_run:
        # 统计文档类型分布与块大小，供核对，不写任何文件
        sizes = [len(c.content) for c in chunks]
        print("\n[dry-run] 不调用 embedding、不写索引。块大小统计：")
        print(f"  min={min(sizes)} max={max(sizes)} avg={sum(sizes)//len(sizes)}")
        return

    data_dir.mkdir(parents=True, exist_ok=True)

    # 阶段 2：embedding + LanceDB（取前 2000 字符向量化）
    print("\n[2/4] 构建向量索引（DashScope Embedding → LanceDB）...")
    vec_texts = [c.content[:2000] for c in chunks]
    vectors = get_embeddings_batch(vec_texts)
    dim = len(vectors[0]) if vectors else settings.embedding_dim
    if settings.embedding_dim and dim != settings.embedding_dim:
        print(f"  ⚠️ 实际维度 {dim} 与配置 EMBEDDING_DIM={settings.embedding_dim} 不一致，以实际为准")
    print(f"  ✅ Embedding 完成: {len(vectors)} 个向量，维度 {dim}")
    index_type = writer.write_lancedb(chunks, vectors, dim, data_dir)

    # 阶段 3：BM25 + meta + parents + vectors 配置
    print("\n[3/4] 构建 BM25 倒排索引...")
    inv_index, doc_lengths = _build_bm25(chunks)
    writer.write_bm25_index(inv_index, doc_lengths, data_dir)
    writer.write_chunks_meta(chunks, data_dir)
    print("\n  保存父文档...")
    writer.write_parents(_build_parents(raw_docs, chunks), data_dir)
    writer.write_vector_config(len(chunks), dim, data_dir, index_type)

    # 阶段 4：结构化数据库为独立子命令（python -m server.indexing.cli struct）
    print("\n[4/4] 结构化数据库：跳过（如需构建，运行 python -m server.indexing.cli struct）")

    # 增量状态快照
    print("\n保存增量索引状态快照...")
    state = hasher.build_state_snapshot(list(raw_docs) + list(wiki_entries))
    (data_dir / "index_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  ✅ 增量状态快照: {len(state)} 个文件")

    # manifest
    print("\n写入索引 manifest...")
    m = manifest_mod.write_manifest_after_build(data_dir, build_mode="full")
    if m:
        print(f"  ✅ index_manifest.json 已写入 (v{m['indexVersion']}, 构建于 {m['builtAt']})")
    else:
        raise RuntimeError("必需 store 存在缺失，manifest 未写入")

    print("\n========================================")
    print(f"  ✅ 全部索引构建完成！总块数 {len(chunks)}，维度 {dim}，BM25 词项 {len(inv_index)}")
    print("========================================")


def run_struct() -> None:
    settings = get_settings()
    data_dir: Path = settings.data_dir
    print("========================================")
    print("  星辰Wiki 结构化数据库构建（两表结构）")
    print("========================================\n")

    print("[1/4] 加载 Wiki 词条...")
    entries = structdb.load_wiki_entries(settings.wiki_dir)
    n_concept = sum(1 for e in entries if e["type"] == "concept")
    n_entity = sum(1 for e in entries if e["type"] == "entity")
    print(f"  ✅ 概念词条: {n_concept} 个")
    print(f"  ✅ 实体词条: {n_entity} 个")
    print(f"  ✅ 总计（含同名文件，入库按 name 去重）: {len(entries)} 个\n")

    print("[2/4] 加载 chunks_meta...")
    all_chunks = structdb.load_chunks_meta(data_dir)
    if not all_chunks:
        raise SystemExit("  ❌ chunks_meta 为空，请先运行 full 构建")
    print(f"  ✅ 总 chunk 数: {len(all_chunks)}\n")

    print("[3/4] 建立词条-chunk 关联关系（wikiLinks）...")
    relations = structdb.build_relations(entries, all_chunks)
    linked = sum(1 for v in relations.values() if v)
    total_links = sum(len(v) for v in relations.values())
    print(f"  ✅ 有 chunk 关联的词条: {linked}/{len(entries)}")
    print(f"  ✅ 总关联边数: {total_links}")
    print(f"  ✅ 平均每词条关联: {total_links / len(entries):.1f} 个 chunk\n")

    print("[4/4] 写入 SQLite 数据库...")
    stats = structdb.build_database(data_dir, entries, relations)
    print(f"  ✅ 数据库路径: {data_dir / structdb.DB_FILENAME}")
    print(
        f"  ✅ 词条: {stats['totalEntries']} "
        f"(概念{stats['totalConcepts']}/实体{stats['totalEntities']})"
    )
    print(f"  ✅ 来源分布: Wiki {stats['wikiEntries']} / LLM {stats['llmEntries']}")
    print(f"  ✅ 关联边: {stats['totalRelations']}\n")

    m = manifest_mod.update_struct_db_entry(data_dir)
    if m:
        print(f"  ✅ manifest 已更新 (v{m['indexVersion']})")
    else:
        raise RuntimeError("struct_kb.db 未找到，manifest 未更新")

    print("\n========================================")
    print("  ✅ 结构化数据库构建完成!")
    print("========================================")


def main() -> None:
    parser = argparse.ArgumentParser(description="llm-wiki 索引构建")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_full = sub.add_parser("full", help="全量重建")
    p_full.add_argument("--dry-run", action="store_true", help="只扫描分块，不调 API 不写文件")
    sub.add_parser("struct", help="构建结构化数据库（Wiki 词条 + wikiLinks 关联）")
    args = parser.parse_args()

    if args.cmd == "full":
        run_full(dry_run=args.dry_run)
    elif args.cmd == "struct":
        run_struct()


if __name__ == "__main__":
    main()
