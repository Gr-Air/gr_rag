"""GET /api/search —— 混合/实体检索（Spec 038 P2）。

只负责请求解析 / 校验 / DTO 映射 / 错误映射；检索流程在 rag 内核（bootstrap 组装）。
同步 def：FastAPI 自动放入线程池执行（embedding/SQLite/LanceDB 均为同步调用）。
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rag.bootstrap import get_entity_search, is_index_ready
from ..rag.types import scores_to_dict
from ..schemas import SearchResponse, SearchResultItemDTO

router = APIRouter()


@router.get("/api/search")
def search(
    q: str | None = Query(default=None),
    topK: int = Query(default=10),
    method: Literal["rrf", "entity"] | None = Query(default=None),
):
    if not q or not q.strip():
        return JSONResponse({"error": "请提供搜索关键词"}, status_code=400)

    if not is_index_ready():
        return JSONResponse(
            {"error": "索引尚未初始化完成，请稍后再试"}, status_code=503
        )

    try:
        trimmed_query = q.strip()
        routed = get_entity_search().routed_search(
            trimmed_query, topK, force_method=method
        )

        items = [
            SearchResultItemDTO(
                id=r.chunk.id,
                docId=r.chunk.doc_id,
                docTitle=r.chunk.doc_title,
                docPath=r.chunk.doc_path,
                content=r.chunk.content[:500],
                metadata=r.chunk.metadata or {},
                score=r.score,
                scores=scores_to_dict(r.scores),
                source=r.source,
                highlight=r.highlight,
            )
            for r in routed.results
        ]
        resp = SearchResponse(
            query=q,
            matchedKeywords=routed.matched_keywords,
            method=routed.method,
            total=len(items),
            results=items,
        )
        # exclude_none：对齐 TS JSON.stringify 省略 undefined 键（matchedKeywords/highlight）
        return JSONResponse(resp.model_dump(exclude_none=True))
    except Exception as err:
        print(f"[API] 搜索失败: {err}")
        return JSONResponse({"error": f"搜索失败: {err}"}, status_code=500)
