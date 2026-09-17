"""GET /api/stats —— 知识库统计（Spec 038 P4，移植自 stats/route.ts + kbStatus.ts）。

同步函数：FastAPI 自动放线程池执行（文件 IO）。
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..config import get_settings
from ..indexing.manifest import read_manifest
from ..kb.kb_info import get_kb_info
from ..rag.bootstrap import get_struct_engine, is_index_ready, is_struct_db_ready

router = APIRouter()


@router.get("/api/stats")
def stats():
    try:
        stats_data = get_kb_info().get_wiki_stats()
        index_ready = is_index_ready()
        struct_db_ready = is_struct_db_ready()

        struct_stats = None
        if struct_db_ready:
            try:
                struct_stats = get_struct_engine().get_struct_stats()
            except Exception:
                struct_stats = None

        manifest = read_manifest(get_settings().data_dir)

        return {
            **stats_data,
            "indexReady": index_ready,
            "structDbReady": struct_db_ready,
            "structStats": struct_stats,
            "indexVersion": manifest["indexVersion"] if manifest else None,
            "indexBuiltAt": manifest["builtAt"] if manifest else None,
            "indexBuildMode": manifest["buildMode"] if manifest else None,
        }
    except Exception as err:
        return JSONResponse({"error": str(err)}, status_code=500)
