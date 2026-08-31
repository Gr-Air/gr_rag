// ============================================================
// SearchResultAssembler（Spec 031）
// 从 pipeline 提取的组装逻辑：RetrievalHit[] → SearchResult[]
//   chunk 附着 → 文档聚合 → 实体加成 → 归一化 → 高亮 → 组装
// Phase 2：接收 SearchQuery + QueryAnalysis 而非 RetrievalContext
// 依赖 ChunkStore（而非 bm25Engine），保持组装与检索引擎解耦
// ============================================================

import { DocChunk, SearchResult, RetrievalHit, SearchSource } from '../types';
import { ChunkStore } from '../document/types';
import { applyEntityMatchBoost } from './entityStrategy';
import { generateHighlight } from './highlight';
import type { SearchQuery, QueryAnalysis } from './types';

export class SearchResultAssembler {
  constructor(private chunkStore: ChunkStore) {}

  /**
   * RetrievalHit[] → SearchResult[]
   *
   * 组装步骤：
   *   1. chunk 附着（ChunkStore.getByIds 批量取回）
   *   2. 文档聚合（实体查询 1 chunk/doc，宽泛查询 5 chunk/doc，跳过同标题重复）
   *   3. 实体加成（applyEntityMatchBoost，匹配实体关键词加分并入 rrf）
   *   4. 排序 + 截断（按 rrf 降序）
   *   5. 归一化（RRF 原始值映射到 0.05~0.95）
   *   6. 高亮 + 组装 SearchResult[]
   */
  assemble(
    hits: RetrievalHit[],
    query: SearchQuery,
    analysis: QueryAnalysis,
    topK: number
  ): SearchResult[] {
    const matchedKeywords = analysis.matchedKeywords;
    const isEntityQuery = matchedKeywords && matchedKeywords.length > 0;

    // Step 1: chunk 附着
    const chunkIds = hits.map(h => h.chunkId);
    const chunks = this.chunkStore.getByIds(chunkIds);
    const chunkMap = new Map<string, DocChunk>();
    chunks.forEach(c => chunkMap.set(c.id, c));

    // Step 2: 文档聚合
    const MAX_CHUNKS_PER_DOC = isEntityQuery ? 1 : 5;
    const docChunks = new Map<string, Array<{ chunk: DocChunk; hit: RetrievalHit }>>();
    const seenChunkIds = new Set<string>();

    for (const f of hits) {
      const chunk = chunkMap.get(f.chunkId);
      if (!chunk || seenChunkIds.has(f.chunkId)) continue;
      seenChunkIds.add(f.chunkId);

      const docId = chunk.docId || f.chunkId.replace(/_\d+$/, '');
      if (!docChunks.has(docId)) docChunks.set(docId, []);

      const existingList = docChunks.get(docId)!;
      if (existingList.length < MAX_CHUNKS_PER_DOC) {
        const chunkTitle = chunk.content.split('\n')[0]?.trim() || '';
        const hasSameTitle = existingList.some(e => {
          const existingTitle = e.chunk.content.split('\n')[0]?.trim() || '';
          return chunkTitle === existingTitle;
        });
        if (!hasSameTitle) existingList.push({ chunk, hit: f });
      }
    }

    // Step 3: 实体匹配度加成
    applyEntityMatchBoost(docChunks, matchedKeywords);

    // Step 4: 排序 + 截断
    const allChunks = Array.from(docChunks.values()).flat();
    const finalTopK = isEntityQuery ? topK : topK * 2;
    const sortedDocs = allChunks
      .sort((a, b) => (b.hit.scores.rrf ?? 0) - (a.hit.scores.rrf ?? 0))
      .slice(0, finalTopK);

    // Step 5: 归一化（RRF 原始值约 0.016~0.033，映射到 0.05~0.95 提升可读性）
    const maxRrf = sortedDocs[0]?.hit.scores.rrf ?? 0.001;
    const minRrf = sortedDocs[sortedDocs.length - 1]?.hit.scores.rrf ?? 0;

    // Step 6: 高亮 + 组装
    return sortedDocs.map(({ chunk, hit }) => {
      let source: SearchSource = 'hybrid';
      if (hit.ranks.vector !== undefined && hit.ranks.bm25 === undefined) source = 'vector';
      if (hit.ranks.bm25 !== undefined && hit.ranks.vector === undefined) source = 'bm25';

      const normalizedScore = maxRrf > minRrf
        ? 0.05 + (((hit.scores.rrf ?? 0) - minRrf) / (maxRrf - minRrf)) * 0.90
        : 0.50; // 所有分数相同时取中间值

      return {
        chunk,
        score: Math.round(normalizedScore * 10000) / 10000, // 保留4位小数
        scores: hit.scores,
        source,
        highlight: generateHighlight(chunk.content, query.query),
      };
    });
  }
}
