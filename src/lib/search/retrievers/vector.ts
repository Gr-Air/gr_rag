// ============================================================
// 向量检索器：包装 vectorEngine.vectorSearch，输出统一 RetrievalHit
// ============================================================

import { RetrievalHit } from '../../types';
import type { SearchQuery, RetrievalOptions, Retriever } from '../types';
import { vectorSearch } from '../../vectorEngine';

export class VectorRetriever implements Retriever {
  readonly name = 'vector' as const;

  async search(query: SearchQuery, options: RetrievalOptions): Promise<RetrievalHit[]> {
    const results = await vectorSearch(query.query, options.topN);
    return results.map(r => ({
      chunkId: r.chunkId,
      scores: { vector: r.score },
      ranks: {},
      source: 'vector' as const,
    }));
  }
}
