"""结构化检索运行时引擎（移植自 src/infrastructure/struct/structSearchEngine.ts）。

indexing/structdb.py 负责构建库；本模块只读查询：
- query：StructQueryPort（单词条精确 + type=entity 过滤；多词条 OR/AND）
- get_known_entities：EntityRepository（实体改写/硬路由字典）
- get_struct_stats：统计接口
"""

from __future__ import annotations

import sqlite3
from functools import lru_cache
from pathlib import Path

from ....config import get_settings


class StructEngine:
    def __init__(self, db_path: Path | None = None) -> None:
        settings = get_settings()
        self._db_path = db_path or (settings.data_dir / "struct_kb.db")
        self._db: sqlite3.Connection | None = None

    # ------------------------------------------------------------
    # 连接
    # ------------------------------------------------------------

    def is_ready(self) -> bool:
        return self._db_path.exists()

    def _get_db(self) -> sqlite3.Connection:
        if self._db is not None:
            return self._db
        if not self.is_ready():
            raise RuntimeError("结构化数据库未构建，请先运行: python -m server.indexing.cli struct")
        # check_same_thread=False：pipeline 在线程池并行调用各检索器，
        # 单例连接会被请求工作线程复用（只读 URI，无写竞争）
        conn = sqlite3.connect(
            f"file:{self._db_path}?mode=ro", uri=True, check_same_thread=False
        )
        conn.row_factory = sqlite3.Row
        self._db = conn
        return conn

    # ------------------------------------------------------------
    # 基础查询
    # ------------------------------------------------------------

    def _query_chunks_by_entry(self, name: str) -> dict | None:
        db = self._get_db()
        row = db.execute("SELECT * FROM entries WHERE name = ?", (name,)).fetchone()
        if row is None:
            return None
        entry = dict(row)
        chunks = [
            dict(r)
            for r in db.execute(
                "SELECT * FROM entry_chunks WHERE entry_id = ?", (entry["id"],)
            ).fetchall()
        ]
        return {"entry": entry, "chunks": chunks}

    def _query_entries(self, names: list[str]) -> list[dict]:
        db = self._get_db()
        placeholders = ",".join("?" for _ in names)
        rows = db.execute(
            f"SELECT * FROM entries WHERE name IN ({placeholders})", names
        ).fetchall()
        results = []
        for row in rows:
            entry = dict(row)
            chunks = [
                dict(r)
                for r in db.execute(
                    "SELECT * FROM entry_chunks WHERE entry_id = ?", (entry["id"],)
                ).fetchall()
            ]
            results.append({"entry": entry, "chunks": chunks})
        return results

    def _query_and(self, entries: list[dict]) -> list[dict]:
        """AND：取各词条 chunk_id 交集；无交集时返回空 chunks 列表。"""
        db = self._get_db()
        common: set[str] | None = None
        per_entry_chunks: dict[int, list[dict]] = {}

        for entry in entries:
            rows = db.execute(
                "SELECT chunk_id FROM entry_chunks WHERE entry_id = ?", (entry["id"],)
            ).fetchall()
            chunk_ids = {r["chunk_id"] for r in rows}
            common = chunk_ids if common is None else (common & chunk_ids)

        if not common:
            return [{"entry": e, "chunks": []} for e in entries]

        results = []
        for entry in entries:
            rows = db.execute(
                "SELECT * FROM entry_chunks WHERE entry_id = ?", (entry["id"],)
            ).fetchall()
            chunks = [dict(r) for r in rows if r["chunk_id"] in common]
            results.append({"entry": entry, "chunks": chunks})
        return results

    # ------------------------------------------------------------
    # Port：结构化查询（仅返回 type=entity 的词条）
    # ------------------------------------------------------------

    def query(self, names: list[str], mode: str = "or") -> list[dict]:
        """返回 StructQueryResult[]：entry 裁剪为领域字段，chunks 原样。"""
        if not self.is_ready() or not names:
            return []

        if len(names) == 1:
            result = self._query_chunks_by_entry(names[0])
            raw = [result] if result else []
        elif mode == "and":
            # _query_entries 返回 {"entry", "chunks"} 包装；AND 需要裸 entry 行
            rows = self._query_entries(names)
            raw = self._query_and([r["entry"] for r in rows])
        else:
            raw = self._query_entries(names)

        out: list[dict] = []
        for r in raw:
            entry = r["entry"]
            if entry.get("type") != "entity":
                continue
            out.append(
                {
                    "entry": {
                        "id": entry["id"],
                        "name": entry["name"],
                        "type": entry["type"],
                        "category": entry["category"],
                        "frequency": entry["frequency"],
                        "path": entry["path"],
                    },
                    "chunks": r["chunks"],
                }
            )
        return out

    # ------------------------------------------------------------
    # Port：实体字典
    # ------------------------------------------------------------

    def get_known_entities(self) -> list[dict]:
        db = self._get_db()
        rows = db.execute(
            "SELECT name, type, category, frequency, definition, source "
            "FROM entries ORDER BY frequency DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_struct_stats(self) -> dict:
        db = self._get_db()

        def count(sql: str) -> int:
            return db.execute(sql).fetchone()["c"]

        return {
            "totalEntries": count("SELECT COUNT(*) as c FROM entries"),
            "totalConcepts": count("SELECT COUNT(*) as c FROM entries WHERE type='concept'"),
            "totalEntities": count("SELECT COUNT(*) as c FROM entries WHERE type='entity'"),
            "totalRelations": count("SELECT COUNT(*) as c FROM entry_chunks"),
        }


@lru_cache(maxsize=1)
def get_struct_engine() -> StructEngine:
    return StructEngine()
