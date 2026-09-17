# Spec 状态账本

> llm-wiki 项目的 spec 治理目录。所有行为变更必须通过 spec 文档记录。

---

## 目录结构

```
spec/
├── README.md                    # 本文件 — 状态分类说明
├── governance/                  # 治理模板
│   └── spec-template.md         # 编写新 spec 的标准模板
├── planned/                     # 计划中（已讨论、待实施）
├── implemented/                 # 已实施（代码已合并到主分支）
└── archived/                    # 归档（已废弃/不再适用）
```

---

## 四类状态

### 1. planned/ — 计划中

**含义**：问题已识别、方案已讨论、但尚未开始编码。

**进入条件**：
- spec 讨论文档已完成（如 `spec_discussion_YYYYMMDD.md`）
- 核心方案已达成共识
- 已评估可行性/必要性/工作量

**典型内容**：
- 问题描述与现状分析
- 多方案对比
- 推荐的实施方案
- 待讨论的开放问题

### 2. in-progress — 开发中（在 planned spec 文档内标注）

**含义**：已创建分支，正在实施。

**标记方式**：在 spec 文档头部将 `状态：planned` 改为 `状态：in-progress`，同时标注分支名和开始日期。

### 3. implemented/ — 已实施

**含义**：代码已合并到主分支，功能已上线。

**进入条件**：
- PR 已合并
- spec 对账清单已完成
- 所有测试通过
- 按标准模板整理为正式 spec

**典型内容**：
- 行为契约（输入→输出）
- 验收标准（可测试的断言）
- 实现锚点（涉及的文件和函数）
- 兼容影响评估
- 降级策略（如有）

### 4. archived/ — 归档

**含义**：曾经计划或实施，但后续被废弃或不再适用。

**进入条件**：
- 方案被否决
- 功能被移除
- 被后续 spec 替代

**要求**：必须在文件头部标注废弃原因和日期。

---

## 当前 Spec 清单

| # | Spec | 状态 | 涉及模块 | 更新日期 |
|---|------|------|---------|---------|
| 1 | [统一分块逻辑 ×3](implemented/001-unified-chunker.md) | ✅ implemented | parser, buildIndex, buildIncremental | 2026-06-09 |
| 2 | [LLM 统一路由决策](implemented/002-llm-unified-routing.md) | ✅ implemented | queryRewriter, chat/route, ragEngine | 2026-06-09 |
| 3 | 检索路径统一 (routedSearch) | 📋 planned | entityRouter, chat/route | 2026-06-08 |
| 4 | 上下文窗口常量参数化 | 📋 planned | chat/route, hybridSearch | 2026-06-08 |
| 5 | 硬编码路由规则覆盖增强 | ✅ implemented → [003](implemented/003-smartrouter-cleanup-fallback.md) | isFollowUpQuery, smartRouter, indexLookup, adaptiveWindow | 2026-06-11 |
| 6 | 实体提取缓存优化 | 📋 planned | queryRewriter, entityRouter | 2026-06-08 |
| 7 | [smartRouter 死代码清理 + 正则降级合一](implemented/003-smartrouter-cleanup-fallback.md) | ✅ implemented | smartRouter, queryRewriter, structSearchEngine, chat/route | 2026-06-11 |
| 8 | [BM25 分词去重导致 TF 恒为 1 修复](implemented/004-bm25-tf-dedup-fix.md) | ✅ implemented | tokenizer, buildIndex, buildIncremental, bm25Engine | 2026-06-11 |
| 9 | [前端增加全量索引构建入口](planned/008-frontend-index-rebuild-button.md) | 📋 planned | page.tsx, api/index/rebuild, indexManager | 2026-06-11 |
| 10 | [结构化数据库 NL2SQL 查询能力讨论](planned/009-structured-db-nl2sql-discussion.md) | 📋 planned | structSearchEngine, chat/route, nl2sql | 2026-06-18 |
| 11 | [SQLAlchemy 校验能否提升准确性讨论](planned/010-sqlalchemy-validation-discussion.md) | 📋 planned | structSearchEngine, nl2sqlEngine, chat/route | 2026-06-18 |
| 12 | [文档清洗切分流水线方案讨论](planned/011-document-cleaning-pipeline-discussion.md) | ✅ implemented (Stage 1) | cleaner, chunker, scanner, staging, clean-and-chunk | 2026-06-20 |
| 13 | [Markdown vs HTML 文档格式切分讨论](planned/012-markdown-vs-html-chunking-discussion.md) | 📋 planned | chunker, cleaner | 2026-06-20 |
| 14 | [结构化数据库实体提取能力差距讨论](planned/013-entity-extraction-gap-discussion.md) | 📋 planned | buildStructDb, entityExtractor, staging | 2026-06-22 |
| 15 | [前端极简化 — 首页即对话框](implemented/015-minimal-chat-homepage.md) | ✅ implemented | layout.tsx, page.tsx | 2026-06-23 |

---

## 使用指南

### 新建 Spec

1. 复制 `governance/spec-template.md` 到 `planned/` 目录
2. 按 `NNN-short-name.md` 格式命名（NNN 为递增序号）
3. 填写模板中的必填字段
4. 更新本 README 的"当前 Spec 清单"表

### 从 Planned 到 Implemented

1. 开发完成后，将 spec 文件从 `planned/` 移动到 `implemented/`
2. 更新文件头部的状态为 `implemented`
3. 补充实现锚点、验收标准、兼容影响
4. 更新本 README 的清单表

### 归档

1. 将 spec 文件从 `planned/` 或 `implemented/` 移动到 `archived/`
2. 在文件头部添加 `废弃原因` 和 `废弃日期`
3. 更新本 README 的清单表

---

## 关联文档

- `AGENTS.md` — 开发治理规范（分支命名、测试要求、对账规则、完成定义）
- `spec_20260608.md` — 遗留代码分析报告（项目全貌基线）
- `spec_discussion_20260608.md` — 多套实现问题分析与重构讨论（6 大问题原始讨论）
- `implemented/003-smartrouter-cleanup-fallback.md` — smartRouter 死代码清理 + 正则降级合一（2026-06-11）
