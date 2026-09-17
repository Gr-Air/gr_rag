"""文件系统文档存储（移植自 FsDocumentFileStore.ts）。

Raw / Wiki 目录 markdown 读取；路径来自 Settings（不直接读 env）。

relPath 归一化约定
------------------
Wiki 词条的 path 在 struct_kb.db / stats 里存的是**仓库相对路径**
（`Wiki/<concept|entity>/<name>.md`），而本 Store 的工作目录是 `WIKI_DIR`。
直接拼接会得到 `WIKI_DIR/Wiki/concept/x.md` 这种双前缀路径，永远读不到文件；
因此这里统一剥掉开头的 `Wiki/` 或与 WIKI_DIR 同名的首段后再拼接。
"""

from __future__ import annotations

from pathlib import Path

from ...config import get_settings

# 仓库相对路径里 Wiki 根目录的两种历史写法
_WIKI_ROOT_NAMES = ("Wiki", "wiki")


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
        """读取 Wiki 词条全文；支持 `Wiki/concept/x.md` 与 `concept/x.md` 两种写法。"""
        file_path = self._resolve_wiki_path(rel_path)
        if file_path is None or not file_path.exists():
            return None
        try:
            return file_path.read_text(encoding="utf-8")
        except OSError as err:
            print(f"[FileStore] 读取 Wiki 文档失败: {file_path} {err}")
            return None

    def _resolve_wiki_path(self, rel_path: str) -> Path | None:
        if not rel_path:
            return None

        candidate = Path(rel_path)
        if candidate.is_absolute():
            return candidate

        # 剥掉与 Wiki 根重名的首段，避免 WIKI_DIR 双前缀
        parts = list(candidate.parts)
        if parts and parts[0] in (*_WIKI_ROOT_NAMES, self._wiki_dir.name):
            parts = parts[1:]
        if not parts:
            return None

        base = self._wiki_dir.resolve()
        resolved = (base / Path(*parts)).resolve()
        if not resolved.is_relative_to(base):
            print(f"[FileStore] 拒绝越界路径: {rel_path}")
            return None
        return resolved
