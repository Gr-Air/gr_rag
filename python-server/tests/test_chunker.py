"""chunker 行为测试（对应 JS chunker 关键规则）。"""

from server.indexing.chunker import (
    chunk_document,
    extract_title,
    extract_wiki_links,
    is_table_block,
    parse_filename,
    split_paragraphs_table_aware,
)

META = {"client": "c", "project": "p", "docType": "t", "date": "d"}


def test_parse_filename_four_parts():
    m = parse_filename("国家电网_ERP系统_需求规格说明书_20250101.md")
    assert m == {"client": "国家电网", "project": "ERP系统",
                 "docType": "需求规格说明书", "date": "20250101"}


def test_parse_filename_client_contains_underscore():
    m = parse_filename("中国_建筑集团_OA_验收报告_20250101.md")
    assert m["client"] == "中国_建筑集团"
    assert m["project"] == "OA"


def test_parse_filename_too_few_parts():
    assert parse_filename("随便.md") == {"client": "", "project": "", "docType": "", "date": ""}


def test_extract_title_h1():
    assert extract_title("# 我是标题\n正文", "f.md") == "我是标题"


def test_extract_title_table_first_line_fallback():
    assert extract_title("| a | b |\n|---|---|\n# 真实标题", "f.md") == "真实标题"


def test_extract_title_no_h1_uses_filename():
    assert extract_title("普通文本开头", "降级名.md") == "普通文本开头"


def test_wiki_links_dedup_ordered():
    assert extract_wiki_links("见 [[A]] 和 [[B]] 再 [[A]]") == ["A", "B"]


def test_table_block_detection():
    table = "| a | b |\n|---|---|\n| 1 | 2 |"
    assert is_table_block(table)
    assert not is_table_block("普通段落\n第二行")


def test_table_blank_line_does_not_split_table():
    text = "| a | b |\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |"
    paras = split_paragraphs_table_aware(text)
    assert len(paras) == 1
    assert is_table_block(paras[0])


def test_table_blank_line_ends_table_when_next_is_text():
    text = "| a |\n|---|\n| 1 |\n\n普通段落"
    paras = split_paragraphs_table_aware(text)
    assert len(paras) == 2


def test_chunk_basic_fields_and_ids():
    content = "# 标题\n\n" + "这是一个足够长的段落。" * 60
    chunks = chunk_document(content, "raw_x", "标题", "Raw/x.md", META)
    assert len(chunks) >= 1
    c0 = chunks[0]
    assert c0.id == "raw_x_0"
    assert c0.parent_doc_id == "parent_raw_x"
    assert c0.doc_path == "Raw/x.md"
    assert c0.metadata["docType"] == "t"
    # chunkIndex 连续重排
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


def test_large_table_is_own_chunk():
    big_table = "| " + " | ".join(["x"] * 400) + " |\n"
    big_table += "|" + "---|" * 401 + "\n"
    for _ in range(6):
        big_table += "| " + " | ".join(["数据内容"] * 400) + " |\n"
    # 前文段落足够长（>= MIN_CHUNK_SIZE），避免短块合并进表格 chunk
    preface = "这是一段足够长的前文说明。" * 30
    content = "# 标题\n\n" + preface + "\n\n## 表格节\n\n" + big_table
    chunks = chunk_document(content, "raw_t", "标题", "Raw/t.md", META)
    table_chunks = [c for c in chunks if c.content.strip().startswith("|")]
    assert table_chunks, "大表格应独立成 chunk（不与前文合并）"


def test_short_adjacent_chunks_merged_and_ids_kept():
    # 两个很短的段落会先成 chunk 再被短块合并；id 保留合并前编号、index 重排
    content = "# t\n\n## s1\n\n短一。\n\n## s2\n\n短二。\n"
    chunks = chunk_document(content, "raw_m", "t", "Raw/m.md", META)
    assert len(chunks) == 1
    # 合并后只有一个 chunk，id 仍为首块 id（合并前编号 0）
    assert chunks[0].id == "raw_m_0"
    assert "短一" in chunks[0].content and "短二" in chunks[0].content


def test_section_title_recorded():
    # 文档直接以 ## 开头时，首个 chunk 记录该 section 标题
    content = "## 第一节\n\n" + "内容。" * 100
    chunks = chunk_document(content, "raw_s", "t", "Raw/s.md", META)
    assert chunks[0].section_title == "第一节"


def test_section_title_blank_for_h1_preface_chunk():
    # H1 标题在首个 ## 之前自成单元（sectionTitle=""），与 Node 版行为一致；
    # 内容超过 MAX 后新起的 chunk 携带 ## 标题
    content = "# t\n\n## 第一节\n\n" + "内容。" * 400
    chunks = chunk_document(content, "raw_h", "t", "Raw/h.md", META)
    assert chunks[0].section_title == ""
    assert any(c.section_title == "第一节" for c in chunks)


def test_empty_content_fallback_no_crash():
    chunks = chunk_document("", "raw_e", "t", "Raw/e.md", META)
    assert chunks == []


def test_overlap_skipped_for_oversized_unit():
    # 前块尾部是超大单元（> overlap_unit_max）时放弃重叠：
    # 旧行为会把整个大段落复制到下一块，导致索引膨胀 + 检索结果重复
    big = "甲" * 600
    mid1 = "乙" * 400
    mid2 = "丙" * 400
    content = f"# t\n\n{big}\n\n{mid1}\n\n{mid2}\n"
    chunks = chunk_document(content, "raw_ov", "t", "Raw/ov.md", META)
    assert len(chunks) == 2
    assert big in chunks[0].content
    assert big not in chunks[1].content, "超大单元不得被整段回带到下一个 chunk"


def test_overlap_applied_for_small_units():
    # 单元均不超过上限时，重叠行为保持原样（回带完整单元，落在句边界）
    sent = "测试内容" * 5 + "。"  # 21 字符，一句一个单元
    content = "# t\n\n" + sent * 60
    chunks = chunk_document(content, "raw_ov2", "t", "Raw/ov2.md", META)
    assert len(chunks) >= 2
    assert chunks[0].content.endswith(sent)
    assert chunks[1].content.startswith(sent), "小单元应正常回带重叠"
