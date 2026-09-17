"""FastAPI 应用入口（Spec 038 P0）。

启动（在 server/ 目录下）：
    uvicorn server.main:app --reload --port 8000

P0：注册 4 个契约桩接口；P1-P4 逐步替换为真实 RAG 内核。
P6 起在此挂载 Next.js 静态产物实现单进程部署。
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import chat, eval as eval_router, search, stats


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="llm-wiki Python backend", version="0.1.0")

    # dev 期前端可能直连 :8000；正式切换走 Next rewrites 同源代理
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(chat.router)
    app.include_router(search.router)
    app.include_router(stats.router)
    app.include_router(eval_router.router)

    @app.get("/health")
    async def health():
        return {"status": "ok", "phase": "P0", "version": app.version}

    return app


app = create_app()
