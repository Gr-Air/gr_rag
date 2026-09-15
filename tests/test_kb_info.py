"""kb_info 测试（对应 TS parser.ts 的运行时重解析，非索引 chunker）。

- Raw 文件名解析 / 标题规则 / wiki 链接去重保序 / 语义 chunk 计数
- Wiki 词条：频次提取、实体类别、concept 无 category 键、频次降序稳定排序
- get_wiki_stats 聚合与 list_raw_docs 字段顺序
"""

from __future__ import annotations

from server.kb.kb_info import KbInfo, _semantic_chunk_count


def _write(directory, name: str, content: str):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(content, encoding="utf-8")


def _kb(tmp_path) -> KbInfo:
    return KbInfo(raw_dir=tmp_path / "Raw", wiki_dir=tmp_path / "Wiki")


# ------------------------------------------------------------
# semanticChunkDocument 计数（parser.ts 版）
# ------------------------------------------------------------


def test_chunk_count_empty_and_single():
    assert _semantic_chunk_count("") == 0
    assert _semantic_chunk_count("\n\n  \n") == 0
    assert _semantic_chunk_count("短。") == 1


def test_chunk_count_multiple_chunks():
    # 每句 301 字符（含句号）；按 TS 算法：906 入块、1207 触发切分 → 3 块
    sentence = "字" * 300 + "。"
    assert _semantic_chunk_count(sentence * 6) == 3


def test_chunk_count_uses_parser_not_table_chunker():
    # 表格在 parser.ts 里被当普通段落句子，与 indexing/chunker.py 的表格感知不同
    content = "## 标题\n\n" + ("数据。" * 50)
    assert _semantic_chunk_count(content) >= 1


# ------------------------------------------------------------
# Raw 文档
# ------------------------------------------------------------


def test_raw_doc_metadata_and_fields(tmp_path):
    raw = tmp_path / "Raw"
    body = "# 项目方案标题\n\n这是正文，提到[[Redis]]与[[Kafka]]，又见[[Redis]]。"
    _write(raw, "客户A_项目X_技术方案_20240101.md", body)

    docs = _kb(tmp_path).list_raw_docs()
    assert len(docs) == 1
    d = docs[0]
    assert list(d.keys()) == ["id", "title", "path", "metadata", "wikiLinks", "chunkCount"]
    assert d["id"] == "raw_客户A_项目X_技术方案_20240101"
    assert d["path"] == "Raw/客户A_项目X_技术方案_20240101.md"
    assert d["title"] == "项目方案标题"
    assert d["metadata"] == {
        "client": "客户A",
        "project": "项目X",
        "docType": "技术方案",
        "date": "20240101",
    }
    # 去重保序
    assert d["wikiLinks"] == ["Redis", "Kafka"]


def test_raw_doc_underscore_client_kept(tmp_path):
    raw = tmp_path / "Raw"
    _write(raw, "客户_集团_项目Y_需求规格说明书_20240202.md", "# T\n\n内容。")
    meta = _kb(tmp_path).list_raw_docs()[0]["metadata"]
    assert meta["client"] == "客户_集团"
    assert meta["project"] == "项目Y"


def test_raw_doc_short_filename_empty_metadata(tmp_path):
    raw = tmp_path / "Raw"
    _write(raw, "短名.md", "# T\n\n内容。")
    d = _kb(tmp_path).list_raw_docs()[0]
    assert d["metadata"] == {"client": "", "project": "", "docType": "", "date": ""}


def test_title_rules(tmp_path):
    raw = tmp_path / "Raw"
    # 首行无 "# "（无空格）：TS replace 不生效，保留井号
    _write(raw, "a_b_c_d.md", "#无空格标题\n\n内容。")
    assert _kb(tmp_path).list_raw_docs()[0]["title"] == "#无空格标题"

    (raw / "a_b_c_d.md").write_text("\n\n正文。", encoding="utf-8")
    # 首行为空 → trim 后空串 → 回落文件名
    assert _kb(tmp_path).list_raw_docs()[0]["title"] == "a_b_c_d.md"


def test_non_md_files_ignored(tmp_path):
    raw = tmp_path / "Raw"
    raw.mkdir(parents=True)
    (raw / "notes.txt").write_text("x", encoding="utf-8")
    assert _kb(tmp_path).list_raw_docs() == []


# ------------------------------------------------------------
# Wiki 词条 + 统计聚合
# ------------------------------------------------------------


def test_wiki_entries_and_stats(tmp_path):
    concept = tmp_path / "Wiki" / "concept"
    entity = tmp_path / "Wiki" / "entity"
    _write(concept, "高频概念.md", "# 高频概念\n\n出现频次: 30\n")
    _write(concept, "低频概念.md", "出现频次: 1\n")
    _write(entity, "万科集团.md", "出现频次: 12\n")
    _write(entity, "张三.md", "出现频次: 3\n")
    _write(entity, "神秘系统XYZ.md", "出现频次: 5\n")

    raw = tmp_path / "Raw"
    _write(raw, "客户A_项目X_技术方案_20240101.md", "# T\n\n" + "句子。" * 200)

    kb = _kb(tmp_path)
    stats = kb.get_wiki_stats()

    assert stats["totalDocs"] == 1
    assert stats["totalChunks"] >= 1
    assert stats["totalConcepts"] == 2
    assert stats["totalEntities"] == 3
    assert stats["totalClients"] == stats["totalProjects"] == stats["totalDocTypes"] == 1
    assert stats["clients"] == ["客户A"]
    assert stats["projects"] == ["项目X"]
    assert stats["docTypes"] == ["技术方案"]

    # 频次降序
    assert [e["name"] for e in stats["topConcepts"]] == ["高频概念", "低频概念"]
    assert [e["name"] for e in stats["topEntities"]] == ["万科集团", "神秘系统XYZ", "张三"]

    # concept 无 category 键；entity 类别猜测
    assert "category" not in stats["topConcepts"][0]
    entries = {e["name"]: e for e in stats["topEntities"]}
    assert entries["万科集团"]["category"] == "客户企业"
    assert entries["张三"]["category"] == "人员"
    assert entries["神秘系统XYZ"]["category"] == "项目系统"
    assert entries["万科集团"]["path"] == "Wiki/entity/万科集团.md"


def test_top_limited_to_20(tmp_path):
    concept = tmp_path / "Wiki" / "concept"
    for i in range(25):
        _write(concept, f"c{i:02d}.md", f"出现频次: {25 - i}\n")
    stats = _kb(tmp_path).get_wiki_stats()
    assert len(stats["topConcepts"]) == 20
    assert stats["topConcepts"][0]["name"] == "c00"


def test_missing_dirs_return_empty(tmp_path):
    kb = KbInfo(raw_dir=tmp_path / "NoRaw", wiki_dir=tmp_path / "NoWiki")
    stats = kb.get_wiki_stats()
    assert stats["totalDocs"] == 0
    assert stats["totalChunks"] == 0
    assert stats["totalConcepts"] == 0
    assert kb.list_raw_docs() == []
