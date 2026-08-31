// ============================================================
// BM25 检索器：包装 bm25Engine.bm25Search，输出统一 RetrievalHit
// ============================================================

import { RetrievalHit } from '../../types';
import type { SearchQuery, RetrievalOptions, Retriever } from '../types';
import { bm25Search } from '../../bm25Engine';

export class BM25Retriever implements Retriever {
  readonly name = 'bm25' as const;

  async search(query: SearchQuery, options: RetrievalOptions): Promise<RetrievalHit[]> {
    const results = await bm25Search(query.query, options.topN);
    return results.map(r => ({
      chunkId: r.chunkId,
      scores: { bm25: r.score },
      ranks: {},
      source: 'bm25' as const,
    }));
  }
}
