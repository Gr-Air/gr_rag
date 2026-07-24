import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { ragChatStream } from '@/lib/ragEngine';
import { hybridSearch } from '@/lib/hybridSearch';
import { isIndexReady } from '@/lib/indexManager';
import { smartRewrite, fallbackRoute } from '@/lib/queryRewriter';
import { executeStructuredQuery, formatStructResults, getKnownEntityNames, isStructDbReady } from '@/lib/structSearchEngine';

import type { SearchResult } from '@/lib/types';
import { lookupIndexByQuery, isIndexQuery } from '@/lib/indexLookup';

function shouldUseStructuredSearch(matchedEntities: string[]): boolean {
  if (!isStructDbReady()) return false;
  
  const knownEntities = getKnownEntityNames();
  const entityMap = new Map<string, { type: string; category: string }>();
  
  for (const e of knownEntities) {
    entityMap.set(e.name.toLowerCase(), { type: e.type, category: e.category });
  }
  
  const enterprisePattern = /集团|公司|银行|证券|电力|保险|能源|通信|钢铁|船舶|置地|宝武|中车|中化|中钢|招商局|华润|中信|浦发|招商|万科|中粮|南方电网|国家电网|中国移动|中国联通|中国电信|中国银行|建设银行|农业银行|工商银行|交通银行|国泰君安|华泰|光大|民生|平安|太平洋|新华|人寿/;
  
  for (const entity of matchedEntities) {
    const info = entityMap.get(entity.toLowerCase());
    if (info && info.type === 'entity' && enterprisePattern.test(entity)) {
      return true;
    }
  }
  
  return false;
}

function extractEnterpriseEntities(matchedEntities: string[]): string[] {
  if (!isStructDbReady()) return [];
  
  const knownEntities = getKnownEntityNames();
  const entityMap = new Map<string, { type: string; category: string }>();
  
  for (const e of knownEntities) {
    entityMap.set(e.name.toLowerCase(), { type: e.type, category: e.category });
  }
  
  const enterprisePattern = /集团|公司|银行|证券|电力|保险|能源|通信|钢铁|船舶|置地|宝武|中车|中化|中钢|招商局|华润|中信|浦发|招商|万科|中粮|南方电网|国家电网|中国移动|中国联通|中国电信|中国银行|建设银行|农业银行|工商银行|交通银行|国泰君安|华泰|光大|民生|平安|太平洋|新华|人寿/;
  
  const results: string[] = [];
  for (const entity of matchedEntities) {
    const info = entityMap.get(entity.toLowerCase());
    if (info && info.type === 'entity' && enterprisePattern.test(entity)) {
      results.push(entity);
    }
  }
  
  return results;
}

export async function POST(req: NextRequest) {
  const {
    query,
    topK = 10,
    apiKey,
    baseURL,
    model,
  } = await req.json();

  if (!query || query.trim().length === 0) {
    return new Response(JSON.stringify({ error: '请提供问题' }), { status: 400 });
  }

  if (!isIndexReady()) {
    return new Response(JSON.stringify({ error: '索引尚未初始化完成' }), { status: 503 });
  }

  const trimmedQuery = query.trim();

  try {
    const rewriteResult = await smartRewrite(trimmedQuery, {
      apiKey, baseURL, model,
      previousQuery: undefined,
    });
    const matched = rewriteResult.entities;
    const rewrittenQuery = rewriteResult.rewrittenQuery;

    const routeDecision = rewriteResult.routeDecision;
    const effectiveRoute = routeDecision?.route ?? fallbackRoute(trimmedQuery, matched)?.route ?? 'semantic';

    let results: SearchResult[] = [];
    let structSummary: string | undefined;
    let entityDocsContent: string | undefined;
    let entitySources: string[] = [];
    let searchMethod: 'rrf' | 'entity' = 'rrf';

    // 实体关联文档加载（完整策略：短文档全文，长文档片段提取）
    // 使用所有匹配的实体进行 OR 查询，确保精确匹配到目标文档
    if (matched.length > 0 && shouldUseStructuredSearch(matched)) {
      const entityResult = await loadEntityDocsContent(matched);
      if (entityResult) {
        structSummary = entityResult.structSummary;
        entityDocsContent = entityResult.docsContent;
        entitySources = entityResult.sources;
        searchMethod = 'entity';
      }
    }

    // Index 元信息查询
    if (!entityDocsContent) {
      const shouldTryIndex = routeDecision
        ? routeDecision.indexSection !== null
        : isIndexQuery(trimmedQuery);

      if (shouldTryIndex) {
        const indexResult = lookupIndexByQuery(trimmedQuery);
        if (indexResult) {
          structSummary = `## 📊 ${indexResult.sectionTitle}\n\n${indexResult.content}`;
          entityDocsContent = indexResult.content;
        }
      }
    }

    // 降级为语义检索
    if (!entityDocsContent && !structSummary) {
      const semanticResults = await hybridSearch(rewrittenQuery || trimmedQuery, topK, 20, 20, {
        matchedKeywords: matched.length > 0 ? matched : undefined,
      });
      results = semanticResults;
      searchMethod = 'rrf';
    }

    let answer = '';
    let finalResults: SearchResult[] = results;

    if (results.length > 0 || entityDocsContent || structSummary) {
      const generator = ragChatStream(trimmedQuery, { 
        apiKey, 
        baseURL, 
        model,
        topK,
        structSummary,
        entityDocsContent,
        preSearchResults: results.length > 0 ? results : undefined,
      });
      
      let fullAnswer = '';
      for await (const chunk of generator) {
        if (chunk.type === 'token' && chunk.content) {
          fullAnswer += chunk.content;
        } else if (chunk.type === 'context' && chunk.results) {
          finalResults = chunk.results;
        }
      }
      answer = fullAnswer || '未能生成回答';
    } else {
      answer = '未检索到相关资料，请尝试其他关键词。';
    }

    const contextChunks = finalResults.slice(0, topK).map(r => r.chunk?.content || '').filter(Boolean);
    const contextSources = finalResults.slice(0, topK).map(r => r.chunk?.docTitle || 'unknown').filter(Boolean);

    // 如果有实体文档内容，作为主要上下文
    if (entityDocsContent) {
      contextChunks.unshift(entityDocsContent.slice(0, 5000)); // 扩大上下文长度到 5000 字符
    }

    // 根据检索类型确定结果数量和来源
    let finalNumResults = finalResults.length;
    let finalSources = contextSources;
    if (searchMethod === 'entity' && entitySources.length > 0) {
      finalNumResults = entitySources.length;
      finalSources = entitySources;
    }

    return new Response(JSON.stringify({
      query: trimmedQuery,
      answer,
      contexts: contextChunks,
      sources: finalSources,
      searchMethod,
      numResults: finalNumResults,
      matchedEntities: matched,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[Eval API Error]', error);
    return new Response(JSON.stringify({
      query: trimmedQuery,
      answer: '',
      contexts: [],
      sources: [],
      searchMethod: 'error',
      numResults: 0,
      matchedEntities: [],
      error: (error as Error).message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * 估算文本的 token 数量（混合中英文场景）
 * 中文约 1.5 字符/token，英文/数字约 4 字符/token
 */
function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/.test(ch)) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 加载实体关联文档内容（完整策略）
 *
 * 策略：
 * - 短文档（< 3000 token）：全文注入
 * - 长文档（≥ 3000 token）：提取实体关键字上下 ±200 token 的片段
 *   每个文档最多取 3 个片段，重叠区间自动合并
 */
async function loadEntityDocsContent(
  matchedKeywords: string[],
): Promise<{ structSummary: string; docsContent: string; sources: string[] } | undefined> {
  const { isStructDbReady } = await import('@/lib/structSearchEngine');
  if (!isStructDbReady()) {
    console.warn('[Eval] 结构化数据库未就绪');
    return undefined;
  }

  let structResults = await executeStructuredQuery(matchedKeywords, 'or');
  
  const hasChunks = structResults.some(r => r.chunks.length > 0);
  
  if (!hasChunks) {
    console.log(`[Eval] 结构化数据库 OR 查询未命中，尝试 AND 查询...`);
    structResults = await executeStructuredQuery(matchedKeywords, 'and');
  }
  
  if (structResults.length === 0 || !structResults.some(r => r.chunks.length > 0)) {
    console.log(`[Eval] 结构化数据库未查到 [${matchedKeywords.join(', ')}] 的关联文档`);
    return undefined;
  }

  const structSummary = formatStructResults(structResults);
  console.log(`[Eval] 结构化数据库查询命中: [${matchedKeywords.join(', ')}]，${structResults.length} 条结果`);

  const docNames = new Set<string>();
  const wikiEntries = new Map<string, string>();

  for (const r of structResults) {
    for (const chunk of r.chunks) {
      const docId = chunk.chunk_id.replace(/_\d+$/, '');
      if (docId.startsWith('raw_')) {
        docNames.add(docId.replace(/^raw_/, ''));
      } else if (docId.startsWith('wiki_')) {
        wikiEntries.set(r.entry.name, r.entry.path || '');
      }
    }
    if (r.entry.type === 'concept' && r.entry.path) {
      wikiEntries.set(r.entry.name, r.entry.path);
    }
  }

  const RAW_DIR = path.join(process.cwd(), '..', 'Raw');
  const WIKI_DIR = path.join(process.cwd(), '..', 'Wiki');
  console.log(`[Eval] RAW_DIR: ${RAW_DIR}, exists: ${fs.existsSync(RAW_DIR)}`);
  console.log(`[Eval] WIKI_DIR: ${WIKI_DIR}, exists: ${fs.existsSync(WIKI_DIR)}`);

  const SHORT_DOC_TOKEN_LIMIT = 3000;
  const CONTEXT_WINDOW = 200;
  const MAX_SNIPPETS_PER_DOC = 3;
  const CHARS_PER_TOKEN_CN = 1.5;
  const CHARS_PER_TOKEN_EN = 4;

  const parts: string[] = [];
  let shortCount = 0;
  let snippetCount = 0;
  let wikiCount = 0;

  for (const [entryName, entryPath] of wikiEntries) {
    const wikiFilePath = path.join(WIKI_DIR, entryPath);
    if (fs.existsSync(wikiFilePath)) {
      try {
        const content = fs.readFileSync(wikiFilePath, 'utf-8');
        const cleanContent = content.replace(/\[\[([^\]]+)\]\]/g, '$1');
        parts.push(`### Wiki 词条：${entryName}\n\n${cleanContent}`);
        wikiCount++;
      } catch (err) {
        console.warn(`[Eval] 读取 Wiki 词条失败: ${wikiFilePath}`, err);
      }
    }
  }

  if (docNames.size > 0 && fs.existsSync(RAW_DIR)) {
    for (const docName of docNames) {
      const filePath = path.join(RAW_DIR, `${docName}.md`);
      if (!fs.existsSync(filePath)) continue;

      try {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        const content = rawContent.replace(/\[\[([^\]]+)\]\]/g, '$1');
        const docTokens = estimateTokens(content);

        if (docTokens < SHORT_DOC_TOKEN_LIMIT) {
          parts.push(`### ${docName}（全文，${docTokens} token）\n\n${content}`);
          shortCount++;
        } else {
          const snippets = extractEntitySnippets(
            content, docName, matchedKeywords,
            CONTEXT_WINDOW, MAX_SNIPPETS_PER_DOC,
            CHARS_PER_TOKEN_CN, CHARS_PER_TOKEN_EN,
          );
          if (snippets) {
            parts.push(snippets);
            snippetCount++;
          }
        }
      } catch (err) {
        console.warn(`[Eval] 读取 Raw 文档失败: ${filePath}`, err);
      }
    }
  }

  if (shortCount === 0 && snippetCount === 0 && wikiCount === 0) return undefined;

  console.log(
    `[Eval] 实体关联文档加载: ${wikiCount} 篇 Wiki + ${shortCount} 篇全文 + ${snippetCount} 篇片段`,
  );

  const sources = [...docNames, ...wikiEntries.keys()];

  return {
    structSummary,
    docsContent: parts.join('\n\n---\n\n'),
    sources,
  };
}

/**
 * 从长文档中提取实体关键字上下文的片段
 */
function extractEntitySnippets(
  content: string,
  docName: string,
  keywords: string[],
  contextTokens: number,
  maxSnippets: number,
  cnCharsPerToken: number,
  enCharsPerToken: number,
): string | null {
  const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
  const escaped = sortedKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'gi');

  const matches: Array<{ start: number; end: number; keyword: string }> = [];
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, keyword: match[0] });
  }

  if (matches.length === 0) return null;

  const avgCharsPerToken = (cnCharsPerToken + enCharsPerToken) / 2;
  const contextChars = Math.ceil(contextTokens * avgCharsPerToken);

  const rawRanges: Array<{ start: number; end: number }> = matches.map((m) => ({
    start: Math.max(0, m.start - contextChars),
    end: Math.min(content.length, m.end + contextChars),
  }));

  const mergedRanges = mergeRanges(rawRanges);

  const scoredRanges = mergedRanges.map((range) => {
    const mentionCount = matches.filter(
      (m) => m.start >= range.start && m.end <= range.end,
    ).length;
    const rangeLength = range.end - range.start;
    const density = mentionCount / (rangeLength || 1);
    return { ...range, mentionCount, density };
  });

  scoredRanges.sort((a, b) => b.density - a.density);
  const topRanges = scoredRanges.slice(0, maxSnippets);
  topRanges.sort((a, b) => a.start - b.start);

  const snippetParts = topRanges.map((range, idx) => {
    const snippet = content.slice(range.start, range.end).trim();
    const startToken = estimateTokens(content.slice(0, range.start));
    const endToken = startToken + estimateTokens(snippet);
    const header =
      topRanges.length > 1
        ? `#### 片段 ${idx + 1}（约第 ${startToken}-${endToken} token，提及 ${range.mentionCount} 次）`
        : `#### 实体上下文片段（约第 ${startToken}-${endToken} token，提及 ${range.mentionCount} 次）`;
    return `${header}\n\n${snippet}`;
  });

  return `### ${docName}（长文档片段提取，原文档约 ${estimateTokens(content)} token）\n\n${snippetParts.join('\n\n')}`;
}

/**
 * 合并重叠或相邻的字符区间
 */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}