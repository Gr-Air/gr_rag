"""索引 Manifest（移植自 scripts/lib/manifest.cjs）。

- 原子读写（tmp + os.replace，中断不损坏）
- 各 store 就绪状态收集
- 构建成功后生成完整 manifest；必需 store 缺失则拒绝写入（保留旧版本）

必需 store：lancedb / bm25 / chunksMeta / parents；structDb 可选。
读取语义：manifest 缺失或 JSON 损坏 → None（调用方降级）。
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MANIFEST_FILENAME = "index_manifest.json"
REQUIRED_STORES = ["lancedb", "bm25", "chunksMeta", "parents"]  # bm25 store 名称保留以兼容旧 manifest，路径已切到 tantivy_bm25/
OPTIONAL_STORES = ["structDb"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _has_matching_file(d: Path, prefix: str, ext: str) -> bool:
    return d.exists() and any(f.name.startswith(prefix) and f.name.endswith(ext) for f in d.iterdir())


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def collect_store_status(data_dir: Path, name: str) -> dict:
    ready = False
    detail: dict | None = None

    if name == "lancedb":
        ready = (data_dir / "lancedb").exists() and (data_dir / "lancedb" / "chunks.lance").exists()
        try:
            cfg = _read_json(data_dir / "vectors" / "config.json")
            detail = {"totalChunks": cfg.get("totalChunks"), "dim": cfg.get("dim")}
        except Exception:
            pass
    elif name == "bm25":
        d = data_dir / "tantivy_bm25"
        # tantivy 自有持久化：目录存在 + 至少有一个 tantivy 段文件
        ready = d.exists() and any(
            f.name.endswith(".meta.json")
            or f.suffix in (".idx", ".pos", ".term", ".fast")
            for f in d.iterdir()
        ) if d.exists() else False
        try:
            meta_path = next((f for f in d.iterdir() if f.name.endswith(".meta.json")), None)
            if meta_path:
                meta = _read_json(meta_path)
                detail = {"docCount": meta.get("doc_count"), "indexed": meta.get("indexed")}
        except Exception:
            pass
    elif name == "chunksMeta":
        d = data_dir / "chunks_meta"
        ready = (d / "config.json").exists() and _has_matching_file(d, "shard_", ".json")
        try:
            cfg = _read_json(d / "config.json")
            detail = {"totalChunks": cfg.get("totalChunks"), "totalShards": cfg.get("totalShards")}
        except Exception:
            pass
    elif name == "parents":
        ready = (data_dir / "parents" / "parents.json").exists()
    elif name == "structDb":
        ready = (data_dir / "struct_kb.db").exists()

    return {"ready": ready, "detail": detail}


def collect_stores_status(data_dir: Path) -> dict[str, dict]:
    return {n: collect_store_status(data_dir, n) for n in REQUIRED_STORES + OPTIONAL_STORES}


def check_stores_ready(data_dir: Path) -> bool:
    return all(collect_store_status(data_dir, n)["ready"] for n in REQUIRED_STORES)


def get_manifest_path(data_dir: Path) -> Path:
    return data_dir / MANIFEST_FILENAME


def read_manifest(data_dir: Path) -> dict | None:
    p = get_manifest_path(data_dir)
    if not p.exists():
        return None
    try:
        m = _read_json(p)
        if not isinstance(m, dict) or not isinstance(m.get("indexVersion"), int):
            return None
        return m
    except Exception:
        return None


def write_manifest(data_dir: Path, manifest: dict) -> None:
    """原子写：tmp + replace。"""
    p = get_manifest_path(data_dir)
    tmp = Path(str(p) + ".tmp")  # index_manifest.json.tmp，与 JS 版一致
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def get_git_commit(root_dir: Path | None = None) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(root_dir) if root_dir else None,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def _read_staging_info(data_dir: Path) -> dict:
    try:
        s = _read_json(data_dir / "chunks_staging" / "manifest.json")
        return {
            "pipelineVersion": s.get("pipelineVersion"),
            "totalDocs": s.get("totalDocs"),
            "gitCommit": s.get("gitCommit"),
        }
    except Exception:
        return {"pipelineVersion": None, "totalDocs": None, "gitCommit": None}


def build_manifest(data_dir: Path, build_mode: str = "full") -> dict | None:
    if not check_stores_ready(data_dir):
        return None
    stores = collect_stores_status(data_dir)
    staging = _read_staging_info(data_dir)
    prev = read_manifest(data_dir)
    return {
        "indexVersion": (prev["indexVersion"] if prev else 0) + 1,
        "pipelineVersion": staging["pipelineVersion"],
        "gitCommit": get_git_commit() or staging["gitCommit"],
        "builtAt": _now_iso(),
        "buildMode": build_mode,
        "stores": stores,
        "stats": {
            "totalDocs": staging["totalDocs"],
            "totalChunks": (stores["chunksMeta"]["detail"] or {}).get("totalChunks"),
        },
    }


def write_manifest_after_build(data_dir: Path, build_mode: str = "full") -> dict | None:
    manifest = build_manifest(data_dir, build_mode)
    if manifest is None:
        return None
    write_manifest(data_dir, manifest)
    return manifest


def update_struct_db_entry(data_dir: Path) -> dict | None:
    """struct 子命令构建完成后，只刷新 structDb store 状态并 bump 版本（移植自 manifest.cjs）。"""
    status = collect_store_status(data_dir, "structDb")
    if not status["ready"]:
        return None

    prev = read_manifest(data_dir)
    if prev:
        manifest = dict(prev)
        stores = dict(prev.get("stores") or {})
    else:
        manifest = {
            "indexVersion": 0,
            "pipelineVersion": None,
            "gitCommit": None,
            "buildMode": "structdb-only",
            "stores": {},
            "stats": {},
        }
        stores = {}

    stores["structDb"] = status
    manifest["stores"] = stores
    manifest["indexVersion"] = int(manifest.get("indexVersion") or 0) + 1
    manifest["builtAt"] = _now_iso()
    write_manifest(data_dir, manifest)
    return manifest


def cleanup_manifest_tmp(data_dir: Path) -> None:
    tmp = Path(str(get_manifest_path(data_dir)) + ".tmp")
    try:
        if tmp.exists():
            tmp.unlink()
    except Exception:
        pass
