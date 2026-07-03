# Spec 010: SQLAlchemy SQL 校验能否提升准确性讨论

> 创建日期：2026-06-18
> 状态：**planned**（讨论阶段，不实施）
> 关联 Spec：[009 结构化数据库 NL2SQL 查询能力讨论](./009-structured-db-nl2sql-discussion.md)
> 核心问题：**在当前/未来的 LLM 生成 SQL 链路中，增加 SQLAlchemy 校验层能否提升查询准确性？**

---

## 1. 问题拆解

"准确性"在 Text-to-SQL 场景下可以分为三层：

| 层次 | 含义 | 示例 | 能否靠校验解决 |
|------|------|------|:---:|
| **语法错误** | SQL 不符合语法规则 | `SELECT FORM documents`（拼写错误） | ✅ 可以 |
| **Schema 错误** | 引用了不存在的表/列 | `SELECT client_name FROM docs`（字段名错误） | ✅ 可以 |
| **语义错误** | SQL 语法正确但逻辑不对 | 用户问"谁的项目最多"，生成 `SELECT name FROM entries` | ❌ 不行 |

**关键结论：校验层只能提升前两类错误（语法+Schema），对语义错误（占 LLM 生成 SQL 错误的多数）无能为力。**

---

## 2. SQLAlchemy 校验能做什么

### 2.1 原理

```python
from sqlalchemy import create_engine, MetaData, text

# 1. 反射真实数据库的 schema
engine = create_engine('sqlite:///struct_kb.db')
metadata = MetaData()
metadata.reflect(bind=engine)  # 读取表名、列名、类型、约束

# 2. 编译 SQL 但不执行
stmt = text("SELECT client, COUNT(*) FROM documents GROUP BY client")
compiled = stmt.compile(bind=engine)  # 此时校验：表存在？列存在？语法OK？

# 3. 如果出错 → 捕获异常
# sqlalchemy.exc.CompileError / NoSuchTableError / etc.
```

### 2.2 能校验的内容

| 校验项 | SQLAlchemy 能做 | 示例 |
|--------|:---:|------|
| 表是否存在于 schema 中 | ✅ | `NoSuchTableError: documentss` |
| 列是否存在于表中 | ✅ | 编译时检查列名与 metadata 中的 Column 匹配 |
| SQL 语法是否合法 | ✅ | SQLite 方言的完整解析 |
| JOIN 是否引用了存在的表 | ✅ | 编译时遍历 AST 校验表引用 |
| 类型是否兼容（对比时） | ⚠️ | SQLite 是动态类型，类型检查意义有限 |

### 2.3 不能校验的内容

| 无法校验的场景 | 原因 |
|---------------|------|
| WHERE 条件是否合理 | `WHERE frequency > 1000000` 语法正确但可能无结果 |
| 聚合逻辑是否正确 | `SUM(frequency)` vs `COUNT(*)` — 都合法但语义不同 |
| JOIN 关系是否正确 | `JOIN entries ON entries.id = documents.name` — 语法OK，语义荒谬 |
| 用户意图是否被满足 | 这是语义理解问题，与 SQL 正确性无关 |

---

## 3. 关键发现：SQLite 本身已经在做这些校验

### 3.1 better-sqlite3 的 prepare 机制

当前项目使用 `better-sqlite3`，其 `.prepare()` 方法在编译阶段就会校验：

```typescript
const db = new BetterSqlite3(DB_PATH, { readonly: true });

// 这句在执行前就会抛出明确的错误：
db.prepare("SELECT client_name FROM docs");
// → SqliteError: no such column: client_name

db.prepare("SELECT client FROM documentss");
// → SqliteError: no such table: documentss

db.prepare("SELECT FORM documents");
// → SqliteError: near "FORM": syntax error
```

### 3.2 SQLAlchemy vs SQLite prepare 对比

| 能力 | SQLAlchemy compile | SQLite .prepare() |
|------|:---:|:---:|
| 语法校验 | ✅ | ✅ |
| 表存在性 | ✅ | ✅ |
| 列存在性 | ✅ | ✅ |
| 错误信息可读性 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 额外依赖 | 🔴 需要 Python + sqlalchemy | 🟢 已内置于 better-sqlite3 |
| 语言栈匹配 | ❌ Python ↔ TypeScript 割裂 | ✅ 纯 Node.js |
| 部署复杂度 | 🔴 需额外 Python 进程/服务 | 🟢 零额外部署 |

**核心发现：SQLAlchemy 提供的语法+Schema 校验，better-sqlite3 的 `.prepare()` 已经全部覆盖了。增加 SQLAlchemy 不会带来额外的准确性提升。**

---

## 4. 本项目实际场景分析

### 4.1 当前状态（无 LLM 生成 SQL）

```typescript
// structSearchEngine.ts 中的所有查询都是硬编码的参数化 SQL
const entry = db.prepare('SELECT * FROM entries WHERE name = ?').get(entryName);
const docs = db.prepare(`
  SELECT d.* FROM documents d
  INNER JOIN entry_docs ed ON d.id = ed.doc_id
  WHERE ed.entry_id = ?
`).all(entry.id);
```

**校验需求：零。** 硬编码 SQL 在开发时就验证过了，不需要运行时校验。

### 4.2 未来状态（Spec 009 的 NL2SQL 方案）

如果按照 Spec 009 的方案 B/C 引入 LLM 生成 SQL：

```
用户 query → LLM 生成 SQL 文本 → [这里需要校验] → better-sqlite3 执行
```

此时 LLM 可能生成错误的 SQL，需要一层"门禁"来拦截。但方案已经存在：

```typescript
// 方案 1：直接 prepare → 捕获异常 → （可选）重试
try {
  const stmt = db.prepare(llmGeneratedSql);
  return stmt.all();
} catch (err) {
  // SqliteError 已包含明确的错误信息
  // 可以 feed 回 LLM 让它在重试时修正
  return { error: err.message };
}
```

**这个 try-catch + prepare 就是 SQLite 内置的校验，无需 SQLAlchemy。**

---

## 5. 真正能提升准确性的方案

### 5.1 方案对比

| 方案 | 成本 | 语法/Schema 准确性 | 语义准确性 | 推荐度 |
|------|:---:|:---:|:---:|:---:|
| **SQLAlchemy compile 校验** | 🔴 高（Python 依赖） | ⭐⭐⭐⭐ | ❌ 零提升 | ❌ |
| **SQLite prepare + 错误重试** | 🟢 零 | ⭐⭐⭐⭐ | ❌ 零提升 | ✅ 推荐 |
| **node-sql-parser 预校验** | 🟡 中（npm 依赖） | ⭐⭐⭐⭐ | ❌ 零提升 | ⚠️ 可选 |
| **Schema 注入 prompt** | 🟢 零 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ✅ 推荐 |
| **Few-shot 示例注入** | 🟢 低 | ⭐⭐ | ⭐⭐⭐⭐ | ✅✅ 最推荐 |
| **结果集合理性校验** | 🟡 中 | ⭐⭐ | ⭐⭐⭐ | ✅ 推荐 |
| **多轮自查** | 🟡 中 | ⭐⭐⭐ | ⭐⭐⭐⭐ | ✅ 推荐 |

### 5.2 推荐组合：Prepare + 错误重试 + Few-shot

这是成本最低、提升最大的组合：

```typescript
async function generateAndExecuteSQL(query: string, maxRetries = 2): Promise<any> {
  const db = getDb();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { sql, explanation } = await llm.generateSQL(query, attempt > 0 ? lastError : null);

    try {
      // SQLite 内置校验：prepare 成功 = SQL 语法+Schema 合法
      const stmt = db.prepare(sql);
      const results = stmt.all();

      // 额外：结果合理性检查
      if (results.length === 0 && expectsResults(query)) {
        // 可能是 SQL 写错导致空结果
        continue; // 重试
      }

      return { sql, results, explanation };
    } catch (err: any) {
      lastError = err.message; // 例如: "no such column: client_name"
      // 下一次循环会将错误信息传给 LLM 让它修正
    }
  }

  // 所有重试失败 → 降级
  throw new Error('SQL generation failed after retries');
}
```

**这个 30 行代码的方案 = SQLAlchemy 的校验能力 + 自动修正能力 + 零额外依赖。**

---

## 6. 开放问题：node-sql-parser 是否有必要？

`node-sql-parser` 是一个纯 JS 的 SQL 解析器，可以将 SQL 文本解析为 AST，提取 `tableList` 和 `columnList`。可以用于：

```typescript
import { Parser } from 'node-sql-parser';
const parser = new Parser();

function preValidate(llmGeneratedSql: string, knownSchema: SchemaDef) {
  const ast = parser.astify(llmGeneratedSql);
  // 提取 AST 中的表名和列名
  const { tableList, columnList } = ast;

  // 检查表名是否都在已知 schema 中
  for (const table of tableList) {
    if (!knownSchema.tables.includes(table)) {
      return { error: `Unknown table: ${table}` };
    }
  }
  // 检查列名是否匹配
  // ...
}
```

**但问题在于**：SQLite 的 `.prepare()` 已经做了同样的事，且更准确（因为 SQLite 知道实际的 schema，而不是 JS 中手动维护的副本）。`node-sql-parser` 的优势仅在于能在 prepare 之前就发现问题，但故障延迟差异（ms 级）在本项目场景下可忽略。

**结论：不需要 node-sql-parser，SQLite prepare 已足够。**

---

## 7. 如果一定要用"SQLAlchemy 式"校验...

如果未来确实需要一个独立于 SQLite 的校验层（比如要做 SQL 白名单/审计/改写），最低成本的 TypeScript 方案是：

```typescript
// 直接用 better-sqlite3 的 prepare 作为校验层
function validateSQL(sql: string): { valid: boolean; error?: string; tables?: string[] } {
  try {
    const stmt = db.prepare(sql);
    // 可选：通过 EXPLAIN 获取更多元信息
    // const plan = db.prepare(`EXPLAIN ${sql}`).all();
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}
```

**对比 SQLAlchemy 方案**：

| 维度 | TypeScript prepare | Python SQLAlchemy |
|------|:---:|:---:|
| 代码量 | 8 行 | ~50 行 + Flask/microservice |
| 语言栈 | 纯 TypeScript | Python + TypeScript 混用 |
| 校验能力 | 完全相同 | 完全相同 |
| 延迟 | 0ms（本地调用） | +100~300ms（跨进程/HTTP） |
| 错误信息 | SQLite 原生错误 | SQLAlchemy 包装错误（稍好读） |

---

## 8. 结论

### 8.1 直接回答

**不会显著提升准确性。** 原因：

1. SQLAlchemy 能做的语法+Schema 校验，better-sqlite3 的 `.prepare()` 已经全部覆盖
2. LLM 生成 SQL 中最难解决的**语义错误**（逻辑正确但不符合用户意图），SQLAlchemy 也校验不了
3. 引入 SQLAlchemy 意味着增加 Python 运行时依赖，成本远大于收益，重复了 Spec 009 中排除 Vanna 的逻辑

### 8.2 推荐替代方案

| 优先级 | 措施 | 准确性提升 |
|:---:|------|:---:|
| P0 | Prompt 中注入完整 DDL + 字段说明 | ⭐⭐⭐ |
| P0 | Few-shot 示例（3~5 条常见查询模式） | ⭐⭐⭐⭐ |
| P1 | `try-catch prepare` + 错误回传 LLM 重试（最多 2 次） | ⭐⭐⭐ |
| P2 | 结果集合理性校验（空集检测、数量级判断） | ⭐⭐ |
| P3 | 积累高频问答的 golden SQL 作为验证集 | ⭐⭐⭐⭐（长期） |

### 8.3 一句话总结

> **SQLite 的 `.prepare()` 本身就是最好的校验器。与其引入 Python 的 SQLAlchemy 做 SQLite 已经做了的事，不如把精力花在改善 prompt 和构建 few-shot 示例上——这才是真正提升准确性的杠杆点。**

---

## 9. 与 Spec 009 的关系

本讨论是 Spec 009 的补充分析。009 的推荐方案（Prompt + 轻量 RAG，纯 TypeScript 实现）中，**SQL 校验天然由 better-sqlite3 的 prepare 机制覆盖**，无需额外设计校验层。

如果未来迁移到 009 的 Phase 3（Vanna），SQLAlchemy 校验才会变得有意义——因为 Vanna 本身就是 Python 生态，SQLAlchemy 是零成本附加。但在纯 TypeScript 方案下，SQLAlchemy 是一个多余的 Python 依赖。
