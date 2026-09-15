"""文档片段提取（领域纯函数，移植自 src/domain/entity/snippets.ts）。

- estimate_tokens：中英文混合 token 估算
- merge_ranges：重叠区间合并
- extract_entity_snippets：长文档实体上下文片段提取（密度排序 top-N）
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

_CJK_PATTERN = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]")
_REGEX_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\]")


@dataclass
class Range:
    start: int
    end: int


def estimate_tokens(text: str) -> int:
    """中文约 1.5 字符/token，英文/数字约 4 字符/token。"""
    chinese_chars = 0
    other_chars = 0
    for ch in text:
        if _CJK_PATTERN.match(ch):
            chinese_chars += 1
        else:
            other_chars += 1
    return math.ceil(chinese_chars / 1.5 + other_chars / 4)


def merge_ranges(ranges: list[Range]) -> list[Range]:
    if not ranges:
        return []
    sorted_ranges = sorted(ranges, key=lambda r: r.start)
    merged = [Range(sorted_ranges[0].start, sorted_ranges[0].end)]

    for r in sorted_ranges[1:]:
        last = merged[-1]
        if r.start <= last.end:
            last.end = max(last.end, r.end)
        else:
            merged.append(Range(r.start, r.end))
    return merged


def _escape_regex(word: str) -> str:
    return _REGEX_SPECIAL.sub(r"\\\g<0>", word)


def extract_entity_snippets(
    content: str,
    doc_name: str,
    keywords: list[str],
    context_tokens: int,
    max_snippets: int,
    cn_chars_per_token: float,
    en_chars_per_token: float,
) -> str | None:
    sorted_keywords = sorted(keywords, key=lambda k: -len(k))
    escaped = [_escape_regex(k) for k in sorted_keywords]
    pattern = re.compile("|".join(escaped), re.IGNORECASE)

    matches = [(m.start(), m.end()) for m in pattern.finditer(content)]
    if not matches:
        return None

    avg_chars_per_token = (cn_chars_per_token + en_chars_per_token) / 2
    context_chars = math.ceil(context_tokens * avg_chars_per_token)

    raw_ranges = [
        Range(max(0, start - context_chars), min(len(content), end + context_chars))
        for start, end in matches
    ]
    merged_ranges = merge_ranges(raw_ranges)

    scored = []
    for rng in merged_ranges:
        mention_count = sum(
            1 for start, end in matches if start >= rng.start and end <= rng.end
        )
        range_length = rng.end - rng.start
        density = mention_count / (range_length or 1)
        scored.append((rng.start, rng.end, mention_count, density))

    # 密度降序取 top-N，再按原始位置排序输出
    scored.sort(key=lambda x: -x[3])
    top = sorted(scored[:max_snippets], key=lambda x: x[0])

    parts = []
    multi = len(top) > 1
    for idx, (start, end, mention_count, _density) in enumerate(top):
        snippet = content[start:end].strip()
        start_token = estimate_tokens(content[:start])
        end_token = start_token + estimate_tokens(snippet)
        if multi:
            header = (
                f"#### 片段 {idx + 1}（约第 {start_token}-{end_token} token，"
                f"提及 {mention_count} 次）"
            )
        else:
            header = (
                f"#### 实体上下文片段（约第 {start_token}-{end_token} token，"
                f"提及 {mention_count} 次）"
            )
        parts.append(f"{header}\n\n{snippet}")

    return (
        f"### {doc_name}（长文档片段提取，原文档约 {estimate_tokens(content)} token）\n\n"
        + "\n\n".join(parts)
    )
