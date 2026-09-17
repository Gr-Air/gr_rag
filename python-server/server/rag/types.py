"""检索 Domain 类型（Spec 038 P2，移植自 src/domain/{search,document}/types.ts）。

dataclass 版检索内核模型；None 语义对齐 TS 的 ``undefined``（字段缺省）。
路由层 DTO 序列化时通过 scores_to_dict 丢弃 None，与 TS JSON 行为一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

SearchSource = Literal["vector", "bm25", "rrf", "entity", "hybrid"]
SearchMethod = Literal["rrf", "entity"]

# ============================================================
# 文档块
# ============================================================


@dataclass
class DocChunk:
    """文档块（检索最小单元）。"""

    id: str
    doc_id: str
    doc_title: str
    doc_path: str
    chunk_index: int
    content: str
    metadata: dict = field(default_factory=dict)
    wiki_links: list[str] = field(default_factory=list)
    parent_doc_id: str | None = None
    parent_start: int | None = None
    parent_end: int | None = None


@dataclass
class ChunkMeta:
    """Chunk 元数据（与 chunks_meta JSON 分片结构对齐）。"""

    doc_id: str
    doc_title: str
    doc_path: str
    metadata: dict
    content: str
    wiki_links: list[str] = field(default_factory=list)
    parent_doc_id: str | None = None


# ============================================================
# 检索中间态 / 最终态
# ============================================================


@dataclass
class Scores:
    """分数链路（各阶段只追加，不覆盖）。None = TS 的字段缺省。"""

    vector: float | None = None
    bm25: float | None = None
    rrf: float | None = None
    rerank: float | None = None
    struct: float | None = None


@dataclass
class Ranks:
    """各路 1-based 排名；被实体过滤的向量结果 vector 缺省。"""

    vector: int | None = None
    bm25: int | None = None
    struct: int | None = None


@dataclass
class RetrievalHit:
    """检索管线中间结果：chunkId + 分数链路。"""

    chunk_id: str
    scores: Scores = field(default_factory=Scores)
    ranks: Ranks = field(default_factory=Ranks)
    source: SearchSource = "rrf"
    """组装阶段批量附上。"""
    chunk: DocChunk | None = None


@dataclass
class SearchResult:
    """搜索结果（最终展示态）。"""

    chunk: DocChunk
    score: float
    scores: Scores
    source: SearchSource
    highlight: str | None = None


# ============================================================
# Phase 2：RetrievalContext 拆分
# ============================================================


@dataclass
class SearchQuery:
    """纯查询意图。"""

    query: str


@dataclass
class QueryAnalysis:
    """查询分析结果（实体匹配信息）。"""

    matched_keywords: list[str] | None = None


@dataclass
class RetrievalFilter:
    """检索过滤条件（docType 白名单，来自 LLM 改写）。"""

    filtered_chunk_ids: list[str] | None = None


@dataclass
class RetrievalOptions:
    """Retriever 选项：topN + 过滤 + 结构化关键词。"""

    top_n: int
    filter: RetrievalFilter | None = None
    keywords: list[str] | None = None


@dataclass
class RetrievalRequest:
    """完整检索请求：query + analysis + filter。"""

    query: SearchQuery
    analysis: QueryAnalysis | None = None
    filter: RetrievalFilter | None = None


def scores_to_dict(scores: Scores) -> dict:
    """Scores → JSON dict，丢弃 None（对齐 TS ``JSON.stringify`` 省略 undefined）。"""
    out: dict[str, float] = {}
    if scores.vector is not None:
        out["vector"] = scores.vector
    if scores.bm25 is not None:
        out["bm25"] = scores.bm25
    if scores.rrf is not None:
        out["rrf"] = scores.rrf
    if scores.rerank is not None:
        out["rerank"] = scores.rerank
    if scores.struct is not None:
        out["struct"] = scores.struct
    return out


# ============================================================
# 文档类型白名单（校验 LLM 输出的 relevantDocTypes）
# ============================================================

KNOWN_DOC_TYPES: frozenset[str] = frozenset(
    [
        "客户项目验收",
        "技术方案",
        "技术架构设计",
        "来往账目",
        "系统测试报告",
        "需求规格说明书",
        "项目人员清单",
        "项目管理计划",
        "项目费用结算",
        "项目进度汇报",
        "大型台账",
    ]
)
