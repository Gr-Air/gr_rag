// ============================================================
// 检索管线接口（已迁移到 domain/search/types.ts，Phase 1）
// 此文件为 re-export 兼容层，供 lib/ 内未迁移的调用方使用
// Phase 2-7 迁移完成后删除此文件
// ============================================================

export type {
  SearchSource,
  SearchMethod,
  RetrievalHit,
  SearchResult,
  SearchQuery,
  QueryAnalysis,
  RetrievalFilter,
  RetrievalOptions,
  RetrievalRequest,
  Retriever,
  Fusion,
  Reranker,
} from '@/domain/search/types';
