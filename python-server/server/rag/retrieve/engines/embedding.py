"""DashScope Embedding 客户端（移植自 scripts/lib/embedder.cjs）。

批量调用 text-embedding，批大小 10（v4 单次上限）。维度从首个响应动态推断，
不硬编码（项目硬约束）。索引与运行时查询共用本模块。
"""

from __future__ import annotations

import httpx

from ....config import get_settings

_DASHSCOPE_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/embeddings/"
    "text-embedding/text-embedding"
)
_BATCH_SIZE = 10
_TIMEOUT = httpx.Timeout(60.0, connect=15.0)


def _post_embeddings(
    client: httpx.Client,
    texts: list[str],
    key: str,
    mdl: str,
    text_type: str,
) -> list[list[float]]:
    resp = client.post(
        _DASHSCOPE_URL,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        json={
            "model": mdl,
            "input": {"texts": texts},
            "parameters": {"text_type": text_type},
        },
    )
    if resp.status_code != 200:
        raise RuntimeError(f"DashScope API error ({resp.status_code}): {resp.text}")
    data = resp.json()
    return [emb["embedding"] for emb in data["output"]["embeddings"]]


def get_embeddings_batch(
    texts: list[str],
    *,
    api_key: str | None = None,
    model: str | None = None,
    text_type: str = "document",
) -> list[list[float]]:
    settings = get_settings()
    key = api_key or settings.dashscope_api_key
    mdl = model or settings.embedding_model
    if not key or key.startswith("sk-你的"):
        raise RuntimeError("DASHSCOPE_API_KEY 未配置或为占位值")

    results: list[list[float]] = []
    with httpx.Client(timeout=_TIMEOUT) as client:
        for i in range(0, len(texts), _BATCH_SIZE):
            batch = texts[i : i + _BATCH_SIZE]
            results.extend(_post_embeddings(client, batch, key, mdl, text_type))
            print(f"  Embedding: {min(i + _BATCH_SIZE, len(texts))}/{len(texts)}")
    return results


def get_embedding_dim(texts: list[str], **kwargs) -> int:
    """用首条文本探测向量维度（动态维度，不硬编码）。"""
    vecs = get_embeddings_batch(texts[:1], **kwargs)
    return len(vecs[0])


# ============================================================
# Query embedding（text_type=query，带进程内缓存，移植自 embedding.ts）
# ============================================================

_query_embedding_cache: dict[str, list[float]] = {}


def prewarm_query_embedding(query: str, embedding: list[float]) -> None:
    """预热 query embedding 缓存（检索缓存层已取过时写入，避免重复调 API）。"""
    _query_embedding_cache[query] = embedding


def get_query_embedding(text: str) -> list[float]:
    """单条查询向量（text_type=query），相同 query 走缓存。"""
    cached = _query_embedding_cache.get(text)
    if cached is not None:
        return cached

    settings = get_settings()
    key = settings.dashscope_api_key
    if not key or key.startswith("sk-你的"):
        raise RuntimeError("DASHSCOPE_API_KEY 未配置或为占位值")

    with httpx.Client(timeout=_TIMEOUT) as client:
        vec = _post_embeddings(client, [text], key, settings.embedding_model, "query")[0]
    _query_embedding_cache[text] = vec
    return vec
