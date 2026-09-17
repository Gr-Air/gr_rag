# Spec 001: 统一分块逻辑 ×3

> 创建日期：2026-06-08
> 状态：**implemented**
> 关联 Issue：`[MULTI] 分块逻辑三套独立维护`
> 实施日期：2026-06-09

---

## 1. 动机

项目存在三套独立维护的分块逻辑：

| 位置 | 文件 | 环境 |
|------|------|------|
| A | `src/lib/parser.ts` | Next.js runtime (TypeScript) |
| B | `scripts/buildIndex.cjs` | Node.js 全量构建 (CJS) |
| C | `scripts/buildIncremental.cjs` | Node.js 增量构建 (CJS) |

三套代码逻辑一致但独立维护，任何改动需要改三处，容易遗漏。此外，`parser.ts` 的 `chunkIndex` 存在跨 section 重复的 bug。

---

## 2. 行为契约

### 2.1 正常路径

| 输入 | 预期输出 |
|------|---------|
| Markdown 文档，按 `##` 分块 | `DocChunk[]`，每个 chunk 含 `chunkId`、`content`、`section`、`docTitle` |
| 文档含 `---` 分隔符 | 按 `##` + `---` 分割 |
| 文档含 wikiLinks (`[[link]]`) | 提取到 `chunk.wikiLinks` |

### 2.2 边界条件

| 输入 | 预期输出 |
|------|---------|
| 空文档 | 空数组 `[]` |
| 仅含标题无正文 | 标题作为 chunk 内容 |
| 超长段落（无 `##`） | 按 `maxChunkSize` 切分，带 `overlapChars` 重叠 |
| 代码块内含 `##` | 不被误分割（代码块保护） |

### 2.3 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| 文件编码异常 | 跳过该文件，继续处理其余文件 |
| 内存不足（超大文档） | 按 `maxChunkSize` 限制单 chunk 大小 |

---

## 3. 验收标准

- [x] `scripts/lib/chunker.cjs` 被 `buildIndex.cjs` 和 `buildIncremental.cjs` 共同引用
- [x] `parser.ts` 的 `chunkDocument()` 调用共享分块逻辑
- [x] 全量构建生成与旧逻辑一致的 chunk 数据
- [x] 增量构建生成与旧逻辑一致的 chunk 数据
- [x] `parser.ts` 的 `chunkIndex` 跨 section 重复 bug 已修复
- [x] `buildIndex.cjs` 代码量从 570 行缩减到 239 行 (-58%)
- [x] `buildIncremental.cjs` 代码量从 842 行缩减到 511 行 (-39%)

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `scripts/lib/chunker.cjs` | `chunkMarkdown()`, `splitByHeading()`, `extractWikiLinks()` | 新增 |
| `scripts/lib/scanner.cjs` | `scanDocuments()` | 新增 |
| `scripts/lib/tokenizer.cjs` | jieba 分词封装 | 新增 |
| `scripts/lib/embedder.cjs` | DashScope Embedding 调用 | 新增 |
| `scripts/lib/hasher.cjs` | MD5 文件 hash | 新增 |
| `scripts/lib/indexWriter.cjs` | LanceDB/BM25/chunks_meta 写入 | 新增 |
| `scripts/lib/envLoader.cjs` | 环境变量加载 | 新增 |
| `scripts/buildIndex.cjs` | 全量构建入口 | 修改（引用公共模块） |
| `scripts/buildIncremental.cjs` | 增量构建入口 | 修改（引用公共模块） |
| `src/lib/parser.ts` | `chunkDocument()` | 修改（调用共享 chunker） |

---

## 5. 兼容影响

### 5.1 公开 API 变更

无。`parser.ts` 的导出接口不变。

### 5.2 数据格式变更

无。chunk 数据格式（chunkId、content、section 结构）保持不变。

### 5.3 下游调用方

| 调用方 | 影响 |
|--------|------|
| `parser.ts` → API stats/docs | 无（内部实现变更，接口不变） |
| `buildIndex.cjs` | 引用公共模块，输出格式不变 |
| `buildIncremental.cjs` | 引用公共模块，输出格式不变 |

---

## 6. 降级策略

- 旧构建脚本逻辑已完全替换为公共模块引用，无回退需要
- 如需回退，git revert 即可

---

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|--------|---------|
| （构建脚本属于 CLI 入口，按 AGENTS.md 约定不强制测试） | — | 通过全量/增量构建回归验证 |
