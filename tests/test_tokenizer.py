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


def test_index_side_shares_query_tokenization():
    """索引侧与查询侧同口径：停用词不进倒排，docLen 只计实词。"""
    from server.indexing.chunker import Chunk
    from server.indexing.cli import _build_bm25

    def _chunk(cid: str, content: str) -> Chunk:
        return Chunk(
            id=cid,
            doc_id="d1",
            doc_title="测试文档",
            doc_path="Raw/测试.md",
            chunk_index=0,
            content=content,
            metadata={},
        )

    text = "我们的微服务系统"  # 的 / 系统 在停用词表，我们 / 微服务 不在
    inv_index, doc_lengths = _build_bm25(
        [_chunk("d1_0", text), _chunk("d1_1", "微服务扩容方案")]
    )

    assert "的" not in inv_index and "系统" not in inv_index
    assert doc_lengths["d1_0"] == len(tokenize_all_filtered(text)) == 2
    assert doc_lengths["d1_0"] < len(tokenize_all(text))  # 比不过滤时更短
    assert {p["chunkId"] for p in inv_index["微服务"]} == {"d1_0", "d1_1"}
    assert inv_index["微服务"][0] == {"chunkId": "d1_0", "tf": 1}


def test_index_and_query_vocabulary_align():
    """同一文本两侧切出的词项集合必须一致——不一致就会静默漏召。"""
    for text in ("数据中台的微服务治理方案", "我们的微服务系统", "扩容方案 V2.0"):
        assert set(tokenize_all_filtered(text)) == set(tokenize_filtered(text))
