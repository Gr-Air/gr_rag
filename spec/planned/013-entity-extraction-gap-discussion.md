# Spec 013: 结构化数据库实体提取能力差距讨论

> 创建日期：2026-06-22
> 状态：**in-progress**（已实施第一步：两表结构 + chunk 级关联）
> 核心问题：**当前的流水线是否完整实现了「LLM 提取文档实体 + 关联文档存入 SQLite」？**

---

## 1. 现状分析

### 1.1 当前 SQLite 里存了什么

`struct_kb.db` 有 3 张表：

```
entries（词条表）
  ├── name: 词条名（如 "星辰数智"、"微服务"）
  ├── type: concept | entity
  ├── category: 分类标签
  ├── frequency: 出现频次
  └── path: Wiki 词条文件路径

documents（文档表）
  ├── name: 文档名（文件名去 .md）
  ├── title: 文档标题
  ├── client / project / doc_type / date: 文件名解析的元数据
  └── ❌ 没有 chunk 级别的关联

entry_docs（关联表）
  └── entry_id ↔ doc_id: 词条出现在哪些文档中
```

### 1.2 实体是从哪来的

`buildStructDb.cjs` 的实体来源：

```
Step 1: 读取 Wiki/concept/*.md 和 Wiki/entity/*.md → 得到词条列表
Step 2: 扫描 Raw/*.md 文档，正则提取 [[wikiLinks]] → 得到文档引用的词条
Step 3: 建立反查：词条 → 出现在哪些文档
Step 4: 写入 SQLite
```

**关键发现：实体不是 LLM 提取的，是预先存在于 `Wiki/` 目录中的。** 文档中的 `[[wikiLinks]]` 是文档生成时就标注好的，`buildStructDb.cjs` 只是用正则 `\[\[([^\]]+)\]\]` 去匹配。

### 1.3 Wiki 词条的实际内容

```
# 星辰数智

> 实体 | 出现频次: 256
```

```
# 微服务

> 概念 | 出现频次: 219
```

**Wiki 词条几乎是空的**——只有标题和频次，没有定义、描述、属性。

---

## 2. 你描述的需求 vs 当前实现的差距

| 需求 | 当前实现 | 差距 |
|------|---------|------|
| **LLM 提取文档实体** | ❌ 不是 LLM，是正则匹配 `[[wikiLinks]]` | 实体来源是人工预标注，非自动提取 |
| **实体有语义信息** | ❌ 只有 name + type + frequency | 没有 definition、attributes、relations |
| **实体关联到文档** | ✅ entry_docs 表实现了 | 但关联粒度是文档级，不是 chunk 级 |
| **实体关联到 chunk** | ❌ 没有 entry_chunks 表 | 无法查"某个实体出现在哪些 chunk" |
| **实体间关系** | ❌ 没有实体关系表 | 无法查"星辰数智 和 中信证券是什么关系" |
| **从新文档自动发现实体** | ❌ 依赖 Wiki/ 目录预置 | 新文档中的新实体不会被自动识别 |

---

## 3. 核心问题：实体提取的三种模式

### 模式 A：当前模式 — 人工预标注 wikiLinks（正则提取）

```
文档生成时人工标注 [[中信证券]] [[数据中台]]
     ↓
buildStructDb.cjs 正则提取 [[xxx]]
     ↓
匹配 Wiki/ 目录中已有的词条
     ↓
写入 SQLite
```

**优点**：零成本、零误差、速度快
**缺点**：只能提取已知的 wikiLinks，无法发现新实体；依赖人工标注质量

### 模式 B：LLM 实体提取（你描述的需求）

```
文档 chunk 内容
     ↓
LLM Prompt: "提取这段文本中的实体（人名、公司、技术、项目等）"
     ↓
LLM 返回: [{name: "中信证券", type: "company"}, {name: "数据中台", type: "concept"}]
     ↓
写入 SQLite（含实体定义、属性、关系）
```

**优点**：能发现新实体、能提取语义信息、能发现实体间关系
**缺点**：消耗 LLM API、有延迟、可能有幻觉

### 模式 C：混合模式（推荐）

```
Step 1: 正则提取 [[wikiLinks]] → 已知实体（零成本）
Step 2: LLM 提取文档中的新实体（补充发现）
Step 3: LLM 为重要实体生成定义和属性
Step 4: 合并写入 SQLite
```

**优点**：兼顾成本和覆盖度，已知实体零成本，新实体有 LLM 兜底

---

## 4. 当前流水线对结构化数据库的覆盖情况

```
Stage 1: clean-and-chunk.cjs
  ├── ✅ 清洗文档
  ├── ✅ 表格感知切分
  ├── ✅ chunk 中保留了 wikiLinks 字段
  └── ❌ 没有调用 LLM 提取实体

Stage 2: build-from-staging.cjs
  ├── ✅ 向量索引（LanceDB）
  ├── ✅ BM25 倒排索引
  ├── ✅ chunks_meta / parents
  ├── ✅ 调用 buildStructDb.cjs 构建结构化数据库
  │     ├── ✅ 从 Wiki/ 读取词条
  │     ├── ✅ 扫描 Raw/ 提取 wikiLinks
  │     ├── ✅ 建立 entry ↔ doc 关联
  │     └── ❌ 没有从 chunk 中 LLM 提取实体
  └── ❌ 没有建立 entry ↔ chunk 关联
```

**结论：当前流水线只实现了「正则提取 wikiLinks → 文档级关联」，没有实现「LLM 提取实体 → chunk 级关联」。**

---

## 5. 要实现完整能力，需要补充什么

### 5.1 缺失的 3 个能力

| 能力 | 说明 | 实现位置 |
|------|------|---------|
| **LLM 实体提取** | 对每个 chunk 调用 LLM 提取实体 | 新增 `scripts/lib/entityExtractor.cjs` |
| **chunk 级关联** | 实体出现在哪些 chunk（不是哪些文档） | SQLite 新增 `entry_chunks` 表 |
| **实体语义信息** | 实体的定义、类型、属性 | SQLite `entries` 表增加字段 |

### 5.2 建议的 SQLite Schema 增强

```sql
-- 增强后的 entries 表
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,              -- concept | entity | person | company | technology | project
  category TEXT DEFAULT '',
  definition TEXT DEFAULT '',      -- [新] LLM 生成的实体定义
  attributes TEXT DEFAULT '{}',    -- [新] JSON 格式的属性（如 {"行业": "金融", "规模": "大型"}）
  frequency INTEGER DEFAULT 0,
  path TEXT DEFAULT '',
  source TEXT DEFAULT 'wiki'      -- [新] wiki | llm_extracted
);

-- [新] 实体-chunk 关联表
CREATE TABLE entry_chunks (
  entry_id INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,          -- 对应 chunks.jsonl 中的 chunk.id
  doc_id INTEGER NOT NULL,
  context TEXT DEFAULT '',         -- 实体在 chunk 中的上下文片段
  PRIMARY KEY (entry_id, chunk_id),
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

-- [新] 实体间关系表
CREATE TABLE entry_relations (
  source_id INTEGER NOT NULL,      -- 主体实体
  target_id INTEGER NOT NULL,      -- 客体实体
  relation TEXT NOT NULL,          -- 关系类型（如 "客户"、"供应商"、"使用"）
  evidence TEXT DEFAULT '',        -- 关系证据（文档名+chunk）
  PRIMARY KEY (source_id, target_id, relation),
  FOREIGN KEY (source_id) REFERENCES entries(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES entries(id) ON DELETE CASCADE
);
```

### 5.3 LLM 实体提取的 Prompt 设计

```
你是一个实体提取专家。从以下文本中提取实体，返回 JSON 数组。

文本：{chunk.content}

提取规则：
1. 提取人名、公司名、技术名词、项目名、产品名、地点
2. 每个实体包含：name（名称）、type（类型）、definition（一句话定义）
3. type 可选值：person, company, technology, concept, project, product, location
4. 只提取文本中明确出现的实体，不要推断

输出格式：
[{"name": "中信证券", "type": "company", "definition": "中国头部证券公司"}]
```

### 5.4 成本估算

| 项目 | 数量 | 单次成本 | 总成本 |
|------|------|---------|--------|
| LLM 实体提取 | 1073 chunk | ~500 token/chunk | ~54万 token |
| 以 GLM-4-flash 计算 | - | ¥0.001/千token | ~¥0.54 |
| 以 GLM-4 计算 | - | ¥0.05/千token | ~¥27 |

**GLM-4-flash 方案成本极低（< ¥1），且实体提取是批量离线任务，对延迟不敏感。**

---

## 6. 推荐方案：分两步实施（已实施第一步）

### 第一步：chunk 级关联 + 两表结构（已实施 ✅）

**变更内容**：
- 将三表结构（entries + documents + entry_docs）简化为两表结构（entries + entry_chunks）
- 移除 `documents` 表和 `entry_docs` 表
- 新增 `entry_chunks` 表，直接关联实体 ↔ chunk
- entries 表新增 `definition`、`attributes`、`source` 字段

**实现文件**：
- `scripts/buildStructDb.cjs`：重写为两表结构
- `src/lib/structSearchEngine.ts`：适配新结构，新增 `queryChunksByEntry()`
- `src/lib/entityRouter.ts`：适配 `loadStructDocChunks()` 函数

**实施结果**：
- 词条总数：3729（概念 1786 / 实体 1943）
- 关联边数：32951
- 平均每词条关联：8.6 个 chunk

### 第二步：LLM 实体提取（待实施）

```javascript
// 对每个 chunk 调用 LLM
for (const chunk of allChunks) {
  const entities = await llmExtractEntities(chunk.content);
  for (const entity of entities) {
    // 新实体 → 写入 entries（source='llm_extracted'）
    // 已知实体 → 补充 definition
    // 建立 entry ↔ chunk 关联
  }
}
```

**价值**：发现文档中未标注 `[[wikiLinks]]` 的实体，为实体生成语义定义。

---

## 7. 结论（2026-07-01 更新）

| 问题 | 答案 |
|------|------|
| 清洗切分实现了吗？ | ✅ 完整实现（Stage 1） |
| 向量索引实现了吗？ | ✅ 完整实现（Stage 2） |
| LLM 提取文档实体实现了吗？ | ❌ 没有实现，当前是正则提取 wikiLinks |
| 实体关联文档存入 SQLite 实现了吗？ | ✅ **已实现 chunk 级关联**（两表结构） |
| 实体有语义信息吗？ | ⚠️ 部分实现（entries 表新增 definition/attributes 字段，待填充） |

**当前流水线覆盖了「清洗切分 → 向量索引 → 正则提取实体 → chunk 级关联」，但没有覆盖「LLM 提取实体 → 实体语义信息填充」。**

已完成的能力：
1. ✅ `entry_chunks` 表（chunk 级关联，零成本）
2. ✅ 两表结构简化（移除 documents 表）
3. ✅ entries 表增强（新增 definition/attributes/source 字段）

待实施的能力：
1. LLM 实体提取（发现新实体，~¥1 成本）
2. 实体定义和属性填充（利用 LLM 为重要实体生成定义）
