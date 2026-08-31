// ============================================================
// 实体路由检索引擎
// 策略：
//   1. 从 SQLite 加载所有实体词条名作为关键字
//   2. 用户提问时，用字典最大匹配法检测是否包含实体关键字
//   3. 有匹配 → 结构化查询，返回包含实体的上下文片段（±200 token）
//   4. 无匹配 → 走向量+BM25 RRF 融合检索
// ============================================================

import fs from 'fs';
import path from 'path';
import { DocChunk, SearchResult } from './types';
import { hybridSearch } from './search';

// ============================================================
// 实体关键字加载（从 SQLite 加载，按频次排序）
// ============================================================

let entityKeywords: string[] | null = null;
let keywordSet: Set<string> | null = null;

/** 从 SQLite 加载所有实体/概念词条名 */
export function loadEntityKeywords(): string[] {
  if (entityKeywords) return entityKeywords;

  try {
    const { getKnownEntityNames, isStructDbReady } = require('./structSearchEngine');
    if (isStructDbReady()) {
      const entities = getKnownEntityNames() as { name: string; type: string }[];
      // 只加载实体类型，排除概念
      const filteredEntities = entities.filter((e) => e.type === 'entity');
      const keywords = filteredEntities.map((e) => e.name).sort((a: string, b: string) => b.length - a.length);
      entityKeywords = keywords;
      keywordSet = new Set(keywords);
      console.log(`[EntityRouter] 从 SQLite 加载 ${keywords.length} 个实体关键字`);
      return keywords;
    }
  } catch (err) {
    console.warn('[EntityRouter] 无法从 SQLite 加载实体，降级为空列表:', err);
  }

  entityKeywords = [];
  keywordSet = new Set();
  return entityKeywords;
}

/** 获取关键字集合（快速查找） */
export function getKeywordSet(): Set<string> {
  if (!keywordSet) loadEntityKeywords();
  return keywordSet!;
}

// ============================================================
// 实体匹配（字典最大匹配）
// ============================================================

/**
 * 从用户问题中提取匹配的实体关键字
 * 使用贪婪最大匹配，优先匹配长词
 */
export function extractEntityKeywords(query: string): string[] {
  const keywords = loadEntityKeywords();
  const matched: Set<string> = new Set();
  const queryLower = query.toLowerCase();

  // 构建关键字的大小写不敏感映射表: 小写 → 原始关键字列表
  // 同一个小写形式可能对应多个原始关键字（如 Docker 和 docker）
  const lowerToOriginal = new Map<string, string[]>();
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    if (!lowerToOriginal.has(lower)) lowerToOriginal.set(lower, []);
    lowerToOriginal.get(lower)!.push(kw);
  }

  // 贪心最大匹配（从当前位置开始，按原始关键字长度降序尝试）
  let i = 0;
  while (i < query.length) {
    let found = false;

    for (const kw of keywords) {
      const kwLen = kw.length;
      if (i + kwLen > query.length) continue;
      // 大小写不敏感比较
      if (queryLower.slice(i, i + kwLen) === kw.toLowerCase()) {
        matched.add(kw);
        i += kwLen;
        found = true;
        break;
      }
    }

    if (!found) i++;
  }

  // 也尝试在整个 query 中搜索（处理非连续匹配的情况）
  for (const kw of keywords) {
    if (queryLower.includes(kw.toLowerCase())) {
      matched.add(kw);
    }
  }

  return [...matched].sort((a, b) => b.length - a.length);
}

// ============================================================
// 实体召回检索
// ============================================================

const CHUNKS_META_DIR = path.join(process.cwd(), 'src', 'data', 'chunks_meta');

export function loadAllChunks(): Record<string, {
  docId: string; docTitle: string; docPath: string;
  metadata: DocChunk['metadata']; content: string; wikiLinks: string[];
}> {
  const configPath = path.join(CHUNKS_META_DIR, 'config.json');
  if (!fs.existsSync(configPath)) return {};

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const allChunks: Record<string, any> = {};

  for (let s = 0; s < config.totalShards; s++) {
    const shardPath = path.join(CHUNKS_META_DIR, `shard_${s}.json`);
    if (!fs.existsSync(shardPath)) continue;
    const shard = JSON.parse(fs.readFileSync(shardPath, 'utf-8'));
    Object.assign(allChunks, shard);
  }

  return allChunks;
}

// 缓存：entity → chunkIds 的倒排索引
let entityToChunks: Map<string, string[]> | null = null;

/** 构建实体→文档块的倒排索引 */
export function buildEntityInvertedIndex(): Map<string, string[]> {
  if (entityToChunks) return entityToChunks;

  const index = new Map<string, string[]>();
  const allChunks = loadAllChunks();

  for (const [chunkId, chunk] of Object.entries(allChunks)) {
    if (!chunk.wikiLinks || chunk.wikiLinks.length === 0) continue;
    for (const link of chunk.wikiLinks) {
      if (!index.has(link)) index.set(link, []);
      index.get(link)!.push(chunkId);
    }
  }

  entityToChunks = index;
  console.log(`[EntityRouter] 倒排索引构建完成: ${index.size} 个实体, ${allChunks ? Object.keys(allChunks).length : 0} 个文档块`);
  return entityToChunks;
}

/**
 * 从文档内容中提取包含实体的上下文片段
 * 每个实体匹配点提取 ±200 token 的上下文，最多 3 个片段，重叠区间合并
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

/**
 * 实体检索：从结构化查询结果中提取包含实体的上下文片段
 * 返回包含实体的文档上下文（±200 token）
 */
async function entityRecallWithContext(
  matchedKeywords: string[],
  structResults: import('./structSearchEngine').StructSearchResult[],
  topK: number
): Promise<SearchResult[]> {
  const allChunksData = loadAllChunks();

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

      const chunkData = allChunksData[chunkId];
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
  // 注意：倒排索引可能只匹配到 _0、_1 等少量 chunk，需要加载该 doc 的全部 chunk 来选最佳
  // 直接从已加载的 allChunksData 构建 DocChunk，避免二次 I/O
  const allChunksData = loadAllChunks();
  const bestChunks: DocChunk[] = [];

  for (const [docId] of rankedDocs) {
    // 找出该 docId 的所有 chunk（格式: raw_xxx_N）
    const docChunkIds = Object.keys(allChunksData).filter(k => k.startsWith(docId));
    if (docChunkIds.length === 0) continue;

    // 直接从 allChunksData 构建 DocChunk 列表，无需再次读文件
    const chunks: DocChunk[] = docChunkIds
      .map(id => {
        const data = allChunksData[id];
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

// ============================================================
// 路由检索主函数
// ============================================================

export interface RoutedSearchResult {
  results: SearchResult[];
  /** 检索方法 */
  method: 'rrf' | 'entity';
  /** 匹配到的实体关键字（entity 方法时） */
  matchedKeywords?: string[];
}

/**
 * 简化路由检索：两条路径
 *
 * 1. 有实体匹配 → 结构化查询，返回包含实体的上下文片段（±200 token）
 * 2. 无实体匹配 → RRF 融合检索（向量+BM25）
 */
export async function routedSearch(
  query: string,
  topK: number = 10,
  options?: {
    /** 强制使用指定检索方法 */
    forceMethod?: 'rrf' | 'entity';
    /** LLM API 配置（保留兼容） */
    apiKey?: string;
    baseURL?: string;
    model?: string;
  }
): Promise<RoutedSearchResult> {
  if (options?.forceMethod) {
    return forceSearch(query, topK, options.forceMethod);
  }

  const matched = extractEntityKeywords(query);

  if (matched.length > 0) {
    console.log(`[EntityRouter] 匹配到实体关键字: [${matched.join(', ')}]，使用结构化检索`);

    try {
      const { isStructDbReady, executeStructuredQuery } = await import('./structSearchEngine');

      if (isStructDbReady()) {
        const structResults = await executeStructuredQuery(matched, 'or');

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
}

/**
 * 强制指定检索方法
 */
async function forceSearch(
  query: string,
  topK: number,
  method: 'rrf' | 'entity'
): Promise<RoutedSearchResult> {
  const matched = extractEntityKeywords(query);

  if (method === 'entity' && matched.length > 0) {
    try {
      const { isStructDbReady, executeStructuredQuery } = await import('./structSearchEngine');

      if (isStructDbReady()) {
        const structResults = await executeStructuredQuery(matched, 'or');

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

/** 初始化：预加载实体关键字和倒排索引 */
export function initEntityRouter(): void {
  loadEntityKeywords();
  // 异步构建倒排索引（不阻塞启动）
  setTimeout(() => buildEntityInvertedIndex(), 100);
}
