# 星辰Wiki - 企业知识库智能检索系统

基于 **RAG + 混合检索** 的企业内部项目文档智能知识库。

## 技术架构全景

```
用户查询
    │
    ├── ① LLM 智能改写 ──── 查询改写 + 实体提取 + docType 推荐
    │                      (不可用时降级 jieba + 字典匹配)
    │                              ↓
    │              ┌───────────────┴───────────────┐
    │              ↓                               ↓
    │       有实体匹配                     无实体匹配
    │              ↓                               ↓
    │   ② 实体文档加载                ② RRF 混合检索
    │   (SQLite AND-first             (向量+BM25, docType 过滤)
    │    精准匹配)                          ↓
    │              ↓                  top20 + top20 → RRF(k=60)
    │   短文档全文 / 长文档                      ↓
    │   关键字片段提取                      top15 候选池
    │   (全量注入，不截断)                      ↓
    │              │                 ③ Rerank 重排序 → top5
    │              │                          ↓
    │              │                    top5 语义 chunk
    │              │                          │
    │              └─────────────┬────────────┘
    │                            ↓
    └── ④ RAG 生成 ──── Prompt 模板 → LLM 流式输出 (SSE)
```

---

## 完整检索流程

### ① LLM 智能改写层（Query Rewriter）

**目标**：一次 LLM 调用同时完成查询改写、实体提取和文档类型推荐。

调用 `qwen3.7-max` 对用户查询进行：

- **查询改写**：补全隐含实体、术语标准化、同义词展开
- **实体提取**：从 SQLite 加载 3700+ 实体词条作为参考，精准提取（支持实体分解——未知实体拆解为已知实体组合）
- **追问检测**：识别指代消解、省略追问、纠错否定等
- **文档类型推荐**：输出 `relevantDocTypes`，用于无实体命中时缩小 hybridSearch 检索范围

LLM 不可用时降级为 jieba 分词 + 字典匹配。

### ② 实体文档加载（Entity Doc Loading）

**目标**：当查询匹配到实体时，直接加载关联文档的完整内容。

流程：
1. **AND-first 查询**：多实体时优先 AND 精准匹配（避免短词如 "ERP" 匹配到无关文档），AND 无结果时降级 OR
2. **短文档（<3000 token）**：全文注入
3. **长文档（≥3000 token）**：提取实体关键字周围 ±200 token 的片段，最多 3 个片段/文档，重叠区间合并
4. 同时加载 Wiki 词条内容作为补充上下文

### ② RRF 混合检索（Hybrid Search）

当实体匹配和索引查询均无结果时，降级为混合检索。LLM 推荐的 `relevantDocTypes` 用于 post-filter 收窄检索范围。

双路并行召回，结果通过 **RRF（Reciprocal Rank Fusion）** 融合：

```
RRF(d) = Σ 1/(k + rank_i(d))，k = 60
```

| 检索通路 | 技术方案 | 召回量 |
|---------|---------|-------|
| 向量检索 | DashScope `text-embedding-v4`，1024维，余弦相似度，LanceDB IVF_PQ 索引 | top20 |
| BM25 检索 | @node-rs/jieba 分词，纯 JS 倒排索引，支持自定义词典 | top20 |

融合后经 Rerank 重排序，取 top5 文档块供 LLM 生成使用。无 LLM 时降级为检索结果直接展示。

> Wiki 概念/实体短词条不参与语义索引（仅通过 SQLite struct DB 在实体路径中发挥作用），索引只包含 1036 个 Raw 文档 chunk。

### ③ Rerank 语义重排序

对 RRF 融合结果进行语义相关性精排，取 top5 进入 LLM prompt。chunk 采用字符级语义分块（上限 1000 字符，表格作为整体保留），每个 chunk 已包含完整段落或表格，无需额外上下文扩展。

### ④ RAG 生成层（RAG Engine）

通过 `PromptTemplate` 管理多场景提示词模板（基础问答、追问、对比分析），将检索结果拼入 prompt，调用 LLM 生成回答：
- **流式输出**（SSE），实时显示生成进度
- **实体文档增强**：结构化文档内容优先于语义检索结果
- **多轮对话**：基于 session 管理上下文，支持追问、指代消解
- **检索结果缓存**：进程内 LRU 语义缓存（Spec 030），缓存 hybridSearch 输出的 `SearchResult[]`，命中时跳过检索直接进入 Rerank+LLM；kbVersion + policyVersion 感知，索引重建自动失效

---

## 核心技术设计

### 两条检索路径

| 路径 | 触发条件 | 数据源 | 特点 |
|------|---------|---------|------|
| entity | 查询匹配到实体词条 | SQLite struct_kb.db → Raw 全文/片段 | 精确匹配，全量注入 |
| rrf | 无实体命中 | LanceDB(1036) + BM25(1036) → docType 过滤 → Rerank top5 | 语义理解，docType 收窄范围 |

### 分层架构（Domain / Application / Infrastructure）

代码按依赖方向分为三层，`src/domain/` 只定义类型与接口，不依赖任何基础设施：

```
src/domain/                    # Domain 层：纯类型 + 接口（零依赖）
├── search/types.ts            #   RetrievalHit / SearchResult / SearchQuery / QueryAnalysis
│                              #   RetrievalFilter / RetrievalOptions / RetrievalRequest
│                              #   Retriever / Fusion / Reranker 接口
├── document/types.ts          #   DocChunk / ChunkMeta / ChunkStore 接口
└── entity/types.ts            #   WikiEntry / EntityMatch / EntityRepository 接口

src/lib/                       # Application + Infrastructure 层
├── search/                    # 检索管线（编排固定，组件可替换）
├── document/                  # ChunkStore 实现（JsonChunkStore）
└── ...                        # 各基础设施引擎
```

### 检索管线（Spec 029 / 031 / Phase 2 拆分）

`src/lib/search/` 将检索流程抽象为三个接口，管线组装固定在 `pipeline.ts`：

- **Retriever**：`VectorRetriever` / `BM25Retriever` / `StructRetriever`，统一 `search(query: SearchQuery, options: RetrievalOptions) → RetrievalHit[]`
- **Fusion**：`RRFFusion` 实现 RRF 融合，接收 `QueryAnalysis`（实体过滤）
- **Reranker**：`QwenReranker`（核心）/ `NoopReranker`（降级），按 API key 自动选择

管线数据流分两段（Spec 031）：

```
hybridSearch(query, options)
  → 内部构建 RetrievalRequest { query: SearchQuery, analysis: QueryAnalysis, filter: RetrievalFilter }
  → pipeline：[Vector, BM25] 并行召回 → filteredChunkIds 过滤 → RRF 融合 → RetrievalHit[]
  → assembler：chunk 附着(ChunkStore) → 文档聚合 → 实体加成 → 归一化 → 高亮 → SearchResult[]
```

Phase 2 将原 `RetrievalContext` 按职责拆分，各组件只接收所需数据：

| 类型 | 职责 | 接收方 |
|------|------|--------|
| `SearchQuery` | 纯查询意图 | Retriever / Reranker / Assembler |
| `QueryAnalysis` | 实体匹配结果（matchedKeywords） | Fusion / Assembler |
| `RetrievalFilter` | docType 过滤条件（filteredChunkIds） | pipeline 过滤阶段 |
| `RetrievalOptions` | Retriever 参数（topN / filter / keywords） | Retriever |
| `RetrievalRequest` | pipeline 聚合请求 | runSearchPipeline |

chunk 读取统一走 `ChunkStore` 接口（`src/lib/document/`），检索引擎（bm25Engine）不再承担 chunk 存储职责。

### 表格感知分块

`scripts/lib/chunker.cjs` 实现了表格感知的语义分块：
- 表格作为一个不可分割单元保留，不跨 chunk 切分
- 表格内空行不中断表格（处理生成文档中表格内部有空行的情况）
- 超大表格（>1000 字符）单独成 chunk
- 跨 section 全局统一 chunkIndex，合并过短 chunk

### @node-rs/jieba 自定义词典

内置 80+ 业务术语（客户企业、技术组件、部门、业务系统），最高优先级 100，确保专业词汇不被错误切分。例如：
- `Kubernetes` 不被切成 `Kuber`、`netes`
- `国家电网` 不被切成 `国家`、`电网`

### 数据分层存储

| 存储类型 | 数据内容 | 用途 |
|---------|---------|------|
| LanceDB | 文档块向量（1024维，1036 chunk） | 向量检索 |
| BM25 倒排索引 | 分词后的词项→文档映射（1036 chunk） | BM25 检索 |
| SQLite `struct_kb.db` | 实体/概念 → chunk 关联（3729 词条，32951 关联边） | 实体查询 |
| chunks_meta | 文档块元数据（1036 条，仅 Raw 文档） | 上下文提取 |
| `index_manifest.json` | 索引版本 + builtAt + gitCommit（Spec 026） | 跨索引一致性 + 缓存失效感知 |

**Wiki 文档特殊处理**：`Wiki/concept/` 和 `Wiki/entity/` 目录下的 3853 个词条不再生成 chunk，Wiki 词条内容通过文件系统直接加载（`entityRouter.ts` 的 `fs.readFileSync`），用于实体文档增强。

---

## 快速开始

```bash
# 1. 安装依赖
cd llm-wiki
npm install

# 2. 构建索引（首次必须运行）
npm run index:full
# 或使用流水线方式（推荐）
node scripts/pipeline/clean-and-chunk.cjs       # Stage 1: 清洗 + 分块
node scripts/pipeline/build-from-staging.cjs    # Stage 2: 向量化 + BM25 + SQLite

# 3. 启动开发服务器
npm run dev

# 4. 访问 http://localhost:3000
```

增量更新：
```bash
npm run index:incremental   # 增量索引构建（仅处理变更文件）
npm run index:struct        # 仅重建结构化数据库
```

重建向量/BM25（不改 SQLite）：
```bash
node scripts/pipeline/build-from-staging.cjs --skip-sqlite
```

---

## RAG 评测

项目内置 RAGAS 离线评测体系（`test/rag-eval/`），支持：

```bash
cd test/rag-eval
pip install -r requirements.txt
python evaluate.py          # 自动加载项目 .env 中的 API Key
```

评测流程：
1. 调用 `/api/eval` 端点对测试集样本进行检索+生成
2. 对返回结果计算 RAGAS 七项指标（Faithfulness、Context Recall、Context Precision、Answer Relevancy、Answer Correctness、Conciseness、Source Citation）
3. 诊断表格截断情况
4. 输出 JSON 详细报告 + Markdown 摘要

最新评测结果（20 样本，qwen3.7-max，2026-08-20）：

| 指标 | 分数 | 说明 |
|------|------|------|
| Faithfulness | 0.94 | 回答忠实于上下文的程度 |
| Context Recall | 0.64 | 上下文包含真实答案的程度 |
| Context Precision | 0.75 | 上下文的精确性 |
| Answer Relevancy | 0.89 | 回答与问题的相关性 |
| Answer Correctness | 0.57 | 回答的事实正确性（结合忠实度与语义相似度） |
| Conciseness | 0.65 | 回答是否简洁精炼，无冗余重复 |
| Source Citation | 1.00 | 回答是否提供具体的文档来源引用 |

---

## 环境配置

复制 `.env` 为 `.env.local`，配置 LLM API：

```env
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen3.7-max

# 向量 Embedding（必填）
DASHSCOPE_API_KEY=sk-xxx
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIM=1024
```

也可以在 AI 问答页面的设置面板中直接配置。

不配置 LLM 时，AI 问答自动降级为基于检索结果的文档摘要展示。

---

## 项目结构

```
llm-wiki/
├── scripts/
│   ├── pipeline/                # 流水线脚本
│   │   ├── clean-and-chunk.cjs  #   Stage 1: 文档清洗 + 表格感知分块
│   │   ├── build-from-staging.cjs # Stage 2: 向量化 + BM25 + SQLite
│   │   ├── extract-entities.cjs #   实体提取
│   │   ├── link-entities.cjs    #   实体链接
│   │   ├── augment-concepts.cjs #   概念词条增强
│   │   ├── inspect-chunks.cjs   #   分块结果检查
│   │   └── gen-test-docs.cjs    #   生成测试文档
│   ├── lib/                     # 流水线公共模块
│   │   ├── chunker.cjs          #   表格感知语义分块器
│   │   ├── cleaner.cjs          #   文档清洗器
│   │   ├── embedder.cjs         #   DashScope 向量化
│   │   ├── entityExtractor.cjs  #   实体提取器
│   │   ├── envLoader.cjs        #   环境变量加载
│   │   ├── hasher.cjs           #   内容哈希（增量判断）
│   │   ├── indexWriter.cjs      #   索引写入器
│   │   ├── linker.cjs           #   实体链接
│   │   ├── scanner.cjs          #   文件扫描器
│   │   ├── staging.cjs          #   中间存储管理
│   │   ├── tokenizer.cjs        #   分词器（jieba + 业务词典）
│   │   └── wikiWriter.cjs       #   Wiki 词条写入
│   ├── buildIndex.cjs           # 全量索引构建
│   ├── buildIncremental.cjs     # 增量索引构建
│   └── buildStructDb.cjs        # 结构化数据库构建
├── src/
│   ├── domain/                  # Domain 层：纯类型 + 接口（零依赖，Phase 1 建立）
│   │   ├── search/types.ts      #   检索类型 + Retriever/Fusion/Reranker 接口
│   │   ├── document/types.ts    #   DocChunk / ChunkMeta / ChunkStore 接口
│   │   └── entity/types.ts      #   WikiEntry / EntityMatch / EntityRepository 接口
│   ├── app/
│   │   ├── page.tsx             # 首页仪表盘
│   │   ├── chat/page.tsx        # AI 问答页（多轮对话 + 流式输出）
│   │   ├── docs/page.tsx        # 文档浏览页
│   │   ├── search/page.tsx      # 检索页
│   │   └── api/
│   │       ├── chat/route.ts    # RAG 问答 API (SSE)
│   │       ├── search/route.ts  # 混合检索 API
│   │       ├── eval/route.ts    # 离线评测 API
│   │       ├── stats/route.ts   # 知识库统计 API
│   │       └── docs/list/       # 文档列表 API
│   ├── lib/
│   │   ├── types.ts             # Application/Infrastructure 类型 + domain 类型 re-export
│   │   ├── document/            # ChunkStore（Spec 031，统一 chunk 读取入口）
│   │   │   ├── types.ts         #   re-export domain 类型（兼容层）
│   │   │   └── chunkStore.ts    #   JsonChunkStore 实现
│   │   ├── search/              # 混合检索模块（Spec 028-031 + Phase 2 拆分）
│   │   │   ├── types.ts         #   re-export domain 检索类型（兼容层）
│   │   │   ├── index.ts         #   hybridSearch 入口（构建 RetrievalRequest）
│   │   │   ├── pipeline.ts      #   固定管线：[Vector+BM25] → 过滤 → RRF → RetrievalHit[]
│   │   │   ├── assembler.ts     #   组装器：RetrievalHit[] → SearchResult[]
│   │   │   ├── fusion.ts        #   RRFFusion 实现 + rrfFusion 纯函数
│   │   │   ├── entityStrategy.ts #  实体过滤标记 + 匹配度加成
│   │   │   ├── highlight.ts     #   关键词高亮
│   │   │   ├── queryPolicy.ts   #   宽泛查询识别 + POLICY_VERSION
│   │   │   ├── retrievers/      #   VectorRetriever / BM25Retriever / StructRetriever
│   │   │   └── rerankers/       #   QwenReranker / NoopReranker
│   │   ├── entityRouter.ts      # 实体路由（关键字提取 + 结构化查询）
│   │   ├── structSearchEngine.ts # SQLite 结构化检索引擎
│   │   ├── queryRewriter.ts     # LLM 查询改写 + 实体提取
│   │   ├── promptTemplate.ts    # 多场景提示词模板管理
│   │   ├── ragEngine.ts         # RAG 生成引擎（OpenAI 兼容 API）
│   │   ├── searchCache.ts       # 检索结果缓存（进程内 LRU 语义缓存）
│   │   ├── tokenizer.ts         # jieba 分词 + 业务自定义词典
│   │   ├── embedding.ts         # DashScope Embedding API
│   │   ├── vectorEngine.ts      # LanceDB 向量检索引擎
│   │   ├── bm25Engine.ts        # BM25 倒排索引引擎
│   │   ├── parser.ts            # Markdown 文档解析器（语义分块）
│   │   ├── indexManager.ts      # 索引管理器（含 index_manifest 版本管理）
│   │   └── sessionManager.ts    # 多轮对话会话管理
│   └── data/                    # 预构建索引数据（git 追踪）
│       ├── lancedb/             # LanceDB 向量数据库
│       ├── bm25/                # BM25 倒排索引分片
│       ├── chunks_meta/         # 文档块元数据
│       ├── chunks_staging/      # 分块中间存储
│       ├── parents/             # 父子文档关系
│       └── struct_kb.db         # SQLite 结构化知识库
├── test/
│   ├── *.test.ts                # 单元测试（vitest）
│   └── rag-eval/                # RAGAS 离线评测
│       ├── evaluate.py          #   评测脚本
│       ├── test_set.json        #   测试集（20 样本）
│       └── results/             #   评测报告
├── spec/                        # Spec 治理文档
│   ├── governance/              #   治理模板
│   ├── planned/                 #   计划中
│   ├── implemented/             #   已实施
│   ├── refactor/                #   架构重构基线（architecture-baseline.md）
│   └── archived/                #   已归档
└── Raw/ Wiki/                   # 原始文档与 Wiki 词条（位于上级目录）
```

---

## 技术栈

- **前端**: Next.js 16 + React 19 + Tailwind CSS 4
- **分词**: @node-rs/jieba（结巴分词 Rust 实现，支持业务自定义词典）
- **向量**: 1024维 DashScope `text-embedding-v4` + LanceDB IVF_PQ 索引 + 余弦相似度
- **BM25**: 纯 JS 倒排索引实现（@node-rs/jieba 分词）
- **LLM**: OpenAI 兼容 API（qwen3.7-max，流式 SSE 输出）
- **向量数据库**: LanceDB（本地文件存储，支持增量索引）
- **结构化数据**: SQLite（3729 词条 → 32951 关联边）
- **评测**: RAGAS（Faithfulness / Context Recall / Context Precision / Answer Relevancy / Answer Correctness / Conciseness / Source Citation）
- **测试**: Vitest（220 个测试用例）
