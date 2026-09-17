"""表格感知语义分块器（移植自 scripts/lib/chunker.cjs，Spec 038）。

分块策略（与 JS 版逐行对齐）：
  1. 按 ## 标题粗切为 sections
  2. section 内按段落/句子边界细切；表格行（| 开头且结尾 |）为不可分割单元
  3. 单元合并为 chunk（MIN~MAX，带重叠）；超大表格单独成 chunk
  4. 跨 section 全局 chunkIndex
  5. 合并过短相邻 chunk（合并后重排 chunkIndex，但 chunk id 保留合并前编号）
  6. 记录 sectionTitle
  7. 重叠按完整单元回带；单个单元体积超过 overlap_unit_max 时放弃重叠
     （宁可牺牲跨块语义连贯，也不让大段落被整段复制到下一块）

注意：chunk id 用「合并前」的 chunkIdx 生成，短块合并不重新生成 id（历史行为，勿改）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# 句子边界：中文句末标点后；或英文句号/问号/感叹号后接空格+大写字母
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？])\s*|(?<=\.)\s+(?=[A-Z])|(?<=[!?])\s+(?=[A-Z])")
_SECTION_SPLIT = re.compile(r"(?=^## )", flags=re.M)
_WIKI_LINK = re.compile(r"\[\[([^\]]+)\]\]")
_H1 = re.compile(r"^# (.+)$", flags=re.M)


@dataclass
class Chunk:
    id: str
    doc_id: str
    doc_title: str
    doc_path: str
    chunk_index: int
    content: str
    metadata: dict
    wiki_links: list[str] = field(default_factory=list)
    parent_doc_id: str = ""
    section_title: str | None = None


@dataclass
class _Unit:
    """分块中间态：一个不可再分的文本单元（一个句子，或整张表格）。

    模块私有；只服务于 chunk_document，不进对外契约。
    """

    text: str
    is_table: bool
    section_title: str


def extract_wiki_links(content: str) -> list[str]:
    """提取所有 [[wikiLinks]]，去重保序。"""
    return list(dict.fromkeys(m.strip() for m in _WIKI_LINK.findall(content)))


def parse_filename(filename: str) -> dict[str, str]:
    """解析 {客户}_{项目系统}_{文档类型}_{日期}.md。"""
    name = re.sub(r"\.md$", "", filename)
    parts = name.split("_")
    if len(parts) >= 4:
        return {
            "client": "_".join(parts[: len(parts) - 3]),
            "project": parts[len(parts) - 3],
            "docType": parts[len(parts) - 2],
            "date": parts[len(parts) - 1],
        }
    return {"client": "", "project": "", "docType": "", "date": ""}


def extract_title(content: str, filename: str) -> str:
    first_line = content.split("\n", 1)[0].strip() if content else ""
    if first_line.startswith("# "):
        return re.sub(r"^#\s+", "", first_line).strip()
    if (
        first_line.startswith("|")
        or first_line.startswith("---")
        or first_line.startswith("###")
        or not first_line
    ):
        m = _H1.search(content)
        return m.group(1).strip() if m else filename
    return re.sub(r"^#\s+", "", first_line).strip() or filename


def is_table_line(line: str) -> bool:
    trimmed = line.strip()
    return trimmed.startswith("|") and trimmed.endswith("|")


def is_table_block(text: str) -> bool:
    lines = [ln for ln in text.split("\n") if ln.strip()]
    return len(lines) >= 2 and all(is_table_line(ln) for ln in lines)


def split_paragraphs_table_aware(section_text: str) -> list[str]:
    """按段落切分，表格整体保留；表格内空行不中断表格。"""
    lines = section_text.split("\n")
    paragraphs: list[str] = []
    current: list[str] = []
    in_table = False

    def flush() -> None:
        if current:
            paragraphs.append("\n".join(current))
            current.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        is_tbl = is_table_line(line)

        if is_tbl:
            in_table = True
            current.append(line)
        elif in_table and line.strip() == "":
            # 向后找下一个非空行：仍是表格行则空行属于表格内部
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            if j < len(lines) and is_table_line(lines[j]):
                current.append(line)
            else:
                flush()
                in_table = False
        else:
            if in_table:
                flush()
                in_table = False
            if line.strip() == "":
                flush()
            else:
                current.append(line)
        i += 1

    flush()
    return [p for p in paragraphs if p.strip()]


def extract_section_title(section_text: str) -> str:
    first_line = section_text.split("\n", 1)[0].strip() if section_text else ""
    if first_line.startswith("## "):
        return re.sub(r"^##\s+", "", first_line).strip()
    return ""


def chunk_document(
    content: str,
    doc_id: str,
    doc_title: str,
    doc_path: str,
    metadata: dict,
    min_chunk_size: int = 200,
    max_chunk_size: int = 1000,
    overlap_unit_ratio: float = 0.2,
) -> list[Chunk]:
    parent_doc_id = f"parent_{doc_id}"

    sections = _SECTION_SPLIT.split(content)

    units: list[_Unit] = []
    for section in sections:
        trimmed = section.strip()
        if not trimmed:
            continue
        section_title = extract_section_title(trimmed)
        for para in split_paragraphs_table_aware(trimmed):
            if is_table_block(para):
                units.append(_Unit(para, True, section_title))
            else:
                for part in _SENTENCE_SPLIT.split(para):
                    s = part.strip()
                    if s:
                        units.append(_Unit(s, False, section_title))

    def make_chunk(text: str, idx: int, section_title: str | None) -> Chunk:
        return Chunk(
            id=f"{doc_id}_{idx}",
            doc_id=doc_id,
            doc_title=doc_title,
            doc_path=doc_path,
            chunk_index=idx,
            content=text,
            metadata=metadata,
            wiki_links=extract_wiki_links(text),
            parent_doc_id=parent_doc_id,
            section_title=section_title,
        )

    if not units:
        # 降级：固定大小切分
        chunks: list[Chunk] = []
        for i in range(0, len(content), max_chunk_size):
            sub = content[i : i + max_chunk_size]
            if not sub.strip():
                continue
            chunks.append(make_chunk(sub, len(chunks), None))
        return chunks

    chunks = []
    current_chunk = ""
    current_section_title = ""
    chunk_idx = 0
    overlap_chars_target = round((min_chunk_size + max_chunk_size) / 2 * 0.1)
    # 单个可回退单元的体积上限：超过就整段放弃回退。
    # 旧行为按"单元"回带，一个 900 字的段落会被原样复制到下一块，
    # 实际重叠量可达目标的十几倍，索引体积与检索重复都不可控。
    overlap_unit_max = max(overlap_chars_target, round(max_chunk_size * overlap_unit_ratio))

    for i, unit in enumerate(units):
        if len(current_chunk) == 0:
            current_section_title = unit.section_title

        # 大表格单独成 chunk
        if unit.is_table and len(unit.text) > max_chunk_size:
            if current_chunk.strip():
                chunks.append(make_chunk(current_chunk.strip(), chunk_idx, current_section_title))
                chunk_idx += 1
            chunks.append(make_chunk(unit.text, chunk_idx, unit.section_title))
            chunk_idx += 1
            current_chunk = ""
            continue

        if (
            len(current_chunk) + len(unit.text) > max_chunk_size
            and len(current_chunk) >= min_chunk_size
        ):
            chunks.append(make_chunk(current_chunk.strip(), chunk_idx, current_section_title))
            chunk_idx += 1

            # 重叠：从本 chunk 首个单元往前取完整单元
            # （跳过表格避免切碎表格；超大单元直接放弃重叠，宁可少重叠也不复制大段落）
            overlap_chars = 0
            overlap_idx = i
            while overlap_idx > 0 and overlap_chars < overlap_chars_target:
                candidate = units[overlap_idx - 1]
                if len(candidate.text) > overlap_unit_max:
                    break
                overlap_idx -= 1
                overlap_chars += len(candidate.text)
            overlap_units = [u.text for u in units[overlap_idx:i] if not u.is_table]
            current_chunk = "\n".join(overlap_units) + "\n" + unit.text + "\n"
            current_section_title = unit.section_title
        else:
            current_chunk += unit.text + "\n"

    if current_chunk.strip():
        chunks.append(make_chunk(current_chunk.strip(), chunk_idx, current_section_title))
        chunk_idx += 1

    # 合并过短相邻 chunk
    merged: list[Chunk] = []
    for chunk in chunks:
        last = merged[-1] if merged else None
        if last and (len(last.content) < min_chunk_size or len(chunk.content) < min_chunk_size):
            last.content = last.content + "\n\n" + chunk.content
            last.wiki_links = list(dict.fromkeys(last.wiki_links + chunk.wiki_links))
        else:
            merged.append(
                Chunk(
                    id=chunk.id,
                    doc_id=chunk.doc_id,
                    doc_title=chunk.doc_title,
                    doc_path=chunk.doc_path,
                    chunk_index=chunk.chunk_index,
                    content=chunk.content,
                    metadata=chunk.metadata,
                    wiki_links=list(chunk.wiki_links),
                    parent_doc_id=chunk.parent_doc_id,
                    section_title=chunk.section_title,
                )
            )

    # 合并后重排 chunkIndex（id 不变）
    for i, c in enumerate(merged):
        c.chunk_index = i

    return merged
