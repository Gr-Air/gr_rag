# 星辰Wiki（llm-wiki）RAG 后端 —— 面试讲解稿

> 代码库里大部分模块头部写着「移植自 `src/xxx.ts`」「Spec 038 P0~P4」，
> 说明这是**一个 TypeScript / Next.js 版 RAG 系统的 Python 重写版（只搬了服务端）**。
> 这是你自我介绍时要先讲清楚的第一句话——诚实交代来源，然后重点讲**你在移植之上做的工程改造**。

---

## 一、30 秒电梯陈述（背下来）

> 「我做的是一个**企业内部项目文档知识库的混合检索 RAG 问答系统**，叫星辰Wiki。
> 后端 FastAPI + Python 3.12，向量库 LanceDB，中文检索用 jieba + 自研 BM25，
> 另有一张 SQLite 结构化表存 Wiki 词条和词条↔chunk 的关联。
> 检索层是**三路召回 + RRF 融合 + 实体干预 + 云端 Rerank**，
> 上层是带**会话记忆、追问识别、LLM 查询改写、双层语义缓存**的问答服务，
> 用 SSE 流式把『方法标记 / 检索结果 / 逐字回答』推给前端。
> 在 TS→Python 移植过程中我还独立完成了几件工程改造：**消除隐式依赖、修复词条读取死路径、
> 统一分块口径、把检索线程池改为进程级复用、让仓库具备开箱可演示能力**，
> 并保证 **342 个测试全绿**。」

**规模事实**（可被追问，务必准确）：

| 项 | 数值 |
|---|---|
| 服务端代码 | 55 个文件 / 6370 行 |
| 测试代码 | 25 个文件 / 5563 行 |
| 测试用例 | **342 个，全部通过**（`pytest -q`，冷启动约 20 秒 / 热缓存 1.8 秒） |
| 对外接口 | `POST /api/chat`(SSE)、`GET /api/search`、`POST /api/eval`、`GET /api/stats`、`GET /health` |
| 示例知识库 | `Raw/` 3 篇文档 + `Wiki/` 9 个词条，**不配任何 API Key 即可演示** |

---

## 二、技术栈（为什么选它）

| 层 | 选型 | 面试话术要点 |
|---|---|---|
| Web 框架 | FastAPI + uvicorn | 同步 `def` 路由交给 Starlette 线程池，避免阻塞事件循环；SSE 用 `StreamingResponse` |
| 数据校验 | Pydantic v2 + pydantic-settings | 请求/响应 DTO 与前端契约字段名逐字对齐（`topK`/`apiKey`/`sessionId`）；配置统一从 Settings 读，业务代码不直接读 env |
| 向量库 | **LanceDB** + pyarrow | 嵌入式列存，无需单独部署服务；`create_index(IVF_PQ, metric=cosine)`；无索引时降级为 Arrow→numpy 向量化暴力检索 |
| 关键词检索 | **自研 BM25**（纯 Python） | 不引入 ES/Lucene，倒排索引入落成 JSON 分片 |
| 分词 | jieba + 98 行业务自定义词典 | 索引侧与查询侧**共用同一实现**（历史上 Node 有两份词典，是踩过的坑） |
| 结构化库 | SQLite（只读 URI + WAL） | 两表 `entries` / `entry_chunks`，做实体精确路由 |
| LLM / Embedding / Rerank | DashScope（阿里云百炼）OpenAI 兼容 | `qwen3.7-max` 生成、`text-embedding-v4`（1024 维）、`qwen3-rerank` 重排 |
| HTTP | httpx | **全部直连 OpenAI 兼容 HTTP 接口，不依赖任何厂商 SDK**（依赖最小化、异常与降级全可控） |
| 测试 | pytest + pytest-asyncio | `asyncio_mode=auto`、`pythonpath=.` |

---

## 三、分层架构（面试必讲，这是加分项）

代码里没有 `application/domain/infrastructure` 目录名，但**依赖方向严格是 Clean Architecture**：

```
routers/          ← Presentation：只做 参数校验 / 错误码 / SSE 帧映射，零业务逻辑
  ↓ (调 bootstrap)
rag/bootstrap.py  ← Composition Root：唯一 new 出具体引擎的地方，懒加载单例
  ↓
rag/chat/*        ← Application Use Case：chat_service / eval_service / rag_engine / query_rewriter
rag/retrieve/*    ← Application + Domain：pipeline / fusion / assembler / entity_search + 纯规则函数
rag/retrieve/engines/* ← Infrastructure：LanceDB / BM25 / SQLite / Embedding
indexing/*        ← 离线索引流水线（CLI，不在 HTTP 进程里跑）
```

关键设计点：

1. **Composition Root 单一入口**：`bootstrap._build()` 是唯一 import 引擎具体类的地方，用一个 dict 组装依赖（`chunk_store / retrievers / fusion / struct_retriever / llm / smart_rewriter / hybrid_search / rag_chat_stream`），对外只暴露 `get_chat_service()` / `get_entity_search()` / `get_eval_service()`。
   - 好处：测试可 `_reset_for_test()` 重置，也可直接构造 fake 依赖，所以 342 个测试几乎零 mock 框架依赖。
2. **Port/Adapter 用鸭子类型**：`EntitySearchDeps` 里的 `struct_query` 只要求有 `is_ready()` / `query(names, mode)`，传 SQLite 实现或内存假实现都行。
3. **降级点都在最里层吞异常并打日志**，不往上抛——所以 `pipeline.py` 里单路检索失败返回 `[]`，其余照跑。

---

## 四、离线索引流水线（`indexing/`）

**入口**：`python -m server.indexing.cli full [--dry-run]` / `python -m server.indexing.cli struct`

### 4.1 四阶段

```
[1/4] 扫描 Raw/*.md + Wiki/{concept,entity}/*.md  →  表格感知语义分块
[2/4] Embedding（DashScope，批大小 10）→ 写 LanceDB chunks 表 + IVF_PQ 索引
[3/4] 倒排索引 → BM25 分片 / chunks_meta 分片 / parents.json / vectors/config.json
[4/4] 提示单独跑 struct 子命令 → 生成 struct_kb.db
最后：index_state.json（增量快照）+ index_manifest.json（版本清单）
```

### 4.2 分块器（`chunker.py`，263 行，最值得讲的算法）

「表格感知 + 语义分块」，参数 `min=200 / max=1000 字符`：

1. 按 `^## ` 粗切成 section；
2. section 内按段落切，**表格行（`|` 开头 `|` 结尾）是不可分割单元**，表格中间的空行不会打断表格；
3. 非表格段落再按句子边界切（`。！？` 后 或 英文句号+空格+大写）；
4. 单元合并成 chunk：超 `max` 且已达 `min` 就切，并**按完整单元向前做 10% 重叠**（`round((min+max)/2*0.1)` ≈ 60 字符），重叠时**跳过表格**以免把表格切碎；
5. **超过 max 的表格单独成 chunk，且表格行完整保留**（有测试覆盖）；
6. 最后**合并过短的相邻 chunk**（任一侧 < min 就合并），合并后**重排 `chunk_index` 但 chunk id 不变**（注释明确写了「历史行为，勿改」——为保持索引幂等/缓存不失效而刻意保留）。

其它：
- 从文件名解析 `{客户}_{项目系统}_{文档类型}_{日期}.md` 生成 4 个 metadata 字段，**这 4 个字段既进 LanceDB 独立列、也进 metadata 字典**，是后面「LLM 推荐 docType → 白名单过滤」的基础；
- 每个 chunk 额外抽 `[[wikiLinks]]` 双链，存 `wiki_links`；
- 每个 chunk 挂 `parent_doc_id = parent_{docId}`，并在 `parents.json` 里反向记录 `childChunkIds` → **父子文档结构，用于回溯全文**。

### 4.3 落盘产物（能被问到「你的存储长什么样」）

| 路径 | 内容 | 作用 |
|---|---|---|
| `lancedb/chunks.lance` | id/docId/docTitle/docPath/chunkIndex/content(截断 3000)/vector/metadata_*4/wikiLinks/parentDocId | 向量召回 |
| `bm25/shard_*.json` + `meta.json` + `doc_lengths.json` | 词项 → `[{chunkId, tf}]` | BM25 召回 |
| `chunks_meta/shard_*.json` + `config.json` | chunkId → 完整元数据 | ChunkStore，回填/倒排/上下文 |
| `parents/parents.json` | docId → {标题, 路径, metadata, childChunkIds} | 父子回溯 |
| `vectors/config.json` | totalChunks / dim / engine / indexType | 就绪校验 |
| `struct_kb.db` | `entries` + `entry_chunks` 两表 | 实体路由 |
| `index_state.json` | 文件 key → md5 | 增量构建判定 |
| `index_manifest.json` | indexVersion / gitCommit / builtAt / 各 store ready 状态 | **索引版本号，缓存失效的依据** |

`manifest` 的设计值得单独讲：
- **原子写**（写 `.tmp` 再 `os.replace`），中断不会损坏；
- 必需 store（lancedb/bm25/chunksMeta/parents）任一缺失就**拒绝写 manifest**（保留旧版本，`raise RuntimeError`），保证「要么整体成功，要么保留旧版本」；
- `builtAt` 被检索缓存当作 `kbVersion`，**索引一重建缓存整体失效**。

### 4.4 结构化库（`structdb.py`）

- 词条来源：`Wiki/concept/*.md` 和 `Wiki/entity/*.md`（正则抽分类、`出现频次: N`、定义）；
- 关联边来源：遍历 `chunks_meta` 的 `wikiLinks`，`link` 命中词条名就建 `(entry_id, chunk_id, context[:200])`；
- 建库时**连 `-wal`/`-shm` 一起删**再重建（注释：避免旧 WAL 回放，是 Python 版相对 Node 版的改进）；
- 注释里明确「Node 版的 LLM 实体提取在生产库零产出（3729 个词条 source 全是 wiki），属死路径，本次不移植」——**一个「我做过死代码清理」的例子**。

---

## 五、在线检索内核（`rag/retrieve/`）★ 重点

### 5.1 固定编排（`pipeline.py`）

```python
run_search_pipeline:
  1. 宽泛查询识别 → 动态 topK（adjust_topk_for_broad_query）
  2. 非实体查询：vector_top_n / bm25_top_n 各 ×2 放大召回
  3. 进程级共享线程池并行跑各路 Retriever（单路异常 → []）
  4. filteredChunkIds 白名单过滤（来自 LLM 推荐的 docType）
  5. 全空提前返回；否则 RRFFusion.fuse(...)
```

- 活动路约定顺序 `[vector, bm25]`，`profile.use_struct=True` 时**追加第三路 struct**；
- 融合 top_k 也放大：实体查询 `top_k`，非实体查询 `top_k * 3`（先粗排后精排）。

### 5.2 三路召回

| Retriever | 底层 | 输出分数 |
|---|---|---|
| `VectorRetriever` | LanceDB `.search(vec).metric("cosine")`，`score = 1 - _distance` | `scores.vector` |
| `BM25Retriever` | 自研倒排 + BM25 | `scores.bm25` |
| `StructRetriever` | SQLite `entry_chunks`，分数取词条 `frequency` | `scores.struct`，`source="entity"` |

**BM25 公式**（可以被要求手写，务必记牢）：
```
idf   = ln(1 + (N - df + 0.5) / (df + 0.5))
score = idf * tf*(k1+1) / (tf + k1*(1 - b + b*docLen/avgDocLen))
k1 = 1.5, b = 0.75
```
- 索引侧 `tokenize_all_filtered`（**过滤停用词 + 保留词频算 TF**），查询侧 `tokenize_filtered`（**过滤停用词 + 去重保序**），**两侧同口径**——这是不漏召的前提；
- 停用词表在索引与查询两侧同时生效，`docLen` 因此只计实词，长度归一化更准；表里除「的/了/在」等虚词外，**也包含「系统/功能/模块/部分」**（高频通用词 IDF 本就极低，一并过滤省倒排空间）；
- 缺 `docLen` 回落到 `avgDocLen`；遍历所有分片按 token 累加 postings。

**无向量索引时的降级**（`_brute_force_search`）：`table.to_arrow()` 取列 → `FixedSizeList` 展平为 `(n, dim)` 矩阵 → `numpy` 一次性算完全部余弦，`argsort(kind="stable")` 取 top_k。若向量列结构不规整则退回逐行纯 Python 计算。**不使用 pandas**（依赖最小化），范数为 0 的行记 0 分，与逐行实现语义一致。

### 5.3 RRF 融合（`fusion.py`）★ 核心亮点

```python
RRF(d) = Σ_path 1 / (k + rank_path(d))，k = 60
```

但**不是教科书 RRF**，有三处工程化改造：

1. **分数链路不覆盖只追加**：`Scores` 有 `vector/bm25/rrf/rerank/struct` 五个槽位，`Ranks` 记三路 1-based 排名。融合时一路的分不会覆盖另一路，最终一起透出给前端（`scores_to_dict` 丢弃 `None`，对齐 TS 的 `JSON.stringify` 省略 `undefined`）。
2. **实体过滤只作用于向量路**：`build_vector_entity_filter` 把「内容里不含任何匹配实体词」的向量命中标出来，这些 chunk **保留原始分、但跳过它的向量排名贡献**（`effective_rank` 不递增，`ranks.vector` 缺省）。动机：向量检索对短实体词（如 "ERP"）容易漂移，用内容包含关系做硬约束，又不完全丢弃候选。
3. **`effective_rank` 连续计数**：被过滤条目跳过后，后面的排名是**连续**的，避免排名空洞导致 RRF 分值不连续。

### 5.4 Assembler（`assembler.py`）五步

```
1. chunk 附着（ChunkStore.get_by_ids 批量取，保序去未命中）
2. 文档聚合：按 docId 归并，每文档最多 5 个 chunk（实体查询只留 1 个），
   且跳过「首行标题相同」的重复 chunk
3. 排序 + 截断：按 rrf 降序，实体查询截 top_k，非实体截 top_k*2
4. 归一化：min-max 映射到 0.05 ~ 0.95（max==min 时给 0.5），
   _round4 用 floor(x*10000+0.5)/10000 对齐 JS 的 Math.round（不是 Python 的银行家舍入）
5. 高亮：定位首个查询字符命中位置取 300 字符窗口，按空格切词加粗（只替换每词首个命中，
   对齐 JS 无 g 标志的 String.replace）
```
- `source` 推导：只有向量命中 → `vector`；只有 BM25 命中 → `bm25`；两者都有 → `hybrid`。前端据此显示来源标签。

### 5.5 实体路由（`entity_search.py`，374 行，全仓最大文件）

```
query → 字典最大匹配 extract_matching_keywords（长词优先 + 全局包含）
  ├─ 无匹配 → RRF 混合检索（method="rrf"）
  └─ 有匹配 → recall_entity_chunks（chat 与 /api/search 共用的唯一实体路实现）
       1) struct 库查询：多实体"优先 AND 精准"（避免 "ERP" 短词误匹配）→ 无 chunk 降级 OR
       2) struct 不可用/仍无命中 → 用 chunks_meta 的 wikiLinks 建**内存倒排索引**兜底
       3) 每个命中 chunk 抽实体上下文（±200 字符、每实体≤3 处、区间合并）+ 实体高亮
  └─ 实体路**只返回实体命中的 chunk**，不用语义检索结果回填：
       auto 路由召回为空 → 降级 RRF（method="rrf"）；?method=entity 强制时如实返回空
```

- `keyword_matcher.py` 是纯领域函数：**贪心最大匹配**（避免 "中国银行" 被切成 "中国"+"银行"）+ 全局包含匹配（处理非连续出现），末尾按长度降序稳定排序。注释特别说明「用 dict 保插入序，因为 Python set 是哈希序，而 TS 的 Set 是插入序」——**「为行为对齐而刻意选择数据结构」的细节，面试讲出来很加分**。
- `decompose_entity`：LLM 抽出未知实体时，分解成包含它的已知实体，解决同义词/简称问题。
- `is_ready()` 懒加载 + 内存缓存实体字典与倒排索引。

### 5.6 检索缓存（`cache.py`）★ 双层缓存

- **LRU 200 条**（`OrderedDict` + `move_to_end`）；
- **两级匹配**：① 精确 key `query|kbVersion|policyVersion|sorted(entities)`；② 同 `kbVersion`/`policyVersion` 下 query embedding **余弦 ≥ 0.92** 取最相似；
- **两个版本号做失效**：`kbVersion` = `index_manifest.builtAt`（索引重建即整体清空）；`policyVersion`（`"v1"`）→ 检索规则一改分区失效，不用重启；
- 只缓存 **hybridSearch 的输出（pre-rerank）**，不缓存 rerank 后结果；
- 读写 `try/except` 吞异常降级，**缓存挂了不影响主流程**；
- 配套 `prewarm_query_embedding`：写缓存时顺手把 query 向量塞进 embedding 缓存，**一次请求只调一次 Embedding**。

---

## 六、问答链路（`rag/chat/`）★ 业务编排

### 6.1 `chat_service.py` 完整时序（让画流程图就画这个）

```
POST /api/chat (SSE)
 └ chat_service.chat(query, options)
    1. get_or_create_session(session_id)
    2. 异步触发 compress_conversation（daemon thread，不阻塞本次请求）
    3. 取对话历史 history_text（在写入本轮 user 消息之前取）
    4. add_message(user)
    5. smart_rewriter.rewrite(query, previous_query=上一轮query)
         → 一次 LLM 调用同时产出：改写后的 query + 实体 + intent + relevantDocTypes + isFollowUp
         → LLM 不可用/输出非法 JSON → 降级：字典匹配 + 本地正则规则
    6. 非追问 且 走了 LLM 改写 → 取 query embedding → cache.lookup
    7. 追问 → 拼 enriched_query = `[上文: 用户之前问"X"] Y`
    8. 有实体 → entity_search.recall_entity_chunks（struct → chunk 上下文片段，与 /api/search 同一实现）
       命中则 method="entity"，结果作为 preSearchResults 下传（进 context 事件 + 参与 Rerank），跳过语义检索
       否则 → cache 命中？用缓存 : hybridSearch（带 docType 过滤）→ 写缓存 + prewarm
    9. save_last_search_results（供下一轮追问）
   10. yield ChatMethodEvent（method / rewriteMethod / matchedKeywords / rewrittenQuery）
       → yield ChatContextEvent(results)（pre-rerank 全量）
       → yield ChatTokenEvent(...) 逐字
       → yield ChatDoneEvent 并把完整回答写入会话
```

**LLM 一次调用做三件事（改写 + 实体抽取 + 路由决策）** 是核心设计：省一次 LLM 往返、保证决策一致性。`build_rewrite_prompt` 动态注入已知实体分类样本（客户企业/技术组件/项目系统/人员/部门/概念各取若干），要求严格输出 JSON，用 `re.search(r"\{.*\}")` 容错解析。

### 6.2 实体召回（`entity_search.recall_entity_chunks`）

- 多实体**优先 AND 精准**（避免 "ERP" 短词误匹配），无结果降级 OR；struct 不可用/仍无命中 → `chunks_meta` 的 wikiLinks 倒排兜底；
- 返回 **chunk 上下文片段**（`_extract_entity_context`：每个实体匹配点取 ±200 字、每实体最多 3 处、重叠区间合并），**含 Wiki 词条 chunk**，并标实体高亮；
- **只返回实体命中的 chunk**，不用语义检索结果回填：auto 路由召回为空降级 RRF（`method="rrf"`），`?method=entity` 强制时如实返回空；
- chat 与 `/api/search` **共用这一实现**，结果作为 `preSearchResults` 下传——所以实体路的结果同样会进 `context` 事件（前端可见来源与分数）、同样参与 Rerank；
- `entity_docs.py` 现在只剩 **`/api/eval` 的 Raw 全文注入**变体（短文档 <3000 token 全文；长文档 `extract_entity_snippets` 围绕实体取 ±200 token 片段、每篇最多 3 个、按实体密度排序），chat 的 `load_entity_docs_content` 变体已删除。

**为什么从「Raw 全文」改成「chunk 片段」**：全文给 LLM 的上下文更完整，但体积不可控（多篇 ×3000 token）、每次要读磁盘、且只覆盖 `raw_` 文档——纯概念词条（如 CRM）查过去会因拿不到 Raw 文档而**整体降级为语义检索**。chunk 召回体积可控、覆盖 Wiki 词条、能算分能重排，代价是长文档的通读能力变弱。

### 6.3 生成（`rag_engine.py`）

```
[可选] hybridSearch → yield context 事件（pre-rerank 全量，前端可见）
→ Rerank（仅用于 LLM prompt，不改回传前端的 context！）
→ 拼 prompt（### 文档 i: 标题 (客户|项目|类型|日期) + 内容，按 score 降序，`---` 分隔）
→ llm.stream(...) 逐 token yield
→ 无 LLM → yield no-llm 事件（**不产出 done**，前端据此走「只展示检索结果」模式）
→ 异常 → yield error 事件
```
- 「**Rerank 只影响 prompt、不改前端展示**」是刻意的：前端展示召回全貌（可解释、可评估），Rerank 只服务让 LLM 看到最相关的 5 条，职责分离。
- 三套 prompt 模板：`followup`（带对话历史）/ `compare`（要求表格）/ `base`，由 `is_follow_up` 和 `intent` 选择；system prompt 明确要求「上下文没有就回答知识库暂无相关信息，不要编造」。

### 6.4 会话（`sessions.py`）

- 进程内 `dict`，`sess_{base36时间戳}_{8位随机}`；
- **30 分钟 TTL**；TS 用 `setInterval` 定时清理，Python 版改成**惰性清理**（create/get/count 时顺带扫一遍）——省一个后台线程；
- 最多保留 10 条消息，**消息数 ≥ 6 时异步触发 LLM 压缩**：把除最后 2 条外的历史压成 ≤200 字摘要，只保留最后 2 条原文；
- `is_follow_up_query`：10 条中文正则（「那个/这个/它」「详细说说」「然后呢」「就这些？」…）作为 LLM 路由失败的兜底。

### 6.5 SSE 契约（`routers/_sse.py`）

- 帧格式 `data: {json}\n\n`；
- **`ensure_ascii=False` + `separators=(",", ":")` 紧凑分隔符**，注释写明「与 TS 端 `JSON.stringify` 的线上帧逐字节一致」——**前端零改动兼容**，这是移植项目的核心约束；
- 事件类型 6 种：`method` / `context` / `token` / `no-llm` / `error` / `done`；DTO 用 Pydantic 定义，`model_dump(exclude_none=True)` 对齐 TS 省略 `undefined` 的行为。

### 6.6 Eval（`rag/eval/eval_service.py`）

- 与 chat 的差异：**无 session / 无缓存 / 无追问 / 无对话历史**，用于离线批量评测；
- 多一层「**企业实体门禁**」：只有匹配到的实体同时满足 `type == "entity"` 且名字命中客户企业正则才走结构化检索；
- 输出 `answer / contexts / sources / searchMethod / numResults / matchedEntities / profileId / resultScores`——**含逐条分数链路，可直接算 recall@k、MRR、命中率**。

### 6.7 检索 Profile（A/B 实验开关，`profile.py`）

| profile | use_struct | use_entity_filter | vector_top_n | bm25_top_n | rerank_top_k |
|---|---|---|---|---|---|
| `baseline`（默认） | ✗ | ✓ | 20 | 20 | 5 |
| `struct` | ✓ | ✓ | 20 | 20 | 5 |
| `no_entity_filter` | ✗ | ✗ | 20 | 20 | 5 |

生产路径不传 profile → `resolve_profile(None)` 回落 baseline，**行为与改造前完全一致**；未知 id 也回落 baseline 而不是报错。

---

## 七、Rerank（`rerankers.py`）

- `qwen3-rerank`（DashScope compatible-api），`POST /reranks`，带 `top_n`；
- **相关性阈值 0.5**：低于阈值的直接丢弃，`rerank` 分写入 `scores.rerank`，**原始链路分数保留**；
- 结果不足 `top_n` 时，用未被 API 返回的索引**按原始分降序补足**（保证条数稳定）；
- 文档文本先还原 `[[wikiLink]]` 为纯文本，再取前 4000 字符；
- 无 `DASHSCOPE_API_KEY` → `NoopReranker`；条数 ≤ top_n 直接返回；API 异常 → 按原始分排序降级。

---

## 八、降级链路总表 ★（回答「健壮性怎么做的」直接背这个）

| 挂了什么 | 降级动作 | 代码位置 |
|---|---|---|
| LanceDB 索引缺失 | 打印提示返回 `[]`（其余路照跑） | `vector_engine._get_table` |
| 向量索引没建 | 自动切 **Arrow→numpy 向量化暴力余弦** | `vector_engine._brute_force_search` |
| 向量列结构不规整 | 再退化为逐行纯 Python 余弦 | `_brute_force_search_rowwise` |
| Embedding API 失败 | 跳过向量路，BM25 仍可用 | `vector_engine.search` |
| BM25 单路异常 | `[]`，继续融合 | `pipeline.search_with_fallback` |
| 全路为空 | 提前 return，不调 fusion | `pipeline` |
| StructDB 未构建/查询异常 | 落到 wikiLinks 内存倒排；再不足用 RRF 补 | `entity_search` |
| LLM 无 key | `NoopLlmClient` → RAG 出 `no-llm` 事件，只展示检索结果 | `llm_client.create_llm_client` |
| LLM 返回非 JSON / 空 | 降级字典匹配 + 本地正则路由（`method="fallback"`） | `query_rewriter.rewrite` |
| 对话压缩失败 | 静默返回 None，历史不压缩 | `sessions.compress_conversation` |
| Rerank 无 key / 超时 / 非 200 / 空结果 | 按原始分排序返回 | `rerankers` |
| 缓存读写异常 | 吞掉，等价于未命中 | `cache.lookup/save` |
| 索引未就绪 | HTTP **503** + 明确文案（不是 500） | `routers/*.py` |

**总结话术**：「设计原则是**降级发生在最靠近故障的那一层，且降级后结果仍然可用**，同时对用户可解释（no-llm 事件、503 文案），绝不把内层异常直接抛成 500。」

---

## 九、我做的工程改造 ★★（这部分是你的差异化，主动讲）

移植完成后我做了 5 项改造，全部有测试与实测验证。

### 改造 1：配置与路径自包含化（`config.py`）

**问题**：`PROJECT_ROOT = Path(__file__).resolve().parents[2]` 实测指向仓库的**上一级**（`/Users/gaorui/Desktop`），于是 `data_dir` / `raw_dir` / `wiki_dir` 全部落在仓库外且**三个目录都不存在** → clone 下来跑不通索引，也无法演示。

**改造**：
- `parents[2]` → `parents[1]`，修正为真正的仓库根；
- 三个目录默认改为仓库内 `Raw/` `Wiki/` `data/`，**clone 即自包含**；
- 顺手补上 `effective_api_key` / `effective_base_url` 属性，兼容 `LLM_API_KEY` 这类历史变量名；
- `.env.example` 逐项说明「不填某项会降级成什么」。

**效果**：实测 `PROJECT_ROOT=/Users/gaorui/Desktop/rag`，三个目录 `in_repo=True` 且 `Raw`/`Wiki` 已存在。

### 改造 2：消除隐式依赖（`vector_engine.py` + `requirements.txt`）

**问题**：`_brute_force_search` 里 `import pandas`，但 `requirements.txt` 没声明 pandas，实测环境里也确实缺失 → 这条降级路径实际会在 ImportError 后被吞掉，**永远返回空**。同时 `openai` 装在依赖里但代码全走 httpx 手写，是纯粹的依赖噪音。

**改造**：
- 把 pandas 实现换成 **`table.to_arrow()` → `FixedSizeList` 展平 → numpy 一次性矩阵运算**（`argsort(kind="stable")` 保持并列时的稳定顺序）；向量列结构不规整时退回逐行 Python；
- 删除 `requirements.txt` 里的 `openai`，并显式声明 `numpy` / `pyarrow`；
- 顺手更新模块 docstring。

**效果**：用真实 LanceDB 表（不建索引）实测，新实现与朴素逐行余弦的 top-3 与分数完全一致；仓库内已无任何 pandas/openai 引用。

### 改造 3：修复 Wiki 词条读取的死路径（`document_store.py`）

**问题**：`struct_kb.db` 里词条 `path` 存的是仓库相对路径 `Wiki/concept/x.md`，而 Store 的工作目录是 `WIKI_DIR`，直接拼接得到 `WIKI_DIR/Wiki/concept/x.md` **双前缀**，`read_wiki_doc` 永远返回 None → **「实体 HTML 全文注入」这条能力等于从未生效**（原版注释还写着「逐字保留此行为，勿修复」）。

**改造**：
- 在 Store 内做路径归一化：剥掉开头的 `Wiki/`（或与 `WIKI_DIR` 同名的首段）后再拼接，两种写法（`Wiki/concept/x.md` 与 `concept/x.md`）都能正确读取；
- 加**路径穿越防护**：`resolve()` 后必须仍在 `WIKI_DIR` 内，否则拒绝；
- 抽出 `_resolve_wiki_path`，把 R/W 逻辑收敛到一处。

**效果**：新增 2 个测试（带前缀可读、越界被拒），词条全文注入真正生效。

### 改造 4：统一分块口径（`kb_info.py`）

**问题**：`/api/stats` 用的是为对齐 TS 端而单独实现的一套**非表格感知**分块统计（`_semantic_chunk_count`），与索引实际使用的表格感知分块器**算法不同** → `totalChunks` 与真实索引块数对不上，属于「同一指标两套算法」的典型隐患。

**改造**：删掉重复实现（连同 3 个分块常量），改为直接复用 `indexing.chunker.chunk_document` 计数，`stats` 与索引**单一数据源**。

**效果**：`/api/stats` 的 `totalChunks` 现与 `cli full --dry-run` 输出一致（示例数据下都是 4）；新增「同源契约」测试 + 「超大表格不被切碎」测试。

### 改造 5：检索线程池进程级复用（`pipeline.py`）

**问题**：每次检索请求都 `with ThreadPoolExecutor(...)` 新建再销毁线程池，高并发下线程创建/销毁开销可观。

**改造**：提升为模块级共享池（`max_workers=4`、带 `thread_name_prefix`，便于排查），检索路是 I/O 密集（Embedding HTTP / 列存扫描 / SQLite 查询），复用线程即可；单路异常已在 `search_with_fallback` 内兜住，不会串扰其他请求。

### 附加：让仓库开箱可演示

补了 `Raw/`（3 篇文档，覆盖表格/双链/多层标题）与 `Wiki/`（3 个概念 + 6 个实体词条，含 `出现频次`、分类、定义），并加 `.env.example`。**不配任何 API Key 即可演示**：

```bash
python -m server.indexing.cli full --dry-run
#   ✅ 共 4 个文档块（3 Raw 文档，9 Wiki 词条）
#   min=455 max=951 avg=779
```

```bash
uvicorn server.main:app --port 8000
GET /health        → {"status":"ok","phase":"P0","version":"0.1.0"}
GET /api/stats     → totalDocs=3 totalChunks=4 totalConcepts=3
                     totalEntities=6 totalClients=3 totalDocTypes=3
```

（以上都是实际跑出来的数字，可以照原样复述。）

---

## 十、测试策略（342 个用例）

- 25 个测试文件，**基本与业务模块一一对应**（`test_chunker / test_fusion_hybrid / test_assembler / test_chat_service / test_entity_search / test_rag_engine / test_query_rewriter / test_cache / test_session_manager / test_structdb / test_struct_engine / test_profile / test_reranker / test_tokenizer / test_p0_contract ...`）；
- `test_p0_contract.py`（253 行）是**契约测试**：锁死 API 字段名、错误码、SSE 帧格式，保证「前端零改动」这一硬约束不被破坏；
- 大量测试是**纯函数测试**（分块、RRF、归一化、关键词匹配、高亮、token 估算），不 mock 网络——这是把领域逻辑抽成纯函数换来的收益；
- 改造过程中我补的测试：`test_chunk_count_same_source_as_index`（口径同源）、`test_oversized_table_kept_intact`（表格不被切碎）、`test_read_wiki_doc_with_repo_relative_prefix`、`test_read_wiki_doc_rejects_path_escape`（路径归一化 + 越界防护）、`test_entity_search.py`（实体路统一后的 AND/OR 降级、wiki chunk 召回、force_method 语义）；
- 有 `_reset_for_test()` / `_reset_chunk_store_for_test()` / `clear_all_sessions()` 这类测试钩子来重置全局单例。

---

## 十一、仍然存在的局限（主动交代，比被问出来好）

1. **进程内状态 → 只能单进程部署**：会话、检索缓存、embedding 缓存、BM25 分片缓存全是模块级单例/全局 dict，多 worker 会各存一份，缓存命中率与会话一致性都下降。生产要换成 Redis。
2. **全量加载进内存**：`ChunkStore` 懒加载**全部** chunks_meta；`entity_search` 还会构建全量 wikiLinks 倒排索引。文档量再上一个量级（>10 万 chunk）需要改分片索引（SQLite FTS / LanceDB 过滤），或按业务域切多个 KB。
3. **无鉴权、无会话隔离、无限流**：`session_id` 由客户端传，没有归属校验，也没做速率限制与配额。
4. **内容截断耦合常量**：`chunks_meta` 与 LanceDB 都把 content 截断到 3000 字符，单 chunk 上限 1000 字符所以目前安全，但两处常量是硬编码的耦合关系。
5. **检索缓存不覆盖 rerank 之后的结果**（有意为之，因为 rerank 与 prompt 长度相关），因此缓存只能省掉召回，不能省掉 rerank 调用。
6. **没有真实评测数据**：`/api/eval` 提供了完整的分数链路与 profile 分组，但仓库内没有标注评测集，效果数字需要在真实知识库上跑。
7. **前端不在本仓库**：这是纯服务端仓库，有 `/api/*` 契约但无页面；如需演示 UI 需自行接一个前端。

---

## 十二、高频追问 & 参考答法

**Q1：为什么 RRF 而不是加权求和？**
RRF 只用排名不用分数，天然免疫「向量余弦 0~1 / BM25 无上界」的量纲不一致，也不需要对每路调权重；k=60 让头部排名区分度平缓，抗单路噪声。代价是丢掉分数信息，所以我把各路原始分**并行保留在 `scores` 里**透出，既便于前端展示也便于离线分析——以后要做加权融合，原始分是现成的。

**Q2：实体过滤为什么只作用向量路，不动 BM25？**
BM25 本身就是词面匹配，命中实体词是它的强项，过滤没有意义；向量路才是「语义漂移」的来源，短实体名容易召回到语义近但没提该实体的 chunk。而且过滤是**只降权不删除**（保留原始分，仅不计排名贡献），避免硬过滤导致召回塌陷。

**Q3：为什么 rerank 结果不改前端展示？**
职责分离：前端 `context` 事件展示「系统召回了什么」（可解释、可评估），rerank 是为了让 **LLM 的 prompt 更短更准**（省 token、提准确率）。如果 rerank 也改前端，用户看到的召回和评测口径就不一致了。

**Q4：缓存怎么保证不串答案？**
三层约束：① key 带 `kbVersion`（索引 builtAt）——索引重建即整体失效；② key 带 `policyVersion`——检索规则变更时 bump，只失效对应分区；③ key 带 `sorted(entities)`——同 query 但实体集合不同不共享。语义匹配还要求候选条目两个版本号都相同。另外**追问和 fallback 路径不读写缓存**。

**Q5：chunk 大小怎么定的？为什么 200~1000？**
文档是企业 Markdown（含大量表格），1000 字符约中文 600~700 token，单条能装下一个完整小节；200 是「再小就没有检索价值」的下限，低于它的相邻块会被合并。开 10% 重叠防止答案被切断在边界。表格感知是必须的——一刀切会把表格拆成没有表头的残片，模型完全读不懂。

**Q6：一次问答要调多少次外部 API？**
最多 1 次 Embedding（索引期批 10 条）+ 1 次 LLM（改写/路由）+ 1 次 Rerank + 1 次 LLM 流式（生成）；压缩是异步的，缓存命中时 embedding 可复用（prewarm）。

**Q7：怎么评估效果？**
`/api/eval` 返回每条结果的完整分数链路 + answer + contexts，可跑批量评测集算命中率 / recall@k / MRR；`profile` 机制让「开/关 struct 路」「开/关实体过滤」变成可对比的实验分组。

**Q8：为什么用 SQLite 而不是 Neo4j 做实体关联？**
数据形态是「词条 → chunk」的两表关系（当前 3729 词条量级），SQLite 索引查询 + 嵌入式零运维就够；`entry_chunks` 上建了 `chunk_id` 索引做反向查询，AND 查询用集合交集（`common &= chunk_ids`）实现，复杂度可控。上图谱在这个规模不划算。

**Q9：移植项目最容易踩的坑是什么？**
三类：① **行为等价 vs 明显 bug 的取舍**——原版注释里有一堆「勿修复」，我是先把它们归类（真 bug / 有意为之的性能取舍 / 历史包袱），再只修确定是 bug 且影响能力的那个（词条读取死路径），其余保留并写清理由；② **隐式依赖**——JS 生态里 `pandas` 这种「环境恰好有」的依赖，在 Python 侧必须显式声明或彻底去掉；③ **语言差异导致的静默行为不一致**——比如 JS 的 `Math.round` 是「四舍五入」而 Python 的 `round` 是银行家舍入、TS 的 `Set` 保插入序而 Python `set` 是哈希序，这些都用显式实现或换数据结构对齐了。

**Q10：如果让你继续优化，下一步做什么？**
按 ROI 排：① 把会话与检索缓存外置到 Redis，解开单进程限制；② `ChunkStore` 改分片按需加载 + 实体倒排落 SQLite FTS，把内存占用打下来；③ 建离线评测集，用 `profile` 机制先把「实体过滤」和「struct 路」的收益量化出来，再有依据地调 RRF 的 k 与 rerank 阈值；④ 给 `/api/chat` 加鉴权、配额与限流。

---

## 十三、一页速记（面试前 5 分钟看这个）

```
定位：企业内部项目文档知识库 RAG 问答（FastAPI + LanceDB + 自研 BM25 + SQLite），
      由 TS/Next.js 版移植而来，只含服务端；342 测试全绿。
结构：routers(Presentation) → bootstrap(Composition Root) → chat/*(Use Case) → retrieve/*+engines(核心/Infra)
索引：扫描 → 表格感知分块(200~1000,+10%重叠,表格不切碎) → Embedding(1024) → LanceDB(IVF_PQ/cosine)
      → BM25 倒排分片 → chunks_meta/parents/vectors → struct_kb.db → manifest(原子写+版本号)
检索：宽泛查询收敛 topK=3；非实体查询召回×2；三路并行（进程级共享线程池）→ 实体过滤向量排名
      → RRF(k=60, effective_rank 连续) → 文档聚合(每篇≤5) → 归一化 0.05~0.95
路由：字典匹配 → struct AND优先→OR → 上下文抽取(±200 字符/每实体≤3) → wikiLinks 倒排兜底（只返回实体命中 chunk）
生成：LLM 一次调用做「改写+实体抽取+路由决策」→ 缓存(精确+余弦≥0.92) → 实体 chunk 片段注入
      → rerank(阈值 0.5, 仅影响 prompt) → 三套 prompt 模板 → SSE 六类事件逐字流式
降级：13 条降级链路，全部「就近降级、结果仍可用」，索引未就绪返 503 而非 500
改造：① 路径自包含(parents[1] + 仓库内 Raw/Wiki/data) ② 去隐式依赖(Arrow+numpy 取代 pandas，删 openai)
      ③ 修词条读取死路径(路径归一化+越界防护) ④ 统一分块口径(与索引同源)
      ⑤ 线程池进程级复用 ⑥ 补示例知识库，无 API Key 可演示
局限：单进程（全局单例）、全量内存加载、无鉴权限流、无标注评测集、无前端
```
