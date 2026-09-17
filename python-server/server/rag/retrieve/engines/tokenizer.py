"""jieba 分词器（索引构建与运行时查询的唯一实现，Spec 038）。

历史：Node 侧 scripts/lib/tokenizer.cjs 与 src/infrastructure/tokenizer 各持一份词典；
Python 统一后，本模块 + 同目录 custom_words.txt 为全项目唯一真源。

行为对齐 scripts/lib/tokenizer.cjs：
- cut(text, HMM=False)（对应 node jieba.cut(text, false)）
- trim 后长度 >= 1 保留
- tokenize*：去重保序（查询侧）；tokenize_all*：保留词频（索引侧）
- 停用词过滤在索引侧与查询侧**同时开启**（两侧同口径，否则词项对不上会静默漏召）
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import jieba

_CUSTOM_WORDS_PATH = Path(__file__).with_name("custom_words.txt")

# ============================================================
# 中文停用词表（精选高频虚词，适配企业技术文档场景）
# 保留：技术名词、公司名、业务术语；过滤：虚词、标点、连接词、代词
# ============================================================
STOPWORDS: frozenset[str] = frozenset(
    [
        # 虚词/助词
        "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
        "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
        "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
        "被", "从", "把", "对", "让", "给", "跟", "向", "往", "为",
        "可以", "可能", "需要", "应该", "能够", "已经", "正在", "将要",
        "这个", "那个", "这些", "那些", "什么", "怎么", "为什么", "多少",
        "如果", "因为", "所以", "但是", "而且", "或者", "虽然", "不过",
        "比较", "非常", "特别", "尤其", "几乎", "大概", "大约", "左右",
        "以及", "等等", "之类", "通过", "进行", "使用", "采用", "利用",
        "基于", "根据", "按照", "关于", "对于", "作为", "其中", "其中的",
        "方面", "方式", "情况", "问题", "系统", "功能", "模块", "部分",
        "该", "其", "此", "之", "且", "则", "而", "与", "或", "及",
        # 单字动词/形容词
        "用", "做", "来", "得", "能", "可", "于",
        # 标点和特殊字符
        " ", "\t", "\n", "，", "。", "！", "？", "、", "；", "：",
        "“", "”", "‘", "’", "（", "）", "【", "】", "《", "》",
        "—", "…", "·", "～", "￥",
    ]
)

_initialized = False


def _ensure_init() -> None:
    """懒加载业务自定义词典（进程一次）。"""
    global _initialized
    if _initialized:
        return
    jieba.initialize()
    jieba.load_userdict(str(_CUSTOM_WORDS_PATH))
    _initialized = True


def _cut(text: str) -> list[str]:
    _ensure_init()
    return [tok.strip() for tok in jieba.cut(text, cut_all=False, HMM=False) if tok.strip()]


def tokenize(text: str) -> list[str]:
    """分词去重保序，不过滤停用词。当前无生产调用方（仅测试引用）。"""
    return list(dict.fromkeys(_cut(text)))


def tokenize_all(text: str) -> list[str]:
    """分词保留词频，不过滤停用词。当前无生产调用方（仅测试引用）。

    索引构建请用 tokenize_all_filtered，与查询侧 tokenize_filtered 保持同口径。
    """
    return _cut(text)


def tokenize_filtered(text: str) -> list[str]:
    """分词 + 停用词过滤，去重保序（BM25 查询侧）。"""
    return list(dict.fromkeys(t for t in _cut(text) if t not in STOPWORDS))


def tokenize_all_filtered(text: str) -> list[str]:
    """分词 + 停用词过滤，保留词频。**索引侧唯一入口**（indexing/cli._build_bm25）。"""
    return [t for t in _cut(text) if t not in STOPWORDS]


@lru_cache(maxsize=4096)
def tokenize_query_cached(text: str) -> tuple[str, ...]:
    """查询分词缓存的未接线版本。当前无生产调用方：BM25 引擎直接调 tokenize_filtered。"""
    return tuple(tokenize_filtered(text))
