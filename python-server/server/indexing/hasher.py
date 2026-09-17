"""文件内容 hash 与增量状态快照（移植自 scripts/lib/hasher.cjs）。"""

from __future__ import annotations

import hashlib
from typing import Protocol


class _KeyedContent(Protocol):
    key: str
    content: str


def file_hash(content: str) -> str:
    return hashlib.md5(content.encode("utf-8")).hexdigest()


def build_state_snapshot(files: list[_KeyedContent]) -> dict[str, str]:
    return {f.key: file_hash(f.content) for f in files}
