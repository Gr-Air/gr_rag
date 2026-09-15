"""文件系统文档存储（移植自 FsDocumentFileStore.ts）。

Raw / Wiki 目录 markdown 读取；路径来自 Settings（不直接读 env）。
"""

from __future__ import annotations

from pathlib import Path

from ...config import get_settings


class FsDocumentFileStore:
    def __init__(
        self,
        raw_dir: Path | None = None,
        wiki_dir: Path | None = None,
    ) -> None:
        settings = get_settings()
        self._raw_dir = raw_dir or settings.raw_dir
        self._wiki_dir = wiki_dir or settings.wiki_dir

    def read_raw_doc(self, doc_name: str) -> str | None:
        """读取 Raw/<docName>.md，不存在返回 None。"""
        file_path = self._raw_dir / f"{doc_name}.md"
        if not file_path.exists():
            return None
        try:
            return file_path.read_text(encoding="utf-8")
        except OSError as err:
            print(f"[FileStore] 读取 Raw 文档失败: {file_path} {err}")
            return None

    def read_wiki_doc(self, rel_path: str) -> str | None:
        """读取 Wiki/<relPath>，不存在返回 None。"""
        file_path = self._wiki_dir / rel_path
        if not file_path.exists():
            return None
        try:
            return file_path.read_text(encoding="utf-8")
        except OSError as err:
            print(f"[FileStore] 读取 Wiki 文档失败: {file_path} {err}")
            return None
