// ============================================================
// 检索管线接口抽象（Spec 029）
// 刻意克制：不做配置驱动的策略注册表、不做策略选择开关，
// 接口只为可替换性和测试 mock 服务，管线组装固定于 pipeline.ts
// ============================================================

import { RetrievalHit, SearchResult } from '../types';

/** 贯穿管线的检索上下文：领域特定逻辑（实体过滤/加成）通过它传入，而非硬编码在融合算法中 */
export interface RetrievalContext {
  query: string;
  matchedKeywords?: string[];
  filteredChunkIds?: string[];
}

/** 检索器：一路召回（向量 / BM25 / 结构化），输出统一 RetrievalHit */
export interface Retriever {
  readonly name: 'vector' | 'bm25' | 'struct';
  search(ctx: RetrievalContext, topN: number): Promise<RetrievalHit[]>;
}

/** 融合器：合并多路召回结果 */
export interface Fusion {
  readonly name: string; // 'rrf'
  fuse(hitLists: RetrievalHit[][], ctx: RetrievalContext, topK: number): RetrievalHit[];
}

/**
 * 重排器：对最终检索结果做语义精排
 * 注：operates on SearchResult（rerank 由 ragEngine 调用侧持有，
 * 输入为含 chunk 的最终结果，而非管线中间态 RetrievalHit）
 */
export interface Reranker {
  readonly name: string; // 'qwen3-rerank' | 'noop'
  rerank(ctx: RetrievalContext, results: SearchResult[], topN: number): Promise<SearchResult[]>;
}
