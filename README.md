# 星辰Wiki - 企业知识库智能检索系统

基于 **RAG + 混合检索** 的企业内部项目文档智能知识库。

**后端为 Python 实现**（`python-server/`），前端沿用 Next.js（`src/`）。

## 技术架构全景

```
用户查询
    │
    ├── ① LLM 智能改写 ──── 查询改写 + 实体提取 + docType 推荐
    │                      (Agently .output() 结构化输出，6 字段 schema)
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

### ① LLM 智能改写层（`server/rag/chat/query_rewriter.py`）

**目标**：一次 LLM 调用同时完成查询改写、实体提取和文档类型推荐。

通过 **Agently 框架**（OpenAI 兼容端点，`qwen3.7-max`）对用户查询进行：

- **查询改写**：补全隐含实体、术语标准化、同义词展开
- **实体提取**：从 SQLite 加载 3700+ 实体词条作为参考，精准提取（支持实体分解——未知实体拆解为已知实体组合）
- **追问检测**：识别指代消解、省略追问、纠错否定等
- **文档类型推荐**：输出 `relevantDocTypes`，用于无实体命中时缩小 hybridSearch 检索范围

改写结果通过 **Agently `.output(schema)` 结构化输出**获取：6 字段 schema（`rewritten / entities / intent / relevantDocTypes / isFollowUp / reason`），`get_data(ensure_keys=...)` 自动校验字段完整性并在缺失时重试（最多 3 次），替代手写正则捞 JSON + `json.loads` + 字段兜底。

LLM 不可用时降级为 jieba 分词 + 字典匹配（`server/rag/retrieve/keyword_matcher.py`）。

### ② 实体文档加载（`server/rag/chat/entity_docs.py` + `server/rag/retrieve/entity_search.py`）

**目标**：当查询匹配到实体时，直接加载关联文档的完整内容。

流程：
1. **AND-first 查询**：多实体时优先 AND 精准匹配（避免短词如 "ERP" 匹配到无关文档），AND 无结果时降级 OR
2. **短文档（<3000 token）**：全文注入
3. **长文档（≥3000 token）**：提取实体关键字周围 ±200 token 的片段，最多 3 个片段/文档，重叠区间合并（`server/rag/retrieve/snippets.py`）
4. 同时加载 Wiki 词条内容作为补充上下文

### ② RRF 混合检索（`server/rag/retrieve/hybrid_search.py` + `pipeline.py`）

当实体匹配和索引查询均无结果时，降级为混合检索。LLM 推荐的 `relevantDocTypes` 用于 post-filter 收窄检索范围。

双路并行召回（`ThreadPoolExecutor`，I/O 密集），结果通过 **RRF（Reciprocal Rank Fusion）** 融合：

```
RRF(d) = Σ 1/(k + rank_i(d))，k = 60
```

| 检索通路 | 技术方案 | 召回量 |
|---------|---------|-------|
| 向量检索 | DashScope `text-embedding-v4`，1024维，余弦相似度，LanceDB IVF_PQ 索引 | top20 |
| BM25 检索 | jieba 分词（Python 实现 + 自定义词典），JSON 分片倒排索引 | top20 |

融合后经 Rerank 重排序，取 top5 文档块供 LLM 生成使用。无 LLM 时降级为检索结果直接展示。

> Wiki 概念/实体短词条不参与语义索引（仅通过 SQLite struct DB 在实体路径中发挥作用），索引只包含 1036 个 Raw 文档 chunk。

### ③ Rerank 语义重排序（`server/rag/retrieve/rerankers.py`）

对 RRF 融合结果进行语义相关性精排（DashScope `qwen3-rerank`，阈值 0.5，API 失败降级按原始分排序），取 top5 进入 LLM prompt。chunk 采用字符级语义分块（上限 1000 字符，表格作为整体保留），每个 chunk 已包含完整段落或表格，无需额外上下文扩展。

### ④ RAG 生成层（`server/rag/chat/rag_engine.py` + `prompt_template.py`）

通过 `PromptTemplate` 管理多场景提示词模板（基础问答、追问、对比分析、查询改写），将检索结果拼入 prompt，调用 LLM 生成回答：
- **流式输出**（SSE），实时显示生成进度（`server/routers/_sse.py`）
- **LLM 请求层走 Agently**：`server/rag/chat/llm_client.py` 把 OpenAI messages 映射为 Agently 请求链（`.system()` / `set_chat_history()` / `.input()`），RAG 回答走 `get_generator(type="delta")` 流式产出
- **实体文档增强**：结构化文档内容优先于语义检索结果
- **多轮对话**：基于 session 管理上下文（`sessions.py`，消息数 ≥6 时异步 LLM 压缩为摘要），支持追问、指代消解
- **检索结果缓存**：进程内 LRU 语义缓存（`server/rag/retrieve/cache.py`），缓存 hybridSearch 输出的 `SearchResult[]`，两级匹配（精确 key + COSINE ≥ 0.92 语义近似）；kbVersion + policyVersion 感知，索引重建自动失效
- **LLM 降级**：无 API Key 时 LlmClient 返回 NoopLlmClient，RAG 引擎 yield `no-llm` 事件，前端生成文档汇总展示

---

## 核心技术设计

### 两条检索路径

| 路径 | 触发条件 | 数据源 | 特点 |
|------|---------|---------|------|
| entity | 查询匹配到实体词条 | SQLite struct_kb.db → Raw 全文/片段 | 精确匹配，全量注入 |
| rrf | 无实体命中 | LanceDB(1036) + BM25(1036) → docType 过滤 → Rerank top5 | 语义理解，docType 收窄范围 |

### 后端分层架构（python-server/）

代码按依赖方向分层，依赖只能自上而下，Infrastructure 反向实现上层定义的抽象（Port），由 `server/rag/bootstrap.py` 组装注入：

```
Routers (server/routers)        # HTTP/SSE/DTO/错误映射，只依赖 bootstrap 组装的 Use Case
    ↓
Use Case 编排 (server/rag/chat, server/rag/retrieve)   # chat_service / rag_engine / hybrid_search / entity_search
    ↓
领域模型与规则 (server/rag/types.py, retrieve/entity_strategy.py, snippets.py)  # 纯类型 + 纯函数，零基础设施依赖
    ↑
基础设施引擎 (server/rag/retrieve/engines/)  # 全部技术实现（LanceDB/BM25/SQLite/Embedding/jieba）
    ↑
组装根 (server/rag/bootstrap.py)  # 唯一允许实例化引擎并注入 Use Case 的位置
```

```
python-server/
├── server/
│   ├── main.py                 # FastAPI 入口 + CORS
│   ├── config.py               # pydantic-settings 配置（.env）
│   ├── schemas.py              # 请求/响应 DTO
│   ├── routers/                # chat(SSE) / search / stats / eval
│   ├── rag/
│   │   ├── bootstrap.py        # 组装根：构建全部引擎 + Use Case + LLM 客户端
│   │   ├── types.py            # RetrievalHit / SearchResult / SearchQuery / Scores / Ranks 等领域类型
│   │   ├── chat/               # 应用层 Use Case
│   │   │   ├── chat_service.py #   会话 + 改写 + 路由 + 检索 + 生成总编排
│   │   │   ├── rag_engine.py   #   RAG 生成引擎（SSE 事件流）
│   │   │   ├── llm_client.py   #   Agently LLM 客户端（complete/stream，NoopLlmClient 降级）
│   │   │   ├── query_rewriter.py #  查询改写（Agently .output() 结构化输出）
│   │   │   ├── prompt_template.py # 多场景提示词模板
│   │   │   ├── sessions.py    #   会话管理（多轮历史 + LLM 压缩 + 30min TTL）
│   │   │   ├── entity_docs.py #   实体文档加载
│   │   │   └── document_store.py # 文档文件读取
│   │   ├── retrieve/          # 检索领域
│   │   │   ├── hybrid_search.py #  RRF 混合检索 Use Case
│   │   │   ├── entity_search.py #  实体路由检索 Use Case
│   │   │   ├── pipeline.py     #   检索管线（并行召回 → 过滤 → 融合）
│   │   │   ├── retrievers.py  #   Vector/BM25/Struct Retriever（统一 RetrievalHit 输出）
│   │   │   ├── fusion.py      #   RRF 融合（k=60，实体过滤仅作用向量路）
│   │   │   ├── rerankers.py   #   QwenReranker / NoopReranker
│   │   │   ├── assembler.py   #   RetrievalHit → SearchResult（附着/聚合/归一化/高亮）
│   │   │   ├── cache.py       #   检索结果 LRU 语义缓存
│   │   │   ├── entity_strategy.py # 纯领域规则（宽泛查询/动态 topK/高亮/向量过滤标记）
│   │   │   ├── snippets.py    #   实体上下文片段提取（密度排序 top-N）
│   │   │   ├── keyword_matcher.py # 字典最大匹配实体抽取
│   │   │   ├── profile.py     #   检索配置（baseline 等）
│   │   │   └── engines/       #   基础设施引擎
│   │   │       ├── vector_engine.py  # LanceDB 向量检索（IVF_PQ 余弦）
│   │   │       ├── bm25_engine.py    # BM25 引擎（读索引分片 JSON）
│   │   │       ├── struct_engine.py  # SQLite 结构化查询
│   │   │       ├── embedding.py       # DashScope Embedding 客户端
│   │   │       ├── tokenizer.py       # jieba 分词 + 业务词典（索引/查询唯一真源）
│   │   │       └── chunk_store.py    # chunk 元数据批量加载
│   │   └── eval/eval_service.py # 评测编排
│   ├── indexing/              # 索引构建（CLI）
│   │   ├── cli.py             #   python -m server.indexing.cli full/struct
│   │   ├── chunker.py         #   表格感知语义分块
│   │   ├── scanner.py / hasher.py / writer.py / manifest.py / structdb.py
│   └── kb/kb_info.py          # 知识库统计
├── tests/                     # pytest 测试（25 个文件）
├── pytest.ini  requirements.txt
├── Raw/  Wiki/  docs/         # 知识库数据（本地保留，不入库）
```

### 检索管线

检索流程抽象为三个角色（实现于 `server/rag/retrieve/`），管线编排固定在 `pipeline.py`，实现由 bootstrap 注入：

- **Retriever**：`VectorRetriever` / `BM25Retriever` / `StructRetriever`，统一 `search(query, options) → RetrievalHit[]`
- **Fusion**：`RRFFusion` 实现 RRF 融合，接收 `QueryAnalysis`（实体过滤，仅作用于向量路）
- **Reranker**：`QwenReranker`（核心）/ `NoopReranker`（降级），按 API key 自动选择

管线数据流：

```
hybrid_search(query, options)
  → 构建 RetrievalRequest { query: SearchQuery, analysis: QueryAnalysis, filter: RetrievalFilter }
  → pipeline：[Vector, BM25] 线程池并行召回（单路失败降级空结果）
    → filteredChunkIds 过滤（docType 白名单）→ RRF 融合 → RetrievalHit[]
  → assembler：chunk 附着(ChunkStore) → 文档聚合 → 归一化 → 高亮 → SearchResult[]
```

非实体查询召回量翻倍（top40+top40），融合取 `top_k*3` 候选池，为 Rerank 精排留足空间；宽泛查询（"有哪些相关文档"等模式）动态下调 topK 避免单文档霸榜。

### 表格感知分块（`server/indexing/chunker.py`）

- 表格作为一个不可分割单元保留，不跨 chunk 切分
- 表格内空行不中断表格
- 超大表格（>1000 字符）单独成 chunk
- 跨 section 全局统一 chunkIndex，合并过短 chunk

### jieba 自定义词典（`server/rag/retrieve/engines/custom_words.txt`）

内置 80+ 业务术语（客户企业、技术组件、部门、业务系统），确保专业词汇不被错误切分。例如：
- `Kubernetes` 不被切成 `Kuber`、`netes`
- `国家电网` 不被切成 `国家`、`电网`

分词器为索引构建与运行时查询的**唯一真源**（`tokenizer.py`），停用词过滤两侧同口径，避免词项对不上静默漏召。

### 数据分层存储

| 存储类型 | 数据内容 | 用途 |
|---------|---------|------|
| LanceDB | 文档块向量（1024维，1036 chunk） | 向量检索 |
| BM25 倒排索引 | 分词后的词项→文档映射（1036 chunk，JSON 分片） | BM25 检索 |
| SQLite `struct_kb.db` | 实体/概念 → chunk 关联（3729 词条，32951 关联边） | 实体查询 |
| chunks_meta | 文档块元数据（1036 条，仅 Raw 文档） | 上下文提取 |
| `index_manifest.json` | 索引版本 + builtAt + gitCommit | 跨索引一致性 + 缓存失效感知 |

**Wiki 文档特殊处理**：`Wiki/concept/` 和 `Wiki/entity/` 词条不生成 chunk，Wiki 词条内容由 `entity_search.py` 编排、经 `document_store.py` 从文件系统直接读取，用于实体文档增强。

---

## 快速开始

```bash
# 1. 安装依赖
cd python-server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. 构建索引（首次必须运行，Raw/ Wiki/ 数据置于 python-server/ 下）
python -m server.indexing.cli full      # 全量重建（分块 + 向量化 + BM25 + SQLite）
python -m server.indexing.cli struct   # 仅重建结构化数据库

# 3. 配置环境变量
cp .env.example .env    # 填入 API Key（见下方环境配置）

# 4. 启动后端
uvicorn server.main:app --reload --port 8000

# 5. 运行测试
pytest
```

---

## 环境配置

在 `python-server/.env` 中配置 LLM API：

```env
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen3.7-max

# 向量 Embedding（必填）
DASHSCOPE_API_KEY=sk-xxx
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIM=1024
```

不配置 LLM 时，LlmClient 返回 NoopLlmClient，RAG 引擎 yield `no-llm` 事件，前端自动生成基于检索结果的文档汇总展示。

---

## 项目结构（仓库级）

```
gr_rag/
├── python-server/      # Python 版后端（本 README 技术架构部分）
│   ├── server/         # FastAPI + RAG 内核 + 索引构建
│   ├── tests/          # pytest 测试
│   ├── Raw/ Wiki/      # 知识库数据（本地保留，不入库）
│   └── pytest.ini  requirements.txt
├── src/                # Next.js 前端（仪表盘 / AI 问答 / 文档浏览 / 检索页）
├── scripts/  spec/     # 历史流水线脚本 + Spec 治理文档（TS 侧）
└── test/               # TS 侧历史测试
```

---

## 技术栈

- **后端框架**: Python 3.12 + FastAPI + Uvicorn + Pydantic v2（pydantic-settings 配置管理）
- **LLM 请求层**: **Agently 框架**（OpenAI 兼容端点，qwen3.7-max；`.output()` 结构化输出 + `get_generator(type="delta")` 流式 SSE）
- **分词**: jieba（结巴分词 Python 实现，业务自定义词典，索引/查询唯一真源）
- **向量**: 1024维 DashScope `text-embedding-v4` + LanceDB IVF_PQ 索引 + 余弦相似度（pyarrow + numpy）
- **BM25**: 纯 Python 倒排索引实现（jieba 分词，JSON 分片存储）
- **结构化数据**: SQLite（3729 词条 → 32951 关联边）
- **Rerank**: DashScope `qwen3-rerank`（httpx 直连，阈值 0.5，失败降级）
- **HTTP 客户端**: httpx（Embedding / Rerank 直连）
- **前端**: Next.js 16 + React 19 + Tailwind CSS 4
- **测试**: pytest（25 个测试文件，覆盖检索管线/融合/缓存/会话/改写/引擎全链路）
