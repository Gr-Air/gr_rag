# Spec 018: Wiki 文档不再切分为 Chunk

> 创建日期：2026-07-03
> 状态：**implemented**
> 关联 Issue：`[DESIGN] Wiki 文档只存 SQLite 不切分 chunk`

---

## 1. 动机

当前构建索引流水线将 `Wiki/concept/` 和 `Wiki/entity/` 目录下的所有 .md 文件都切分为 chunk 存入 LanceDB，这导致：

1. **语义污染**：Wiki 概念/实体词条（如"项目管理"、"华润置地"）作为独立 chunk 参与向量检索和 BM25 检索，与原始文档混合在一起，降低检索精度
2. **冗余存储**：Wiki 词条已经通过 SQLite 的 `entries` 表存储（供结构化查询使用），再存为 chunk 属于重复存储
3. **检索策略冲突**：Wiki 词条的语义信息适合用于实体匹配和概念扩展，但不适合作为上下文片段参与语义检索

变更目标：`Wiki/concept/` 和 `Wiki/entity/` 只存储到 SQLite，不再生成 chunk。

## 2. 行为契约

### 2.1 正常路径

| 输入 | 预期输出 |
|------|---------|
| `generateAllChunks()` 调用 | 仅从 `Raw/` 目录生成 chunk，不处理 `Wiki/concept/` 和 `Wiki/entity/` |
| `buildIndex.ts` 执行 | SQLite 正常写入 entries，LanceDB 仅包含 raw_ 前缀的 chunk |

### 2.2 边界条件

| 输入 | 预期输出 |
|------|---------|
| Wiki 目录不存在 | 跳过，不影响构建流程 |
| Wiki 目录为空 | 跳过，不影响构建流程 |
| 部分 Wiki 文件解析失败 | 记录错误，继续处理其他文件 |

### 2.3 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| Wiki 文件读取失败 | 记录错误日志，继续处理下一个文件 |
| SQLite 写入失败 | 终止构建并报告错误 |

## 3. 验收标准

- [ ] `generateAllChunks()` 不再遍历 `Wiki/concept/` 和 `Wiki/entity/` 目录
- [ ] `buildIndex.ts` 中 Wiki 词条仅写入 SQLite，不生成 chunk
- [ ] 重新构建索引后，`chunks_meta` 中不再包含 `wiki_` 前缀的 chunk ID
- [ ] 结构化查询功能正常（通过 SQLite 查询）
- [ ] 混合检索功能正常（仅使用 Raw 文档的 chunk）

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `scripts/buildIndex.ts` | `generateAllChunks()` 第 157-181 行 | 删除 |
| `scripts/buildIndex.ts` | `main()` 函数中 wiki 处理逻辑 | 修改 |
| `src/lib/hybridSearch.ts` | Wiki 文档权重加成逻辑（第 268-294 行） | 删除 |

## 5. 兼容影响

### 5.1 公开 API 变更

| API | 变更类型 | 迁移方式 |
|-----|---------|---------|
| 无 | 无破坏性 | N/A |

### 5.2 数据格式变更

- LanceDB 索引：删除所有 `wiki_` 前缀的 chunk
- SQLite：保持不变，继续存储概念和实体词条

### 5.3 下游调用方

| 调用方 | 影响 |
|--------|------|
| `entityRouter.ts` | 不受影响（从 SQLite 读取） |
| `queryRewriter.ts` | 不受影响（从 SQLite 读取） |
| `hybridSearch.ts` | 删除 Wiki 权重加成逻辑 |
| `structSearchEngine.ts` | 不受影响（从 SQLite 读取） |

## 6. 降级策略

无，此变更是清理冗余逻辑，不涉及功能替代。

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|--------|---------|
| `test/buildIndex.test.ts` | 3 | Wiki 目录处理、chunk 生成过滤、索引构建完整性 |
| `test/hybridSearch.test.ts` | 1 | 混合检索不包含 wiki_ 文档 |
