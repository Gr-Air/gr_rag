"""会话管理（逐字移植自 src/application/chat/sessionManager.ts）。

进程内 Map（单用户场景）：最近 N 轮历史、追问检测、历史压缩、30 分钟 TTL。
TS 用 setInterval 定时清理；Python 改为惰性清理（create/get/count 时顺带扫描）。
"""

from __future__ import annotations

import random
import re
import string
import time
from dataclasses import dataclass

from .types import ChatMessage, ChatSession, LastSearchResults, LlmMessage

MAX_MESSAGES = 10
COMPRESS_THRESHOLD = 6
SESSION_TTL_MS = 30 * 60 * 1000

_sessions: dict[str, ChatSession] = {}

_FOLLOW_UP_PATTERNS = [
    re.compile(r"^那(?:么|这个|第二个|第三个|第一个|它|他|她|这些)"),
    re.compile(r"^(?:详细|具体|展开)(?:说说|讲讲|解释)"),
    re.compile(r"^(?:能|可以|能否)(?:详细|具体|展开)"),
    re.compile(r"^(?:还有|另外)(?:呢|吗)"),
    re.compile(r"^(?:然后|接下来)(?:呢|怎么样)"),
    re.compile(r"^(?:这|那)(?:是|个)(?:什么|为什么|怎么)"),
    re.compile(r"^(?:上面|前面|刚才|之前)(?:的|提到)"),
    re.compile(r"^(?:它|他|她)(?:们|的)?(?:和|跟|与|比)"),
    re.compile(r"^(?:再|继续|接着)(?:说|讲|解释)"),
    re.compile(r"^(?:什么意思|为什么)"),
]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _to_base36(n: int) -> str:
    chars = string.digits + string.ascii_lowercase
    if n == 0:
        return "0"
    result = ""
    while n:
        n, rem = divmod(n, 36)
        result = chars[rem] + result
    return result


def _generate_session_id() -> str:
    timestamp = _to_base36(_now_ms())
    rand = "".join(random.choices(string.digits + string.ascii_lowercase, k=8))
    return f"sess_{timestamp}_{rand}"


def _clean_expired_sessions() -> None:
    now = _now_ms()
    expired = [sid for sid, s in _sessions.items() if now - s.updated_at > SESSION_TTL_MS]
    for sid in expired:
        del _sessions[sid]


# ============================================================
# 会话 API
# ============================================================

def create_session() -> ChatSession:
    _clean_expired_sessions()
    now = _now_ms()
    session = ChatSession(id=_generate_session_id(), created_at=now, updated_at=now)
    _sessions[session.id] = session
    print(f"[Session] 创建会话: {session.id}")
    return session


def get_or_create_session(session_id: str | None = None) -> ChatSession:
    if session_id and session_id in _sessions:
        session = _sessions[session_id]
        session.updated_at = _now_ms()
        return session
    return create_session()


def get_session(session_id: str) -> ChatSession | None:
    session = _sessions.get(session_id)
    if session:
        session.updated_at = _now_ms()
    return session


def add_message(session_id: str, role: str, content: str) -> None:
    session = _sessions.get(session_id)
    if not session:
        return
    session.messages.append(ChatMessage(role=role, content=content, timestamp=_now_ms()))
    session.updated_at = _now_ms()


def save_last_search_results(
    session_id: str,
    query: str,
    results: list,
    method: str,
) -> None:
    session = _sessions.get(session_id)
    if not session:
        return
    session.last_search_results = LastSearchResults(query=query, results=results, method=method)
    session.updated_at = _now_ms()


def get_last_search_results(session_id: str) -> LastSearchResults | None:
    session = _sessions.get(session_id)
    return session.last_search_results if session else None


def is_follow_up_query(query: str) -> bool:
    text = query.strip()
    return any(p.search(text) for p in _FOLLOW_UP_PATTERNS)


@dataclass
class ConversationContext:
    history_text: str
    summary: str | None
    has_follow_up: bool


def get_conversation_context(session_id: str) -> ConversationContext:
    session = _sessions.get(session_id)
    if not session:
        return ConversationContext("", None, False)

    recent = session.messages[-MAX_MESSAGES:]
    has_follow_up = len(recent) >= 2 and recent[-2].role == "assistant"

    history_text = ""
    if session.summary:
        history_text = f"## 对话历史摘要\n{session.summary}\n\n"

    if recent:
        pairs: list[str] = []
        i = 0
        while i < len(recent):
            msg = recent[i]
            if msg.role == "user":
                assistant_msg = recent[i + 1] if i + 1 < len(recent) else None
                if assistant_msg and assistant_msg.role == "assistant":
                    content = assistant_msg.content
                    suffix = "..." if len(content) > 300 else ""
                    pairs.append(
                        f"用户: {msg.content}\n助手: {content[:300]}{suffix}"
                    )
                    i += 2
                    continue
                pairs.append(f"用户: {msg.content}")
            i += 1
        if pairs:
            history_text += "## 最近对话\n" + "\n\n".join(pairs)

    return ConversationContext(history_text, session.summary, has_follow_up)


def compress_conversation(session_id: str, llm) -> str | None:
    """消息数 ≥ COMPRESS_THRESHOLD 时用 LLM 压缩历史；失败静默返回 None。"""
    session = _sessions.get(session_id)
    if not session:
        return None

    if len(session.messages) < COMPRESS_THRESHOLD:
        return None

    if not getattr(llm, "available", False):
        print("[Session] 无 LLM，跳过对话压缩")
        return None

    old_messages = session.messages[:-2]  # 保留最后 2 条不压缩
    lines = []
    for m in old_messages:
        lines.append(f"{'用户' if m.role == 'user' else '助手'}: {m.content}")
    conversation_text = "\n".join(lines)

    system_prompt = (
        "你是一个对话摘要助手。请将以下对话历史压缩为一段简洁的摘要（不超过 200 字），"
        "提取关键信息和上下文要点。只输出摘要文本，不要加任何前缀。"
    )

    try:
        content = llm.complete(
            [
                LlmMessage(role="system", content=system_prompt),
                LlmMessage(
                    role="user",
                    content=f"对话历史:\n{conversation_text[:4000]}",
                ),
            ],
            temperature=0.3,
            max_tokens=300,
        )
        summary = (content or "").strip()
        if summary:
            session.summary = summary
            session.messages = session.messages[-2:]
            session.updated_at = _now_ms()
            print(f"[Session] 对话已压缩: {session_id}, 摘要长度: {len(summary)}")
            return summary
    except Exception as err:
        print(f"[Session] 对话压缩失败: {err}")

    return None


def delete_session(session_id: str) -> None:
    _sessions.pop(session_id, None)
    print(f"[Session] 删除会话: {session_id}")


def get_active_session_count() -> int:
    _clean_expired_sessions()
    return len(_sessions)


def clear_all_sessions() -> None:
    _sessions.clear()
    print("[Session] 清空所有会话（测试用）")
