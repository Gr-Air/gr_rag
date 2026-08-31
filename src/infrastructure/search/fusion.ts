// ============================================================
// RRF (Reciprocal Rank Fusion) 融合（Spec 029：RRFFusion 实现 Fusion 接口）
// Phase 2：fuse 接收 QueryAnalysis 而非 RetrievalContext（不依赖 query/filter）
// 架构分层：Infrastructure 层 Fusion Port 实现；chunk 内容通过注入的
// ChunkStore Port 获取（实体过滤规则本体在 domain/search/entityStrategy.ts）
// ============================================================

import type { RetrievalHit, Fusion, QueryAnalysis } from '@/domain/search/types';
import type { ChunkStore } from '@/domain/document/types';
import { buildVectorEntityFilter } from '@/domain/search/entityStrategy';

/** RRF 平滑参数 */
export const RRF_K = 60;

/**
 * RRFFusion：两路召回（向量 + BM25）的 RRF 融合
 *
 * 实体过滤：向量结果中不含 analysis.matchedKeywords 的 chunk，
 * 其向量排名不计入 RRF（策略详见 entityStrategy.ts）
 */
export class RRFFusion implements Fusion {
  readonly name = 'rrf';

  constructor(private chunkStore?: ChunkStore) {}

  fuse(hitLists: RetrievalHit[][], analysis: QueryAnalysis, topK: number = 10): RetrievalHit[] {
    const [vectorHits = [], bm25Hits = []] = hitLists;

    let vectorEntityFilter: Set<string> | undefined;
    if (this.chunkStore && analysis.matchedKeywords && analysis.matchedKeywords.length > 0 && vectorHits.length > 0) {
      const chunks = this.chunkStore.getByIds(vectorHits.map(h => h.chunkId));
      const contentMap = new Map<string, string>();
      chunks.forEach(c => contentMap.set(c.id, c.content));
      vectorEntityFilter = buildVectorEntityFilter(vectorHits, analysis.matchedKeywords, contentMap);
    }

    return rrfFusion(vectorHits, bm25Hits, topK, vectorEntityFilter);
  }
}

/**
 * RRF 核心纯函数
 *
 * 公式: RRF(d) = Σ 1/(k + rank_i(d))
 *
 * 其中:
 * - d 是文档
 * - rank_i(d) 是文档 d 在第 i 个检索系统中的排名（从1开始）
 * - k 是平滑参数（默认60）
 *
 * 优点:
 * - 不依赖原始分数的量纲，直接基于排名融合
 * - 对异常分数不敏感
 * - 简单高效
 */
export function rrfFusion(
  vectorHits: RetrievalHit[],
  bm25Hits: RetrievalHit[],
  topK: number = 10,
  /** 向量搜索结果中不包含实体关键词的 chunkId 集合，这些结果的向量排名不计入 RRF */
  vectorEntityFilter?: Set<string>
): RetrievalHit[] {
  const fused = new Map<string, RetrievalHit>();

  const getOrCreate = (chunkId: string): RetrievalHit => {
    let hit = fused.get(chunkId);
    if (!hit) {
      hit = { chunkId, scores: {}, ranks: {}, source: 'rrf' };
      fused.set(chunkId, hit);
    }
    return hit;
  };

  // 向量检索排名（跳过被实体过滤的结果）
  let effectiveVecRank = 0;
  vectorHits.forEach((vecHit, index) => {
    const rank = index + 1;
    const hit = getOrCreate(vecHit.chunkId);
    if (vecHit.scores.vector !== undefined) {
      hit.scores.vector = vecHit.scores.vector;
    }
    // 如果该结果不包含实体关键词，跳过其向量排名贡献（ranks.vector 缺省）
    if (vectorEntityFilter?.has(vecHit.chunkId)) {
      return;
    }

    effectiveVecRank++;
    hit.ranks.vector = rank;
    hit.scores.rrf = (hit.scores.rrf || 0) + 1 / (RRF_K + effectiveVecRank);
  });

  // BM25 检索排名
  bm25Hits.forEach((bm25Hit, index) => {
    const rank = index + 1;
    const hit = getOrCreate(bm25Hit.chunkId);
    if (bm25Hit.scores.bm25 !== undefined) {
      hit.scores.bm25 = bm25Hit.scores.bm25;
    }
    hit.ranks.bm25 = rank;
    hit.scores.rrf = (hit.scores.rrf || 0) + 1 / (RRF_K + rank);
  });

  // 按 RRF 分数排序
  return Array.from(fused.values())
    .sort((a, b) => (b.scores.rrf ?? 0) - (a.scores.rrf ?? 0))
    .slice(0, topK);
}
