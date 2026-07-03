# Spec 009: 结构化数据库 NL2SQL 查询能力讨论

> 创建日期：2026-06-18
> 状态：**planned**（讨论阶段，不实施）
> 关联 Issue：`[DESIGN] RAG 增加结构化数据库自然语言查询能力`
> 核心问题：**是否应集成 Vanna 框架？更好的方案是什么？**

---

## 1. 背景与动机

### 1.1 当前状态

项目已有一个 SQLite 结构化数据库（`src/data/struct_kb.db`），包含 3 张表：

```sql
entries       (id, name, type, category, frequency, path)  -- 概念/实体词条
documents     (id, name, title, client, project, doc_type, date)  -- 文档
entry_docs    (entry_id, doc_id)  -- 词条↔文档 N:N 关联
```

当前查询能力仅限于**关键词精确匹配**：

| 能力 | 示例 query | 当前支持 |
|------|-----------|:---:|
| 单词条查关联文档 | "徐峰参与了哪些项目" | ✅ 实体提取 → `WHERE name = '徐峰'` → JOIN 查文档列表 |
| 多词条 OR/AND | "ERP 和 CRM 相关的项目" | ✅ 取并集/交集 |
| 模糊搜索词条名 | "有哪些关于数智的项目" | ✅ `LIKE '%数智%'` |
| 聚合统计 | "2024年做了多少个项目" | ❌ 无聚合能力 |
| 条件过滤 | "哪些客户的项目超过3个" | ❌ 无 GROUP BY/HAVING |
| 排序查询 | "最近的一个项目是什么" | ❌ 无 ORDER BY |
| 关联推断 | "使用最多的是哪个技术组件" | ❌ 需要 JOIN+COUNT+ORDER |

**核心差距**：当前 `structSearchEngine` 只能按实体名做"查字典"式的关联查询，无法回答任何涉及聚合、过滤、排序、统计的自然语言问题。

### 1.2 目标

让用户可以用自然语言对话方式查询结构化数据库，例如：
- "2024年我们做了多少个项目？"
- "哪个客户的项目最多？"
- "阿里巴巴的项目都用了哪些技术组件？"
- "最近三个月有哪些新项目启动？"

并将结构化查询结果与语义检索结果一起注入 LLM 上下文，生成增强回答。

---

## 2. 方案 A：集成 Vanna 框架

### 2.1 Vanna 是什么

Vanna 是一个基于 MIT 许可证的开源 Python RAG 框架，专注于 **Text-to-SQL**（自然语言 → SQL 生成）。核心工作流程：

```
用户自然语言 query
    │
    ▼
RAG 检索：从训练数据中召回最相关的 10 条信息
    ├─ DDL 建表语句（表结构）
    ├─ 文档说明（字段含义、业务语义）
    └─ 历史 SQL 问答对（query→SQL 示例）
    │
    ▼
LLM 生成 SQL：检索结果 + 用户 query → prompt → SQL
    │
    ▼
执行 SQL → 返回结果 → 可选生成图表
```

### 2.2 Vanna 的训练数据

要获得较好效果（准确率 >80%），需要准备：

| 数据类型 | 内容 | 本项目现状 | 录入工作量 |
|----------|------|-----------|:---:|
| DDL | `CREATE TABLE ...` | ✅ 已有（3表3索引） | 低 |
| Documentation | 业务语义说明 | ⚠️ 需要编写 | 中 |
| SQL Examples | 历史问答对 | ❌ 零条（需从零构建） | **高** |

典型需求：**10~50 条 SQL 示例**才能达到可用准确率。

### 2.3 Vanna 的优势

| 优势 | 说明 |
|------|------|
| **专业 Text-to-SQL** | 专为此场景设计，支持复杂 SQL（JOIN、子查询、窗口函数） |
| **RAG 增强** | 自动检索最相关的 DDL/Doc/SQL 示例来引导 LLM |
| **多 LLM 支持** | 支持 OpenAI、Anthropic、本地模型等 |
| **多数据库支持** | Snowflake、PostgreSQL、MySQL、SQLite 等 |
| **生态完善** | 有图表生成、前端组件、Slack 集成等 |
| **权限感知（v2.0）** | 支持用户级别的表/列访问控制 |

### 2.4 Vanna 的劣势与风险

| 劣势 | 严重度 | 说明 |
|------|:---:|------|
| **语言栈不匹配** | 🔴 高 | Vanna 是 Python 库，项目是 TypeScript/Next.js。集成需要额外搭建 Python 微服务或通过子进程调用 |
| **过度设计** | 🔴 高 | 本项目仅 3 张表、约 200+ 条记录，Vanna 设计目标是数十张表、百万级数据的企业数据库 |
| **训练数据缺口** | 🟡 中 | 需要从零构建 10~50 条 `(自然语言, SQL)` 训练对，人工成本高 |
| **部署复杂度** | 🟡 中 | 需要 Python 运行时、向量数据库（如 ChromaDB）、额外的 API 端点 |
| **延迟增加** | 🟡 中 | 每次查询多一次 Python 进程调用或 HTTP 请求，增加 200~500ms 延迟 |
| **维护成本** | 🟡 中 | 新增一个语言栈的依赖，技术栈分化，需维护两个运行时 |
| **SQL 注入风险** | 🟢 低 | 生成的 SQL 直接执行存在风险，但 SQLite 只读权限可控 |

### 2.5 Vanna 适用场景 vs 本项目

| 维度 | Vanna 典型场景 | 本项目 | 匹配度 |
|------|--------------|--------|:---:|
| 表数量 | 10~100+ | 3 | ❌ |
| 数据量 | 百万级+ | 200+条 | ❌ |
| 查询复杂度 | 多表 JOIN、子查询、聚合 | 简单聚合+过滤 | ❌ |
| 用户群体 | 业务人员自助查数 | 知识库问答 | ⚠️ |
| SQL 示例积累 | 有历史查询日志 | 零 | ❌ |
| 运行时 | Python | TypeScript/Node.js | ❌ |

---

## 3. 方案 B：LLM Prompt Engineering（轻量方案）

### 3.1 核心思路

不引入额外框架，直接在 TypeScript 中通过 prompt engineering 让 LLM 生成 SQL：

```
用户 query
    │
    ▼
[Prompt 组装]
    ├─ 数据库 schema（DDL + 字段说明）
    ├─ 少量 few-shot 示例（手动编写 3~5 条）
    ├─ 用户自然语言 query
    └─ 输出格式约束（JSON: { sql, explanation }）
    │
    ▼
LLM 生成 SQL → better-sqlite3 执行 → 结果注入 RAG 上下文
```

### 3.2 示例 Prompt

```typescript
const NL2SQL_PROMPT = `
你是一个 SQLite 查询助手。以下是数据库 schema：

## 表结构
${DDL}

## 字段说明
- entries.name: 词条名称（概念或实体，如"微服务"、"徐峰"、"国家电网"）
- entries.type: 词条类型（'concept'=概念, 'entity'=实体）
- entries.frequency: 词条出现频次
- documents.client: 客户名称
- documents.project: 项目名称
- documents.doc_type: 文档类型
- documents.date: 文档日期（格式 YYYYMMDD）
- entry_docs: 词条与文档的 N-N 关联表

## 示例
Q: 2024年有多少个项目
A: {"sql": "SELECT COUNT(*) as count FROM documents WHERE date >= '20240101' AND date <= '20241231'", "explanation": "统计2024年的项目数"}

Q: 哪个客户的项目最多
A: {"sql": "SELECT client, COUNT(*) as cnt FROM documents GROUP BY client ORDER BY cnt DESC LIMIT 1", "explanation": "按客户分组统计项目数，取最多的"}

## 用户问题
${userQuery}

请返回 JSON：{"sql": "...", "explanation": "..."}
`;
```

### 3.3 方案 B 的优势

| 优势 | 说明 |
|------|------|
| **零新依赖** | 复用现有 OpenAI 兼容 API 调用，不引入新框架 |
| **零语言栈开销** | 纯 TypeScript 实现，无需 Python 运行时 |
| **开发成本极低** | 一个 prompt 模板 + SQL 执行 + 结果注入，约 50~100 行代码 |
| **与现有流程无缝集成** | 可直接在 `chat/route.ts` 的检索决策树中新增一个 `structured_sql` 路由 |
| **延迟可控** | 仅增加一次 LLM 调用（可与 smartRewrite 合并），无额外网络开销 |
| **渐进增强** | 先支持简单聚合，后续可逐步增加 few-shot 示例提升准确率 |

### 3.4 方案 B 的劣势

| 劣势 | 说明 | 缓解措施 |
|------|------|---------|
| **复杂 SQL 准确率低** | 没有 RAG 检索相关示例，多表 JOIN 容易出错 | 本项目的 SQL 复杂度本来就不高 |
| **幻觉风险** | LLM 可能生成不存在的字段名 | prompt 中严格约束字段白名单 + 结果校验 |
| **无自动训练** | 不像 Vanna 可以积累训练数据自动优化 | 可通过日志积累 successful SQL 对，手动升级 prompt |
| **无图表能力** | 没有内置可视化 | 前端可用 Chart.js/ECharts 自行渲染，与方案独立 |

---

## 4. 方案 C：混合方案（Prompt + 轻量 RAG）

### 4.1 核心思路

在方案 B 的基础上，增加一个简单的 **SQL 示例检索层**：

```
用户 query → 向量化 → 从 SQL 示例库检索最相似的 3 条 → 注入 prompt
```

SQL 示例库可以手动积累（5~15 条），存储为 JSON 文件或内存 Map，不需要专门的向量数据库。

### 4.2 架构

```
src/lib/nl2sqlEngine.ts
    │
    ├─ SQL_EXAMPLES  (预定义的 query→SQL 映射，5~15 条)
    ├─ generateSQL(query): 组装 prompt → LLM 生成 SQL
    └─ executeSQL(sql):    better-sqlite3 执行 → 返回结果
    │
    ▼
chat/route.ts 新增路由分支:
    if (routeDecision.route === 'structured_sql') {
      const result = generateAndExecuteSQL(query);
      structSummary += formatSQLResult(result);
    }
```

### 4.3 与方案 B 的差异

| 维度 | 方案 B（纯 Prompt） | 方案 C（Prompt + 轻量 RAG） |
|------|-------------------|--------------------------|
| SQL 准确率 | 中等（依赖 LLM 本身能力） | 较高（few-shot 示例引导） |
| 示例维护 | 无 | 需要手动维护 5~15 条示例 |
| 开发成本 | ~50 行 | ~150 行 |
| 可扩展性 | 低（改 prompt 只能改模板） | 中（加示例即可改善特定场景） |

---

## 5. 方案对比总结

| 维度 | A: Vanna 框架 | B: 纯 Prompt | C: Prompt + 轻量 RAG |
|------|:---:|:---:|:---:|
| 开发成本 | 🔴 高（×10） | 🟢 低（×1） | 🟡 中（×2） |
| SQL 准确率 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| 技术栈匹配 | ❌ Python/TS 割裂 | ✅ 纯 TypeScript | ✅ 纯 TypeScript |
| 部署复杂度 | 🔴 高 | 🟢 低 | 🟢 低 |
| 维护成本 | 🔴 高（双语言栈） | 🟢 低 | 🟡 中 |
| 训练数据需求 | 🔴 需 10~50 条 | 🟢 3~5 条即可 | 🟡 需 5~15 条 |
| 延迟影响 | 🟡 +300~500ms | 🟢 +100~200ms | 🟢 +100~200ms |
| 适合数据规模 | 10~100 表 | 1~5 表 | 1~5 表 |
| 图表能力 | ✅ 内置 | ❌ 需自建 | ❌ 需自建 |
| 企业级特性 | ✅ 权限/审计 | ❌ | ❌ |

---

## 6. 建议与推荐

### 6.1 推荐方案

**推荐方案 C（Prompt + 轻量 RAG）**，理由：

1. **Vanna 严重过度设计**：3 张表、200+ 条记录的 SQLite 数据库不需要一个全功能 Text-to-SQL 框架，就像用卡车运一个快递包裹
2. **语言栈割裂是长期隐患**：引入 Python 运行时意味着团队需要维护两套环境、两类依赖、两种部署方式
3. **快速验证价值**：方案 C 可在 1~2 天内实现 MVP，而 Vanna 集成至少需要 1 周+
4. **渐进路线清晰**：如果未来数据库确实发展到 Vanna 的适用规模（10+ 表、10万+ 记录），届时再迁移也不迟

### 6.2 实施路线建议

```
Phase 1: 方案 B（快速验证，1~2 天）
  ├─ 新增 src/lib/nl2sqlEngine.ts
  ├─ 3~5 条手动 few-shot 示例
  ├─ chat/route 新增 'structured_sql' 路由分支
  └─ 测试 5 个典型 query 的准确率

Phase 2: 升级为方案 C（如 Phase 1 准确率不满足，2~3 天）
  ├─ 增加 SQL 示例检索层（5~15 条示例）
  ├─ 向量化检索最相似示例（可复用现有 embedding API）
  └─ 针对性优化高频失败 case

Phase 3: 评估 Vanna（如业务增长到需要）
  ├─ 触发条件：表数量 >10 或数据量 >10万 或 SQL 复杂度不可控
  ├─ 搭建 Python 微服务
  └─ 将 nl2sqlEngine 替换为 Vanna 调用
```

### 6.3 什么情况下 Vanna 才值得考虑

- 结构化数据增长到 **10 张表以上**
- 查询复杂度涉及 **3 表以上 JOIN** 或窗口函数
- 需要 **图表/BI 看板** 能力
- 有多人团队可以维护 Python 服务
- 用户对 SQL 准确率要求极高（>95%）

---

## 7. 待讨论的开放问题

1. **路由决策**：如何判断一个 query 应该走 `structured_sql` 还是现有的 `structured`（关键词精确匹配）？是否需要在 `smartRewrite` 的 LLM 路由中增加 `structured_sql` 选项？

2. **结果注入策略**：SQL 查询结果如何注入 LLM prompt？作为表格？作为自然语言摘要？与语义检索结果如何排列优先级？

3. **失败处理**：SQL 执行失败时，是静默降级为语义检索还是告知用户"无法回答这个问题"？

4. **安全边界**：是否需要 SQL 白名单（只允许 SELECT）？是否需要限制返回行数？是否需要超时控制？

5. **与现有 `structSummary` 的关系**：是否替代现有的 `executeStructuredQuery` → `formatStructResults` 流程？还是并存？

6. **few-shot 示例维护**：由谁维护？每次数据库 schema 变更后是否需要同步更新示例？
