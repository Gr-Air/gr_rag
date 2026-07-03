# Spec 017: Context Recall 优化

> 创建日期：2026-07-01
> 状态：**implemented**（已实施）
> 核心问题：**两表结构变更后，Context Recall 从 0.5333 下降到 0.4667，需要优化实体文档加载策略**

---

## 1. 问题描述

### 评估结果对比

| 指标 | 两表结构前 | 两表结构后（优化前） | 优化后（50条） | Context Precision 专项优化后 | 变化 |
|------|-----------|---------------------|---------------|---------------------------|------|
| Context Recall | 0.5333 | 0.4667 | 0.5633 | **0.5450** | 保持 ✅ |
| Context Precision | 0.3531 | 0.4578 | 0.3271 | **0.4817** | **+47%** ✅✅ |
| Faithfulness | 0.9444 | nan | nan | nan | - |
| Answer Relevancy | nan | nan | 0.8691 | **0.8608** | 保持 ✅ |
| Chunk 级表格截断率 | - | 16.09% | 2.30% | **3.17%** | 保持 ✅ |

### 根因分析

1. **entityRouter.ts 文档加载策略问题**：
   - 旧三表结构中，`loadStructDocChunks` 基于 `entry_docs` 表获取文档列表
   - 新两表结构中，改为基于 `entry_chunks` 表获取 chunk，然后解析 docId
   - 部分实体关联的文档可能未被正确加载

2. **eval/route.ts 文档名解析问题**：
   - `chunk_id` 格式为 `raw_文档名_序号`，解析逻辑可能遗漏部分文档
   - Wiki 词条（`wiki_` 前缀）的文档无法在 Raw 目录找到

3. **RAGAS 评估工具兼容性问题**：
   - Faithfulness：LLM 返回 JSON 超出 max_tokens（3072）限制
   - Answer Relevancy：`OpenAIEmbeddings` 与百炼 API 不兼容

### 优化措施

| 措施 | 文件 | 效果 |
|------|------|------|
| Wiki 词条直接注入上下文 | entityRouter.ts | Context Recall 恢复 |
| 支持 `wiki_` 前缀文档解析 | eval/route.ts | Wiki 概念知识参与检索 |
| 自定义 DashScopeEmbeddings | evaluate.py | Answer Relevancy 正常评估 |
| 修复表格截断检测逻辑 | evaluate.py | 截断率从 16.09% 降至 3.17% |
| 实体匹配度评分 | hybridSearch.ts | 提升包含查询实体文档的优先级 |
| rerank 阈值调整（0.3→0.5） | reranker.ts | 过滤低相关度上下文 |
| topK 减少（5→3） | ragEngine.ts | 降低无关上下文概率 |
| Wiki 概念权重优化 | hybridSearch.ts | 仅包含查询实体的 Wiki 文档给予加成 |
| 查询类型识别+动态 topK | hybridSearch.ts | 宽泛查询使用更小的 topK |

---

## 2. 行为契约

### 正常路径

1. 用户查询包含实体 → 结构化查询命中 → 加载关联文档 → 返回精准结果
2. 短文档（< 3000 token）：全文注入
3. 长文档（≥ 3000 token）：提取实体关键字上下 ±200 token 片段

### 边界条件

1. 实体关联多个文档时，按频次排序优先加载
2. Wiki 概念词条直接作为上下文注入（无需读 Raw 目录）
3. chunk_id 解析需支持 `raw_` 和 `wiki_` 两种前缀

---

## 3. 验收标准

- [x] Context Recall ≥ 0.53（恢复到之前水平）✅ 0.5450（50条）
- [x] Context Precision ≥ 0.45 ✅ 0.4817（50条）
- [x] API `/api/eval` 对所有测试用例返回 200 ✅ 50/50
- [ ] Faithfulness 评估正常（解决 max_tokens 限制）⚠️ 待解决
- [x] Answer Relevancy 评估正常（解决 Embeddings 兼容性）✅ 0.8608
- [x] 表格截断检测逻辑修复 ✅ 截断率从 16.09% 降至 3.17%

---

## 4. 实现锚点

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/lib/entityRouter.ts` | 优化 `loadStructDocChunks`，支持 Wiki 词条直接注入 |
| `src/app/api/eval/route.ts` | 优化文档名解析，支持 `wiki_` 前缀 |
| `test/rag-eval/evaluate.py` | 解决 RAGAS 与百炼 API 兼容性问题 |

---

## 5. 兼容影响

- 无破坏性变更，仅优化内部逻辑
- API 接口保持不变

---

## 6. 降级策略

- 如果结构化数据库未就绪，自动降级为语义检索
- 如果 Wiki 词条文件不存在，跳过该词条的上下文注入