// ============================================================
// 混合检索引擎 —— 唯一对外入口
// 管线编排固定于 pipeline.ts（[向量, BM25] → RRF 融合 → 组装），
// 组件接口（Retriever / Fusion / Reranker）见 types.ts（Spec 029）
// ============================================================

import { SearchResult } from '../types';
import { runSearchPipeline } from './pipeline';

/**
 * 混合检索主函数
 *
 * @param query - 用户查询
 * @param topK - 返回文档数（默认5）
 * @param vectorTopN - 向量检索召回数（默认20）
 * @param bm25TopN - BM25 检索召回数（默认20）
 * @param options - 可选参数
 * @param options.matchedKeywords - 实体关键字，用于过滤向量检索的噪音结果
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
  return runSearchPipeline(
    {
      query,
      matchedKeywords: options?.matchedKeywords,
      filteredChunkIds: options?.filteredChunkIds,
    },
    { topK, vectorTopN, bm25TopN }
  );
}
