// ============================================================
// 混合检索 Use Case（Application 层）
// 管线编排固定于 pipeline.ts（[向量, BM25] → RRF 融合），
// 组装逻辑见 SearchResultAssembler（assembler.ts）
// Phase 2：内部构建 RetrievalRequest（query + analysis + filter）
// 架构分层：依赖通过 createHybridSearch 注入（ChunkStore Port +
// Retriever/Fusion 组件），由 Composition Root 组装
// ============================================================

import type {
  SearchResult,
  SearchQuery,
  QueryAnalysis,
  RetrievalFilter,
  RetrievalRequest,
  Retriever,
  Fusion,
} from '@/domain/search/types';
import type { ChunkStore } from '@/domain/document/types';
import { runSearchPipeline } from './pipeline';
import { SearchResultAssembler } from './assembler';

export interface HybridSearchDeps {
  chunkStore: ChunkStore;
  retrievers: Retriever[];
  fusion: Fusion;
}

export type HybridSearchFn = (
  query: string,
  topK?: number,
  vectorTopN?: number,
  bm25TopN?: number,
  options?: {
    matchedKeywords?: string[];
    filteredChunkIds?: string[];
  }
) => Promise<SearchResult[]>;

/**
 * 创建混合检索函数
 *
 * @param deps - chunkStore + retrievers + fusion（由 Composition Root 注入）
 * @returns hybridSearch(query, topK, vectorTopN, bm25TopN, options)
 */
export function createHybridSearch(deps: HybridSearchDeps): HybridSearchFn {
  const assembler = new SearchResultAssembler(deps.chunkStore);

  return async function hybridSearch(
    query: string,
    topK: number = 10,
    vectorTopN: number = 20,
    bm25TopN: number = 20,
    options?: {
      matchedKeywords?: string[];
      filteredChunkIds?: string[];
    }
  ): Promise<SearchResult[]> {
    const searchQuery: SearchQuery = { query };
    const analysis: QueryAnalysis = { matchedKeywords: options?.matchedKeywords };
    const filter: RetrievalFilter | undefined = options?.filteredChunkIds
      ? { filteredChunkIds: options.filteredChunkIds }
      : undefined;

    const request: RetrievalRequest = { query: searchQuery, analysis, filter };
    const hits = await runSearchPipeline(
      request,
      { topK, vectorTopN, bm25TopN },
      { retrievers: deps.retrievers, fusion: deps.fusion }
    );
    return assembler.assemble(hits, searchQuery, analysis, topK);
  };
}
