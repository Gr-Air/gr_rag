# [DESIGN] 简化路由为两条路径

## 状态

- 状态：`implemented`
- 创建日期：2026-07-03
- 作者：AI Agent

## 概述

将当前复杂的四级路由体系（entity/structured/hybrid/rrf）简化为两条路径：

1. **有实体匹配** → 结构化查询，返回包含实体的上下文片段（±200 token）
2. **无实体匹配** → RRF 混合检索（向量+BM25）

## 行为契约

### 输入

```typescript
interface RoutedSearchResult {
  results: SearchResult[];
  method: 'entity' | 'rrf';
  matchedKeywords?: string[];
  structSummary?: string;
}
```

### 输出

- **有实体**：返回结构化查询到的文档中包含实体的上下文片段
- **无实体**：返回 RRF 融合检索结果

### 边界条件

- 实体上下文提取：±200 token，最多 3 个片段，重叠区间合并
- 实体召回不足时，用 RRF 补充

## 实现锚点

- `src/lib/entityRouter.ts`：重写 `routedSearch()` 和 `entityRecall()`
- 删除 `forceSearch()` 中的 structured/hybrid 分支

## 兼容影响

- `method` 类型从 `'rrf' | 'entity' | 'structured' | 'hybrid'` 简化为 `'rrf' | 'entity'`
- 移除 LLM 智能路由决策（不再调用 queryRewriter）

## 验收标准

- [ ] 有实体时，返回包含实体上下文的文档片段
- [ ] 无实体时，返回 RRF 检索结果
- [ ] 测试通过（178 个测试）
