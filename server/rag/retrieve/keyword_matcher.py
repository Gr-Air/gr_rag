"""实体关键词匹配（领域纯函数，移植自 src/domain/entity/keywordMatcher.ts）。

- extract_matching_keywords：贪心最大匹配（长词优先、大小写不敏感）+ 全局包含匹配
- decompose_entity：未知实体分解为已知实体组合
字典（关键字列表）由调用方注入。
"""

from __future__ import annotations


def extract_matching_keywords(query: str, keywords: list[str]) -> list[str]:
    # dict 键保插入序：对齐 TS Set 的插入序（Python set 哈希序随机，
    # 最终长度降序稳定排序的并列项必须保持发现顺序）
    matched: dict[str, None] = {}
    query_lower = query.lower()
    sorted_kws = sorted(keywords, key=lambda kw: -len(kw))

    # 贪心最大匹配（从当前位置开始，按关键字长度降序尝试）
    i = 0
    qlen = len(query)
    while i < qlen:
        found = False
        for kw in sorted_kws:
            kw_len = len(kw)
            if i + kw_len > qlen:
                continue
            if query_lower[i : i + kw_len] == kw.lower():
                matched[kw] = None
                i += kw_len
                found = True
                break
        if not found:
            i += 1

    # 全局包含匹配（处理非连续出现）
    for kw in sorted_kws:
        if kw.lower() in query_lower:
            matched[kw] = None

    return sorted(matched, key=lambda kw: -len(kw))


def decompose_entity(unknown: str, known_names: list[str]) -> list[str]:
    """未知实体 → 所有为其子串（长度≥2）的已知实体，长度降序。"""
    results: list[str] = []
    unknown_lower = unknown.lower()

    for known in known_names:
        if len(known) >= 2 and known.lower() in unknown_lower:
            if not any(known in r for r in results):
                results.append(known)

    return sorted(results, key=lambda kw: -len(kw))
