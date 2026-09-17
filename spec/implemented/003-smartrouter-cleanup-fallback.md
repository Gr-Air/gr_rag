# Spec 003: smartRouter 死代码清理 + 正则降级合一

> 创建日期：2026-06-11
> 状态：**implemented**
> 关联 Issue：`[REFACTOR] smartRouter 改为 LLM 做意图识别，正则匹配做降级`
> 实施日期：2026-06-11

---

## 1. 动机

Spec 002（LLM 统一路由决策）完成后，`queryRewriter.smartRewrite()` 已经能通过一次 LLM 调用输出 `routeDecision`，但原路由模块 `smartRouter.ts` 的 `smartRoute()`（本地正则优先 → LLM 兜底）**没有被清理**，形成两套路由逻辑并存：

| 组件 | 状态 | 问题 |
|------|------|------|
| `smartRouter.smartRoute()` | 死代码 | chat/route.ts 从未调用 |
| `smartRouter.localRuleJudge()` | 死代码 | 正则规则仅在 smartRouter 内部使用 |
| `smartRouter.llmRouteJudge()` | 死代码 | smartRouter 自己的 LLM 调用，已被 queryRewriter 替代 |
| `smartRouter.STRUCTURED_PATTERNS` + `SEMANTIC_PATTERNS` | 待迁移 | 29 条正则规则仍有价值，应作为 LLM 降级策略 |
| `smartRouter.executeStructuredQuery()` + `formatStructResults()` | 活代码 | 被 chat/route 引用，但属于 structSearch 职责 |

同时，Spec #5 "硬编码路由规则覆盖增强" 识别了多处正则遗漏（`谁负责`、`有没有`、`介绍一下` 等），需要在迁移时一并补充。

**目标**：
1. 清除 smartRouter 死代码（~230 行）
2. 将正则规则迁移到 `queryRewriter.fallbackRoute()`，作为 LLM 降级策略
3. 将工具函数迁移到 `structSearchEngine`，消除跨模块依赖
4. 补充 spec 分析中识别的高频遗漏正则

---

## 2. 行为契约

### 2.1 正常路径

**LLM 可用时（主路径）**：

```
smartRewrite(query) → routeDecision 非 null
  ├── routeDecision.route → chat/route 直接使用
  ├── routeDecision.isFollowUp → chat/route 直接使用
  ├── routeDecision.contextWindow → ragEngine 直接使用
  └── routeDecision.indexSection → chat/route 直接使用
```

**LLM 不可用时（降级路径）**：

```
smartRewrite(query) → routeDecision === null
  └── chat/route.ts 各模块独立降级：
        ├── fallbackRoute(query, matchedEntries) → { route, matchedEntries, reason }
        │     ├── 无实体          → 'semantic'
        │     ├── 命中结构化正则  → 'structured'
        │     ├── 命中语义正则    → 'semantic'
        │     └── 有实体未命中    → 'hybrid'
        ├── isFollowUpQuery(query) → isFollowUp
        ├── adaptiveContextWindow(query) → contextWindow
        └── lookupIndexByQuery(query) → indexSection
```

### 2.2 fallbackRoute() 输入输出

```typescript
interface FallbackRouteResult {
  route: RouteDecision;           // 'structured' | 'semantic' | 'hybrid'
  matchedEntries: string[];       // 已匹配的词条列表
  reason: string;                 // 可读的决策原因（用于调试/日志）
}
```

| 输入 query | matchedEntries | 预期 route | 预期 reason |
|------------|:---:|------|------|
| "有哪些客户做了ERP项目" | ['ERP'] | `structured` | "匹配结构化模式" |
| "ERP是什么意思" | ['ERP'] | `semantic` | "匹配语义分析模式" |
| "徐峰负责哪些项目" | ['徐峰'] | `structured` | "匹配结构化模式（补充规则）" |
| "有没有关于微服务的文档" | ['微服务'] | `structured` | "匹配结构化模式（补充规则）" |
| "介绍一下微服务架构" | ['微服务'] | `semantic` | "匹配语义分析模式（补充规则）" |
| "ERP" | [] | `semantic` | "未匹配到任何已知实体" |
| "好" | [] | `semantic` | "未匹配到任何已知实体" |

### 2.3 边界条件

| 输入 | 预期输出 |
|------|---------|
| `matchedEntries` 为空数组 | `route = 'semantic'`，无实体走语义检索 |
| `matchedEntries` 有 1 个但 query 太短无法匹配任何模式 | `route = 'hybrid'`（有实体但无明确模式指示，走混合检索） |
| `matchedEntries` 有多个，query 命中结构化模式 | `route = 'structured'` |

### 2.4 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| `fallbackRoute` 内部正则异常 | 不可发生（纯同步正则，无 IO） |
| `executeStructuredQuery` DB 未就绪 | 返回空数组 `[]`，不影响下游 |
| `smartRouter` re-export 循环引用 | 不会发生（仅 re-export，无自身逻辑） |

---

## 3. 验收标准

- [x] `smartRouter.ts` 从 353 行精简至 15 行（纯 re-export）
- [x] `queryRewriter.ts` 新增 `fallbackRoute()` 函数
- [x] 33 条正则规则全部从 smartRouter 迁移至 queryRewriter（29 条原有 + 4 条补充）
- [x] 补充规则覆盖：`谁负责` / `有没有` / `介绍一下` 类
- [x] `structSearchEngine.ts` 新增 `executeStructuredQuery()` + `formatStructResults()`
- [x] `chat/route.ts` 引用路径更新：`smartRouter` → `structSearchEngine`
- [x] `chat/route.ts` 新增 `fallbackRoute` 降级调用
- [x] `chat/route.ts` SSE 元信息新增 `route`、`fallbackRouteReason` 字段
- [x] smartRouter 保留 re-export 兼容层（避免引用断裂）
- [x] 所有现有测试通过（116 tests, 6 files）
- [x] 新增 40 条 fallbackRoute 专项测试（37 条 queryRewriter + 3 条 smartRouter 兼容性）

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `src/lib/queryRewriter.ts` | 新增 `STRUCTURED_PATTERNS`（26条正则） | 新增 |
| `src/lib/queryRewriter.ts` | 新增 `SEMANTIC_PATTERNS`（12条正则） | 新增 |
| `src/lib/queryRewriter.ts` | 新增 `fallbackRoute()` 函数 | 新增 |
| `src/lib/queryRewriter.ts` | 新增 `FallbackRouteResult` 类型导出 | 新增 |
| `src/lib/structSearchEngine.ts` | 新增 `executeStructuredQuery()` | 新增（迁移） |
| `src/lib/structSearchEngine.ts` | 新增 `formatStructResults()` | 新增（迁移） |
| `src/lib/smartRouter.ts` | 删除 `smartRoute()`、`localRuleJudge()`、`llmRouteJudge()`、29 条正则 | 删除 |
| `src/lib/smartRouter.ts` | 改为纯 re-export `structSearchEngine` | 重写 |
| `src/app/api/chat/route.ts` | import 改从 `structSearchEngine` 引用 | 修改 |
| `src/app/api/chat/route.ts` | 新增 `fallbackRoute(trimmedQuery, matched)` 降级调用 | 新增 |
| `src/app/api/chat/route.ts` | SSE 元信息新增 `route`、`fallbackRouteReason` | 新增 |
| `test/queryRewriter.test.ts` | 新建，37 条测试覆盖 fallbackRoute 全场景 | 新增 |
| `test/smartRouter.test.ts` | 重写为 3 条兼容层测试 | 重写 |

---

## 5. 兼容影响

### 5.1 公开 API 变更

| API | 变更类型 | 迁移方式 |
|-----|---------|---------|
| `smartRouter.smartRoute()` | **删除** | 无人调用（死代码），无需迁移 |
| `smartRouter.localRuleJudge()` | **删除** | 无人调用，降级逻辑已迁移至 `fallbackRoute()` |
| `smartRouter.llmRouteJudge()` | **删除** | 无人调用，LLM 路由已在 `smartRewrite()` 中完成 |
| `smartRouter.executeStructuredQuery()` | **兼容保留** | 仍可从 smartRouter import，实际执行在 structSearchEngine |
| `smartRouter.formatStructResults()` | **兼容保留** | 同上 |
| `queryRewriter.fallbackRoute()` | **新增** | chat/route.ts 降级时调用 |

### 5.2 数据格式变更

无。

### 5.3 下游调用方

| 调用方 | 影响 |
|--------|------|
| `chat/route.ts` | 引用路径从 `smartRouter` 改为 `structSearchEngine`，新增 `fallbackRoute` 调用 |
| 其他从 `smartRouter` 引用的文件 | **无影响**（re-export 兼容层保留） |

---

## 6. 降级策略

### 整体降级链

```
LLM 调用（queryRewriter.smartRewrite）
  ├── 成功 → 使用 routeDecision（LLM 判断）✅ 主路径
  └── 失败 → routeDecision = null
        ├── fallbackRoute(query, entities) → route 降级  ← 本文变更
        ├── isFollowUpQuery(query) → isFollowUp 降级
        ├── adaptiveContextWindow(query) → contextWindow 降级
        └── lookupIndexByQuery(query) → indexSection 降级
```

### fallbackRoute 内部降级优先级

1. 无实体匹配 → `semantic`（保守策略）
2. 命中结构化正则 → `structured`
3. 命中语义正则 → `semantic`
4. 有实体但未命中正则 → `hybrid`（数据+语义混合）

### 正则规则来源

| 来源 | 数量 | 说明 |
|------|:---:|------|
| smartRouter 原有 STRUCTURED_PATTERNS | 22 条 | 文档列表、关联查询、统计数量等 |
| smartRouter 原有 SEMANTIC_PATTERNS | 11 条 | 解释、对比、推荐等 |
| 新增：谁负责/谁在做 | 2 条 | spec 分析识别的高频遗漏 |
| 新增：有没有/是否存在 | 2 条 | spec 分析识别的高频遗漏 |
| 新增：介绍一下/讲一下 | 1 条 | spec 分析识别的高频遗漏 |
| **合计** | **38 条** | |

> 注：smartRouter 原有 29 条正则中包含部分语义覆盖，迁移时重新分类为 STRUCTURED（26 条）和 SEMANTIC（12 条），总数 38 条。

---

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|:---:|------|
| `test/queryRewriter.test.ts`（新建） | 37 | fallbackRoute 结构化/语义/hybrid 路由、补充遗漏模式（谁负责/有没有/介绍一下）、边界条件（空实体、短查询）、reason 可读性、类型校验 |
| `test/smartRouter.test.ts`（重写） | 3 | 兼容层 re-export 验证（executeStructuredQuery、formatStructResults、StructSearchResult 类型） |
| 其他模块测试（不变） | 76 | sessionManager、ragEngine 等不受影响 |

**全量测试**：116 个用例，6 个文件，0 失败。

---

## 8. 收益

| 维度 | 变化 |
|------|------|
| 死代码消除 | smartRouter.ts -338 行（353→15） |
| 职责清晰 | 路由决策（LLM 主路径 + 正则降级）全部在 `queryRewriter.ts` |
| 覆盖增强 | 正则规则从 29 条增至 38 条，补 4 类高频遗漏 |
| LLM-first 落地 | 降级时不再走 smartRouter 自己的 LLM，回归统一的正则 fallback |
| 工具函数归位 | 结构化查询工具函数归属 `structSearchEngine`，不再跨模块依赖 |
| 零破坏性 | smartRouter 保留 re-export 兼容层，下游不受影响 |
