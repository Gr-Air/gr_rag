// ============================================================
// 检索管线（Spec 029）：固定组装，不做配置驱动的策略选择
//   [VectorRetriever, BM25Retriever] → RRFFusion（实体过滤内部处理）
//   → 组装（chunk 附着 / 文档聚合 / 实体加成 / 归一化）
// 组件仅支持测试注入（runSearchPipeline 第三参），默认组件固定
// ============================================================

import { DocChunk, SearchResult, RetrievalHit, SearchSource } from '../types';
import { getChunksByIds } from '../bm25Engine';
import { VectorRetriever } from './retrievers/vector';
import { BM25Retriever } from './retrievers/bm25';
import { RRFFusion } from './fusion';
import { applyEntityMatchBoost } from './entityStrategy';
import { adjustTopKForBroadQuery } from './queryPolicy';
import { generateHighlight } from './highlight';
import type { RetrievalContext, Retriever, Fusion } from './types';

/** 默认固定组件：两路召回 + RRF 融合 */
const defaultRetrievers: Retriever[] = [new VectorRetriever(), new BM25Retriever()];
const defaultFusion: Fusion = new RRFFusion();

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
 * 运行检索管线
 *
 * @param ctx - 检索上下文（query + 领域参数，透传给各组件）
 * @param params - topK / 各路召回数
 * @param components - 组件注入（仅测试用 mock，默认为固定组件）
 */
export async function runSearchPipeline(
  ctx: RetrievalContext,
  params: PipelineParams,
  components?: Partial<PipelineComponents>
): Promise<SearchResult[]> {
  const retrievers = components?.retrievers ?? defaultRetrievers;
  const fusion = components?.fusion ?? defaultFusion;

  const { query } = ctx;
  const matchedKeywords = ctx.matchedKeywords;
  const isEntityQuery = matchedKeywords && matchedKeywords.length > 0;

  console.log(`[Hybrid] 查询: "${query}", topK=${params.topK}`);

  // 查询类型识别和动态 topK（宽泛查询收敛，规则见 queryPolicy.ts）
  const topK = adjustTopKForBroadQuery(query, params.topK);

  // Step 1: 并行执行各路检索（某路抛错按空结果继续，维持降级语义）
  // 对于无实体匹配的概括性查询，增加检索召回数量，确保能覆盖更多文档章节
  const effectiveVectorTopN = isEntityQuery ? params.vectorTopN : params.vectorTopN * 2;
  const effectiveBm25TopN = isEntityQuery ? params.bm25TopN : params.bm25TopN * 2;
  const topNs = [effectiveVectorTopN, effectiveBm25TopN];

  const searchWithFallback = async (retriever: Retriever, topN: number): Promise<RetrievalHit[]> => {
    try {
      return await retriever.search(ctx, topN);
    } catch (err) {
      console.error(`[Hybrid] ${retriever.name} 检索失败:`, err);
      return [];
    }
  };

  let hitLists = await Promise.all(
    retrievers.map((r, i) => searchWithFallback(r, topNs[i] ?? topNs[0]))
  );

  console.log(`[Hybrid] 向量检索: ${hitLists[0]?.length ?? 0} 条, BM25 检索: ${hitLists[1]?.length ?? 0} 条`);

  // Step 1.1: 按 docType 过滤（如果调用方传入了 filteredChunkIds）
  const filteredChunkIds = ctx.filteredChunkIds;
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

  // Step 2: RRF 融合（实体过滤由 RRFFusion 基于 ctx.matchedKeywords 内部处理）
  const fusionTopK = isEntityQuery ? topK : topK * 3;
  const fused = fusion.fuse(hitLists, ctx, fusionTopK);

  console.log(`[Hybrid] RRF 融合后 top${topK}:`);
  fused.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.chunkId}] RRF=${(r.scores.rrf ?? 0).toFixed(6)} (vec#${r.ranks.vector ?? '-'} bm25#${r.ranks.bm25 ?? '-'})`);
  });

  // Step 3: 获取完整文档块信息
  const chunkIds = fused.map(f => f.chunkId);
  const chunks = getChunksByIds(chunkIds);
  const chunkMap = new Map<string, DocChunk>();
  chunks.forEach(c => chunkMap.set(c.id, c));

  // Step 4: 按文档聚合 chunks
  // 策略：有实体匹配时每个文档取最佳 chunk（精准匹配）
  //       无实体匹配时每个文档取多个 chunks（支持概括性查询）
  const MAX_CHUNKS_PER_DOC = isEntityQuery ? 1 : 5;

  const docChunks = new Map<string, Array<{ chunk: DocChunk; hit: RetrievalHit }>>();

  const seenChunkIds = new Set<string>();

  for (const f of fused) {
    const chunk = chunkMap.get(f.chunkId);
    if (!chunk) continue;
    if (seenChunkIds.has(f.chunkId)) continue;
    seenChunkIds.add(f.chunkId);

    const docId = chunk.docId || f.chunkId.replace(/_\d+$/, '');
    if (!docChunks.has(docId)) {
      docChunks.set(docId, []);
    }

    const existingList = docChunks.get(docId)!;
    if (existingList.length < MAX_CHUNKS_PER_DOC) {
      const chunkTitle = chunk.content.split('\n')[0]?.trim() || '';
      const hasSameTitle = existingList.some(e => {
        const existingTitle = e.chunk.content.split('\n')[0]?.trim() || '';
        return chunkTitle === existingTitle;
      });
      if (!hasSameTitle) {
        existingList.push({ chunk, hit: f });
      }
    }
  }

  // Step 4.7: 实体匹配度评分加成（问题场景与策略详见 entityStrategy.ts）
  applyEntityMatchBoost(docChunks, matchedKeywords);

  // Step 5: 组装最终结果（按 RRF 分数排序，归一化放大到 0~1 区间）
  const allChunks = Array.from(docChunks.values()).flat();
  const finalTopK = isEntityQuery ? topK : topK * 2;
  const sortedDocs = allChunks
    .sort((a, b) => (b.hit.scores.rrf ?? 0) - (a.hit.scores.rrf ?? 0))
    .slice(0, finalTopK);

  // RRF 分数归一化：RRF 原始值范围约 0.016~0.033，对用户不直观
  // 将最高分映射到 ~0.95，最低分保持相对比例
  const maxRrf = sortedDocs.length > 0 ? (sortedDocs[0].hit.scores.rrf ?? 0) : 0.001;
  const minRrf = sortedDocs.length > 0 ? (sortedDocs[sortedDocs.length - 1].hit.scores.rrf ?? 0) : 0;

  const results: SearchResult[] = sortedDocs.map(({ chunk, hit }) => {
    // 判断来源（已在上一步合并了同一文档多 chunk 的排名信息）
    let source: SearchSource = 'hybrid';
    if (hit.ranks.vector !== undefined && hit.ranks.bm25 === undefined) source = 'vector';
    if (hit.ranks.bm25 !== undefined && hit.ranks.vector === undefined) source = 'bm25';
    if (hit.ranks.vector !== undefined && hit.ranks.bm25 !== undefined) source = 'hybrid';

    // 归一化到 0.05~0.95 区间（避免出现 0 或 1 的极端值）
    const normalizedScore = maxRrf > minRrf
      ? 0.05 + (((hit.scores.rrf ?? 0) - minRrf) / (maxRrf - minRrf)) * 0.90
      : 0.50; // 所有分数相同时取中间值

    const highlight = generateHighlight(chunk.content, query);

    return {
      chunk,
      score: Math.round(normalizedScore * 10000) / 10000, // 保留4位小数
      scores: hit.scores,
      source,
      highlight,
    };
  });

  return results;
}
