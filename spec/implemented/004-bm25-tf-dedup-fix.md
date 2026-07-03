# Spec 004: BM25 分词去重导致 TF 恒为 1 的修复

> 创建日期：2026-06-11
> 状态：**implemented**
> 关联 Issue：`[BUG] BM25 tokenize 使用 Set 去重导致 TF 始终为 1，削弱排序精度`
> 实施日期：2026-06-11

---

## 1. 动机

BM25 的核心公式依赖 **TF（词频）** 和 **文档长度归一化** 来区分文档的相关性等级。但在当前实现中，`tokenize()` 使用 `Set` 去重。索引构建时，每个词在同一个 chunk 中只会保留 1 次，导致：

| 问题 | 修复前 | 影响 |
|------|--------|------|
| `tf` 恒为 1 | `tokens` 已去重，`tfMap` 统计结果永为 1 | 词频区分度丧失，"微服务"出现 5 次和 1 次的 chunk 没有区别 |
| `docLength` 偏小 | `docLengths[id] = toekns.length` 统计的是唯一词数 | 长度归一化分量 `b × dl / avgdl` 失真，短文档和长文档无法正确区分 |
| `avgDocLen` 偏低 | 基于唯一词数计算 | 进一步放大长度归一化偏差 |

**目标**：将索引构建侧的分词改为不去重版本，保留真实词频和文档长度，不改动查询侧行为。

---

## 2. 行为契约

### 2.1 正常路径

**索引构建时（buildIndex / buildIncremental）**：

```
tokenizeAll(chunk.content) → 不去重的原始分词列表
  ├── tokens.length → 真实文档词数，写入 docLengths
  └── tfMap 统计 → 每个词的真实出现次数，写入倒排索引
```

**查询时（bm25Search）**：

```
tokenize(query) → 去重后的分词列表（行为不变）
```

### 2.2 边界条件

| 输入 | 预期输出 |
|------|---------|
| chunk 中同一词出现 3 次 | `tf = 3`，参与 BM25 词频饱和计算 |
| chunk 中同一词出现 1 次 | `tf = 1`，与之前行为一致 |
| chunk 总词数 500（去重后 200） | `docLength = 500`，正确反映文档大小 |
| 查询中同一词出现 2 次 | `tokenize()` 去重后只剩 1 次（无变化） |

### 2.3 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| `tokenizeAll()` 输入空字符串 | 返回 `[]`（与 `tokenize()` 一致） |
| jieba 词典未加载 | 与 `tokenize()` 共用同一个 Jieba 单例，行为一致 |

---

## 3. 验收标准

- [x] `tokenizeAll()` 返回不去重的分词结果
- [x] `buildIndex.cjs` 使用 `tokenizeAll()` 构建倒排索引
- [x] `buildIncremental.cjs` 使用 `tokenizeAll()` 构建倒排索引
- [x] `bm25Engine.ts` 查询侧仍使用去重的 `tokenize()`
- [x] 重建索引后 TF 不再恒为 1

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `scripts/lib/tokenizer.cjs` | 新增 `tokenizeAll()` | 新增 |
| `scripts/lib/tokenizer.cjs` | 导出新增 `tokenizeAll` | 修改 |
| `src/lib/tokenizer.ts` | 新增 `tokenizeAll()` | 新增 |
| `scripts/buildIndex.cjs` | L18: import 改为 `tokenizeAll` | 修改 |
| `scripts/buildIndex.cjs` | L161: `tokenize(c.content)` → `tokenizeAll(c.content)` | 修改 |
| `scripts/buildIncremental.cjs` | L26: import 改为 `tokenizeAll` | 修改 |
| `scripts/buildIncremental.cjs` | L292: `tokenize(chunk.content)` → `tokenizeAll(chunk.content)` | 修改 |

---

## 5. 兼容影响

### 5.1 公开 API 变更

| API | 变更类型 | 迁移方式 |
|-----|---------|---------|
| `tokenize()` | 无破坏性 | 行为不变（查询侧继续使用） |
| `tokenizeAll()` | 新增 | 仅索引构建脚本使用 |

### 5.2 数据格式变更

**BM25 倒排索引格式不变**（`shard_*.json` 结构不变）。`tf` 字段的值从恒为 1 变为实际频次，`doc_lengths.json` 中的值从唯一词数变为真实词数。

⚠️ **需要重建索引**：
```bash
node scripts/buildIndex.cjs
```

### 5.3 下游调用方

| 调用方 | 是否受影响 | 说明 |
|--------|-----------|------|
| `bm25Engine.ts` → `tokenize()` | ❌ 不受影响 | 查询侧继续使用去重的 `tokenize()` |
| `buildIndex.cjs` | ✅ 已修改 | 改用 `tokenizeAll()` |
| `buildIncremental.cjs` | ✅ 已修改 | 改用 `tokenizeAll()` |

---

## 6. 降级策略

无需降级。`tokenize()` 函数保持不变，查询侧检索逻辑不受任何影响。如果索引未重建，倒排索引中的 TF 仍为旧值（恒为 1），行为与修复前一致。
