"""知识库统计（对外契约沿用 src/infrastructure/parser/parser.ts）。

分块口径已统一：chunkCount 由 indexing/chunker.py 的表格感知分块器产出，
与索引实际落盘块数一致（原 TS 版另有一套非表格感知的 semanticChunkDocument，
导致 totalChunks 与索引块数对不上）。
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

from ..config import get_settings
from ..indexing.chunker import chunk_document, extract_title, parse_filename

_FREQUENCY = re.compile(r"出现频次:\s*(\d+)")

# guessEntityCategory 词表（逐字移植，顺序勿动）
_CLIENTS = [
    "万科集团", "中信证券", "中化集团", "中国中车", "中国中铁", "中国建筑",
    "中国电科", "中国石油", "中国移动", "中国联通", "中国航发", "中国航天",
    "中国船舶", "中国银行", "中粮集团", "中钢集团", "华润置地", "华能集团",
    "南方电网", "国家电网", "国泰君安", "太平洋保险", "宝武钢铁", "招商银行",
    "浦发银行", "碧桂园", "融创中国", "龙湖集团",
]
_TECH_COMPONENTS = [
    "Redis", "MySQL", "PostgreSQL", "MongoDB", "Kafka", "RabbitMQ", "RocketMQ",
    "Elasticsearch", "Nginx", "Docker", "Kubernetes", "Jenkins", "GitLab",
    "Spring", "SpringCloud", "Vue", "React", "Node.js", "Python", "Java",
    "阿里云", "腾讯云", "华为云", "AWS", "Azure", "高斯DB", "MinIO",
]
_DEPARTMENTS = [
    "产品设计部", "人力资源部", "商务拓展部", "技术研发部",
    "财务管理部", "质量保障部", "项目管理部",
]
_PERSON_NAME = re.compile(r"^[一-龥]{2,3}$")  # 一-龥 = U+4E00..U+9FA5


def count_chunks(
    content: str,
    doc_id: str,
    title: str,
    doc_path: str,
    metadata: dict,
) -> int:
    """与索引同源计数：直接复用 indexing 的表格感知分块器。"""
    return len(chunk_document(content, doc_id, title, doc_path, metadata))


def _guess_entity_category(name: str) -> str:
    if name in _CLIENTS:
        return "客户企业"
    if name in _TECH_COMPONENTS:
        return "技术组件"
    if name in _DEPARTMENTS:
        return "部门"
    if _PERSON_NAME.match(name):
        return "人员"
    return "项目系统"


class KbInfo:
    """Raw/Wiki 文件系统实时重解析（路径来自 Settings）。"""

    def __init__(self, raw_dir: Path | None = None, wiki_dir: Path | None = None) -> None:
        settings = get_settings()
        self._raw_dir = raw_dir or settings.raw_dir
        self._wiki_dir = wiki_dir or settings.wiki_dir

    # ------------------------------------------------------------
    # 解析
    # ------------------------------------------------------------

    def _load_raw_docs(self) -> list[dict]:
        """Raw 文档 → 统计真正消费的字段（metadata + 与索引同源的 chunkCount）。"""
        docs: list[dict] = []
        if not self._raw_dir.exists():
            return docs
        # sorted：Node readdirSync 经 libuv/getattrlistbulk 在 APFS 上按名升序枚举，
        # os.listdir（getdirentries）无序，必须显式排序才能对齐稳定排序与列表顺序
        for filename in sorted(os.listdir(self._raw_dir)):
            if not filename.endswith(".md"):
                continue
            content = (self._raw_dir / filename).read_text(encoding="utf-8")
            metadata = parse_filename(filename)
            # title 与索引侧（indexing/cli.py）走同一实现，保证计数口径同源
            title = extract_title(content, filename)
            name = filename[: -len(".md")]
            docs.append(
                {
                    "metadata": metadata,
                    "chunkCount": count_chunks(
                        content, f"raw_{name}", title, f"Raw/{filename}", metadata
                    ),
                }
            )
        return docs

    def _load_wiki_entries(self) -> list[dict]:
        entries: list[dict] = []
        for sub in ("concept", "entity"):
            directory = self._wiki_dir / sub
            if not directory.exists():
                continue
            # sorted：对齐 Node readdirSync 的 APFS 升序枚举（见 _load_raw_docs）
            for filename in sorted(os.listdir(directory)):
                if not filename.endswith(".md"):
                    continue
                content = (directory / filename).read_text(encoding="utf-8")
                name = filename[: -len(".md")]
                match = _FREQUENCY.search(content)
                frequency = int(match.group(1)) if match else 0
                if sub == "concept":
                    # category 为 undefined：JSON.stringify 直接省略该键
                    entries.append(
                        {
                            "name": name,
                            "type": sub,
                            "frequency": frequency,
                            "path": f"Wiki/{sub}/{filename}",
                        }
                    )
                else:
                    entries.append(
                        {
                            "name": name,
                            "type": sub,
                            "frequency": frequency,
                            "category": _guess_entity_category(name),
                            "path": f"Wiki/{sub}/{filename}",
                        }
                    )
        return entries

    # ------------------------------------------------------------
    # 对外能力（KbInfoPort）
    # ------------------------------------------------------------

    def get_wiki_stats(self) -> dict:
        raw_docs = self._load_raw_docs()
        wiki_entries = self._load_wiki_entries()

        # Python sorted 稳定：频次并列保持目录枚举顺序（与 V8 Array.sort 一致）
        concepts = sorted(
            (e for e in wiki_entries if e["type"] == "concept"),
            key=lambda e: -e["frequency"],
        )
        entities = sorted(
            (e for e in wiki_entries if e["type"] == "entity"),
            key=lambda e: -e["frequency"],
        )

        clients: dict[str, None] = {}
        projects: dict[str, None] = {}
        doc_types: dict[str, None] = {}
        for doc in raw_docs:
            meta = doc["metadata"]
            if meta["client"]:
                clients[meta["client"]] = None
            if meta["project"]:
                projects[meta["project"]] = None
            if meta["docType"]:
                doc_types[meta["docType"]] = None

        return {
            "totalDocs": len(raw_docs),
            "totalChunks": sum(d["chunkCount"] for d in raw_docs),
            "totalConcepts": len(concepts),
            "totalEntities": len(entities),
            "totalClients": len(clients),
            "totalProjects": len(projects),
            "totalDocTypes": len(doc_types),
            "topConcepts": concepts[:20],
            "topEntities": entities[:20],
            "clients": sorted(clients),
            "projects": sorted(projects),
            "docTypes": sorted(doc_types),
        }


@lru_cache(maxsize=1)
def get_kb_info() -> KbInfo:
    return KbInfo()
