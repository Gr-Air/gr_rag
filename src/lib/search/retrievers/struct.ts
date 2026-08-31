// ============================================================
// 结构化检索器：包装 structSearchEngine.executeStructuredQuery
// 默认管线不启用（启用与否留给 eval 数据决策，见 Spec 029）；
// 实体名来自 options.keywords（检索参数，非实体域知识），查询异常内部 catch 返回空
// ============================================================

import { RetrievalHit } from '../../types';
import type { SearchQuery, RetrievalOptions, Retriever } from '../types';
import { executeStructuredQuery } from '../../structSearchEngine';

export class StructRetriever implements Retriever {
  readonly name = 'struct' as const;

  async search(_query: SearchQuery, options: RetrievalOptions): Promise<RetrievalHit[]> {
    try {
      const entries = options.keywords ?? [];
      if (entries.length === 0) return [];

      const results = await executeStructuredQuery(entries);

      // hit 组装：chunk 去重（同一 chunk 可关联多个词条），词条频次作为排序分
      const hits: RetrievalHit[] = [];
      const seen = new Set<string>();
      for (const r of results) {
        for (const c of r.chunks) {
          if (seen.has(c.chunk_id)) continue;
          seen.add(c.chunk_id);
          hits.push({
            chunkId: c.chunk_id,
            scores: { struct: r.entry.frequency },
            ranks: {},
            source: 'entity',
          });
        }
      }
      return hits.slice(0, options.topN);
    } catch (err) {
      console.error('[StructRetriever] 结构化检索失败:', err);
      return [];
    }
  }
}
