"""实体路由检索 Use Case（移植自 src/application/search/entitySearch.ts）。

策略：
  1. 字典最大匹配检测 query 中的实体关键字（keyword_matcher）
  2. 有匹配 → 结构化查询（struct 引擎），返回含实体的上下文片段
  3. struct 不可用/不足 → chunks_meta wikiLinks 倒排兜底 → RRF 补足
  4. 无匹配 → RRF 融合检索
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
    # 路由
    # ------------------------------------------------------------

    def _force_search(self, query: str, top_k: int, method: str) -> RoutedSearchResult:
        matched = extract_matching_keywords(query, self._load_entity_keywords())

        if method == "entity" and matched:
            try:
                if self._struct_query.is_ready():
                    struct_results = self._struct_query.query(matched, "or")
                    entity_results = self._entity_recall_with_context(
                        matched, struct_results, top_k
                    )
                    if entity_results:
                        return RoutedSearchResult(entity_results, "entity", matched)
            except Exception as err:
                print(f"[EntityRouter] 强制实体检索失败，降级: {err}")

            entity_results = self._entity_recall(matched, top_k)
            return RoutedSearchResult(entity_results, "entity", matched)

        rrf_results = self._hybrid_search(
            query,
            top_k,
            20,
            20,
            HybridSearchOptions(matched_keywords=matched if matched else None),
        )
        return RoutedSearchResult(rrf_results, "rrf")

    def routed_search(
        self,
        query: str,
        top_k: int = 10,
        force_method: str | None = None,
    ) -> RoutedSearchResult:
        if force_method:
            return self._force_search(query, top_k, force_method)

        matched = extract_matching_keywords(query, self._load_entity_keywords())

        if matched:
            print(f"[EntityRouter] 匹配到实体关键字: [{', '.join(matched)}]，使用结构化检索")
            try:
                if self._struct_query.is_ready():
                    struct_results = self._struct_query.query(matched, "or")
                    entity_results = self._entity_recall_with_context(
                        matched, struct_results, top_k
                    )
                    if entity_results:
                        return RoutedSearchResult(entity_results, "entity", matched)
            except Exception as err:
                print(f"[EntityRouter] 结构化检索失败，降级为倒排索引: {err}")

            entity_results = self._entity_recall(matched, top_k)

            if len(entity_results) < top_k:
                need_more = top_k - len(entity_results)
                entity_chunk_ids = {r.chunk.id for r in entity_results}
                rrf_results = self._hybrid_search(
                    query,
                    need_more + 5,
                    20,
                    20,
                    HybridSearchOptions(matched_keywords=matched if matched else None),
                )
                supplements = [
                    r for r in rrf_results if r.chunk.id not in entity_chunk_ids
                ][:need_more]
                entity_results.extend(supplements)

            return RoutedSearchResult(entity_results, "entity", matched)

        print("[EntityRouter] 未匹配到实体关键字，使用 RRF 融合检索")
        rrf_results = self._hybrid_search(
            query,
            top_k,
            20,
            20,
            HybridSearchOptions(matched_keywords=matched if matched else None),
        )
        return RoutedSearchResult(rrf_results, "rrf")


def create_entity_search(deps: EntitySearchDeps) -> EntitySearch:
    return EntitySearch(deps)
