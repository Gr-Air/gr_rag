"""manifest store 就绪检查与原子写测试。"""

import json

from server.indexing import manifest as m


def _make_ready_store(d):
    """构造四个必需 store 的最小就绪结构。"""
    (d / "lancedb" / "chunks.lance").mkdir(parents=True)
    (d / "vectors").mkdir(parents=True)
    (d / "vectors" / "config.json").write_text(
        json.dumps({"totalChunks": 3, "dim": 1024}), encoding="utf-8")

    bm = d / "bm25"
    bm.mkdir(parents=True)
    (bm / "shard_0.json").write_text("{}", encoding="utf-8")
    (bm / "meta.json").write_text(
        json.dumps({"docCount": 3, "avgDocLen": 10, "totalTerms": 2, "totalShards": 1}),
        encoding="utf-8")
    (bm / "doc_lengths.json").write_text("{}", encoding="utf-8")

    cm = d / "chunks_meta"
    cm.mkdir(parents=True)
    (cm / "shard_0.json").write_text("{}", encoding="utf-8")
    (cm / "config.json").write_text(
        json.dumps({"totalChunks": 3, "shardSize": 2000, "totalShards": 1}),
        encoding="utf-8")

    (d / "parents").mkdir(parents=True)
    (d / "parents" / "parents.json").write_text("{}", encoding="utf-8")


def test_missing_required_store_blocks_manifest(tmp_path):
    # 空目录：必需 store 全缺
    assert m.check_stores_ready(tmp_path) is False
    assert m.build_manifest(tmp_path) is None
    assert m.write_manifest_after_build(tmp_path) is None
    assert not (tmp_path / m.MANIFEST_FILENAME).exists()


def test_full_stores_build_and_version_increment(tmp_path):
    _make_ready_store(tmp_path)
    assert m.check_stores_ready(tmp_path) is True

    m1 = m.write_manifest_after_build(tmp_path, "full")
    assert m1 is not None
    assert m1["indexVersion"] == 1
    assert m1["buildMode"] == "full"
    assert m1["stores"]["chunksMeta"]["ready"] is True
    assert m1["stores"]["chunksMeta"]["detail"]["totalChunks"] == 3
    assert m1["stats"]["totalChunks"] == 3
    # structDb 可选，默认未就绪
    assert m1["stores"]["structDb"]["ready"] is False

    m2 = m.write_manifest_after_build(tmp_path, "full")
    assert m2 is not None
    assert m2["indexVersion"] == 2


def test_atomic_write_no_tmp_left(tmp_path):
    _make_ready_store(tmp_path)
    m.write_manifest_after_build(tmp_path)
    assert not (tmp_path / "index_manifest.json.tmp").exists()
    assert (tmp_path / "index_manifest.json").exists()


def test_read_corrupt_manifest_returns_none(tmp_path):
    (tmp_path / "index_manifest.json").write_text("{坏json", encoding="utf-8")
    assert m.read_manifest(tmp_path) is None
