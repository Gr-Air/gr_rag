"""重排器（移植自 src/infrastructure/search/rerankers.ts，Spec 029）。

QwenReranker（DashScope qwen3-rerank，阈值 0.5）+ NoopReranker。
召回 → rerank → 取 top N；API 失败降级按原始分排序。
API key 走 config Settings（业务代码不读 os.environ）。
"""

from __future__ import annotations

import dataclasses
import re

import httpx

from ...config import get_settings
from ..types import SearchQuery, SearchResult

_RERANK_MODEL = "qwen3-rerank"
_RERANK_URL = "https://dashscope.aliyuncs.com/compatible-api/v1/reranks"
_MIN_RELEVANCE_SCORE = 0.5
_TIMEOUT = httpx.Timeout(60.0, connect=15.0)
_WIKI_LINK = re.compile(r"\[\[([^\]]+)\]\]")


class NoopReranker:
    name = "noop"

    def rerank(
        self,
        _query: SearchQuery,
        search_results: list[SearchResult],
        top_n: int = 5,
    ) -> list[SearchResult]:
        return search_results[:top_n]


class QwenReranker:
    name = "qwen3-rerank"

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key

    def rerank(
        self,
        query: SearchQuery,
        search_results: list[SearchResult],
        top_n: int = 5,
    ) -> list[SearchResult]:
        if not search_results:
            return []

        api_key = self._api_key if self._api_key is not None else get_settings().dashscope_api_key
        if not api_key:
            print("[Reranker] DASHSCOPE_API_KEY 未配置，跳过 rerank")
            return search_results[:top_n]

        if len(search_results) <= top_n:
            return search_results

        documents = []
        for r in search_results:
            title = _WIKI_LINK.sub(r"\1", r.chunk.doc_title)
            content = _WIKI_LINK.sub(r"\1", r.chunk.content)
            documents.append(f"[{title}] {content[:4000]}")

        try:
            print(f"[Reranker] 开始重排序: {len(documents)} 条文档 → top {top_n}")
            with httpx.Client(timeout=_TIMEOUT) as client:
                resp = client.post(
                    _RERANK_URL,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": _RERANK_MODEL,
                        "query": query.query,
                        "documents": documents,
                        "top_n": top_n,
                    },
                )
            if resp.status_code != 200:
                raise RuntimeError(f"Rerank API error ({resp.status_code}): {resp.text}")
            data = resp.json()

            api_results = data.get("results") or []
            if not api_results:
                print("[Reranker] 重排序返回空结果，使用原始排序")
                return search_results[:top_n]

            # 相关性 ≥0.5 才用 rerank 分覆盖（rerank 分写入 scores.rerank，原始链路保留）
            filtered: list[SearchResult] = []
            for item in api_results:
                if item["relevance_score"] < _MIN_RELEVANCE_SCORE:
                    continue
                original = search_results[item["index"]]
                filtered.append(
                    dataclasses.replace(
                        original,
                        score=item["relevance_score"],
                        scores=dataclasses.replace(
                            original.scores, rerank=item["relevance_score"]
                        ),
                    )
                )

            final = list(filtered)
            if len(filtered) < top_n:
                # 用未被 API 返回的索引按原始分降序补足
                used_indices = {item["index"] for item in api_results}
                remaining = [
                    r for idx, r in enumerate(search_results) if idx not in used_indices
                ]
                remaining.sort(key=lambda r: -r.score)
                final.extend(remaining[: top_n - len(filtered)])

            print(
                f"[Reranker] 重排序完成: {len(final)} 条（过滤后 {len(filtered)} 条，"
                f"补充 {len(final) - len(filtered)} 条）"
            )
            return final
        except Exception as err:
            print(f"[Reranker] 重排序失败，降级使用原始排序: {err}")
            return sorted(search_results, key=lambda r: -r.score)[:top_n]


def get_reranker(api_key: str | None = None):
    """无 DASHSCOPE_API_KEY 时使用 NoopReranker。"""
    key = api_key if api_key is not None else get_settings().dashscope_api_key
    if not key:
        print("[Reranker] DASHSCOPE_API_KEY 未配置，跳过 rerank")
        return NoopReranker()
    return QwenReranker(api_key=key)
