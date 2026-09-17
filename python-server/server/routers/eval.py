"""POST /api/eval —— 离线评测单样本（Spec 038 P4，移植自 eval/route.ts + evalService.ts）。

普通 JSON 同步路由（非 SSE）；FastAPI 将同步函数放线程池执行。
错误体严格对齐 TS：400/503 为 {error}，500 为完整业务错误 JSON（searchMethod='error'）。
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..rag.bootstrap import create_request_llm, get_eval_service, is_index_ready
from ..rag.eval.eval_service import EvalRequestOptions
from ..schemas import EvalRequest

router = APIRouter()


@router.post("/api/eval")
def eval_one(req: EvalRequest):
    if not req.query or not req.query.strip():
        return JSONResponse({"error": "请提供问题"}, status_code=400)

    if not is_index_ready():
        return JSONResponse({"error": "索引尚未初始化完成"}, status_code=503)

    # 按请求配置创建 LlmClient（无 key 时 NoopLlmClient → answer 确定性兜底）
    llm = create_request_llm(req.api_key, req.base_url, req.model)

    try:
        result = get_eval_service().evaluate(
            EvalRequestOptions(
                query=req.query,
                top_k=req.top_k,
                llm=llm,
                profile_id=req.profile_id,
            )
        )
        return JSONResponse(result.to_dict())
    except Exception as err:
        # TS：返回完整错误体（非 {error}、非 SSE）
        return JSONResponse(
            {
                "query": (req.query or "").strip(),
                "answer": "",
                "contexts": [],
                "sources": [],
                "searchMethod": "error",
                "numResults": 0,
                "matchedEntities": [],
                "error": str(err),
            },
            status_code=500,
        )
