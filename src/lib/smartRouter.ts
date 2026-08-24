// ============================================================
// smartRouter - 兼容层
//
// 原 smartRouter 的路由逻辑已统一到 queryRewriter.ts（LLM-first + 正则 fallback）。
// 结构化查询的工具函数已迁移到 structSearchEngine.ts。
// 本文件保留为兼容层，建议外部调用方直接引用 structSearchEngine。
// ============================================================

export {
  executeStructuredQuery,
} from './structSearchEngine';

// 保留类型导出（向后兼容）
export type { StructSearchResult } from './structSearchEngine';
