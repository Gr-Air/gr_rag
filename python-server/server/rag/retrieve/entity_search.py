"""实体路由检索 Use Case（移植自 src/application/search/entitySearch.ts）。

策略：
  1. 字典最大匹配检测 query 中的实体关键字（keyword_matcher）
  2. 有匹配 → 结构化查询（struct 引擎）取关联 chunk 的实体上下文片段
  3. struct 不可用/仍无命中 → chunks_meta wikiLinks 倒排索引兜底
  4. 无匹配 → RRF 融合检索

**实体路只返回实体命中的 chunk**，不用语义检索结果回填（`recall_entity_chunks`）。
召回为空时的降级由调用方决定：auto 路由降级 RRF（`method="rrf"`），
`force_method="entity"` 如实返回空结果。chat 与 `/api/search` 共用同一实现。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..types import DocChunk, Scores, SearchResult
from .hybrid_search import HybridSearchOptions
from .keyword_matcher import extract_matching_keywords

_REGEX_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\]")
_TRAILING_INDEX = re.compile(r"_\d+$")


def _escape_regex(word: str) -> str:
    return _REGEX_SPECIAL.sub(r"\\\g<0>", word)


def _bold_keywords(text: str, keywords) -> str:
    """case-sensitive 全局加粗（对齐 JS new RegExp(kw, 'g')）。"""
    for kw in keywords:
        try:
            text = re.sub(_escape_regex(kw), lambda _m, k=kw: f"**{k}**", text)
        except re.error:
            continue
    return text


@dataclass
class RoutedSearchResult:
    results: list[SearchResult]
    method: str  # 'rrf' | 'entity'
    matched_keywords: list[str] | None = None


@dataclass
class EntitySearchDeps:
    chunk_store: Any
    struct_query: Any  # is_ready() / query(names, mode)
    entity_repo: Any  # is_ready() / get_known_entities()
    hybrid_search: Any


def _extract_entity_context(content: str, entities: list[str], context_size: int = 200) -> str:
    """每个实体匹配点提取 ±contextSize 字符上下文，每实体最多 3 处，重叠区间合并。"""
    segments: list[tuple[int, int]] = []

    for entity in entities:
        pattern = re.compile(_escape_regex(entity), re.IGNORECASE)
        count = 0
        for m in pattern.finditer(content):
            if count >= 3:
                break
            start = max(0, m.start() - context_size)
            end = min(len(content), m.end() + context_size)
            segments.append((start, end))
            count += 1

    if not segments:
        return content[: context_size * 2]

    segments.sort(key=lambda s: s[0])
    merged: list[list[int]] = [list(segments[0])]
    for start, end in segments[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    return "\n".join(content[s:e] for s, e in merged)


class EntitySearch:
    def __init__(self, deps: EntitySearchDeps) -> None:
        self._chunk_store = deps.chunk_store
        self._struct_query = deps.struct_query
        self._entity_repo = deps.entity_repo
        self._hybrid_search = deps.hybrid_search
        self._entity_keywords: list[str] | None = None
        self._entity_to_chunks: dict[str, list[str]] | None = None

    # ------------------------------------------------------------
    # 字典 / 倒排索引（懒加载缓存）
    # ------------------------------------------------------------

    def _load_entity_keywords(self) -> list[str]:
        if self._entity_keywords is not None:
            return self._entity_keywords
        try:
            if self._entity_repo.is_ready():
                entities = self._entity_repo.get_known_entities()
                keywords = sorted(
                    (e["name"] for e in entities if e["type"] == "entity"),
                    key=lambda n: -len(n),
                )
                self._entity_keywords = keywords
                print(f"[EntityRouter] 从 EntityRepository 加载 {len(keywords)} 个实体关键字")
                return keywords
        except Exception as err:
            print(f"[EntityRouter] 无法加载实体，降级为空列表: {err}")
        self._entity_keywords = []
        return self._entity_keywords

    def _build_entity_inverted_index(self) -> dict[str, list[str]]:
        if self._entity_to_chunks is not None:
            return self._entity_to_chunks

        index: dict[str, list[str]] = {}
        all_chunks = self._chunk_store.get_all()
        for chunk_id, chunk in all_chunks.items():
            for link in chunk.wiki_links or []:
                index.setdefault(link, []).append(chunk_id)

        self._entity_to_chunks = index
        print(
            f"[EntityRouter] 倒排索引构建完成: {len(index)} 个实体, {len(all_chunks)} 个文档块"
        )
        return self._entity_to_chunks

    def extract_entity_keywords(self, query: str) -> list[str]:
        return extract_matching_keywords(query, self._load_entity_keywords())

    def load_all_chunks(self) -> dict:
        return dict(self._chunk_store.get_all())

    # ------------------------------------------------------------
    # struct 上下文召回
    # ------------------------------------------------------------

    def _entity_recall_with_context(
        self,
        matched_keywords: list[str],
        struct_results: list[dict],
        top_k: int,
    ) -> list[SearchResult]:
        all_chunks_data = self._chunk_store.get_all()
        results: list[SearchResult] = []
        seen_chunk_ids: set[str] = set()
        seen_entry_names: set[str] = set()

        for sr in struct_results:
            entry_name = sr["entry"]["name"]
            if entry_name in seen_entry_names:
                continue
            seen_entry_names.add(entry_name)

            for struct_chunk in sr["chunks"]:
                chunk_id = struct_chunk["chunk_id"]
                if chunk_id in seen_chunk_ids:
                    continue
                seen_chunk_ids.add(chunk_id)

                chunk_data = all_chunks_data.get(chunk_id)
                if chunk_data is None:
                    continue

                context = _extract_entity_context(chunk_data.content, matched_keywords)
                chunk = DocChunk(
                    id=chunk_id,
                    doc_id=chunk_data.doc_id,
                    doc_title=chunk_data.doc_title,
                    doc_path=chunk_data.doc_path,
                    chunk_index=0,
                    content=context,
                    metadata=chunk_data.metadata,
                    wiki_links=chunk_data.wiki_links or [],
                )

                highlight = _bold_keywords(context[:500], matched_keywords)
                results.append(
                    SearchResult(
                        chunk=chunk,
                        score=sr["entry"]["frequency"] / 500,
                        scores=Scores(),
                        source="entity",
                        highlight=highlight,
                    )
                )

                if len(results) >= top_k:
                    return results
        return results

    # ------------------------------------------------------------
    # wikiLinks 倒排兜底召回
    # ------------------------------------------------------------

    def _entity_recall(
        self, matched_keywords: list[str], top_k: int = 10
    ) -> list[SearchResult]:
        index = self._build_entity_inverted_index()
        # docId → {累计分, 命中关键字}
        doc_info: dict[str, dict] = {}

        for i, kw in enumerate(matched_keywords):
            chunk_ids = index.get(kw, [])
            keyword_weight = 1.0 / (i + 1)  # 排在前面的关键字权重更高
            for chunk_id in chunk_ids:
                doc_id = _TRAILING_INDEX.sub("", chunk_id)
                info = doc_info.get(doc_id)
                if info is not None:
                    info["score"] += keyword_weight
                    info["hit_keywords"].add(kw)
                    info["chunk_ids"].add(chunk_id)
                else:
                    doc_info[doc_id] = {
                        "chunk_ids": {chunk_id},
                        "score": keyword_weight,
                        "hit_keywords": {kw},
                    }

        ranked_docs = sorted(doc_info.items(), key=lambda kv: -kv[1]["score"])[:top_k]

        # 每篇文档选内容最丰富的 chunk（跳过纯标题/元信息 chunk）
        all_chunks_data = self._chunk_store.get_all()
        best_chunks: list[DocChunk] = []
        for doc_id, _info in ranked_docs:
            doc_chunk_ids = [k for k in all_chunks_data.keys() if k.startswith(doc_id)]
            if not doc_chunk_ids:
                continue

            chunks: list[DocChunk] = []
            for cid in doc_chunk_ids:
                data = all_chunks_data.get(cid)
                if data is None:
                    continue
                chunks.append(
                    DocChunk(
                        id=cid,
                        doc_id=data.doc_id,
                        doc_title=data.doc_title,
                        doc_path=data.doc_path,
                        chunk_index=0,
                        content=data.content,
                        metadata=data.metadata,
                        wiki_links=data.wiki_links or [],
                    )
                )
            if not chunks:
                continue

            def sort_key(c: DocChunk) -> tuple[int, int]:
                is_meta = len(c.content) < 100 or c.content.strip().startswith("## 文档元信息")
                # 非元信息优先（0 在前），其次内容更长
                return (1 if is_meta else 0, -len(c.content))

            chunks.sort(key=sort_key)
            best_chunks.append(chunks[0])

        results: list[SearchResult] = []
        for doc_id, info in ranked_docs:
            chunk = next((c for c in best_chunks if c.id.startswith(doc_id)), None)
            if chunk is None:
                continue

            highlight = _bold_keywords(chunk.content[:500], info["hit_keywords"])
            results.append(
                SearchResult(
                    chunk=chunk,
                    score=info["score"] / len(matched_keywords),
                    scores=Scores(),
                    source="entity",
                    highlight=highlight,
                )
            )
        return results

    # ------------------------------------------------------------
    # 实体 chunk 召回（chat 与 /api/search 共用的唯一实体路实现）
    # ------------------------------------------------------------

    def recall_entity_chunks(
        self, matched_keywords: list[str], top_k: int = 10
    ) -> list[SearchResult]:
        """实体关键字 → chunk 上下文片段召回（只召回，不做路由判定）。

        降级链：struct（多实体优先 AND 精准）→ OR → chunks_meta wikiLinks 倒排兜底。
        **只返回实体命中的 chunk**，不掺语义检索结果、不读磁盘 Raw 全文；
        片段由 `_extract_entity_context` 从内存 chunk 抽取，含 Wiki 词条 chunk。
        struct 异常或召回为空时返回空列表，由调用方决定是否降级 RRF。
        """
        if not matched_keywords:
            return []

        try:
            if self._struct_query.is_ready():
                use_and_first = len(matched_keywords) > 1
                mode = "and" if use_and_first else "or"
                struct_results = self._struct_query.query(matched_keywords, mode)

                # 判据是「存在非空 chunks」：有条目但关联 chunk 为空同样要降级
                if use_and_first and not any(
                    r.get("chunks") for r in struct_results
                ):
                    print("[EntityRouter] struct AND 未命中，降级 OR 查询...")
                    struct_results = self._struct_query.query(
                        matched_keywords, "or"
                    )

                hits = self._entity_recall_with_context(
                    matched_keywords, struct_results, top_k
                )
                if hits:
                    print(
                        f"[EntityRouter] 实体 chunk 召回 {len(hits)} 条: "
                        f"[{', '.join(matched_keywords)}]"
                    )
                    return hits

            return self._entity_recall(matched_keywords, top_k)
        except Exception as err:
            print(f"[EntityRouter] 实体 chunk 召回失败，降级语义检索: {err}")
            return []

    # ------------------------------------------------------------
    # 路由
    # ------------------------------------------------------------

    def routed_search(
        self,
        query: str,
        top_k: int = 10,
        force_method: str | None = None,
    ) -> RoutedSearchResult:
        """字典匹配 → 实体 chunk 召回 / RRF 融合检索。

        `force_method="entity"` 如实返回实体结果（可能为空），**不掺语义结果、不改标 method**；
        `force_method="rrf"` 直接走 RRF；auto 路由下实体召回为空才降级 RRF（`method="rrf"`）。
        """
        matched = extract_matching_keywords(query, self._load_entity_keywords())

        if force_method == "entity":
            entity_results = self.recall_entity_chunks(matched, top_k)
            print(
                f"[EntityRouter] 强制实体检索: [{', '.join(matched)}] → "
                f"{len(entity_results)} 条"
            )
            return RoutedSearchResult(entity_results, "entity", matched or None)

        if force_method != "rrf" and matched:
            entity_results = self.recall_entity_chunks(matched, top_k)
            if entity_results:
                print(
                    f"[EntityRouter] 匹配到实体关键字: [{', '.join(matched)}]，"
                    f"使用实体 chunk 召回（{len(entity_results)} 条）"
                )
                return RoutedSearchResult(entity_results, "entity", matched)

        print("[EntityRouter] 实体路无结果或未匹配实体，使用 RRF 融合检索")
        rrf_results = self._hybrid_search(
            query,
            top_k,
            20,
            20,
            HybridSearchOptions(matched_keywords=matched if matched else None),
        )
        return RoutedSearchResult(rrf_results, "rrf", matched or None)


def create_entity_search(deps: EntitySearchDeps) -> EntitySearch:
    return EntitySearch(deps)
