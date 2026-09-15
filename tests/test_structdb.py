"""structdb 构建器单测（Spec 038 P1，对齐 buildStructDb.cjs 确定性路径）。"""

from __future__ import annotations

import json
import sqlite3

from server.indexing import manifest as manifest_mod
from server.indexing import structdb


def _write_wiki(wiki_dir, sub: str, name: str, content: str) -> None:
    d = wiki_dir / sub
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.md").write_text(content, encoding="utf-8")


def test_parse_wiki_entry_fields():
    content = "> 技术概念 | 别名: 无\n\n> 定义: 这是定义。\n\n出现频次: 42 次\n"
    e = structdb.parse_wiki_entry("微服务", "concept", "微服务.md", content)
    assert e == {
        "name": "微服务",
        "type": "concept",
        "category": "技术概念",
        "frequency": 42,
        "path": "Wiki/concept/微服务.md",
        "definition": "这是定义。",
        "attributes": "{}",
        "source": "wiki",
    }


def test_parse_wiki_entry_defaults():
    e = structdb.parse_wiki_entry("X", "entity", "X.md", "无任何元信息\n")
    assert e["category"] == "entity"
    assert e["frequency"] == 0
    assert e["definition"] == ""


def test_load_wiki_entries_order_and_duplicate_names(tmp_path):
    _write_wiki(tmp_path, "concept", "云原生", "> c1 |\n")
    _write_wiki(tmp_path, "entity", "K8s", "x")
    _write_wiki(tmp_path, "entity", "云原生", "y")  # 与 concept 同名
    entries = structdb.load_wiki_entries(tmp_path)
    assert [e["name"] for e in entries] == ["云原生", "K8s", "云原生"]
    assert [e["type"] for e in entries] == ["concept", "entity", "entity"]


def test_build_relations_context_and_unknown_link():
    entries = [{"name": "微服务"}, {"name": "K8s"}]
    chunks = {
        "raw_a_0": {
            "content": "第一行\n第二行链接[[微服务]]与[[不存在词条]]",
            "wikiLinks": ["微服务", "不存在词条"],
        },
        "raw_a_1": {"content": "x" * 250 + "[[K8s]][[微服务]]", "wikiLinks": ["K8s", "微服务"]},
    }
    rel = structdb.build_relations(entries, chunks)
    assert [r["chunkId"] for r in rel["微服务"]] == ["raw_a_0", "raw_a_1"]
    assert rel["微服务"][0]["context"] == "第一行 第二行链接[[微服务]]与[[不存在词条]]"
    # 超 200 字符截断
    assert len(rel["K8s"][0]["context"]) == 200
    assert "不存在词条" not in rel  # 未知词条不建 key 之外的东西（key 集合只来自 entries）


def test_build_database_dedup_and_ignore(tmp_path):
    entries = [
        {"name": "云原生", "type": "concept", "category": "concept", "frequency": 1,
         "path": "Wiki/concept/云原生.md", "definition": "c", "attributes": "{}", "source": "wiki"},
        {"name": "云原生", "type": "entity", "category": "entity", "frequency": 2,
         "path": "Wiki/entity/云原生.md", "definition": "e", "attributes": "{}", "source": "wiki"},
        {"name": "K8s", "type": "entity", "category": "entity", "frequency": 0,
         "path": "Wiki/entity/K8s.md", "definition": "", "attributes": "{}", "source": "wiki"},
    ]
    relations = {
        "云原生": [
            {"chunkId": "raw_a_0", "context": "ctx1"},
            {"chunkId": "raw_a_0", "context": "ctx1-dup"},  # 同 PK → IGNORE
            {"chunkId": "raw_a_1", "context": "ctx2"},
        ],
        "K8s": [{"chunkId": "raw_b_0", "context": ""}],
        "幽灵": [{"chunkId": "raw_x_0", "context": ""}],  # entries 表无此行 → 跳过
    }
    stats = structdb.build_database(tmp_path, entries, relations)
    assert stats["totalEntries"] == 2
    assert stats["totalEntities"] == 2  # 同名以 entity 覆盖
    assert stats["totalRelations"] == 3
    assert stats["wikiEntries"] == 2
    assert stats["llmEntries"] == 0

    db = sqlite3.connect(str(tmp_path / "struct_kb.db"))
    row = db.execute("SELECT type, path, definition FROM entries WHERE name='云原生'").fetchone()
    assert row == ("entity", "Wiki/entity/云原生.md", "e")
    rows = db.execute(
        "SELECT chunk_id, context FROM entry_chunks JOIN entries ON entries.id = entry_id "
        "WHERE name='云原生' ORDER BY chunk_id"
    ).fetchall()
    assert rows == [("raw_a_0", "ctx1"), ("raw_a_1", "ctx2")]
    db.close()


def test_load_chunks_meta_shards(tmp_path):
    meta = tmp_path / "chunks_meta"
    meta.mkdir(parents=True)
    (meta / "config.json").write_text(json.dumps({"totalShards": 2}), encoding="utf-8")
    (meta / "shard_0.json").write_text(json.dumps({"a": {"v": 1}}), encoding="utf-8")
    (meta / "shard_1.json").write_text(json.dumps({"b": {"v": 2}}), encoding="utf-8")
    chunks = structdb.load_chunks_meta(tmp_path)
    assert set(chunks.keys()) == {"a", "b"}

    assert structdb.load_chunks_meta(tmp_path / "missing") == {}


def test_update_struct_db_entry_no_db(tmp_path):
    assert manifest_mod.update_struct_db_entry(tmp_path) is None


def test_update_struct_db_entry_bumps_existing_manifest(tmp_path):
    # 只有 struct_kb.db + 既有 manifest
    (tmp_path / "struct_kb.db").write_bytes(b"fake")
    manifest_mod.write_manifest(tmp_path, {
        "indexVersion": 7,
        "pipelineVersion": "1.1.0",
        "stores": {"lancedb": {"ready": True, "detail": None}},
    })
    m = manifest_mod.update_struct_db_entry(tmp_path)
    assert m is not None
    assert m["indexVersion"] == 8
    assert m["stores"]["lancedb"] == {"ready": True, "detail": None}
    assert m["stores"]["structDb"]["ready"] is True


def test_update_struct_db_entry_creates_minimal_manifest(tmp_path):
    (tmp_path / "struct_kb.db").write_bytes(b"fake")
    m = manifest_mod.update_struct_db_entry(tmp_path)
    assert m is not None
    assert m["indexVersion"] == 1
    assert m["buildMode"] == "structdb-only"
    assert m["stores"]["structDb"]["ready"] is True
