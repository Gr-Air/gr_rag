// ============================================================
// 检索管线（Spec 029/031）：固定编排，只做检索 + 过滤 + 融合
//   [VectorRetriever, BM25Retriever] → filteredChunkIds 过滤 → RRFFusion
// Phase 2：RetrievalContext 拆为 RetrievalRequest，按组件分发不同子结构
//   - Retriever 收到 SearchQuery + RetrievalOptions（不含 Entity/Analysis）
//   - Fusion 收到 QueryAnalysis（含 matchedKeywords，用于实体过滤）
// 组装逻辑见 SearchResultAssembler（assembler.ts）
// 架构分层：Application 层 Use Case，组件（Retriever/Fusion）由
// Composition Root 注入，此处禁止默认构造 Infrastructure 实现
// ============================================================

import type {
  RetrievalHit,
  QueryAnalysis,
  RetrievalOptions,
  RetrievalRequest,
  Retriever,
  Fusion,
} from '@/domain/search/types';
import { adjustTopKForBroadQuery } from '@/domain/search/queryPolicy';

export interface PipelineParams {
  topK: number;
  vectorTopN: number;
  bm25TopN: number;
}

export interface PipelineComponents {
  retrievers: Retriever[];
  fusion: Fusion;
}

/**
 * 运行检索管线：检索 → 过滤 → 融合，返回 RetrievalHit[]
 *
 * @param request - 检索请求（query + analysis + filter）
 * @param params - topK / 各路召回数
 * @param components - 管线组件（由 Composition Root 注入；测试用 mock）
 */
export async function runSearchPipeline(
  request: RetrievalRequest,
  params: PipelineParams,
  components: PipelineComponents
): Promise<RetrievalHit[]> {
  const { retrievers, fusion } = components;

  const { query, analysis, filter } = request;
  const matchedKeywords = analysis?.matchedKeywords;
  const isEntityQuery = matchedKeywords && matchedKeywords.length > 0;

  console.log(`[Hybrid] 查询: "${query.query}", topK=${params.topK}`);

  // 查询类型识别和动态 topK（宽泛查询收敛，规则见 queryPolicy.ts）
  const topK = adjustTopKForBroadQuery(query.query, params.topK);

  // Step 1: 并行执行各路检索（某路抛错按空结果继续，维持降级语义）
  // 实体查询保持原召回量；宽泛查询翻倍召回覆盖更多文档章节
  const effectiveVectorTopN = isEntityQuery ? params.vectorTopN : params.vectorTopN * 2;
  const effectiveBm25TopN = isEntityQuery ? params.bm25TopN : params.bm25TopN * 2;
  const topNs = [effectiveVectorTopN, effectiveBm25TopN];

  const searchWithFallback = async (
    retriever: Retriever,
    topN: number
  ): Promise<RetrievalHit[]> => {
    try {
      const options: RetrievalOptions = { topN, filter, keywords: matchedKeywords };
      return await retriever.search(query, options);
    } catch (err) {
      console.error(`[Hybrid] ${retriever.name} 检索失败:`, err);
      return [];
    }
  };

  let hitLists = await Promise.all(
    retrievers.map((r, i) => searchWithFallback(r, topNs[i] ?? topNs[0]))
  );

  console.log(`[Hybrid] 向量检索: ${hitLists[0]?.length ?? 0} 条, BM25 检索: ${hitLists[1]?.length ?? 0} 条`);

  // Step 2: filteredChunkIds 过滤（docType 过滤，来自 LLM 改写）
  const filteredChunkIds = filter?.filteredChunkIds;
  if (filteredChunkIds && filteredChunkIds.length > 0) {
    const filterSet = new Set(filteredChunkIds);
    const before = hitLists.map(l => l.length);
    hitLists = hitLists.map(list => list.filter(h => filterSet.has(h.chunkId)));
    console.log(`[Hybrid] docType 过滤: ${hitLists.map((l, i) => `#${i} ${before[i]}→${l.length}`).join(', ')}`);
  }

  // 空结果提前返回
  if (hitLists.every(list => list.length === 0)) {
    console.log('[Hybrid] 所有检索路均无结果');
    return [];
  }

  // Step 3: RRF 融合（实体过滤由 RRFFusion 基于 analysis.matchedKeywords 内部处理）
  const fusionTopK = isEntityQuery ? topK : topK * 3;
  const analysisForFusion: QueryAnalysis = { matchedKeywords };
  const fused = fusion.fuse(hitLists, analysisForFusion, fusionTopK);

  console.log(`[Hybrid] RRF 融合后 top${topK}: ${fused.length} 条`);
  fused.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.chunkId}] RRF=${(r.scores.rrf ?? 0).toFixed(6)} (vec#${r.ranks.vector ?? '-'} bm25#${r.ranks.bm25 ?? '-'})`);
  });

  return fused;
}
