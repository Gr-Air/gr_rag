"""SSE 帧序列化工具（前后端零改动契约，Spec 038 §1.2）。"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pydantic


def sse_frame(event: pydantic.BaseModel | dict) -> str:
    """序列化为 `data: {json}\\n\\n`。

    紧凑分隔符 + 中文不转义，与 TS 端 JSON.stringify 的线上帧逐字节一致。
    """
    payload = event.model_dump(exclude_none=True) if isinstance(event, pydantic.BaseModel) else event
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"data: {body}\n\n"


async def sse_response(events: AsyncIterator[pydantic.BaseModel | dict]):
    """FastAPI StreamingResponse 的异步生成器：逐事件 yield 帧。"""
    async for event in events:
        yield sse_frame(event)
