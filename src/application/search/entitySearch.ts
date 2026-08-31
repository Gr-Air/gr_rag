// ============================================================
// 实体路由检索 Use Case（Application 层）
// 从 lib/entityRouter 拆分：业务流程在此，技术实现在 infrastructure
//
// 策略：
//   1. 用字典最大匹配法检测 query 中的实体关键字（算法在 domain/entity/keywordMatcher）
//   2. 有匹配 → 结构化查询（StructQueryPort），返回包含实体的上下文片段
//   3. 无匹配 → 走向量+BM25 RRF 融合检索（注入的 hybridSearch）
//
// 依赖注入：chunkStore / structQuery / entityRepo / hybridSearch
// ============================================================

import type { SearchResult } from '@/domain/search/types';
import type { ChunkStore, ChunkMeta, DocChunk } from '@/domain/document/types';
import type { StructQueryPort, EntityRepository } from '@/domain/entity/types';
import { extractMatchingKeywords } from '@/domain/entity/keywordMatcher';
import type { HybridSearchFn } from './hybridSearch';

export type { ChunkMeta };

// ============================================================
// 类型
// ============================================================

export interface RoutedSearchResult {
  results: SearchResult[];
  /** 检索方法 */
  method: 'rrf' | 'entity';
  /** 匹配到的实体关键字（entity 方法时） */
  matchedKeywords?: string[];
}

export interface EntitySearch {
  /** 从用户问题中提取匹配的实体关键字（字典最大匹配，结果缓存） */
  extractEntityKeywords(query: string): string[];
  /** 路由检索：有实体 → 结构化召回，无实体 → RRF 融合 */
  routedSearch(
    query: string,
    topK?: number,
    options?: {
      forceMethod?: 'rrf' | 'entity';
      /** LLM API 配置（保留兼容） */
      apiKey?: string;
      baseURL?: string;
      model?: string;
    }
  ): Promise<RoutedSearchResult>;
  /** 加载全部 chunks（Record 签名，兼容 route 调用方） */
  loadAllChunks(): Record<string, ChunkMeta>;
}

// ============================================================
// 内部工具
// ============================================================

/**
 * 从文档内容中提取包含实体的上下文片段
 * 每个实体匹配点提取 ±contextSize token 的上下文，最多 3 个片段，重叠区间合并
 */
function extractEntityContext(
  content: string,
  entities: string[],
  contextSize: number = 200
): string {
  const segments: { start: number; end: number }[] = [];

  for (const entity of entities) {
    const regex = new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let match;
    let count = 0;

    while ((match = regex.exec(content)) !== null && count < 3) {
      const start = Math.max(0, match.index - contextSize);
      const end = Math.min(content.length, match.index + match[0].length + contextSize);
      segments.push({ start, end });
      count++;
    }
  }

  if (segments.length === 0) {
    return content.slice(0, contextSize * 2);
  }

  segments.sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const last = merged[merged.length - 1];
    if (segments[i].start <= last.end) {
      last.end = Math.max(last.end, segments[i].end);
    } else {
      merged.push(segments[i]);
    }
  }

  return merged.map(s => content.slice(s.start, s.end)).join('\n');
}

// ============================================================
// 工厂
// ============================================================

export function createEntitySearch(deps: {
  chunkStore: ChunkStore;
  structQuery: StructQueryPort;
  entityRepo: EntityRepository;
  hybridSearch: HybridSearchFn;
}): EntitySearch {
  const { chunkStore, structQuery, entityRepo, hybridSearch } = deps;

  // 实体关键字缓存（来自 EntityRepository，按长度降序）
  let entityKeywords: string[] | null = null;

  function loadEntityKeywords(): string[] {
    if (entityKeywords) return entityKeywords;
    try {
      if (entityRepo.isReady()) {
        const entities = entityRepo.getKnownEntities();
        // 只加载实体类型，排除概念
        const keywords = entities
          .filter((e) => e.type === 'entity')
          .map((e) => e.name)
          .sort((a, b) => b.length - a.length);
        entityKeywords = keywords;
        console.log(`[EntityRouter] 从 EntityRepository 加载 ${keywords.length} 个实体关键字`);
        return keywords;
      }
    } catch (err) {
      console.warn('[EntityRouter] 无法加载实体，降级为空列表:', err);
    }
    entityKeywords = [];
    return entityKeywords;
  }

  // 缓存：entity → chunkIds 的倒排索引
  let entityToChunks: Map<string, string[]> | null = null;

  function buildEntityInvertedIndex(): Map<string, string[]> {
    if (entityToChunks) return entityToChunks;

    const index = new Map<string, string[]>();
    const allChunks = chunkStore.getAll();

    for (const [chunkId, chunk] of allChunks) {
      if (!chunk.wikiLinks || chunk.wikiLinks.length === 0) continue;
      for (const link of chunk.wikiLinks) {
        if (!index.has(link)) index.set(link, []);
        index.get(link)!.push(chunkId);
      }
    }

    entityToChunks = index;
    console.log(`[EntityRouter] 倒排索引构建完成: ${index.size} 个实体, ${allChunks.size} 个文档块`);
    return entityToChunks;
  }

  /**
   * 实体检索：从结构化查询结果中提取包含实体的上下文片段
   * 返回包含实体的文档上下文（±200 token）
   */
  async function entityRecallWithContext(
    matchedKeywords: string[],
    structResults: Awaited<ReturnType<StructQueryPort['query']>>,
    topK: number
  ): Promise<SearchResult[]> {
    const allChunksData = chunkStore.getAll();

    const results: SearchResult[] = [];
    const seenChunkIds = new Set<string>();
    const seenEntryNames = new Set<string>();

    for (const sr of structResults) {
      if (seenEntryNames.has(sr.entry.name)) continue;
      seenEntryNames.add(sr.entry.name);

      for (const structChunk of sr.chunks) {
        const chunkId = structChunk.chunk_id;
        if (seenChunkIds.has(chunkId)) continue;
        seenChunkIds.add(chunkId);

        const chunkData = allChunksData.get(chunkId);
        if (!chunkData) continue;

        const context = extractEntityContext(chunkData.content, matchedKeywords);

        const chunk: DocChunk = {
          id: chunkId,
          docId: chunkData.docId,
          docTitle: chunkData.docTitle,
          docPath: chunkData.docPath,
          chunkIndex: 0,
          content: context,
          metadata: chunkData.metadata,
          wikiLinks: chunkData.wikiLinks || [],
        };

        let highlight = context.slice(0, 500);
        for (const kw of matchedKeywords) {
          try {
            highlight = highlight.replace(
              new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
              `**${kw}**`
            );
          } catch { /* ignore regex errors */ }
        }

        results.push({
          chunk,
          score: sr.entry.frequency / 500,
          scores: {},
          source: 'entity',
          highlight,
        });

        if (results.length >= topK) break;
      }
      if (results.length >= topK) break;
    }

    return results;
  }

  /**
   * 实体精确召回：根据匹配到的实体关键字，返回所有相关文档块
   * 对每个匹配到的文档，选取内容最丰富的 chunk（跳过标题/元信息 chunk）
   * 按实体出现频率加权排序
   */
  function entityRecall(
    matchedKeywords: string[],
    topK: number = 10
  ): SearchResult[] {
    const index = buildEntityInvertedIndex();
    // docId → { 所有匹配的 chunkIds, 累计分数, 命中关键字 }
    const docInfo = new Map<string, { chunkIds: Set<string>; score: number; hitKeywords: Set<string> }>();

    for (let i = 0; i < matchedKeywords.length; i++) {
      const kw = matchedKeywords[i];
      const chunkIds = index.get(kw) || [];

      // 优先级高的关键字给更高权重
      const keywordWeight = 1.0 / (i + 1);

      for (const chunkId of chunkIds) {
        // 从 chunkId 提取 docId（格式: raw_xxx_N 或 wiki_xxx）
        const docId = chunkId.replace(/_\d+$/, '');

        const existing = docInfo.get(docId);
        if (existing) {
          existing.score += keywordWeight;
          existing.hitKeywords.add(kw);
          existing.chunkIds.add(chunkId);
        } else {
          docInfo.set(docId, {
            chunkIds: new Set([chunkId]),
            score: keywordWeight,
            hitKeywords: new Set([kw]),
          });
        }
      }
    }

    // 按文档分数排序，取 topK
    const rankedDocs = Array.from(docInfo.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, topK);

    // 对每个文档，加载该文档的所有 chunk，选取内容最丰富的（跳过纯标题/元信息 chunk）
    // 直接从 chunkStore 全量数据构建 DocChunk，避免二次 I/O
    const allChunksData = chunkStore.getAll();
    const bestChunks: DocChunk[] = [];

    for (const [docId] of rankedDocs) {
      // 找出该 docId 的所有 chunk（格式: raw_xxx_N）
      const docChunkIds = [...allChunksData.keys()].filter(k => k.startsWith(docId));
      if (docChunkIds.length === 0) continue;

      const chunks: DocChunk[] = docChunkIds
        .map(id => {
          const data = allChunksData.get(id);
          if (!data) return null;
          return {
            id,
            docId: data.docId,
            docTitle: data.docTitle,
            docPath: data.docPath,
            chunkIndex: 0,
            content: data.content,
            metadata: data.metadata,
            wikiLinks: data.wikiLinks || [],
          };
        })
        .filter((c): c is DocChunk => c !== null);

      if (chunks.length === 0) continue;

      // 排序：优先选内容长且不是纯标题/元信息的 chunk
      // 元信息 chunk 特征：内容极短（纯标题，<100字符）或以"文档元信息"开头
      const sorted = chunks.sort((a, b) => {
        const aIsMeta = a.content.length < 100 || a.content.trim().startsWith('## 文档元信息');
        const bIsMeta = b.content.length < 100 || b.content.trim().startsWith('## 文档元信息');
        if (aIsMeta && !bIsMeta) return 1;
        if (!aIsMeta && bIsMeta) return -1;
        return b.content.length - a.content.length;
      });

      bestChunks.push(sorted[0]);
    }

    const results: SearchResult[] = [];
    for (const [docId, info] of rankedDocs) {
      // 找到这个 docId 对应的最佳 chunk
      const chunk = bestChunks.find(c => c.id.startsWith(docId));
      if (!chunk) continue;

      // 生成高亮
      let highlight = chunk.content.slice(0, 500);
      for (const kw of info.hitKeywords) {
        highlight = highlight.replace(
          new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          `**${kw}**`
        );
      }

      results.push({
        chunk,
        score: info.score / matchedKeywords.length,
        scores: {},
        source: 'entity',
        highlight,
      });
    }

    return results;
  }

  /**
   * 强制指定检索方法
   */
  async function forceSearch(
    query: string,
    topK: number,
    method: 'rrf' | 'entity'
  ): Promise<RoutedSearchResult> {
    const matched = extractMatchingKeywords(query, loadEntityKeywords());

    if (method === 'entity' && matched.length > 0) {
      try {
        if (structQuery.isReady()) {
          const structResults = await structQuery.query(matched, 'or');

          const entityResults = await entityRecallWithContext(matched, structResults, topK);

          if (entityResults.length > 0) {
            return {
              results: entityResults,
              method: 'entity',
              matchedKeywords: matched,
            };
          }
        }
      } catch (err) {
        console.warn('[EntityRouter] 强制实体检索失败，降级:', err);
      }

      const entityResults = entityRecall(matched, topK);
      return { results: entityResults, method: 'entity', matchedKeywords: matched };
    }

    const rrfResults = await hybridSearch(query, topK, 20, 20, {
      matchedKeywords: matched.length > 0 ? matched : undefined,
    });
    return { results: rrfResults, method: 'rrf' };
  }

  return {
    extractEntityKeywords(query: string): string[] {
      return extractMatchingKeywords(query, loadEntityKeywords());
    },

    async routedSearch(query, topK = 10, options): Promise<RoutedSearchResult> {
      if (options?.forceMethod) {
        return forceSearch(query, topK, options.forceMethod);
      }

      const matched = extractMatchingKeywords(query, loadEntityKeywords());

      if (matched.length > 0) {
        console.log(`[EntityRouter] 匹配到实体关键字: [${matched.join(', ')}]，使用结构化检索`);

        try {
          if (structQuery.isReady()) {
            const structResults = await structQuery.query(matched, 'or');

            const entityResults = await entityRecallWithContext(matched, structResults, topK);

            if (entityResults.length > 0) {
              return {
                results: entityResults,
                method: 'entity',
                matchedKeywords: matched,
              };
            }
          }
        } catch (err) {
          console.warn('[EntityRouter] 结构化检索失败，降级为倒排索引:', err);
        }

        const entityResults = entityRecall(matched, topK);

        if (entityResults.length < topK) {
          const needMore = topK - entityResults.length;
          const entityChunkIds = new Set(entityResults.map(r => r.chunk.id));
          const rrfResults = await hybridSearch(query, needMore + 5, 20, 20, {
            matchedKeywords: matched.length > 0 ? matched : undefined,
          });
          const supplements = rrfResults
            .filter(r => !entityChunkIds.has(r.chunk.id))
            .slice(0, needMore);
          entityResults.push(...supplements);
        }

        return {
          results: entityResults,
          method: 'entity',
          matchedKeywords: matched,
        };
      }

      console.log(`[EntityRouter] 未匹配到实体关键字，使用 RRF 融合检索`);
      const rrfResults = await hybridSearch(query, topK, 20, 20, {
        matchedKeywords: matched.length > 0 ? matched : undefined,
      });
      return {
        results: rrfResults,
        method: 'rrf',
      };
    },

    loadAllChunks(): Record<string, ChunkMeta> {
      const map = chunkStore.getAll();
      return Object.fromEntries(map);
    },
  };
}
