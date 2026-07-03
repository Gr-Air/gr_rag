# Spec 009: 结构化查询修复（API 500 错误）

> 创建日期：2026-07-01
> 状态：**implemented**
> 关联 Issue：`[BUG] executeStructuredQuery 传入查询字符串而非实体数组`
> 实施日期：2026-07-01

---

## 1. 动机

`executeStructuredQuery()` 函数期望接收实体数组，但调用方传入了查询字符串，导致 API 500 错误。同时需要增加 `matched.length > 0` 检查，避免空实体列表调用。

---

## 2. 行为契约

### 2.1 正常路径

| 输入 | 预期输出 |
|------|---------|
| `matched` 实体数组（非空） | 调用 `executeStructuredQuery(matched)` 成功 |
| `matched` 实体数组（空） | 跳过结构化查询，走 RRF 混合检索 |
| 查询字符串 | 不直接传给结构化查询 |

### 2.2 边界条件

| 输入 | 预期输出 |
|------|---------|
| 部分实体匹配 | 只传匹配到的实体 |
| 无实体匹配 | 正常回退到 RRF 检索 |
| 实体格式异常 | 过滤无效实体，只传有效实体 |

### 2.3 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| `matched` 为 undefined | 视为空数组，跳过结构化查询 |
| `executeStructuredQuery` 抛出异常 | 捕获异常，回退到 RRF 检索 |

---

## 3. 验收标准

- [x] `src/app/api/chat/route.ts` 中将 `executeStructuredQuery(trimmedQuery)` 改为 `executeStructuredQuery(matched)`
- [x] 添加 `matched.length > 0` 检查
- [x] `src/app/api/eval/route.ts` 同步相同修复
- [x] API 500 错误不再出现
- [x] 实体匹配时正确走结构化查询路径

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `src/app/api/chat/route.ts` | 结构化查询调用 | 修改 |
| `src/app/api/eval/route.ts` | 结构化查询调用 | 修改 |

---

## 5. 兼容影响

### 5.1 公开 API 变更

无。修复内部调用参数错误。

### 5.2 数据格式变更

无。

### 5.3 下游调用方

| 调用方 | 影响 |
|--------|------|
| 前端 Chat 页面 | 无影响（自动获得正确的检索结果） |
| RAGAS 评估脚本 | 无影响（自动获得正确的评估结果） |

---

## 6. 降级策略

- 如需回退，git revert 即可

---

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|--------|---------|
| （API Route Handler 的集成行为按 AGENTS.md 约定不强制测试） | — | 通过手动测试验证 |