"""JsonChunkStore 测试（翻译自 test/chunkStore.test.ts，Spec 031）。

Python 版直接用 tmp_path 构造真实分片文件，比 mock fs 更直接：
get_by_ids 保序 / get_all 全量 / 实例缓存 / config 缺失返回空。
"""

import json

from server.rag.retrieve.engines.chunk_store import JsonChunkStore


def make_meta(doc_id: str, content: str) -> dict:
    return {
        "docId": doc_id,
        "docTitle": f"标题-{doc_id}",
        "docPath": f"Raw/{doc_id}.md",
        "metadata": {},
        "content": content,
        "wikiLinks": [],
    }


def write_shards(dir_path, shards):
    dir_path.mkdir(parents=True, exist_ok=True)
    (dir_path / "config.json").write_text(
        json.dumps({"totalShards": len(shards)}), encoding="utf-8"
    )
    for i, shard in enumerate(shards):
        (dir_path / f"shard_{i}.json").write_text(
            json.dumps(shard, ensure_ascii=False), encoding="utf-8"
        )


def test_get_by_ids_order_and_miss_skip(tmp_path):
    write_shards(tmp_path, [
        {"A": make_meta("docA", "内容A"), "B": make_meta("docB", "内容B")},
    ])

    store = JsonChunkStore(tmp_path)
    chunks = store.get_by_ids(["A", "X", "B"])

    assert len(chunks) == 2
    assert [c.id for c in chunks] == ["A", "B"]
    assert chunks[0].doc_id == "docA"
    assert chunks[0].content == "内容A"
    assert chunks[0].chunk_index == 0


def test_get_all_across_shards(tmp_path):
    write_shards(tmp_path, [
        {"A": make_meta("docA", "内容A")},
        {"B": make_meta("docB", "内容B")},
    ])

    store = JsonChunkStore(tmp_path)
    all_chunks = store.get_all()

    assert len(all_chunks) == 2
    assert all_chunks["A"].doc_id == "docA"
    assert all_chunks["B"].content == "内容B"


def test_instance_cache_no_reread(tmp_path):
    write_shards(tmp_path, [{"A": make_meta("docA", "内容A")}])

    store = JsonChunkStore(tmp_path)
    store.get_all()

    config_mtime = (tmp_path / "config.json").stat().st_mtime_ns
    store.get_all()
    # 二次调用走内存缓存（修改磁盘文件不反映）
    (tmp_path / "shard_0.json").write_text(
        json.dumps({"Z": make_meta("docZ", "新内容")}, ensure_ascii=False),
        encoding="utf-8",
    )
    assert set(store.get_all()) == {"A"}
    assert (tmp_path / "config.json").stat().st_mtime_ns == config_mtime


def test_missing_config_returns_empty(tmp_path):
    tmp_path.mkdir(parents=True, exist_ok=True)

    store = JsonChunkStore(tmp_path)

    assert store.get_all() == {}
    assert store.get_by_ids(["A"]) == []
