# 星辰Wiki - 企业知识库智能检索系统

基于 **RAG + 混合检索** 的企业内部项目文档智能知识库。

## 技术架构全景

```
用户查询
    │
    ├── ① 实体提取 ──── jieba + 字典匹配（贪心最大匹配）
    │                      ↓
    │              ┌───────┴───────┐
    │              ↓               ↓
    │         有实体            无实体
    │              ↓               ↓
    │   ② 结构化查询       ② RRF 混合检索
    │   (SQLite + 上下文)   (向量+BM25)
    │              ↓               ↓
    │    返回包含实体的    top20 + top20 → RRF(k=60) 融合
    │    上下文片段                ↓
    │    (±200 token)         top10 文档块
    │              └───────┬───────┘
    │                      ↓
    └── ③ RAG 生成 ──── 调用 LLM → 流式输出 (SSE)
```

---

## 完整检索流程

### ① 实体提取层（Entity Extractor）

**目标**：从用户查询中提取实体关键字，决定检索路径。

使用**贪心最大匹配**算法，从 SQLite 结构化数据库加载实体词条（仅 `type='entity'`），优先匹配长词。

| 触发条件 | 检索路径 | 返回内容 |
|---------|---------|---------|
| 查询中包含实体关键字 | 结构化查询 | 包含实体的上下文片段（±200 token） |
| 查询中无实体关键字 | RRF 混合检索 | 向量+BM25 融合结果 |

**策略**：
- **字典匹配**：从 SQLite 加载实体词条（约 1943 个），按长度降序排列
- **贪心匹配**：优先匹配最长词，避免"华润"被误匹配而漏掉"华润置地"
- **大小写不敏感**：支持中英文混合匹配

### ② 结构化查询（Entity Context Retrieval）

**目标**：当查询包含实体时，返回包含该实体的文档上下文片段。

流程：
1. 从 SQLite 查找实体关联的所有 chunk
2. 过滤掉 `wiki_` 前缀的概念文档，只保留 Raw 文档
3. 对每个 chunk 提取实体周围 ±200 token 的上下文片段
4. 最多提取 3 个片段/文档，重叠区间合并

特点：
- **精确匹配**：基于实体与 chunk 的关联关系
- **上下文聚焦**：只返回实体周围的相关内容，减少噪声
- **多文档覆盖**：支持一个实体关联多个文档

### ② RRF 混合检索（Hybrid Search）

双路并行召回，结果通过 **RRF（Reciprocal Rank Fusion）** 融合：

```
RRF(d) = Σ 1/(k + rank_i(d))，k = 60
```

| 检索通路 | 技术方案 | 召回量 |
|---------|---------|-------|
| 向量检索 | DashScope `text-embedding-v4`，1024维，余弦相似度，LanceDB IVF_PQ 索引 | top20 |
| BM25 检索 | @node-rs/jieba 分词，纯 JS 倒排索引，支持自定义词典 | top20 |

融合后输出 **top10 文档块**，无 LLM 时降级为检索结果直接展示。

### ③ RAG 生成层（RAG Engine）

将检索结果拼入 prompt，调用 LLM（兼容 OpenAI 格式）生成回答，支持：
- **流式输出**（SSE），实时显示生成进度
- **思考模型支持**（自动识别 `mimo`/`reasoning` 模型，调整 temperature）
- **多轮对话**：基于 session 管理上下文，支持追问、指代消解

---

## 核心技术设计

### 双路径检索策略

简化路由体系，移除 LLM 智能路由，改为确定性规则：

```
有实体 → 结构化查询（返回上下文片段）
无实体 → RRF 混合检索（向量+BM25）
```

**优势**：
- **稳定性**：无 LLM 依赖，路由决策零延迟
- **可预测性**：查询结果完全由实体匹配决定
- **一致性**：相同查询始终走相同路径

### 多路召回 + RRF 融合

单一检索方式各有局限：
- **向量检索**：语义相关性好，但精确术语召回弱
- **BM25**：精确术语匹配强，但无法捕捉语义相关性

RRF 融合兼顾两者优势，k=60 平滑参数防止排名差异过大影响融合结果。

### 实体上下文提取

对于长文档（≥3000 token），只提取实体周围 ±200 token 的上下文片段：
- 最多 3 个片段/文档
- 重叠区间自动合并
- 短文档（<3000 token）注入全文

### @node-rs/jieba 自定义词典

内置 80+ 业务术语（客户企业、技术组件、部门、业务系统），最高优先级 100，确保专业词汇不被错误切分。例如：
- `Kubernetes` 不被切成 `Kuber`、`netes`
- `国家电网` 不被切成 `国家`、`电网`

### 数据分层存储

| 存储类型 | 数据内容 | 用途 |
|---------|---------|------|
| LanceDB | 文档块向量（1024维） | 向量检索 |
| BM25 倒排索引 | 分词后的词项→文档映射 | BM25 检索 |
| SQLite `struct_kb.db` | 实体/概念 → chunk 关联 | 结构化查询 |
| chunks_meta | 文档块元数据（内容、标题、wikiLinks） | 上下文提取 |

**Wiki 文档特殊处理**：`Wiki/concept/` 和 `Wiki/entity/` 目录下的文件**不切分为 chunk**，只存储在 SQLite 数据库中作为词条定义，检索时通过 Raw 文档中的 wikiLinks 关联召回。

---

## 快速开始

```bash
# 1. 安装依赖
cd llm-wiki
npm install

# 2. 构建索引（首次必须运行）
npm run index:full

# 3. 启动开发服务器
npm run dev

# 4. 访问 http://localhost:3000
```

---

## 环境配置

复制 `.env` 为 `.env.local`，配置 LLM API：

```env
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.xiaomimimo.com/v1
LLM_MODEL=mimo-v2.5

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
│   ├── buildIndex.cjs         # 全量索引构建（文档解析→分块→Embedding→存储）
│   ├── buildIncremental.cjs   # 增量索引构建
│   └── buildStructDb.cjs      # 结构化数据库构建（概念/实体→文档关联）
├── src/
│   ├── app/
│   │   ├── page.tsx           # 首页仪表盘
│   │   ├── chat/page.tsx      # AI 问答页（多轮对话 + 流式输出）
│   │   └── api/
│   │       ├── search/        # 混合检索 API
│   │       └── chat/          # RAG 问答 API (SSE)
│   ├── lib/
│   │   ├── types.ts           # 统一类型定义
│   │   ├── tokenizer.ts       # jieba 分词 + 业务自定义词典
│   │   ├── embedding.ts        # DashScope Embedding API 调用
│   │   ├── vectorEngine.ts    # LanceDB 向量检索引擎
│   │   ├── bm25Engine.ts      # BM25 倒排索引引擎
│   │   ├── hybridSearch.ts    # 混合检索 + RRF 融合
│   │   ├── entityRouter.ts    # 实体路由（提取关键字 + 结构化查询）
│   │   ├── structSearchEngine.ts  # SQLite 结构化检索引擎
│   │   ├── ragEngine.ts       # RAG 生成引擎（OpenAI 兼容 API）
│   │   └── indexManager.ts    # 索引管理器
│   └── data/                  # 预构建索引数据（git 追踪）
│       ├── lancedb/           # LanceDB 向量数据库
│       ├── bm25/             # BM25 倒排索引分片
│       ├── chunks_meta/       # 文档块元数据
│       ├── parents/           # 父子文档关系
│       └── struct_kb.db       # SQLite 结构化知识库
└── test/                      # 单元测试（vitest，178 个测试用例）
    ├── tokenizer.test.ts
    ├── hybridSearch.test.ts
    ├── entityRouter.test.ts
    └── sessionManager.test.ts
```

---

## 技术栈

- **前端**: Next.js 16 + React 19 + Tailwind CSS 4
- **分词**: @node-rs/jieba（结巴分词 Rust 实现，支持业务自定义词典）
- **向量**: 1024维 DashScope `text-embedding-v4` + LanceDB IVF_PQ 索引 + 余弦相似度
- **BM25**: 纯 JS 倒排索引实现（@node-rs/jieba 分词）
- **LLM**: OpenAI 兼容 API（流式 SSE 输出，支持思考模型）
- **向量数据库**: LanceDB（本地文件存储，支持增量索引）
- **结构化数据**: SQLite（词条 → 关联文档映射）
- **测试**: Vitest（178 个测试用例）
