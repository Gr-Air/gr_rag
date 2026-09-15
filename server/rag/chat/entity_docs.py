"""实体关联文档加载（逐字移植自 src/application/chat/entityDocs.ts chat 变体）。

struct 库查关联 chunk → docName 去重 → 读 Raw 文件：
短文档（<3000 token）全文注入；长文档提取实体上下文片段（±200 token，每篇≤3）。
另含 docType 过滤（LLM 推荐类型 → chunkId 列表）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..retrieve.snippets import estimate_tokens, extract_entity_snippets

SHORT_DOC_TOKEN_LIMIT = 3000
CONTEXT_WINDOW = 200
MAX_SNIPPETS_PER_DOC = 3
CHARS_PER_TOKEN_CN = 1.5
CHARS_PER_TOKEN_EN = 4

_WIKI_LINK = re.compile(r"\[\[([^\]]+)\]\]")
_TRAILING = re.compile(r"_\d+$")
_RAW_PREFIX = "raw_"
_WIKI_PREFIX = "wiki_"


def _clean_wiki_links(content: str) -> str:
    return _WIKI_LINK.sub(r"\1", content)


@dataclass
class EntityDocsResult:
    docs_content: str


@dataclass
class EvalEntityDocsResult:
    """eval 变体额外返回 sources（Raw 文档名 + Wiki 词条名，保序拼接）。"""

    docs_content: str
    sources: list[str]


def load_entity_docs_content(
    struct_query,
    file_store,
    matched_keywords: list[str],
) -> EntityDocsResult | None:
    if not struct_query.is_ready():
        print("[Chat] 结构化数据库未就绪")
        return None

    # 多实体优先 AND 精准（避免 "ERP" 等短词误匹配），无结果降级 OR
    use_and_first = len(matched_keywords) > 1
    mode = "and" if use_and_first else "or"
    struct_results = struct_query.query(matched_keywords, mode)

    if not struct_results and use_and_first:
        print("[Chat] 结构化数据库 AND 查询未命中，降级 OR 查询...")
        struct_results = struct_query.query(matched_keywords, "or")

    if not struct_results:
        print(f"[Chat] 结构化数据库未查到 [{', '.join(matched_keywords)}] 的关联文档")
        return None

    print(
        f"[Chat] 结构化数据库查询命中: [{', '.join(matched_keywords)}]，"
        f"{len(struct_results)} 条结果"
    )

    # TS Set 保插入序，Python 用 dict 键对齐（裸 set 为哈希序，双端拼接顺序会不一致）
    doc_names: dict[str, None] = {}
    for r in struct_results:
        for chunk in r["chunks"]:
            doc_id = _TRAILING.sub("", chunk["chunk_id"])
            if doc_id.startswith(_RAW_PREFIX):
                doc_names[doc_id[len(_RAW_PREFIX):]] = None

    if not doc_names:
        return None

    parts: list[str] = []
    short_count = 0
    snippet_count = 0

    for doc_name in doc_names:
        raw_content = file_store.read_raw_doc(doc_name)
        if raw_content is None:
            print(f"[Chat] Raw 文档不存在: {doc_name}.md")
            continue

        try:
            content = _clean_wiki_links(raw_content)
            doc_tokens = estimate_tokens(content)

            if doc_tokens < SHORT_DOC_TOKEN_LIMIT:
                parts.append(f"### {doc_name}（全文，{doc_tokens} token）\n\n{content}")
                short_count += 1
            else:
                snippet = extract_entity_snippets(
                    content,
                    doc_name,
                    matched_keywords,
                    CONTEXT_WINDOW,
                    MAX_SNIPPETS_PER_DOC,
                    CHARS_PER_TOKEN_CN,
                    CHARS_PER_TOKEN_EN,
                )
                if snippet:
                    parts.append(snippet)
                    snippet_count += 1
        except Exception as err:
            print(f"[Chat] 读取 Raw 文档失败: {doc_name}.md {err}")

    if short_count == 0 and snippet_count == 0:
        return None

    print(
        f"[Chat] 实体关联文档加载: {short_count} 篇全文 + {snippet_count} 篇片段 "
        f"(共 {len(doc_names)} 篇)"
    )
    return EntityDocsResult(docs_content="\n\n---\n\n".join(parts))


def load_entity_docs_content_for_eval(
    struct_query,
    file_store,
    matched_keywords: list[str],
) -> EvalEntityDocsResult | None:
    """eval 变体（逐字移植 entityDocs.ts L141-248）。

    与 chat 变体差异：
    - 额外加载关联 Wiki 词条全文（排在 Raw 文档之前）
    - 双向降级：多实体 AND 空 → OR；单词条 OR 空也重试 AND
    - 判据是「存在非空 chunks」而非 struct_results 非空
    """
    if not struct_query.is_ready():
        print("[Eval] 结构化数据库未就绪")
        return None

    use_and_first = len(matched_keywords) > 1
    struct_results = struct_query.query(
        matched_keywords, "and" if use_and_first else "or"
    )

    has_chunks = any(r["chunks"] for r in struct_results)

    if not has_chunks and use_and_first:
        print("[Eval] 结构化数据库 AND 查询未命中，降级 OR 查询...")
        struct_results = struct_query.query(matched_keywords, "or")
    elif not has_chunks and not use_and_first:
        print("[Eval] 结构化数据库 OR 查询未命中，尝试 AND 查询...")
        struct_results = struct_query.query(matched_keywords, "and")

    if not struct_results or not any(r["chunks"] for r in struct_results):
        print(f"[Eval] 结构化数据库未查到 [{', '.join(matched_keywords)}] 的关联文档")
        return None

    print(
        f"[Eval] 结构化数据库查询命中: [{', '.join(matched_keywords)}]，"
        f"{len(struct_results)} 条结果"
    )

    doc_names: dict[str, None] = {}
    wiki_entries: dict[str, str] = {}

    for r in struct_results:
        for chunk in r["chunks"]:
            doc_id = _TRAILING.sub("", chunk["chunk_id"])
            if doc_id.startswith(_RAW_PREFIX):
                doc_names[doc_id[len(_RAW_PREFIX):]] = None
            elif doc_id.startswith(_WIKI_PREFIX):
                wiki_entries[r["entry"]["name"]] = r["entry"].get("path") or ""
        if r["entry"].get("type") == "concept" and r["entry"].get("path"):
            wiki_entries[r["entry"]["name"]] = r["entry"]["path"]

    parts: list[str] = []
    short_count = 0
    snippet_count = 0
    wiki_count = 0

    # Wiki 词条全文（注意：entry.path 带 "Wiki/" 前缀，与 WIKI_DIR 拼接为双前缀，
    # TS 侧 readWikiDoc 同样如此 → 实际返回 null。逐字保留此行为，勿"修复"）
    for entry_name, entry_path in wiki_entries.items():
        content = file_store.read_wiki_doc(entry_path)
        if content is not None:
            try:
                parts.append(f"### Wiki 词条：{entry_name}\n\n{_clean_wiki_links(content)}")
                wiki_count += 1
            except Exception as err:
                print(f"[Eval] 读取 Wiki 词条失败: {entry_path} {err}")

    # Raw 文档（短文档全文 / 长文档片段）
    for doc_name in doc_names:
        raw_content = file_store.read_raw_doc(doc_name)
        if raw_content is None:
            continue
        try:
            content = _clean_wiki_links(raw_content)
            doc_tokens = estimate_tokens(content)

            if doc_tokens < SHORT_DOC_TOKEN_LIMIT:
                parts.append(f"### {doc_name}（全文，{doc_tokens} token）\n\n{content}")
                short_count += 1
            else:
                snippet = extract_entity_snippets(
                    content,
                    doc_name,
                    matched_keywords,
                    CONTEXT_WINDOW,
                    MAX_SNIPPETS_PER_DOC,
                    CHARS_PER_TOKEN_CN,
                    CHARS_PER_TOKEN_EN,
                )
                if snippet:
                    parts.append(snippet)
                    snippet_count += 1
        except Exception as err:
            print(f"[Eval] 读取 Raw 文档失败: {doc_name}.md {err}")

    if short_count == 0 and snippet_count == 0 and wiki_count == 0:
        return None

    print(
        f"[Eval] 实体关联文档加载: {wiki_count} 篇 Wiki + {short_count} 篇全文 + "
        f"{snippet_count} 篇片段"
    )

    sources = [*doc_names.keys(), *wiki_entries.keys()]
    return EvalEntityDocsResult(
        docs_content="\n\n---\n\n".join(parts), sources=sources
    )


def filter_chunks_by_doc_types(
    chunk_store,
    doc_types: list[str],
    log_prefix: str = "[Chat]",
) -> list[str] | None:
    """docTypes 为空 → None（不过滤）；有匹配 → chunkId 列表；无匹配 → None。"""
    if not doc_types:
        return None

    filtered = [
        chunk_id
        for chunk_id, chunk in chunk_store.get_all().items()
        if chunk.metadata.get("docType") and chunk.metadata["docType"] in doc_types
    ]
    print(
        f"{log_prefix} docType 过滤: types=[{','.join(doc_types)}] → {len(filtered)} chunks"
    )
    return filtered if filtered else None
