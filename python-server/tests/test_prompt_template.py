"""PromptTemplate 测试（翻译自 test/promptTemplate.test.ts）。"""

import pytest

from server.rag.chat.prompt_template import BuildOptions, PromptTemplate


@pytest.fixture
def template():
    return PromptTemplate()


# ---------- 基础模板 ----------

def test_base_prompt(template):
    system, user = template.build(BuildOptions(context="这是文档上下文", query="项目经理是谁"))

    assert "星辰Wiki助手" in system
    assert "企业内部项目文档知识库" in system
    assert "这是文档上下文" in user
    assert "项目经理是谁" in user


def test_missing_required_vars(template):
    with pytest.raises(ValueError, match="context"):
        template.build(BuildOptions(context="", query="项目经理是谁"))

    with pytest.raises(ValueError, match="query"):
        template.build(BuildOptions(context="文档内容", query=""))


# ---------- 追问模板 ----------

def test_followup_prompt(template):
    _, user = template.build(
        BuildOptions(
            context="文档内容",
            query="还有呢",
            is_follow_up=True,
            conversation_context="用户: 之前的问题\n助手: 之前的回答",
        )
    )
    assert "追问" in user
    assert "对话历史" in user
    assert "之前的问题" in user
    assert "之前的回答" in user


def test_followup_without_history_degrades(template):
    _, user = template.build(
        BuildOptions(context="文档内容", query="还有呢", is_follow_up=True)
    )
    assert "追问" in user
    assert "文档内容" in user


# ---------- 对比模板 ----------

def test_compare_prompt(template):
    _, user = template.build(
        BuildOptions(
            context="方案A内容\n方案B内容", query="对比两个方案", intent="compare"
        )
    )
    assert "对比" in user
    assert "方案A内容" in user
    assert "方案B内容" in user


# ---------- 变量替换 ----------

def test_replace_all_vars(template):
    _, user = template.build(
        BuildOptions(context="文档上下文", query="用户问题")
    )
    assert "文档上下文" in user
    assert "用户问题" in user


def test_base_template_injects_history(template):
    _, user = template.build(
        BuildOptions(
            context="文档上下文", query="用户问题", conversation_context="对话历史内容"
        )
    )
    assert "对话历史内容" in user


def test_special_chars_not_interpreted(template):
    _, user = template.build(
        BuildOptions(context="文档包含 $符号 和 {大括号}", query="查询$test{变量}")
    )
    assert "文档包含" in user
    assert "查询" in user
    # 用户内容中的 ${...} 之外的 $ / {} 原样保留
    assert "$test{变量}" in user


# ---------- 实体文档 ----------

def test_entity_docs_injected_before_semantic(template):
    _, user = template.build(
        BuildOptions(
            context="语义检索文档",
            query="项目经理是谁",
            entity_docs_content="实体关联文档全文",
        )
    )
    assert "实体关联文档全文" in user
    assert "语义检索文档" in user
    assert user.index("实体关联文档全文") < user.index("语义检索文档")


# ---------- 系统提示词 ----------

def test_system_prompt_rules(template):
    system, _ = template.build(BuildOptions(context="文档", query="问题"))
    assert "基于提供的文档上下文回答" in system
    assert "不要编造信息" in system
    assert "使用中文回答" in system
    assert "对话历史" in system


# ---------- rewrite 模板 ----------

def test_build_rewrite_prompt_contains_categories(template):
    system = template.build_rewrite_prompt(
        [
            {"name": "国家电网", "type": "entity", "category": "客户企业"},
            {"name": "Redis", "type": "entity", "category": "技术组件"},
            {"name": "徐峰", "type": "entity", "category": "人员"},
            {"name": "微服务", "type": "concept", "category": "技术概念"},
        ]
    )
    assert "国家电网" in system
    assert "Redis" in system
    assert "徐峰" in system
    assert "微服务" in system
    # schema 仍在 prompt 内（让 LLM 一次答对），同时由 Agently .output() 在响应侧校验兜底
    assert '"rewritten"' in system
    assert '"relevantDocTypes"' in system
    assert '"isFollowUp"' in system
