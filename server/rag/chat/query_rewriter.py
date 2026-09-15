"""Query Rewriting（逐字移植自 src/application/search/queryRewriter.ts）。

1. 优先 LLM 改写 query + 一次调用输出路由决策（追问/docType）
2. LLM 不可用/返回异常时降级字典匹配 + 本地硬编码规则
实体匹配/分解算法在 retrieve/keyword_matcher（纯领域规则）。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from ..types import KNOWN_DOC_TYPES
from ..retrieve.keyword_matcher import decompose_entity, extract_matching_keywords
from .prompt_template import PromptTemplate
from .types import LlmMessage

_INTENTS = ("fact", "list", "compare", "summary", "analysis", "other")
_JSON_OBJECT = re.compile(r"\{.*\}", re.S)

_prompt_template = PromptTemplate()


@dataclass
class FallbackRouteResult:
    matched_entries: list[str]
    reason: str


@dataclass
class LlmRouteDecision:
    is_follow_up: bool
    relevant_doc_types: list[str]


@dataclass
class SmartRewriteResult:
    rewritten_query: str
    entities: list[str]
    intent: str
    method: str  # 'llm' | 'fallback'
    route_decision: LlmRouteDecision | None
    relevant_doc_types: list[str] = field(default_factory=list)


@dataclass
class SmartRewriteOptions:
    llm: object | None = None
    previous_query: str | None = None


def fallback_route(query: str, matched_entries: list[str]) -> FallbackRouteResult:
    if matched_entries:
        reason = f"匹配到实体词条 [{', '.join(matched_entries)}]"
    else:
        reason = "未匹配到任何已知概念/实体"
    return FallbackRouteResult(matched_entries=list(matched_entries), reason=reason)


class SmartRewriter:
    def __init__(self, llm, entity_repo) -> None:
        self._llm = llm
        self._entity_repo = entity_repo

    def _rewrite_query(self, query: str, options: SmartRewriteOptions):
        client_llm = options.llm or self._llm
        if not getattr(client_llm, "available", False):
            print("[QueryRewriter] 无 LLM，跳过改写")
            return None

        entities_with_meta = self._entity_repo.get_known_entities()
        system_prompt = _prompt_template.build_rewrite_prompt(entities_with_meta)
        context_hint = (
            f'\n对话历史：用户上一轮问了"{options.previous_query}"'
            if options.previous_query
            else ""
        )
        user_prompt = (
            f'用户查询: "{query}"{context_hint}\n\n请改写查询并提取实体，输出 JSON。'
        )

        try:
            content = client_llm.complete(
                [
                    LlmMessage(role="system", content=system_prompt),
                    LlmMessage(role="user", content=user_prompt),
                ],
                temperature=0,
                max_tokens=300,
            )
            if not content:
                print("[QueryRewriter] LLM 返回空 content")
                return None

            match = _JSON_OBJECT.search(content)
            if not match:
                print(f"[QueryRewriter] LLM 返回格式异常: {content[:200]}")
                return None
            parsed = json.loads(match.group(0))

            # 校验 entities 是否在 SQLite 已知列表中（不在的也保留，可能是同义词）
            known_names = [e["name"] for e in entities_with_meta]
            known_set = {n.lower() for n in known_names}

            validated: list[str] = []
            unknown: list[str] = []
            for e in parsed.get("entities") or []:
                if not isinstance(e, str):
                    continue
                (validated if e.lower() in known_set else unknown).append(e)

            # 实体分解：未知实体中包含的更小已知实体
            decomposed: list[str] = []
            for u in unknown:
                parts = decompose_entity(u, known_names)
                if parts:
                    decomposed.extend(parts)
                    print(f'[QueryRewriter] 实体分解: "{u}" → [{", ".join(parts)}]')

            all_entities = list(dict.fromkeys([*validated, *unknown, *decomposed]))

            raw_doc_types = parsed.get("relevantDocTypes")
            relevant_doc_types = (
                [t for t in raw_doc_types if isinstance(t, str) and t in KNOWN_DOC_TYPES]
                if isinstance(raw_doc_types, list)
                else []
            )

            intent = parsed.get("intent")
            intent = intent if intent in _INTENTS else "other"

            rewritten = parsed.get("rewritten") or query
            reason = parsed.get("reason") or "LLM 改写"

            print(f'[QueryRewriter] 改写: "{query}" → "{rewritten}"')
            print(
                f"[QueryRewriter] 实体: [{', '.join(all_entities)}] "
                f"(已知:{len(validated)} 未知:{len(unknown)})"
            )
            print(f"[QueryRewriter] 意图: {intent} | 理由: {reason}")
            print(
                f"[QueryRewriter] 路由: followUp={parsed.get('isFollowUp') is True}"
            )

            return SmartRewriteResult(
                rewritten_query=rewritten,
                entities=all_entities,
                intent=intent,
                method="llm",
                route_decision=LlmRouteDecision(
                    is_follow_up=parsed.get("isFollowUp") is True,
                    relevant_doc_types=relevant_doc_types,
                ),
                relevant_doc_types=relevant_doc_types,
            )
        except Exception as err:
            print(f"[QueryRewriter] LLM 调用失败: {err}")
            return None

    def rewrite(self, query: str, options: SmartRewriteOptions | None = None) -> SmartRewriteResult:
        options = options or SmartRewriteOptions()

        llm_result = self._rewrite_query(query, options)
        if llm_result is not None:
            return llm_result

        # 降级：字典匹配（仅 type=entity 的词条）+ 本地硬编码路由
        print("[QueryRewriter] LLM 改写不可用，降级为字典匹配 + 本地硬编码路由")
        keywords = [
            e["name"]
            for e in self._entity_repo.get_known_entities()
            if e.get("type") == "entity"
        ]
        fallback_entities = extract_matching_keywords(query, keywords)

        return SmartRewriteResult(
            rewritten_query=query,
            entities=fallback_entities,
            intent="other",
            method="fallback",
            route_decision=None,
            relevant_doc_types=[],
        )


def create_smart_rewriter(deps: dict) -> SmartRewriter:
    return SmartRewriter(llm=deps["llm"], entity_repo=deps["entity_repo"])
