"""实体关键词匹配测试（翻译自 test/keywordMatcher.test.ts）。

直接测 domain 纯函数 extract_matching_keywords：贪心最大匹配 + 全局包含匹配。
"""

from server.rag.retrieve.keyword_matcher import extract_matching_keywords

MOCK_KEYWORDS = [
    # 技术概念
    "微服务架构", "微服务", "云原生", "数字孪生", "分布式", "容器",
    # 技术组件
    "Docker", "Kubernetes", "Redis", "MySQL", "Kafka", "Nginx",
    "Elasticsearch", "Spring", "Vue", "React",
    # 客户企业
    "国家电网", "中国移动", "中国联通", "宝武钢铁", "中粮集团", "招商银行",
    "华润置地", "万科集团",
    # 业务系统
    "ERP", "CRM", "OA", "数据中台", "智能客服",
    # 业务术语
    "星辰数智", "等保2.0",
]


# ---------- 空字典与边界 ----------

def test_empty_keyword_dict():
    result = extract_matching_keywords("微服务架构设计", [])
    assert isinstance(result, list)
    assert result == []


def test_empty_query():
    assert extract_matching_keywords("", MOCK_KEYWORDS) == []


def test_no_match():
    assert extract_matching_keywords("今天天气真好", MOCK_KEYWORDS) == []


# ---------- 贪心最大匹配 - 长词优先 ----------

def test_longest_match_wins():
    result = extract_matching_keywords("微服务架构设计", MOCK_KEYWORDS)
    assert "微服务架构" in result


def test_guojiadianwang_not_split():
    result = extract_matching_keywords("国家电网项目", MOCK_KEYWORDS)
    assert "国家电网" in result
    assert "国家" not in result


# ---------- 大小写不敏感 ----------

def test_case_insensitive_lower():
    assert "Redis" in extract_matching_keywords("redis 缓存方案", MOCK_KEYWORDS)


def test_case_insensitive_upper():
    assert "Docker" in extract_matching_keywords("DOCKER 部署", MOCK_KEYWORDS)


def test_case_insensitive_mixed():
    assert "Kubernetes" in extract_matching_keywords("kubernetes 集群", MOCK_KEYWORDS)


# ---------- 多关键字匹配 ----------

def test_multiple_independent_keywords():
    result = extract_matching_keywords(
        "国家电网使用 Kubernetes 和 Redis 构建微服务架构", MOCK_KEYWORDS
    )
    for kw in ("国家电网", "Kubernetes", "Redis", "微服务架构"):
        assert kw in result


def test_synonym_dedup():
    result = extract_matching_keywords("Docker docker DOCKER", MOCK_KEYWORDS)
    docker_count = sum(1 for r in result if r.lower() == "docker")
    assert docker_count <= 1


def test_result_sorted_by_length_desc():
    result = extract_matching_keywords("微服务架构和微服务", MOCK_KEYWORDS)
    for i in range(len(result) - 1):
        assert len(result[i]) >= len(result[i + 1])


# ---------- 全局搜索（非连续匹配） ----------

def test_keyword_in_middle():
    assert "Redis" in extract_matching_keywords("请介绍一下 Redis 的使用方式", MOCK_KEYWORDS)


def test_keywords_scattered():
    result = extract_matching_keywords(
        "Docker 和 Kubernetes 在宝武钢铁的微服务架构中如何应用", MOCK_KEYWORDS
    )
    for kw in ("Docker", "Kubernetes", "宝武钢铁", "微服务架构"):
        assert kw in result


# ---------- 特殊查询 ----------

def test_pure_english_query():
    result = extract_matching_keywords("What is Redis and Kubernetes", MOCK_KEYWORDS)
    assert "Redis" in result
    assert "Kubernetes" in result


def test_special_chars_query():
    result = extract_matching_keywords("ERP/CRM/OA 系统", MOCK_KEYWORDS)
    assert "ERP" in result
    assert "CRM" in result
    assert "OA" in result


def test_adjacent_keywords_without_separator():
    result = extract_matching_keywords("RedisMySQL", MOCK_KEYWORDS)
    assert "Redis" in result
    assert "MySQL" in result


# ---------- 特殊关键字 ----------

def test_dengbao_with_number_and_dot():
    assert "等保2.0" in extract_matching_keywords("等保2.0合规要求", MOCK_KEYWORDS)


def test_xingchen_shuzhi():
    assert "星辰数智" in extract_matching_keywords("星辰数智平台", MOCK_KEYWORDS)


def test_short_keyword_oa():
    assert "OA" in extract_matching_keywords("OA系统升级", MOCK_KEYWORDS)


# ---------- 等长并列保序（TS Set 插入序，禁止 Python set 哈希序） ----------

def test_equal_length_ties_keep_discovery_order():
    # 贪心先发现 aaaa(i=0)，再发现最长 bbbbcccc(i=4)；
    # 全局包含按 keywords 顺序补入 bbbb、cccc；长度降序稳定排序后并列 4 字词
    # 必须保持发现顺序 aaaa → bbbb → cccc
    keywords = ["aaaa", "bbbb", "cccc", "bbbbcccc"]
    assert extract_matching_keywords("aaaabbbbcccc", keywords) == [
        "bbbbcccc", "aaaa", "bbbb", "cccc",
    ]
