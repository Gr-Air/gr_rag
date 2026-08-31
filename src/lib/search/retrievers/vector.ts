// ============================================================
// 向量检索器：包装 vectorEngine.vectorSearch，输出统一 RetrievalHit
// ============================================================

import { RetrievalHit } from '../../types';
import { Retriever, RetrievalContext } from '../types';
import { vectorSearch } from '../../vectorEngine';

export class VectorRetriever implements Retriever {
  readonly name = 'vector' as const;

  async search(ctx: RetrievalContext, topN: number): Promise<RetrievalHit[]> {
    const results = await vectorSearch(ctx.query, topN);
    return results.map(r => ({
      chunkId: r.chunkId,
      scores: { vector: r.score },
      ranks: {},
      source: 'vector' as const,
    }));
  }
}
