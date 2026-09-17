"""检索 Profile（移植自 src/application/search/profile.ts，Spec 037 Part A）。

生产路径不传 profile，resolve_profile(None) = baseline，行为与 Spec 037 前一致。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SearchProfile:
    id: str
    use_struct: bool
    use_entity_filter: bool
    use_hyde: bool
    vector_top_n: int
    bm25_top_n: int
    rerank_top_k: int


SEARCH_PROFILES: dict[str, SearchProfile] = {
    "baseline": SearchProfile("baseline", False, True, False, 20, 20, 5),
    "struct": SearchProfile("struct", True, True, False, 20, 20, 5),
    "no_entity_filter": SearchProfile("no_entity_filter", False, False, False, 20, 20, 5),
}

DEFAULT_SEARCH_PROFILE_ID = "baseline"


def resolve_profile(profile_id: str | None) -> SearchProfile:
    """未知 id / None 回落 baseline（eval 请求不因此失败）。"""
    if not profile_id:
        return SEARCH_PROFILES[DEFAULT_SEARCH_PROFILE_ID]
    profile = SEARCH_PROFILES.get(profile_id)
    if profile is None:
        print(f'[Profile] 未知检索 profile "{profile_id}"，回落 {DEFAULT_SEARCH_PROFILE_ID}')
        return SEARCH_PROFILES[DEFAULT_SEARCH_PROFILE_ID]
    return profile
