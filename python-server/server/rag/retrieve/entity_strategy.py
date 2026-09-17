"""搜索领域规则（纯函数，移植自 src/domain/search/entityStrategy.ts）。

- 查询策略：宽泛查询识别 + 动态 topK
- 搜索结果高亮片段生成
- 实体关键词向量过滤标记
"""

from __future__ import annotations

import re

from ..types import RetrievalHit

# ============================================================
# 查询策略
# ============================================================

"""查询策略版本：规则变更时 bump，用于检索缓存失效。"""
POLICY_VERSION = "v1"

_BROAD_QUERY_PATTERNS: list[re.Pattern] = [
    re.compile(p)
    for p in (
        r"相关的.*文档有哪些",
        r"有哪些.*项目",
        r"包含.*的文档",
        r"涉及.*的项目",
        r"哪些.*文档",
        r"哪些.*项目",
        r"有.*多少.*文档",
        r"有.*多少.*项目",
    )
]

"""宽泛查询下 topK 收敛到此值。"""
BROAD_QUERY_TOPK = 3


def is_broad_query(query: str) -> bool:
    return any(p.search(query) for p in _BROAD_QUERY_PATTERNS)


def adjust_topk_for_broad_query(query: str, top_k: int) -> int:
    if is_broad_query(query) and top_k > BROAD_QUERY_TOPK:
        print(f"[Hybrid] 检测到宽泛查询，topK 从 {top_k} 调整为 {BROAD_QUERY_TOPK}")
        return BROAD_QUERY_TOPK
    return top_k


# ============================================================
# 高亮
# ============================================================

_REGEX_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\]")
_WHITESPACE = re.compile(r"\s+")


def _escape_regex(word: str) -> str:
    return _REGEX_SPECIAL.sub(r"\\\g<0>", word)


def generate_highlight(content: str, query: str) -> str:
    """定位首个查询字符命中位置，截取窗口并对查询词（按空格切分）加粗。"""
    max_highlight_len = 300
    query_chars = _WHITESPACE.sub("", query)

    if not query_chars:
        snippet = content[:max_highlight_len]
        return snippet + ("..." if len(content) > max_highlight_len else "")

    # 查找第一个匹配位置（大小写敏感，与 JS indexOf 一致）
    best_idx = 0
    for char in query_chars:
        idx = content.find(char)
        if idx != -1:
            best_idx = idx
            break

    start = max(0, best_idx - 50)
    end = min(len(content), start + max_highlight_len)
    snippet = content[start:end]

    # 高亮查询词：JS 版正则无 g 标志，String.replace 只替换每词的首个命中
    query_words = [w for w in _WHITESPACE.split(query) if len(w) > 0]
    for word in query_words:
        pattern = re.compile(f"({_escape_regex(word)})", re.IGNORECASE)
        snippet = pattern.sub(r"**\1**", snippet, count=1)

    if start > 0:
        snippet = "..." + snippet
    if end < len(content):
        snippet = snippet + "..."
    return snippet


# ============================================================
# 实体过滤
# ============================================================


def build_vector_entity_filter(
    vector_hits: list[RetrievalHit],
    matched_keywords: list[str] | None,
    content_map: dict[str, str],
) -> set[str] | None:
    """返回不含任一实体关键词的向量 hit chunkId 集合；无需过滤时返回 None。"""
    if not matched_keywords or not vector_hits:
        return None

    excluded_ids: set[str] = set()
    for vr in vector_hits:
        content = content_map.get(vr.chunk_id, "")
        has_keyword = any(kw in content for kw in matched_keywords)
        if not has_keyword:
            excluded_ids.add(vr.chunk_id)

    if excluded_ids:
        print(
            f"[Hybrid] 实体关键词过滤: 向量结果 {len(vector_hits)} 条中 {len(excluded_ids)} "
            f"条不包含 [{', '.join(matched_keywords)}]，向量排名将不计入 RRF"
        )
        return excluded_ids
    return None
