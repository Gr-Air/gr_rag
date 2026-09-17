# Spec 016: 概念类知识入库

> 创建日期：2026-07-01
> 状态：**implemented**
> 关联 Issue：`[BUG] 数据清洗加载pipeline缺少概念类知识入库功能`
> 实施日期：2026-07-01

---

## 1. 动机

数据清洗加载 pipeline（`clean-and-chunk.cjs`）存在以下问题：

1. **增量检测不完整**：仅检测 Raw 文档变更，未检测 Wiki 词条（概念/实体）的变更
2. **概念类知识缺失**：Wiki 目录下的 1910 个概念词条未被正确纳入索引流程
3. **检索覆盖率不足**：概念类查询（如 RAG、Kubernetes、Docker）缺少结构化定义文档支撑

---

## 2. 行为契约

### 2.1 正常路径

| 输入 | 预期输出 |
|------|---------|
| `Wiki/concept/` 目录下的概念词条 | 作为独立 chunk 进入 staging，docId 前缀 `wiki_` |
| `Wiki/entity/` 目录下的实体词条 | 作为独立 chunk 进入 staging，docId 前缀 `wiki_` |
| 增量模式下新增概念词条 | 检测到变更并纳入处理 |
| 概念词条含频次信息 | 保留频次元数据，用于后续过滤 |

### 2.2 边界条件

| 输入 | 预期输出 |
|------|---------|
| 空概念词条（仅标题） | 创建最小 chunk（标题 + 类型标识） |
| 超大概念文档 | 单 chunk 不超过 maxChunkSize，完整保留 |
| 概念词条不存在（文件被删除） | 增量检测标记为删除，索引中移除对应数据 |

### 2.3 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| Wiki 目录不存在 | 跳过 Wiki 处理，仅处理 Raw 文档 |
| 概念词条文件编码异常 | 跳过该词条，继续处理其余词条 |

---

## 3. 验收标准

- [x] `clean-and-chunk.cjs` 扫描阶段显示概念类和实体类数量
- [x] 增量模式支持检测 Wiki 词条（概念 + 实体）的新增/修改/删除
- [x] 概念词条直接入库，不调用 LLM 生成详细文档
- [x] 全量构建包含 3853 个 Wiki 词条（1910 概念 + 1943 实体）
- [x] Wiki 词条生成的 chunk 在检索时获得 WIKI_DOC_BOOST（1.3倍）加成
- [x] `build-from-staging.cjs` 正确处理概念类 chunk 的向量化和 BM25 索引

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `scripts/pipeline/clean-and-chunk.cjs` | CLI 参数解析（新增 `--min-frequency`） | 修改 |
| `scripts/pipeline/clean-and-chunk.cjs` | 增量检测逻辑（扩展到 Wiki 词条） | 修改 |
| `scripts/pipeline/clean-and-chunk.cjs` | 概念词条入库阶段（新增 Stage 2） | 修改 |
| `scripts/pipeline/clean-and-chunk.cjs` | 主流程（5阶段替代原4阶段） | 修改 |
| `scripts/lib/scanner.cjs` | `scanWikiEntries()` 返回 `type` 字段 | 已有 |
| `scripts/lib/chunker.cjs` | `buildWikiChunk()` 支持概念/实体类型 | 已有 |

---

## 5. 兼容影响

### 5.1 公开 API 变更

无。仅构建 pipeline 内部实现变更。

### 5.2 数据格式变更

| 数据结构 | 变更类型 |
|---------|---------|
| chunk.id | 新增 `wiki_` 前缀格式（如 `wiki_RAG`） |
| chunk.metadata.docType | 新增 `概念`/`实体` 类型标识 |
| chunk.parentDocId | Wiki 词条为 `undefined`（无父文档） |

### 5.3 下游调用方

| 调用方 | 影响 |
|--------|------|
| `build-from-staging.cjs` | 无影响（自动处理所有 staging chunk） |
| `buildIncremental.cjs` | 无影响（已支持 Wiki 词条增量） |
| `src/lib/hybridSearch.ts` | 已支持 `wiki_` 前缀文档的权重加成 |

---

## 6. 降级策略

- 可通过 `--no-augment-concepts` 参数跳过概念增强（当前默认为直接入库）
- 如需回退到仅处理 Raw 文档，修改 scanner 过滤逻辑即可

---

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|--------|---------|
| （构建脚本属于 CLI 入口，按 AGENTS.md 约定不强制测试） | — | 通过全量/增量构建回归验证 |

---

## 8. 执行结果

- 总 chunk 数：4889（110 Raw 文档分块 + 3853 Wiki 词条）
- 概念类：1910 个
- 实体类：1943 个
- BM25 词项：7915
- 向量索引：LanceDB IVF_PQ（4889 条记录，1024 维）