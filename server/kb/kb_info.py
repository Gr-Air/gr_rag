"""知识库统计与 Raw 文档列表（逐字移植自 src/infrastructure/parser/parser.ts）。

注意：这里的语义分块与 indexing/chunker.py（scripts/lib/chunker.cjs 的表格感知版）
**不是**同一算法——TS 生产侧 stats/docs 实时重解析用的就是 parser.ts 内的
semanticChunkDocument（非表格感知），totalChunks 因此可能与索引块数不一致。
行为零变化，勿互换。
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

from ..config import get_settings
from ..indexing.chunker import extract_wiki_links, parse_filename

_MIN_CHUNK_SIZE = 200
_MAX_CHUNK_SIZE = 1000
_OVERLAP_CHARS = round((_MIN_CHUNK_SIZE + _MAX_CHUNK_SIZE) / 2 * 0.1)

_SECTION_SPLIT = re.compile(r"(?=^## )", flags=re.M)
_PARA_SPLIT = re.compile(r"\n\s*\n")
_FREQUENCY = re.compile(r"出现频次:\s*(\d+)")

# 与 chunker._SENTENCE_SPLIT 同一规则（parser.ts 的句子边界正则逐字一致）
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？])\s*|(?<=\.)\s+(?=[A-Z])|(?<=[!?])\s+(?=[A-Z])")

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


def _semantic_chunk_count(content: str) -> int:
    """semanticChunkDocument：只返回合并后的 chunk 数量（stats/docs 只用长度）。"""
    sections = _SECTION_SPLIT.split(content)

    sentences: list[str] = []
    for section in sections:
        trimmed = section.strip()
        if not trimmed:
            continue
        for para in _PARA_SPLIT.split(trimmed):
            if not para.strip():
                continue
            for part in _SENTENCE_SPLIT.split(para):
                s = part.strip()
                if s:
                    sentences.append(s)

    if not sentences:
        # 降级：固定大小切分
        count = 0
        for i in range(0, len(content), _MAX_CHUNK_SIZE):
            sub = content[i : i + _MAX_CHUNK_SIZE]
            if sub.strip():
                count += 1
        return count

    chunks: list[str] = []
    current = ""
    for i, sentence in enumerate(sentences):
        if (
            len(current) + len(sentence) > _MAX_CHUNK_SIZE
            and len(current) >= _MIN_CHUNK_SIZE
        ):
            chunks.append(current.strip())

            overlap_chars = 0
            overlap_idx = i
            while overlap_idx > 0 and overlap_chars < _OVERLAP_CHARS:
                overlap_idx -= 1
                overlap_chars += len(sentences[overlap_idx])
            current = (
                "\n".join(sentences[overlap_idx:i]) + "\n" + sentence + "\n"
            )
        else:
            current += sentence + "\n"

    if current.strip():
        chunks.append(current.strip())

    # 合并过短相邻 chunk（合并会减少 chunk 数）
    merged: list[str] = []
    for chunk in chunks:
        if merged and (len(merged[-1]) < _MIN_CHUNK_SIZE or len(chunk) < _MIN_CHUNK_SIZE):
            merged[-1] = merged[-1] + "\n\n" + chunk
        else:
            merged.append(chunk)
    return len(merged)


def _extract_title(content: str, filename: str) -> str:
    """parser.ts：首行去 ``^#\\s+`` 后 trim，空则回落文件名。"""
    first_line = content.split("\n", 1)[0] if content else ""
    return re.sub(r"^#\s+", "", first_line).strip() or filename


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
        docs: list[dict] = []
        if not self._raw_dir.exists():
            return docs
        # sorted：Node readdirSync 经 libuv/getattrlistbulk 在 APFS 上按名升序枚举，
        # os.listdir（getdirentries）无序，必须显式排序才能对齐稳定排序与列表顺序
        for filename in sorted(os.listdir(self._raw_dir)):
            if not filename.endswith(".md"):
                continue
            content = (self._raw_dir / filename).read_text(encoding="utf-8")
            name = filename[: -len(".md")]
            meta = parse_filename(filename)
            docs.append(
                {
                    "id": f"raw_{name}",
                    "title": _extract_title(content, filename),
                    "path": f"Raw/{filename}",
                    "rawContent": content,
                    "metadata": {
                        "client": meta["client"],
                        "project": meta["project"],
                        "docType": meta["docType"],
                        "date": meta["date"],
                    },
                    "wikiLinks": extract_wiki_links(content),
                    "chunkCount": _semantic_chunk_count(content),
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

    def list_raw_docs(self) -> list[dict]:
        return [
            {
                "id": d["id"],
                "title": d["title"],
                "path": d["path"],
                "metadata": d["metadata"],
                "wikiLinks": d["wikiLinks"],
                "chunkCount": d["chunkCount"],
            }
            for d in self._load_raw_docs()
        ]


@lru_cache(maxsize=1)
def get_kb_info() -> KbInfo:
    return KbInfo()
