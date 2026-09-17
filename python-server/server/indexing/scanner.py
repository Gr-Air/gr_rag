"""文件扫描器（移植自 scripts/lib/scanner.cjs）。

扫描 Raw/*.md 与 Wiki/{concept,entity}/*.md，路径来自 config.Settings。
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import get_settings


@dataclass
class RawDoc:
    file: str  # 形如 Raw/xxx.md
    content: str
    key: str  # raw_<文件名去 .md>


@dataclass
class WikiEntry:
    file: str  # Wiki/entity/xxx.md
    content: str
    key: str  # wiki_<name>
    name: str
    type: str  # concept | entity


def scan_raw_documents() -> list[RawDoc]:
    settings = get_settings()
    results: list[RawDoc] = []
    if not settings.raw_dir.exists():
        return results
    for p in sorted(settings.raw_dir.glob("*.md")):
        results.append(
            RawDoc(
                file=f"Raw/{p.name}",
                content=p.read_text(encoding="utf-8"),
                key=f"raw_{p.name.removesuffix('.md')}",
            )
        )
    return results


def scan_wiki_entries() -> list[WikiEntry]:
    settings = get_settings()
    results: list[WikiEntry] = []
    for sub in ("concept", "entity"):
        d = settings.wiki_dir / sub
        if not d.exists():
            continue
        for p in sorted(d.glob("*.md")):
            name = p.name.removesuffix(".md")
            results.append(
                WikiEntry(
                    file=f"Wiki/{sub}/{p.name}",
                    content=p.read_text(encoding="utf-8"),
                    key=f"wiki_{name}",
                    name=name,
                    type=sub,
                )
            )
    return results


def scan_all() -> tuple[list[RawDoc], list[WikiEntry]]:
    return scan_raw_documents(), scan_wiki_entries()
