# Spec 002: LLM 统一路由决策

> 创建日期：2026-06-09
> 状态：**implemented**
> 关联 Issue：`[API] queryRewriter 扩展路由决策输出`
> 实施日期：2026-06-09

---

## 1. 动机

原先 `/api/chat` 的检索路由判断分散在 4 个独立模块中，共涉及 ~78 条硬编码正则/关键词规则：

| 模块 | 职责 | 规则数 |
|------|------|:---:|
| `isFollowUpQuery()` | 追问检测 | 10 条正则 |
| `smartRouter.localRuleJudge()` | 路由决策（structured/semantic/hybrid） | 28 条正则 |
| `indexLookup.lookupIndexByQuery()` | index.md 章节命中 | 65 关键词 |
| `adaptiveContextWindow()` | Small-to-Big 窗口大小 | 25 条正则 + LLM |

这些规则分散维护，覆盖不全（存在多类高优先级遗漏场景），且 `queryRewriter` 已经有一次 LLM 调用，可以复用。

---

## 2. 行为契约

### 2.1 正常路径

`smartRewrite(query, history)` 返回值新增 `routeDecision` 字段：

```typescript
interface LlmRouteDecision {
  isFollowUp: boolean;       // 是否为追问/纠错/反问
  route: "structured" | "semantic" | "hybrid";
  contextWindow: 1 | 2 | 3;  // Small-to-Big 窗口大小
  indexSection: string | null; // index.md 章节命中
}
```

### 2.2 边界条件

| 输入 | 预期输出 |
|------|---------|
| LLM 调用成功，返回完整 JSON | `routeDecision` 非 null，chat/route 使用 LLM 判断 |
| LLM 调用失败 / JSON 解析异常 | `routeDecision` 为 null，chat/route 回退到硬编码降级 |
| LLM 返回不完整字段 | 缺失字段按 null 处理，仅可用字段生效 |

### 2.3 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| LLM API 超时 | `routeDecision = null`，走硬编码降级 |
| LLM 返回非 JSON | `routeDecision = null`，走硬编码降级 |
| LLM 返回的 route 值非法 | `routeDecision.route` 按 null 处理，走 hybrid 降级 |

---

## 3. 验收标准

- [x] `queryRewriter.smartRewrite()` 返回值包含 `routeDecision` 字段
- [x] LLM prompt 扩展，一次调用输出 `isFollowUp`、`route`、`contextWindow`、`indexSection`
- [x] chat/route.ts 优先使用 `routeDecision`，为 null 时回退硬编码
- [x] `ragEngine` 支持 `contextWindowOverride` 参数，有值时跳过 `adaptiveContextWindow()`
- [x] 原有 4 个硬编码模块保留不删除（降级策略）
- [x] 零额外 LLM 调用（复用 `queryRewriter` 已有调用，token 增加约 50-100）
- [x] 所有现有测试通过（103 tests）

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `src/lib/queryRewriter.ts` | 新增 `LlmRouteDecision` 类型 | 新增 |
| `src/lib/queryRewriter.ts` | `smartRewrite()` 返回值新增 `routeDecision` | 修改 |
| `src/lib/queryRewriter.ts` | LLM prompt 扩展路由字段 | 修改 |
| `src/app/api/chat/route.ts` | 用 `routeDecision` 替代独立 `isFollowUpQuery()` / `lookupIndexByQuery()` 调用 | 修改 |
| `src/app/api/chat/route.ts` | fallback 保留硬编码逻辑 | 修改 |
| `src/lib/ragEngine.ts` | options 新增 `contextWindowOverride` | 修改 |

---

## 5. 兼容影响

### 5.1 公开 API 变更

| API | 变更类型 | 迁移方式 |
|-----|---------|---------|
| `smartRewrite()` 返回值 | 破坏性（新增字段） | 下游需处理 `routeDecision` 可能为 null |
| `ragEngine` options | 无破坏性（新增可选字段） | `contextWindowOverride` 可选，不传则行为不变 |

### 5.2 数据格式变更

无。

### 5.3 下游调用方

| 调用方 | 影响 |
|--------|------|
| `chat/route.ts` | 主调用方，已适配 |
| `ragEngine.ts` | 新增可选参数，向后兼容 |

---

## 6. 降级策略

LLM 调用失败或返回异常时，`routeDecision` 为 `null`，chat/route.ts 回退到原有硬编码：

- `isFollowUp` → 调用 `isFollowUpQuery()`（10 条正则）
- `indexSection` → 调用 `lookupIndexByQuery()`（关键词匹配）
- `contextWindow` → `ragEngine` 内部调用 `adaptiveContextWindow()`（25 条正则 + LLM）
- `route` → 有实体走 structured，无实体走 semantic

**原硬编码模块全部保留不删除**，仅在 `routeDecision === null` 时作为 fallback 触发。

---

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|--------|---------|
| `test/smartRouter.test.ts` | 27 | localRuleJudge 结构化/语义/hybrid 路由决策 |
| `test/sessionManager.test.ts` | 31 | isFollowUpQuery 追问检测 |
| （其他模块已有测试覆盖） | — | 全部 103 测试通过 |
