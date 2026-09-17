"""kb_info 测试（Raw/Wiki 运行时重解析）。

- Raw 文件名解析（metadata）/ chunk 计数（与索引分块器同源）
- Wiki 词条：频次提取、实体类别、concept 无 category 键、频次降序稳定排序
- get_wiki_stats 聚合
"""

from __future__ import annotations

from server.indexing.chunker import chunk_document
from server.kb.kb_info import KbInfo, count_chunks


def _write(directory, name: str, content: str):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(content, encoding="utf-8")


def _kb(tmp_path) -> KbInfo:
    return KbInfo(raw_dir=tmp_path / "Raw", wiki_dir=tmp_path / "Wiki")


# ------------------------------------------------------------
# chunk 计数（与 indexing 分块器同源）
# ------------------------------------------------------------


def _chunks(content: str) -> list:
    return chunk_document(content, "raw_x", "标题", "Raw/raw_x.md", {})


def _count(content: str) -> int:
    return count_chunks(content, "raw_x", "标题", "Raw/raw_x.md", {})


def test_chunk_count_empty_and_single():
    assert _count("") == 0
    assert _count("\n\n  \n") == 0
    assert _count("短。") == 1


def test_chunk_count_multiple_chunks():
    # 每句 301 字符（含句号）：单元超过 overlap_unit_max(200) 时放弃重叠，
    # 于是每块能装 3 句 → 6 句切成 2 块（各 905 字，无重复内容）
    sentence = "字" * 300 + "。"
    assert _count(sentence * 6) == 2


def test_chunk_count_same_source_as_index():
    """stats/docs 的 totalChunks 必须与索引分块器口径一致（同源契约）。"""
    content = "## 标题\n\n" + ("数据。" * 50)
    assert _count(content) == len(_chunks(content))


def test_oversized_table_kept_intact():
    """表格感知：超过 max 的表格单独成块且不被切碎。"""
    rows = [f"| f{i} | {'说明' * 40} |" for i in range(20)]
    content = "| 字段 | 说明 |\n| --- | --- |\n" + "\n".join(rows)

    assert _count(content) == 1
    assert all(row in _chunks(content)[0].content for row in rows)


# ------------------------------------------------------------
# Raw 文档
# ------------------------------------------------------------


def test_raw_doc_metadata_and_chunk_count(tmp_path):
    raw = tmp_path / "Raw"
    body = "# 项目方案标题\n\n这是正文，提到[[Redis]]与[[Kafka]]，又见[[Redis]]。"
    _write(raw, "客户A_项目X_技术方案_20240101.md", body)

    docs = _kb(tmp_path)._load_raw_docs()
    assert len(docs) == 1
    d = docs[0]
    # 只产出统计真正消费的两个字段
    assert list(d.keys()) == ["metadata", "chunkCount"]
    assert d["metadata"] == {
        "client": "客户A",
        "project": "项目X",
        "docType": "技术方案",
        "date": "20240101",
    }
    assert d["chunkCount"] >= 1


def test_raw_doc_underscore_client_kept(tmp_path):
    raw = tmp_path / "Raw"
    _write(raw, "客户_集团_项目Y_需求规格说明书_20240202.md", "# T\n\n内容。")
    meta = _kb(tmp_path)._load_raw_docs()[0]["metadata"]
    assert meta["client"] == "客户_集团"
    assert meta["project"] == "项目Y"


def test_raw_doc_short_filename_empty_metadata(tmp_path):
    raw = tmp_path / "Raw"
    _write(raw, "短名.md", "# T\n\n内容。")
    d = _kb(tmp_path)._load_raw_docs()[0]
    assert d["metadata"] == {"client": "", "project": "", "docType": "", "date": ""}


def test_non_md_files_ignored(tmp_path):
    raw = tmp_path / "Raw"
    raw.mkdir(parents=True)
    (raw / "notes.txt").write_text("x", encoding="utf-8")
    assert _kb(tmp_path)._load_raw_docs() == []


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
    assert kb._load_raw_docs() == []
