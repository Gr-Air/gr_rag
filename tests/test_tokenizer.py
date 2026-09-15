"""分词器测试：自定义词不被切碎 + 停用词 + 去重/词频。"""

from server.rag.retrieve.engines.tokenizer import (
    STOPWORDS,
    tokenize,
    tokenize_all,
    tokenize_all_filtered,
    tokenize_filtered,
)


def test_custom_words_not_split():
    assert "Kubernetes" in tokenize("使用Kubernetes进行编排")
    assert "国家电网" in tokenize("国家电网项目")
    assert "微服务架构改造" in tokenize("进行微服务架构改造")


def test_tokenize_dedup_preserves_order():
    toks = tokenize("微服务微服务容器")
    assert toks.count("微服务") == 1
    assert len(toks) == len(set(toks))


def test_tokenize_all_keeps_tf():
    toks = tokenize_all("微服务微服务容器")
    assert toks.count("微服务") == 2


def test_stopwords_filtered():
    assert "的" in STOPWORDS
    toks = tokenize_filtered("我们的微服务系统")
    assert "的" not in toks
    assert "系统" not in toks  # “系统”在停用词表
    assert "微服务" in toks


def test_all_filtered_keeps_tf_without_stopwords():
    toks = tokenize_all_filtered("的的微服务")
    assert "的" not in toks
    assert "微服务" in toks
