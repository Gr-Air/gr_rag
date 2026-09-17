"""StructEngine 查询测试（含多词条 AND/OR，回归 _query_and 包装层 bug）。"""

from __future__ import annotations

import sqlite3

from server.indexing import structdb
from server.rag.retrieve.engines.struct_engine import StructEngine


def _build(tmp_path):
    entries = [
        {"name": "云原生", "type": "entity", "category": "技术组件", "frequency": 5,
         "path": "Wiki/entity/云原生.md", "definition": "", "attributes": "{}",
         "source": "wiki"},
        {"name": "K8s", "type": "entity", "category": "技术组件", "frequency": 3,
         "path": "Wiki/entity/K8s.md", "definition": "", "attributes": "{}",
         "source": "wiki"},
        {"name": "微服务", "type": "concept", "category": "技术概念", "frequency": 9,
         "path": "Wiki/concept/微服务.md", "definition": "d", "attributes": "{}",
         "source": "wiki"},
    ]
    relations = {
        "云原生": [
            {"chunkId": "raw_shared_0", "context": "共享块"},
            {"chunkId": "raw_a_1", "context": "甲独有"},
        ],
        "K8s": [
            {"chunkId": "raw_shared_0", "context": "共享块"},
            {"chunkId": "raw_b_1", "context": "乙独有"},
        ],
        "微服务": [{"chunkId": "raw_c_0", "context": "概念块"}],
    }
    structdb.build_database(tmp_path, entries, relations)
    return StructEngine(db_path=tmp_path / "struct_kb.db")


def test_is_ready_and_single_entity(tmp_path):
    engine = _build(tmp_path)
    assert engine.is_ready() is True

    results = engine.query(["云原生"], "or")
    assert len(results) == 1
    assert results[0]["entry"]["name"] == "云原生"
    assert results[0]["entry"]["type"] == "entity"
    assert sorted(c["chunk_id"] for c in results[0]["chunks"]) == [
        "raw_a_1", "raw_shared_0"
    ]


def test_concept_excluded(tmp_path):
    engine = _build(tmp_path)
    assert engine.query(["微服务"], "or") == []


def test_missing_name_returns_empty(tmp_path):
    engine = _build(tmp_path)
    assert engine.query(["不存在词条"], "or") == []


def test_or_multi_entries(tmp_path):
    engine = _build(tmp_path)
    results = engine.query(["云原生", "K8s"], "or")
    by_name = {r["entry"]["name"]: r for r in results}
    assert set(by_name) == {"云原生", "K8s"}
    assert sorted(c["chunk_id"] for c in by_name["云原生"]["chunks"]) == [
        "raw_a_1", "raw_shared_0"
    ]
    assert sorted(c["chunk_id"] for c in by_name["K8s"]["chunks"]) == [
        "raw_b_1", "raw_shared_0"
    ]


def test_and_intersection(tmp_path):
    engine = _build(tmp_path)
    results = engine.query(["云原生", "K8s"], "and")
    by_name = {r["entry"]["name"]: r for r in results}
    assert set(by_name) == {"云原生", "K8s"}
    # 仅交集块
    assert [c["chunk_id"] for c in by_name["云原生"]["chunks"]] == ["raw_shared_0"]
    assert [c["chunk_id"] for c in by_name["K8s"]["chunks"]] == ["raw_shared_0"]


def test_and_missing_name_intersects_found_only(tmp_path):
    engine = _build(tmp_path)
    # 不存在的词条不在 entries 中，按 TS 语义仅在找到的词条上求交
    results = engine.query(["云原生", "不存在的实体名"], "and")
    assert len(results) == 1
    assert results[0]["entry"]["name"] == "云原生"
    assert {c["chunk_id"] for c in results[0]["chunks"]} == {
        "raw_shared_0", "raw_a_1"
    }


def test_and_disjoint_pair(tmp_path):
    engine = _build(tmp_path)
    # 删掉共享关系使两个实体无交集（引擎连接为只读，用独立写连接）
    writer = sqlite3.connect(str(tmp_path / "struct_kb.db"))
    writer.execute("DELETE FROM entry_chunks WHERE chunk_id='raw_shared_0'")
    writer.commit()
    writer.close()

    results = engine.query(["云原生", "K8s"], "and")
    assert {r["entry"]["name"] for r in results} == {"云原生", "K8s"}
    assert all(r["chunks"] == [] for r in results)


def test_get_known_entities(tmp_path):
    engine = _build(tmp_path)
    entities = engine.get_known_entities()
    names = [e["name"] for e in entities]
    # frequency DESC
    assert names == ["微服务", "云原生", "K8s"]
    assert set(entities[0].keys()) == {
        "name", "type", "category", "frequency", "definition", "source"
    }
