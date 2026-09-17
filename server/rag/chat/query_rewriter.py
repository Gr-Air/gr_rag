"""Query Rewriting（逐字移植自 src/application/search/queryRewriter.ts）。

1. 优先 LLM 改写 query + 一次调用输出路由决策（追问/docType）
2. LLM 不可用/返回异常时降级字典匹配 + 本地硬编码规则
实体匹配/分解算法在 retrieve/keyword_matcher（纯领域规则）。

Schema 由 Agently .output() 注入（不再手写 JSON 字面量 + 正则捞取）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from agently import Agently
from agently.types.settings import OpenAICompatibleSettings

from ..types import KNOWN_DOC_TYPES
from ..retrieve.keyword_matcher import decompose_entity, extract_matching_keywords
from .prompt_template import PromptTemplate

_INTENTS = ("fact", "list", "compare", "summary", "analysis", "other")

# Agently .output() 接收的 schema 描述：字段名 → (类型, required, description)
_REWRITE_SCHEMA: dict[str, tuple[Any, Any, str]] = {
    "rewritten":        (str,       None, "改写后的查询语句"),
    "entities":         (list[str], None, "从查询中提取的实体关键词（list[str]）"),
    "intent":           (str,       None, "枚举之一：fact|list|compare|summary|analysis|other"),
    "relevantDocTypes": (list[str], None, "最可能含答案的文档类型（1-3 个），无关则 []"),
    "isFollowUp":       (bool,      None, "当前 query 是否依赖上一轮对话才能理解"),
    "reason":           (str,       None, "改写理由（中文，不超过 20 字）"),
}

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


def _default_settings_factory(llm: object) -> OpenAICompatibleSettings | None:
    """从任意 LLM 客户端抽取 Agently settings（duck-typing，缺 _config 时返回 None）。"""
    config = getattr(llm, "_config", None)
    if config is None:
        return None
    base_url = (getattr(config, "base_url", "") or "").rstrip("/") or None
    return OpenAICompatibleSettings(
        base_url=base_url,
        api_key=getattr(config, "api_key", ""),
        model=getattr(config, "model", ""),
    )


def fallback_route(query: str, matched_entries: list[str]) -> FallbackRouteResult:
    if matched_entries:
        reason = f"匹配到实体词条 [{', '.join(matched_entries)}]"
    else:
        reason = "未匹配到任何已知概念/实体"
    return FallbackRouteResult(matched_entries=list(matched_entries), reason=reason)


class SmartRewriter:
    def __init__(
        self,
        llm,
        entity_repo,
        *,
        agent_factory: Callable | None = None,
        settings_factory: Callable[[object], OpenAICompatibleSettings | None] | None = None,
    ) -> None:
        self._llm = llm
        self._entity_repo = entity_repo
        # 接缝 1：测试可注入 FakeAgent，避免真实 Agently 调用
        self._agent_factory = agent_factory or Agently.create_agent
        # 接缝 2：测试可注入自定义 settings 工厂（FakeLlm 没 _config 时必填）
        self._settings_factory = settings_factory or _default_settings_factory

    def _rewrite_query(self, query: str, options: SmartRewriteOptions):
        client_llm = options.llm or self._llm
        if not getattr(client_llm, "available", False):
            print("[QueryRewriter] 无 LLM，跳过改写")
            return None

        settings = self._settings_factory(client_llm)
        if settings is None:
            print("[QueryRewriter] 无法从 LLM 抽取 Agently settings，跳过改写")
            return None

        entities_with_meta = self._entity_repo.get_known_entities()
        system_prompt = _prompt_template.build_rewrite_prompt(entities_with_meta)
        context_hint = (
            f'\n对话历史：用户上一轮问了"{options.previous_query}"'
            if options.previous_query
            else ""
        )
        user_prompt = (
            f'用户查询: "{query}"{context_hint}\n\n请改写查询并提取实体。'
        )

        try:
            parsed = (
                self._agent_factory()
                .set_settings(settings)
                .options({"temperature": 0, "max_tokens": 300})
                .system(system_prompt)
                .input(user_prompt)
                .output(_REWRITE_SCHEMA)
                .get_result()
                .get_data(ensure_keys=list(_REWRITE_SCHEMA.keys()))
            )
            if not isinstance(parsed, dict):
                print(f"[QueryRewriter] LLM 返回非 dict: {type(parsed).__name__}")
                return None

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
                f"[QueryRewriter] 路由: followUp={bool(parsed.get('isFollowUp'))}"
            )

            return SmartRewriteResult(
                rewritten_query=rewritten,
                entities=all_entities,
                intent=intent,
                method="llm",
                route_decision=LlmRouteDecision(
                    is_follow_up=bool(parsed.get("isFollowUp")),
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