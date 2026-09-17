"""结构化数据库构建（移植自 scripts/buildStructDb.cjs 的确定性部分）。

只保留生产实际使用的路径：Wiki concept/entity 词条 + chunks_meta 中的 wikiLinks
→ SQLite entries / entry_chunks 两表。

Node 版的 LLM 实体提取（--llm-only / 默认开启）在生产库零产出
（现存 3729 个词条 source 全部为 'wiki'），属于死路径，本次不移植。
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

DB_FILENAME = "struct_kb.db"

_CATEGORY = re.compile(r"^>\s*(.+?)\s*\|", re.M)
_FREQUENCY = re.compile(r"出现频次:\s*(\d+)")
_DEFINITION = re.compile(r"> 定义:\s*(.+)")

_DDL = """
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('concept', 'entity')),
  category TEXT NOT NULL DEFAULT '',
  frequency INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL DEFAULT '',
  definition TEXT DEFAULT '',
  attributes TEXT DEFAULT '{}',
  source TEXT DEFAULT 'wiki'
);

CREATE TABLE IF NOT EXISTS entry_chunks (
  entry_id INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  context TEXT DEFAULT '',
  PRIMARY KEY (entry_id, chunk_id),
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entries_name ON entries(name);
CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entry_chunks_chunk ON entry_chunks(chunk_id);
"""


def parse_wiki_entry(name: str, sub: str, file_name: str, content: str) -> dict[str, Any]:
    m = _CATEGORY.search(content)
    category = m.group(1).strip() if m else ""
    m = _FREQUENCY.search(content)
    frequency = int(m.group(1)) if m else 0
    m = _DEFINITION.search(content)
    definition = m.group(1).strip() if m else ""
    return {
        "name": name,
        "type": sub,
        "category": category or sub,
        "frequency": frequency,
        "path": f"Wiki/{sub}/{file_name}",
        "definition": definition,
        "attributes": "{}",
        "source": "wiki",
    }


def load_wiki_entries(wiki_dir: Path) -> list[dict[str, Any]]:
    """按 concept → entity 顺序扫描；同名词条后者在 INSERT OR REPLACE 时覆盖。"""
    entries: list[dict[str, Any]] = []
    for sub in ("concept", "entity"):
        d = wiki_dir / sub
        if not d.exists():
            continue
        for p in sorted(d.glob("*.md")):
            name = p.name.removesuffix(".md")
            entries.append(parse_wiki_entry(name, sub, p.name, p.read_text(encoding="utf-8")))
    return entries


def load_chunks_meta(data_dir: Path) -> dict[str, dict]:
    """按 config.totalShards 顺序合并 chunks_meta 分片。"""
    meta_dir = data_dir / "chunks_meta"
    cfg_path = meta_dir / "config.json"
    if not cfg_path.exists():
        return {}
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    all_chunks: dict[str, dict] = {}
    for i in range(cfg.get("totalShards", 0)):
        shard_path = meta_dir / f"shard_{i}.json"
        if shard_path.exists():
            all_chunks.update(json.loads(shard_path.read_text(encoding="utf-8")))
    return all_chunks


def build_relations(
    entries: list[dict[str, Any]], all_chunks: dict[str, dict]
) -> dict[str, list[dict[str, str]]]:
    """词条 → [{chunkId, context}]，context 取 chunk 前 200 字符并换行转空格。"""
    names = {e["name"] for e in entries}
    relations: dict[str, list[dict[str, str]]] = {e["name"]: [] for e in entries}
    for chunk_id, chunk in all_chunks.items():
        links = chunk.get("wikiLinks") or []
        if not links:
            continue
        for link in links:
            if link in names:
                context = (chunk.get("content") or "")[:200].replace("\n", " ").strip()
                relations[link].append({"chunkId": chunk_id, "context": context})
    return relations


def build_database(
    data_dir: Path,
    entries: list[dict[str, Any]],
    relations: dict[str, list[dict[str, str]]],
) -> dict[str, int]:
    db_path = data_dir / DB_FILENAME
    # Node 版只 unlink 主文件；Python 版连 -wal/-shm 一起清，避免旧 WAL 回放
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(db_path) + suffix)
        if p.exists():
            p.unlink()

    db = sqlite3.connect(str(db_path))
    try:
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA synchronous = NORMAL")
        db.execute("PRAGMA cache_size = -64000")
        db.executescript(_DDL)

        db.executemany(
            """
            INSERT OR REPLACE INTO entries
                (name, type, category, frequency, path, definition, attributes, source)
            VALUES
                (:name, :type, :category, :frequency, :path, :definition, :attributes, :source)
            """,
            entries,
        )

        for name, chunks in relations.items():
            row = db.execute("SELECT id FROM entries WHERE name = ?", (name,)).fetchone()
            if row is None:
                continue
            db.executemany(
                "INSERT OR IGNORE INTO entry_chunks (entry_id, chunk_id, context) VALUES (?, ?, ?)",
                [(row[0], c["chunkId"], c["context"]) for c in chunks],
            )
        db.commit()

        def scalar(sql: str) -> int:
            return db.execute(sql).fetchone()[0]

        return {
            "totalEntries": scalar("SELECT COUNT(*) FROM entries"),
            "totalConcepts": scalar("SELECT COUNT(*) FROM entries WHERE type='concept'"),
            "totalEntities": scalar("SELECT COUNT(*) FROM entries WHERE type='entity'"),
            "totalRelations": scalar("SELECT COUNT(*) FROM entry_chunks"),
            "wikiEntries": scalar("SELECT COUNT(*) FROM entries WHERE source='wiki'"),
            "llmEntries": scalar("SELECT COUNT(*) FROM entries WHERE source='llm_extracted'"),
        }
    finally:
        db.close()
