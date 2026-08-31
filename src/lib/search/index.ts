// ============================================================
// 混合检索引擎 —— 唯一对外入口
// 管线编排固定于 pipeline.ts（[向量, BM25] → RRF 融合），
// 组装逻辑移至 SearchResultAssembler（assembler.ts，Spec 031）
// Phase 2：内部构建 RetrievalRequest（query + analysis + filter）
// 组件接口（Retriever / Fusion / Reranker）见 types.ts（Spec 029）
// ============================================================

import { SearchResult } from '../types';
import { runSearchPipeline } from './pipeline';
import { SearchResultAssembler } from './assembler';
import { getChunkStore } from '../document/chunkStore';
import type { SearchQuery, QueryAnalysis, RetrievalFilter, RetrievalRequest } from './types';

// 懒初始化 assembler（依赖 ChunkStore 单例，测试 mock 时需在调用时获取）
let _assembler: SearchResultAssembler | null = null;
function getAssembler(): SearchResultAssembler {
  if (!_assembler) _assembler = new SearchResultAssembler(getChunkStore());
  return _assembler;
}

/** 测试用：重置 assembler 缓存（让下一次调用重新获取 ChunkStore mock） */
export function _resetAssemblerForTest(): void {
  _assembler = null;
}

/**
 * 混合检索主函数
 *
 * @param query - 用户查询
 * @param topK - 返回文档数（默认5）
 * @param vectorTopN - 向量检索召回数（默认20）
 * @param bm25TopN - BM25 检索召回数（默认20）
 * @param options - 可选参数
 * @param options.matchedKeywords - 实体关键字，用于过滤向量检索的噪音结果
 * @param options.filteredChunkIds - docType 过滤的 chunkId 白名单
 * @returns topK 个搜索结果
 */
export async function hybridSearch(
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
  const hits = await runSearchPipeline(request, { topK, vectorTopN, bm25TopN });
  return getAssembler().assemble(hits, searchQuery, analysis, topK);
}
