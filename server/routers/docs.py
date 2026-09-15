"""GET /api/docs/list —— Raw 文档列表（Spec 038 P4，移植自 docs/list/route.ts）。"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..kb.kb_info import get_kb_info

router = APIRouter()


@router.get("/api/docs/list")
def docs_list():
    try:
        docs = get_kb_info().list_raw_docs()
        return {"total": len(docs), "docs": docs}
    except Exception as err:
        return JSONResponse({"error": str(err)}, status_code=500)
