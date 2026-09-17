# Spec 011: 文档清洗切分流水线方案讨论

> 创建日期：2026-06-18
> 状态：**implemented**（Stage 1 已实施，2026-06-20）
> 核心问题：**如何将「文档上传 → 向量 chunk」拆分为独立的文档清洗切分流水线？**

---

## 1. 现状分析

### 1.1 当前架构：单体构建脚本

当前的 `buildIndex.cjs` 是一个**全耦合的单体脚本**，4 个阶段全部内联：

```
buildIndex.cjs (单体脚本)
  ├─ [1/4] scanAll()          → 扫描文件系统
  ├─ [1/4] chunkDocument()    → 语义分块
  ├─ [2/4] getEmbeddingsBatch() → DashScope API 向量化
  ├─ [2/4] LanceDB 写入       → IVF_PQ 向量索引
  ├─ [3/4] tokenizeAll()      → jieba 分词
  ├─ [3/4] BM25 倒排索引      → JSON 分片写入
  ├─ [3/4] parents.json       → 父文档映射
  ├─ [4/4] buildStructDb()    → SQLite 结构化数据库
  └─ buildStateSnapshot()     → 增量状态快照
```

### 1.2 关键痛点

| 痛点 | 影响 |
|------|------|
| **无法预览 chunk 质量** | 必须跑完整个 embedding（耗时+花钱）才能看到分块效果 |
| **调试困难** | 分块参数调优需要反复重建索引，每次都要调 embedding API |
| **文档清洗缺失** | 当前没有任何文档预处理（去除页眉页脚、空行规范化、特殊字符清理） |
| **无中间产物** | chunk 结果仅在内存中流转，无法被其他消费方复用 |
| **耦合度高** | scanner → chunker → embedder → indexer 四阶段无法独立运行 |
| **无质量门禁** | 没有 chunk 质量校验（空 chunk、过短、重复、低信息密度），劣质 chunk 直接进向量库 |
| **增量构建重复逻辑** | `buildIncremental.cjs` 复制了大量的 scanner + chunker 逻辑 |

### 1.3 当前数据流

```
                    buildIndex.cjs
文件系统                   │
  Raw/*.md      →  scanner  →  chunker  →  embedder  →  LanceDB
  Wiki/**/*.md  →           →           →  tokenizer →  BM25 JSON
                                            │
                                            ↓
                                        structDb
```

**没有任何中间输出或可观测性。**

---

## 2. 方案设计：三阶段流水线

### 2.1 目标架构

```
┌──────────────────────────────────────────────────────────────────┐
│  Stage 1: 文档清洗切分流水线（本次讨论重点）                       │
│                                                                    │
│ 文件系统          清洗器          分块器          质量门禁          │
│ Raw/*.md    →  ┌──────────┐  ┌──────────┐  ┌──────────────┐     │
│ Wiki/*.md   →  │ normalize│→ │ semantic │→ │ quality check│     │
│               │ dedup    │  │ chunk    │  │ score/filter │     │
│               └──────────┘  └──────────┘  └──────┬───────┘     │
│                                                    │              │
│                                                    ▼              │
│                                         chunks_staging/            │
│                                         ├─ chunks.jsonl            │
│                                         ├─ manifest.json           │
│                                         └─ quality_report.json     │
└──────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 2: 向量化 & 索引构建                                       │
│                                                                    │
│ chunks_staging/  →  embedder  →  LanceDB                          │
│                  →  tokenizer →  BM25 JSON                        │
│                  →              →  structDb                        │
└──────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 3: 检索服务（已有，不变）                                    │
│                                                                    │
│ LanceDB + BM25 + structDb  →  hybridSearch  →  RAG                │
└──────────────────────────────────────────────────────────────────┘
```

**核心变化**：Stage 1 独立运行，输出可持久化的 chunk 中间产物。Stage 2 从中间产物读取，不再直接依赖文件系统扫描。

### 2.2 分阶段执行

```bash
# 独立运行清洗分块（不消耗 embedding API）
node scripts/pipeline/clean-and-chunk.cjs

# 预览/调试分块效果
node scripts/pipeline/inspect-chunks.cjs --doc raw_xxx

# 从中间产物构建索引（不再扫描文件系统）
node scripts/pipeline/build-from-staging.cjs
```

---

## 3. 文档清洗能力设计

### 3.1 清洗器职责

当前项目**没有任何文档清洗**，`scanner.cjs` 直接读取原始文件内容传入 chunker。需要增加：

| 清洗步骤 | 说明 | 优先级 |
|----------|------|:---:|
| **Markdown 清洗** | 去除 YAML front matter、HTML 注释、导航菜单残留 | P0 |
| **空行规范化** | 连续 3+ 空行合并为 2 行，首尾空行去除 | P0 |
| **特殊字符清理** | 移除零宽字符、不可见控制字符、全角/半角混用纠正 | P1 |
| **表格保留** | 识别 markdown 表格，保持结构完整性，不拆散 | P0 |
| **代码块保留** | 识别 ``` 代码块，整体保留不切割 | P0 |
| **重复段落检测** | 检测文档内重复的段落（如复制粘贴的模板文字） | P2 |
| **页眉页脚去除** | 匹配重复出现的固定模式文字（如"第X页/共Y页"） | P2 |
| **长度过滤** | 丢弃清洗后有效内容 < 50 字符的文档 | P1 |

### 3.2 清洗器输入/输出

```typescript
// 输入
interface RawDocument {
  path: string;          // "Raw/阿里巴巴_ERP_方案设计_20240315.md"
  content: string;       // 原始 markdown 文本
  source: 'raw' | 'wiki_concept' | 'wiki_entity';
}

// 输出
interface CleanedDocument {
  path: string;
  title: string;
  content: string;        // 清洗后的文本
  metadata: {
    client?: string;
    project?: string;
    docType?: string;
    date?: string;
    source: string;
    originalLength: number;
    cleanedLength: number;
    cleaningRatio: number;  // 清洗损失比例（用于判断是否过度清洗）
  };
  rawWikiLinks: string[];  // 保留原始 [[链接]]
  warnings: string[];       // 清洗过程中发现的问题
}
```

---

## 4. 分块器设计（复用 + 增强）

### 4.1 核心策略：保持现有语义分块逻辑

现有的 `chunker.cjs` 分块策略已经很合理：

```
按 ## 标题粗切 → 段落/句子细切 → 合并为 200~1000 字符 chunk → 10% 重叠 → 合并过短 chunk
```

**完全复用**，但需要增加：

| 增强能力 | 说明 | 优先级 |
|----------|------|:---:|
| **表格/代码块感知** | 表格和代码块不会在中间被切断 | P0 |
| **可配置参数** | chunk 大小、重叠比例通过配置文件/CLI 参数控制 | P0 |
| **chunk 元数据丰富** | 记录 chunk 所属 section 标题、在文档中的位置比例 | P1 |
| **Wiki 词条不分块** | 保持现有逻辑，但统一走同一 Pipeline | P0 |

### 4.2 分块器输出格式

```typescript
// 每个 chunk 的输出
interface StagedChunk {
  id: string;              // "raw_阿里_ERP_0"
  parentDocId: string;     // "parent_raw_阿里_ERP"
  docTitle: string;
  docPath: string;
  chunkIndex: number;       // 在文档内的序号
  totalChunks: number;      // 该文档的总 chunk 数（需要后处理计算）
  content: string;          // 清洗后的 chunk 文本
  sectionTitle?: string;    // 所属的 ## 标题（增强上下文）
  positionRatio?: number;   // 在文档中的位置比例（0~1）
  metadata: {
    client: string;
    project: string;
    docType: string;
    date: string;
    source: 'raw' | 'wiki';
  };
  wikiLinks: string[];
}
```

---

## 5. 质量门禁设计

当前**零质量校验**，清洗后的 chunk 直接进向量库。建议增加三层门禁：

### 5.1 三层门禁

```
Layer 1: 硬拒绝 (HARD REJECT)
  ├─ content.length < 50 字符      → 丢弃
  ├─ 有效文本比例 < 30%              → 丢弃（全是标点/空格/数字）
  └─ 与同文档其他 chunk 完全重复     → 丢弃

Layer 2: 软告警 (SOFT WARN)
  ├─ content.length < 100 字符      → 标记但保留
  ├─ 信息密度 < 阈值                  → 标记但保留（如纯列表/目录）
  ├─ 与同文档其他 chunk 相似度 > 0.9  → 标记为 near-duplicate
  └─ wikiLinks 数量为 0（Raw 文档）  → 标记（可能缺少关联信息）

Layer 3: 统计上报 (REPORT)
  ├─ chunk 大小分布（min/max/avg/p50/p95）
  ├─ 每个文档的 chunk 数量分布
  ├─ 清洗前后长度对比
  └─ 各类型错误/告警计数
```

### 5.2 质量报告输出

```json
// quality_report.json
{
  "pipelineVersion": "1.0.0",
  "timestamp": "2026-06-18T16:00:00Z",
  "summary": {
    "totalDocs": 150,
    "totalChunks": 3200,
    "hardRejected": 12,
    "softWarned": 45,
    "passRate": "96.2%"
  },
  "perDoc": [
    {
      "docPath": "Raw/阿里_ERP_方案_20240315.md",
      "chunks": 8,
      "warnings": ["chunk_3: low density (0.28)"],
      "rejects": []
    }
  ],
  "distribution": {
    "chunkSizes": { "min": 58, "max": 998, "avg": 342, "p50": 320, "p95": 780 },
    "chunksPerDoc": { "min": 1, "max": 25, "avg": 6.4 }
  }
}
```

---

## 6. 中间存储格式方案

### 6.1 方案对比

| 格式 | 可追加 | 人类可读 | 流式处理 | 适合本项目 |
|------|:---:|:---:|:---:|:---:|
| **JSON Lines (.jsonl)** | ✅ 逐行追加 | ⚠️ 单行很长 | ✅ 逐行读取 | ⭐⭐⭐ 推荐 |
| JSON 数组 | ❌ 需整体重写 | ✅ | ❌ | ⭐⭐ |
| SQLite | ✅ | ❌ 需工具查看 | ✅ | ⭐ 过度设计 |
| Parquet | ✅ | ❌ | ✅ | ❌ 需额外依赖 |

**推荐 JSON Lines**：每行一个 chunk 对象，可追加、可流式读取、可直接用 `head`/`tail`/`wc -l` 查看。

### 6.2 目录结构

```
src/data/chunks_staging/
├── chunks.jsonl           # 所有 chunk（JSONL 格式，每行一个 chunk）
├── manifest.json          # 构建清单
│   {
│     "pipelineVersion": "1.0.0",
│     "totalChunks": 3200,
│     "totalDocs": 150,
│     "sourceFiles": ["Raw/xxx.md", ...],
│     "chunkConfig": { "minSize": 200, "maxSize": 1000, "overlap": 0.1 },
│     "builtAt": "2026-06-18T16:00:00Z",
│     "gitCommit": "abc123"
│   }
├── quality_report.json    # 质量报告
└── cleaning_log.jsonl     # 清洗日志（每条文档一行）
```

### 6.3 增量策略

```
全量构建：
  node scripts/pipeline/clean-and-chunk.cjs --mode full
  → 清空 chunks_staging/，重建所有 chunk

增量更新：
  node scripts/pipeline/clean-and-chunk.cjs --mode incremental
  → 对比 index_state.json，只处理新增/修改的文件
  → 从 chunks.jsonl 中移除旧 chunk（按 parentDocId 过滤）
  → 追加新 chunk
```

---

## 7. 脚本架构设计

### 7.1 模块划分

```
scripts/
├── lib/                          # 共享模块（已有，需增强）
│   ├── scanner.cjs               # 文件扫描（保持不变）
│   ├── chunker.cjs               # 语义分块（增强：表格/代码块感知）
│   ├── cleaner.cjs               # [新] 文档清洗器
│   ├── quality.cjs               # [新] 质量门禁
│   ├── staging.cjs               # [新] 中间存储读写
│   ├── tokenizer.cjs             # jieba 分词（已有，不变）
│   ├── embedder.cjs              # DashScope 嵌入（已有，不变）
│   ├── indexWriter.cjs           # 索引写入（已有，不变）
│   └── hasher.cjs                # 文件 hash（已有，不变）
│
├── pipeline/                     # [新] 流水线脚本
│   ├── clean-and-chunk.cjs       # Stage 1: 清洗 + 分块
│   ├── inspect-chunks.cjs        # 调试工具：预览 chunk
│   └── build-from-staging.cjs    # Stage 2: 从中间产物构建索引
│
├── buildIndex.cjs                # 全量构建（重构为调用 pipeline/）
├── buildIncremental.cjs          # 增量构建（重构为调用 pipeline/）
└── buildStructDb.cjs             # 结构化 DB（已有，不变）
```

### 7.2 核心脚本伪代码

```javascript
// scripts/pipeline/clean-and-chunk.cjs

async function main({ mode, dryRun, verbose }) {
  const changes = mode === 'full'
    ? { added: scanAll() }  // 全量：所有文件都是"新增"
    : detectChanges();       // 增量：对比 index_state.json

  const results = [];

  for (const file of [...changes.added, ...changes.modified]) {
    // 1. 清洗
    const cleaned = cleanDocument(file.content, {
      source: file.key.startsWith('raw_') ? 'raw' : 'wiki',
    });

    // 2. 过滤（硬拒绝）
    if (cleaned.content.length < 50) {
      log(`HARD REJECT: ${file.path} (too short)`);
      continue;
    }

    // 3. 分块
    const chunks = cleaned.source === 'wiki'
      ? [buildWikiChunk(cleaned)]     // Wiki 不分块
      : chunkDocument(cleaned.content, cleaned);  // Raw 语义分块

    // 4. 质量校验
    for (const chunk of chunks) {
      const qr = qualityCheck(chunk);
      if (qr.reject) continue;        // 硬拒绝
      if (qr.warnings.length > 0) {   // 软告警
        chunk.warnings = qr.warnings;
      }
      results.push(chunk);
    }
  }

  // 5. 写入中间存储
  if (!dryRun) {
    writeStaging(results, mode);
    writeManifest(results);
    writeQualityReport(results);
  }

  console.log(`✅ ${results.length} chunks staged`);
}
```

---

## 8. 与现有系统的兼容方案

### 8.1 重构路径

```
Phase 1（当前讨论后实施）: 新增 pipeline/ 模块，不破坏现有构建脚本
  ├─ 新增 scripts/lib/cleaner.cjs
  ├─ 新增 scripts/lib/quality.cjs
  ├─ 新增 scripts/lib/staging.cjs
  ├─ 新增 scripts/pipeline/clean-and-chunk.cjs
  └─ 现有 buildIndex.cjs 保持不变

Phase 2（验证后统一）: 重构现有构建脚本使用 pipeline 输出
  ├─ buildIndex.cjs 改为读取 chunks_staging/ 而非直接扫描文件
  ├─ buildIncremental.cjs 同步改为读取中间产物
  └─ 保留旧逻辑作为降级路径（feature flag 控制）

Phase 3（长期）: 前端集成
  ├─ API 路由：POST /api/pipeline/clean-and-chunk
  ├─ 前端展示 chunk 预览、质量报告
  └─ 与 Spec 008（前端索引重建按钮）协同
```

### 8.2 降级策略

```
if (chunks_staging/manifest.json 不存在) {
  // 降级：直接从文件系统扫描 + 分块 + 嵌入（现有流程）
  await buildIndexLegacy();
} else {
  // 新流程：从中间产物读取 chunk → 嵌入 → 索引
  await buildFromStaging();
}
```

### 8.3 完全不改变 runtime 检索

无论 pipeline 怎么改：
- **LanceDB 表结构不变**：`chunks` 表的 schema 保持一致
- **BM25 倒排索引格式不变**：JSON 分片结构保持一致
- **parents.json 格式不变**：父文档映射结构保持一致
- **chunks_meta 格式不变**：元数据分片结构保持一致

**运行时检索服务（hybridSearch / ragEngine）零改动。**

---

## 9. 方案对比

### 9.1 三种方案

| 方案 | 描述 | 复杂度 | 收益 |
|------|------|:---:|:---:|
| **A. 最小改造** | 仅抽取 scanner+chunker 为独立脚本，输出 JSON 文件，不增加清洗能力 | ⭐ | ⭐⭐ |
| **B. 标准方案** | 增加清洗器 + 质量门禁 + JSONL 中间存储（本文推荐） | ⭐⭐ | ⭐⭐⭐⭐ |
| **C. 重型方案** | 引入 ETL 框架（如 Apache NiFi/Airflow）、消息队列、分布式处理 | ⭐⭐⭐⭐⭐ | ⭐⭐（过度设计） |

### 9.2 详细对比

| 维度 | A 最小改造 | B 标准方案 | C 重型方案 |
|------|:---:|:---:|:---:|
| 开发工作量 | 0.5 天 | 2~3 天 | 1~2 周 |
| 文档清洗能力 | ❌ 无新增 | ✅ normalize/dedup/filter | ✅ 完整 ETL |
| chunk 质量门禁 | ❌ 无 | ✅ 三层校验 | ✅ 完整 |
| 中间产物可观测 | ✅ 基础 | ✅ 完整报告 | ✅ 完整监控 |
| 调试便利性 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 嵌入 API 成本节省 | ✅ 可预览后决定 | ✅ 可预览后决定 | ✅ 可预览后决定 |
| 新依赖 | 0 | 0（纯 Node.js） | 🔴 多个（MQ、调度器） |
| 维护成本 | 低 | 低 | 🔴 高 |
| 适合文档量级 | < 500 篇 | 500~5000 篇 | > 5000 篇 |

---

## 10. 推荐方案

### 10.1 推荐：方案 B（标准方案）

**理由**：
1. 当前 ~150 篇文档的规模，不需要 ETL 框架
2. 新增能力（清洗 + 质量门禁）直接解决当前最大痛点
3. 纯 Node.js 实现，零新依赖，与现有技术栈完全匹配
4. 渐进式改造，不破坏任何现有功能
5. 2~3 天即可完成，快速产生价值

### 10.2 实施优先级

| 优先级 | 任务 | 说明 |
|:---:|------|------|
| P0 | `cleaner.cjs` — 基础清洗 | 空行规范化、特殊字符清理、表格/代码块标记 |
| P0 | `staging.cjs` — JSONL 读写 | 基本写入/读取/追加能力 |
| P0 | `clean-and-chunk.cjs` — 主脚本 | 串联 scanner → cleaner → chunker → staging |
| P1 | `quality.cjs` — 质量门禁 | 三层校验 + 质量上报 |
| P1 | `inspect-chunks.cjs` — 调试工具 | 按 docId 预览 chunk 效果 |
| P2 | `build-from-staging.cjs` | 从中间产物构建索引 |
| P2 | 重构 `buildIndex.cjs` | 切换为调用 pipeline 脚本 |
| P3 | 前端集成 | chunk 预览页、质量报告展示、API 触发清理 |

---

## 11. 待讨论的开放问题

1. **清洗规则的维护**：文档格式多样（不同的客户/项目可能有不同模板），清洗规则如何适配？是否需要文档类型级别的清洗配置？

2. **表格和代码块的处理**：当前分块器不感知 markdown 表格和代码块，可能在中间切断。增强后是保留在原文中还是单独提取为 metadata？

3. **Wiki 词条的清洗**：Wiki 词条目前不做清洗也不分块。如果词条内容变长（超过 1000 字），是否也需要走清洗+分块流程？

4. **质量门禁的阈值**：`content.length < 50` 硬拒绝、信息密度 < 阈值软告警等参数如何确定？是否需要基于现有数据跑一次分析来标定？

5. **增量策略**：chunks.jsonl 的增量更新策略是"重写文件"还是"标记删除 + 追加"？前者简单但大文件写入耗时，后者复杂但更高效。当前数据量下（~3000 chunk），重写完全可行。

6. **manifest 中的 gitCommit**：是否需要在 manifest 中记录构建时的 git commit？这对问题回溯非常有价值，但需要处理 detached HEAD 等边界情况。

---

## 12. 实证分析：当前 chunker 的真实表现（2026-06-20 补充）

在继续讨论开放问题之前，我们先对现有 104 篇 Raw 文档跑了一次全量分块统计，用数据说话：

### 12.1 全量统计结果

| 指标 | 数值 |
|------|------|
| 文档数 | 104 |
| 总 chunk 数 | 834 |
| 平均每文档 chunk 数 | 8.0 |
| 空 chunk（< 50 字符） | 0 |
| 短 chunk（< 100 字符） | 0 |
| **含表格的 chunk** | **771（92.4%）** |
| **表格被切断的 chunk** | **244（29.3%）** |
| 涉及表格切断的文档 | 90 / 104（86.5%） |
| chunk 大小 min / p50 / p95 / max | 206 / 910 / 1595 / 2377 |

### 12.2 关键发现

**发现 1：表格切断是当前最严重的问题**

29.3% 的 chunk 存在表格被从中间切断的情况，影响 86.5% 的文档。这是本项目文档的特殊性决定的——来往账目、技术选型、需求分析等核心文档**高度依赖表格**来组织信息。

典型切断案例（`中信证券_数据中台_来往账目`）：

```
chunk 1 末尾: | 合计 | - | 13,662,000.00 | 10,880,000.00 | 2,782,000.00 | - | - |
chunk 2 开头: ## 2. 应收账款明细   ← 切断了"应收"和"应付"的表格上下文
```

```
chunk 6 末尾: | 合计 | - | 10,880,000.00 | - | - | - | - |
chunk 7 开头: ## 7. 账龄分析         ← 回款记录表格被切走了一半
```

**发现 2：短 chunk 和空 chunk 问题不存在**

`< 100 字符` 的 chunk 数为 0，说明现有分块器的"合并过短 chunk"逻辑有效。质量门禁中的"硬拒绝 < 50 字符"规则在当前数据集上不会被触发。

**发现 3：chunk 大小分布偏大**

p50 = 910 字符，已经接近 MAX_CHUNK_SIZE（1000）。p95 = 1595，远超上限。原因是**表格作为一个段落被整体保留**，一个大表格可能 800+ 字符，加上前后文本就超标了。这说明现有"表格感知"不是有没有的问题，而是**已经有了隐式感知（表格不切），但大小控制失效了**。

### 12.4 数据对方案的影响

这组数据直接改变了几个设计决策的优先级：

| 原设计 | 数据反馈后调整 |
|--------|---------------|
| 质量门禁 P0 优先级 | ⬇️ 降级为 P1——当前数据集没有空/短 chunk 问题 |
| 表格/代码块感知 P0 优先级 | ⬆️ 保持 P0 并提升为**最高优先级**——29.3% 切断率必须解决 |
| 清洗规则 P0 优先级 | 保持——`[[wikiLinks]]` 密度过高也需要处理 |
| chunk 大小控制 | ⬆️ 需要增加"大表格单独成 chunk + 摘要"策略 |

---

## 13. 开放问题深入讨论（2026-06-20 补充）

### 问题 1：清洗规则的维护

**现状**：文档格式实际上高度统一——所有 Raw 文档都遵循 `{客户}_{项目}_{文档类型}_{日期}.md` 命名，内容结构也一致（`#` 标题 → `## 文档元信息` 表格 → `## 1. xxx` 正文章节）。

**结论：不需要文档类型级别的清洗配置。**

理由：
- 文档格式由生成模板统一控制，变体极少
- 唯一的差异是 `docType`（来往账目 vs 技术方案 vs 需求规格说明书），但结构差异不大
- 引入"清洗配置"会增加维护成本，当前收益不匹配

**建议的清洗规则集（单一配置，不分类型）**：

```javascript
// 所有文档统一适用，配置项固化在 cleaner.cjs 中
const CLEAN_RULES = {
  // P0: 必须做
  stripFrontMatter: true,      // 去除 YAML front matter（如果出现）
  normalizeBlankLines: true,    // 连续3+空行→2行，首尾去空
  stripInvisibleChars: true,    // 零宽字符、BOM、不可见控制字符
  // P1: 建议做
  dedupWikiLinks: true,         // 同一段落内重复的 [[链接]] 只保留第一次
  normalizePunctuation: true,   // 全角/半角混用纠正（，→, 不改，但 ／→/）
  // P2: 暂不做
  stripHeaderFooter: false,     // 页眉页脚检测——当前文档没有这个问题
  dedupParagraphs: false,       // 重复段落检测——ROI 低
};
```

**`[[wikiLinks]]` 密度问题**——这是本项目特有的清洗需求。实测发现有些句子 wikiLinks 密度极高：

```
| 客户名称 | [[中信证券]]股份有限公司 |
| 项目名称 | [[中信证券]]数据[[中台]]建设项目 |
| 所属部门 | [[星辰数智]][[财务管理部]]往来核算组 |
```

**建议**：cleaner 阶段**不去除** wikiLinks（它们对结构化检索和 parent 文档映射有价值），但在 chunker 阶段为每个 chunk 计算 `wikiLinkDensity`（wikiLinks 字符数 / chunk 总长度），密度 > 30% 的 chunk 标记为软告警。

---

### 问题 2：表格和代码块的处理 ⭐ 最关键

**实测数据**：29.3% 的 chunk 表格被切断，这是当前流水线最大的质量缺陷。

**三种处理策略对比**：

| 策略 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A. 表格感知切分** | 切分时识别表格边界，表格不切断，整块进入 chunk | 实现简单，信息完整 | 大表格导致 chunk 超标 |
| **B. 表格提取为 metadata** | 表格从正文中抽出，存入 chunk.metadata.tables | 正文干净，表格结构化 | 改动 runtime 检索逻辑 |
| **C. 表格摘要 + 原文保留** | 大表格生成自然语言摘要，原文存入 metadata | 向量检索友好 | 需要 LLM 调用，增加成本 |

**推荐：策略 A（表格感知切分）+ 降级处理**

理由：
- 策略 B 改动 runtime，违反"零运行时改动"原则
- 策略 C 引入 LLM 依赖，违背 Stage 1"不消耗 API"的设计目标
- 策略 A 只改 chunker，效果立竿见影

**具体实现方案**：

```javascript
// chunker.cjs 增强：表格感知切分

function chunkDocument(content, ...) {
  // Step 0（新增）: 预扫描，标记表格和代码块的行范围
  const protectedRanges = scanProtectedRanges(content);
  // protectedRanges = [{start: 15, end: 28, type: 'table'}, {start: 40, end: 55, type: 'code'}]

  // Step 1（修改）: 按 ## 标题粗切，但切分点不能落在 protectedRange 内
  const sections = splitByHeaders(content, protectedRanges);

  // Step 2（修改）: 段落切分时，表格/代码块作为一个不可分割的单元
  const paragraphs = splitRespectingProtected(sections, protectedRanges);

  // Step 3（新增）: 大表格单独成 chunk
  for (const para of paragraphs) {
    if (isTable(para) && para.length > MAX_CHUNK_SIZE) {
      // 表格超过 maxChunkSize，单独作为一个 chunk
      chunks.push(buildTableChunk(para));
      continue;
    }
    // ... 正常合并逻辑
  }
}
```

**边界情况处理**：
- 表格前有 1-2 行说明文字（如"单位：人民币元"）→ 跟随表格一起进入 chunk
- 表格后有"合计"行 → 必须包含在同一个 chunk 中
- 代码块跨多行 → 整体保留，不切割

**代码块处理**：当前文档集**没有代码块**（实测 104 篇文档无 ``` 代码块），所以代码块感知标记为 P2 优先级，先解决表格问题。

---

### 问题 3：Wiki 词条的清洗

**现状**：Wiki 词条由 `buildWikiChunk()` 处理，只提取名称和频次，丢弃了原文内容。

```javascript
// 当前逻辑——只保留标题和频次
const text = `# ${name}\n${sub === 'concept' ? '概念' : '实体'} | 出现频次: ${freq}`;
```

**问题**：Wiki 词条的原始内容（可能包含概念定义、实体描述）**完全没有进入向量索引**。这是一个比"清洗"更严重的问题——**信息丢失**。

**建议分两步**：

1. **本次流水线重构时**：Wiki 词条走 cleaner（去除频次行等元信息），保留实际内容，不分块（词条通常 < 500 字符）。修改 `buildWikiChunk` 为保留清洗后内容：

```javascript
function buildWikiChunk(name, type, file, content) {
  const cleaned = cleanWikiContent(content); // 去除"出现频次: N"行
  return {
    id: `wiki_${name}`,
    content: `# ${name}\n${cleaned}`,  // 保留实际内容
    // ...
  };
}
```

2. **后续（不在本次范围）**：如果词条内容 > 1000 字符，才走分块流程。当前 Wiki 词条都很短，不需要。

---

### 问题 4：质量门禁的阈值

**实测数据支撑下的阈值标定**：

| 规则 | 原设计阈值 | 实测数据 | 调整后阈值 |
|------|-----------|---------|-----------|
| 硬拒绝：< 50 字符 | 50 | min = 206 | 保持 50（防御性，当前不触发） |
| 软告警：< 100 字符 | 100 | 0 个 | 保持 100（防御性） |
| 硬拒绝：有效文本 < 30% | 30% | 未测 | 保持 30%（防御性） |
| 软告警：信息密度低 | 未定 | 未测 | **新增：wikiLinkDensity > 30%** |
| 软告警：近重复 > 0.9 | 0.9 | 未测 | 保持 0.9（P2，暂不实现） |

**结论：质量门禁在当前数据集上不是瓶颈，优先级降为 P1。**

当前数据集质量很高（生成模板统一，无脏数据），质量门禁更多是**防御性措施**——防止未来手动添加的低质量文档污染索引。

**建议的实现策略**：
- P0：只实现 `hard reject`（< 50 字符 + 完全重复检测），20 行代码
- P1：实现 `wikiLinkDensity` 软告警，10 行代码
- P2：近重复检测、信息密度计算，暂不实现

---

### 问题 5：增量策略

**当前数据量**：834 chunk / 104 文档，chunks.jsonl 预估 ~1MB。

**结论：直接重写整个 chunks.jsonl 文件。**

理由：
- 1MB 文件写入耗时 < 50ms，性能完全可接受
- 重写逻辑简单，不易出 bug
- "标记删除 + 追加"需要维护 tombstone，增加复杂度
- 即使文档增长到 1000 篇（~8000 chunk），文件也就 ~10MB，重写仍然可接受

**增量检测仍然需要**——只是写入策略用重写，但**处理范围**仍然是增量的（只清洗+分块新增/修改的文件）：

```javascript
async function cleanAndChunk({ mode }) {
  const changes = detectChanges(); // 对比 index_state.json
  // 只对 changes.added + changes.modified 做清洗+分块
  const newChunks = processFiles(changes.added.concat(changes.modified));

  if (mode === 'full') {
    writeStaging(newChunks); // 全量重写
  } else {
    // 增量：读取旧 chunks，移除变更文档的旧 chunk，合并新 chunk，重写
    const oldChunks = readStaging().filter(
      c => !changes.affectedDocIds.includes(c.parentDocId)
    );
    writeStaging([...oldChunks, ...newChunks]);
  }
}
```

---

### 问题 6：manifest 中的 gitCommit

**结论：记录，但用简单方式。**

```javascript
// scripts/lib/staging.cjs
const { execSync } = require('child_process');

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown'; // 非 git 仓库或 detached HEAD
  }
}
```

理由：
- `try-catch` 处理所有边界情况（detached HEAD、非 git 仓库、无 commit）
- gitCommit 对问题回溯的价值远大于实现成本（5 行代码）
- 即使返回 `'unknown'`，也不影响流水线运行

---

## 14. 修订后的实施优先级（2026-06-20 调整）

基于实证分析，调整后的优先级：

| 优先级 | 任务 | 理由 |
|:---:|------|------|
| **P0** | chunker 表格感知切分 | 29.3% 表格切断率，最高 ROI |
| **P0** | `cleaner.cjs` 基础清洗 | wikiLinks 密度规范化、空行处理 |
| **P0** | `staging.cjs` JSONL 读写 | 中间产物持久化基础 |
| **P0** | `clean-and-chunk.cjs` 主脚本 | 串联全流程 |
| **P1** | `buildWikiChunk` 保留内容 | 修复 Wiki 词条信息丢失 |
| **P1** | 硬拒绝质量门禁 | 防御性措施，20 行代码 |
| **P1** | `inspect-chunks.cjs` 调试工具 | 表格感知效果的验证依赖它 |
| **P2** | `build-from-staging.cjs` | 从中间产物构建索引 |
| **P2** | 软告警质量门禁 | wikiLinkDensity 等 |
| **P3** | 重构 `buildIndex.cjs` | 切换为调用 pipeline |
| **P3** | 前端集成 | chunk 预览页 |

**核心变化**：表格感知切分从原设计的"增强能力"提升为**最高优先级**，因为实测 29.3% 的切断率是当前向量检索质量的最大隐患。

---

## 15. 实施记录（2026-06-20）

### 15.1 已创建文件

| 文件 | 说明 |
|------|------|
| `scripts/lib/cleaner.cjs` | 文档清洗器：BOM/不可见字符/YAML front matter/HTML 注释清理、空行规范化、全角半角纠正 |
| `scripts/lib/chunker.cjs` | 分块器（v2 表格感知）：表格整体保留、大表格单独成 chunk、sectionTitle 元数据、buildWikiChunk 保留正文 |
| `scripts/lib/staging.cjs` | JSONL 中间存储：读写/追加/增量更新、manifest 管理、质量报告写入 |
| `scripts/pipeline/clean-and-chunk.cjs` | 流水线编排脚本：scanner→cleaner→chunker→质量校验→staging，支持全量/增量/dry-run |
| `scripts/pipeline/inspect-chunks.cjs` | 调试工具：--list/--doc/--stats/--report 四种查看模式 |

### 15.2 运行结果

```
全量构建: 104 Raw 文档 + 228 Wiki 词条
总 chunk 数: 1049
chunk 大小: min=25 p50=818 p95=1472 max=2377
硬拒绝: 0
软告警: 8 (高 wikiLink 密度)
表格被切断: 0 (0.0%)  ← 从 29.3% 降至 0%
```

### 15.3 表格感知效果对比

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 表格被切断的 chunk | 244（29.3%） | **0（0.0%）** |
| 含表格的 chunk | 771（92.4%） | 756（72.1%） |
| 总 chunk 数 | 834 | 1049（含 Wiki 词条） |
| chunk 大小 p50 | 910 | 818 |
| buildWikiChunk 内容 | 只有标题+频次 | 保留正文内容 |

### 15.4 向后兼容性

- `chunkDocument()` 签名不变，旧调用方式完全兼容
- `buildWikiChunk()` 签名不变，增强为保留正文
- `buildIndex.cjs` / `buildIncremental.cjs` 无需修改即可使用新 chunker
- 运行时检索服务（hybridSearch/ragEngine）零改动

### 15.5 产出文件

```
src/data/chunks_staging/
├── chunks.jsonl          2.1 MB (1049 行)
├── manifest.json         15 KB (含 gitCommit: a697c12)
└── quality_report.json   31 KB
```

### 15.6 使用方式

```bash
# 全量清洗切分（不消耗 embedding API）
node scripts/pipeline/clean-and-chunk.cjs

# 增量更新
node scripts/pipeline/clean-and-chunk.cjs --mode incremental

# 预览不写入
node scripts/pipeline/clean-and-chunk.cjs --dry-run

# 调试工具
node scripts/pipeline/inspect-chunks.cjs --list
node scripts/pipeline/inspect-chunks.cjs --doc raw_中信证券_数据中台_来往账目_20250407
node scripts/pipeline/inspect-chunks.cjs --stats
node scripts/pipeline/inspect-chunks.cjs --report
```

### 15.7 待实施（后续阶段）

| 阶段 | 任务 | 说明 |
|:---:|------|------|
| Stage 2 | `build-from-staging.cjs` | 从 chunks.jsonl 读取 → embedding → LanceDB + BM25 |
| Stage 2 | 重构 `buildIndex.cjs` | 切换为从 staging 读取，保留旧逻辑作降级 |
| Stage 3 | 前端集成 | chunk 预览页、质量报告展示 |
