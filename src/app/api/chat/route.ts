import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { ragChatStream } from '@/lib/ragEngine';
import { hybridSearch } from '@/lib/hybridSearch';
import { isIndexReady } from '@/lib/indexManager';
import { smartRewrite, fallbackRoute } from '@/lib/queryRewriter';
import { executeStructuredQuery, formatStructResults } from '@/lib/structSearchEngine';

import type { SearchResult } from '@/lib/types';
import { lookupIndexByQuery, isIndexQuery } from '@/lib/indexLookup';
import {
  getOrCreateSession,
  addMessage,
  saveLastSearchResults,
  getLastSearchResults,
  getConversationContext,
  isFollowUpQuery,
  compressConversation,
} from '@/lib/sessionManager';

export async function POST(req: NextRequest) {
  const {
    query,
    topK = 10,
    apiKey,
    baseURL,
    model,
    sessionId,  // 新增：会话 ID
  } = await req.json();

  if (!query || query.trim().length === 0) {
    return new Response('请提供问题', { status: 400 });
  }

  if (!isIndexReady()) {
    return new Response('索引尚未初始化完成，请稍后再试', { status: 503 });
  }

  const trimmedQuery = query.trim();

  // ================================================================
  // 多轮对话：获取或创建会话
  // ================================================================
  const session = getOrCreateSession(sessionId);

  // 对话压缩（异步触发，不阻塞当前请求）
  compressConversation(session.id, { apiKey, baseURL, model }).catch(() => {});

  // 获取对话历史上下文
  const { historyText } = getConversationContext(session.id);

  // 添加用户消息
  addMessage(session.id, 'user', trimmedQuery);

  // 创建 SSE 流
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let fullAnswer = '';

      try {
        // 0. Query Rewriting + 统一路由决策（一次 LLM 调用覆盖全部判断）
        const rewriteResult = await smartRewrite(trimmedQuery, {
          apiKey, baseURL, model,
          previousQuery: getLastSearchResults(session.id)?.query,
        });
        const matched = rewriteResult.entities;
        const rewrittenQuery = rewriteResult.rewrittenQuery;

        // 解析路由决策：LLM 成功时使用 LLM 结果，失败时降级为本地硬编码
        const routeDecision = rewriteResult.routeDecision;
        const isFollowUp = routeDecision
          ? routeDecision.isFollowUp
          : isFollowUpQuery(trimmedQuery); // fallback: 本地硬编码追问检测

        // 路由降级：LLM 不可用时用正则匹配
        const fallbackRouteResult = routeDecision ? null : fallbackRoute(trimmedQuery, matched);
        const effectiveRoute = routeDecision?.route ?? fallbackRouteResult?.route ?? 'semantic';

        // 追问时补充上下文
        let enrichedQuery = trimmedQuery;
        if (isFollowUp) {
          const lastResults = getLastSearchResults(session.id);
          if (lastResults) {
            enrichedQuery = `[上文: 用户之前问"${lastResults.query}"] ${trimmedQuery}`;
            console.log(`[Chat] 检测到追问，补充上下文: "${lastResults.query}"`);
          }
        }

        // 1. 统一检索策略：优先实体关联文档，无实体命中时走语义检索
        let results: SearchResult[] = [];
        let structSummary: string | undefined;
        let entityDocsContent: string | undefined;
        let searchMethod: 'rrf' | 'entity' | 'structured' | 'hybrid' = 'rrf';

        if (matched.length > 0) {
          // 有实体关键词命中：从 SQLite 查关联文档列表，加载 Raw 全文/片段
          const entityResult = await loadEntityDocsContent(matched);
          if (entityResult) {
            structSummary = entityResult.structSummary;
            entityDocsContent = entityResult.docsContent;
            searchMethod = 'structured';
            console.log(`[Chat] 实体关联命中: [${matched.join(', ')}] (${rewriteResult.method})，跳过语义检索`);
          }
        }

        // 如果实体关联无结果，尝试 index.md 元信息查询
        if (!entityDocsContent) {
          // LLM 路由决策优先，fallback 时用本地硬编码
          const shouldTryIndex = routeDecision
            ? routeDecision.indexSection !== null
            : isIndexQuery(trimmedQuery);

          if (shouldTryIndex) {
            const indexResult = lookupIndexByQuery(trimmedQuery);
            if (indexResult) {
              structSummary = `## 📊 ${indexResult.sectionTitle}\n\n${indexResult.content}`;
              entityDocsContent = indexResult.content;
              console.log(`[Chat] IndexLookup 命中: ${indexResult.matchedIntent} (${routeDecision ? 'LLM路由' : '本地规则'})`);
            }
          }
        }

        // 如果结构化查询也无结果，降级为语义检索（使用改写后的 query）
        if (!entityDocsContent && !structSummary) {
          const searchQuery = rewriteResult.method === 'llm' ? rewrittenQuery : enrichedQuery;
          console.log(`[Chat] 无实体关联结果，降级为语义检索（向量+BM25），query="${searchQuery.slice(0, 50)}"`);
          results = await hybridSearch(searchQuery, topK, 20, 20, {
            matchedKeywords: matched.length > 0 ? matched : undefined,
          });
          searchMethod = 'rrf';
        }

        // 保存检索结果到会话（用于后续追问）
        saveLastSearchResults(session.id, trimmedQuery, results, searchMethod, structSummary);

        // 发送检索方法信息
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'method',
              method: searchMethod,
              matchedKeywords: matched.length > 0 ? matched : undefined,
              structSummary: structSummary || undefined,
              entityDocsContent: entityDocsContent || undefined,
              sessionId: session.id,
              rewriteMethod: rewriteResult.method,
              rewrittenQuery: rewriteResult.method === 'llm' ? rewrittenQuery : undefined,
              routeSource: routeDecision ? 'llm' : 'regex-fallback',
              route: effectiveRoute,
              fallbackRouteReason: fallbackRouteResult?.reason,
            })}\n\n`
          )
        );

        // 用改写后的 query 或原始 query 调用 RAG
        const finalQuery = rewriteResult.method === 'llm' ? rewrittenQuery : trimmedQuery;
        const generator = ragChatStream(finalQuery, {
          topK,
          apiKey,
          baseURL,
          model,
          preSearchResults: results,
          structSummary,
          entityDocsContent,
          conversationContext: historyText || undefined,
          isFollowUp,
          enableExpansion: true,  // 启用 Small-to-Big 自适应窗口扩展
          matchedKeywords: matched.length > 0 ? matched : undefined,
          /** LLM 路由决策的窗口大小（优先于 adaptiveWindow 内部判断） */
          contextWindowOverride: routeDecision?.contextWindow,
        });

        for await (const event of generator) {
          if (event.type === 'context') {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'context',
                  sessionId: session.id,
                  results: event.results?.map(r => ({
                    docTitle: r.chunk.docPath
                      ? r.chunk.docPath.replace(/^Raw\//, '').replace(/\.md$/, '')
                      : r.chunk.docTitle,
                    metadata: r.chunk.metadata,
                    source: r.source,
                    score: r.score,
                    content: r.chunk.content,
                    docPath: r.chunk.docPath,
                  })),
                })}\n\n`
              )
            );
          } else if (event.type === 'token') {
            fullAnswer += event.content || '';
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'token', content: event.content })}\n\n`
              )
            );
          } else if (event.type === 'error') {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'error', content: event.content })}\n\n`
              )
            );
          } else if (event.type === 'done') {
            // 保存助手回复
            if (fullAnswer) {
              addMessage(session.id, 'assistant', fullAnswer);
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'done', sessionId: session.id })}\n\n`
              )
            );
          }
        }

        controller.close();
      } catch (err: any) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * 估算文本的 token 数量（混合中英文场景）
 * 中文约 1.5 字符/token，英文/数字约 4 字符/token
 * 返回估算 token 数，用于判断文档是否需要截断
 */
function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    // Unicode 范围：CJK 统一表意文字 + 中文标点
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/.test(ch)) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 加载实体关联文档内容（一步完成：查 SQLite → 读 Raw 文件）
 *
 * 策略：
 * - 短文档（< 3000 token）：全文注入，保留完整上下文
 * - 长文档（≥ 3000 token）：提取实体关键字上下 ±200 token 的片段，
 *   每个文档最多取 3 个片段，重叠区间自动合并
 *
 * @returns structSummary（文档列表摘要）+ docsContent（文档全文/片段），或 undefined
 */
async function loadEntityDocsContent(
  matchedKeywords: string[],
): Promise<{ structSummary: string; docsContent: string } | undefined> {
  // 1. 查结构化数据库，获取关联文档列表
  const { isStructDbReady } = await import('@/lib/structSearchEngine');
  if (!isStructDbReady()) {
    console.warn('[Chat] 结构化数据库未就绪');
    return undefined;
  }

  const structResults = await executeStructuredQuery(matchedKeywords, 'or');
  if (structResults.length === 0) {
    console.log(`[Chat] 结构化数据库未查到 [${matchedKeywords.join(', ')}] 的关联文档`);
    return undefined;
  }

  const structSummary = formatStructResults(structResults);
  console.log(`[Chat] 结构化数据库查询命中: [${matchedKeywords.join(', ')}]，${structResults.length} 条结果`);

  // 2. 收集所有关联文档名（去重）
  const docNames = new Set<string>();
  for (const r of structResults) {
    for (const chunk of r.chunks) {
      const docId = chunk.chunk_id.replace(/_\d+$/, '');
      if (docId.startsWith('raw_')) {
        docNames.add(docId.slice(4));
      }
    }
  }

  if (docNames.size === 0) return undefined;

  // 3. 读 Raw 文件，按策略注入
  const RAW_DIR = path.join(process.cwd(), '..', 'Raw');
  if (!fs.existsSync(RAW_DIR)) {
    console.warn('[Chat] Raw 目录不存在:', RAW_DIR);
    return undefined;
  }

  const SHORT_DOC_TOKEN_LIMIT = 3000;
  const CONTEXT_WINDOW = 200;
  const MAX_SNIPPETS_PER_DOC = 3;
  const CHARS_PER_TOKEN_CN = 1.5;
  const CHARS_PER_TOKEN_EN = 4;

  const parts: string[] = [];
  let shortCount = 0;
  let snippetCount = 0;

  for (const docName of docNames) {
    const filePath = path.join(RAW_DIR, `${docName}.md`);
    if (!fs.existsSync(filePath)) {
      console.warn(`[Chat] Raw 文档不存在: ${filePath}`);
      continue;
    }

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
      console.warn(`[Chat] 读取 Raw 文档失败: ${filePath}`, err);
    }
  }

  if (shortCount === 0 && snippetCount === 0) return undefined;

  console.log(
    `[Chat] 实体关联文档加载: ${shortCount} 篇全文 + ${snippetCount} 篇片段 (共 ${docNames.size} 篇)`,
  );

  return {
    structSummary,
    docsContent: parts.join('\n\n---\n\n'),
  };
}

/**
 * 从长文档中提取实体关键字上下文的片段
 *
 * 算法：
 * 1. 用所有 matchedKeywords 构建正则，匹配文档中所有提及位置
 * 2. 对每处提及，向前后扩展指定 token 数对应的字符
 * 3. 合并重叠的区间
 * 4. 按提及密度排序，取 top-N 个片段
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
  // 构建正则：匹配所有关键字（按长度降序，避免短关键字被长关键字遮蔽）
  const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
  const escaped = sortedKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'gi');

  // 找到所有匹配位置（字符索引）
  const matches: Array<{ start: number; end: number; keyword: string }> = [];
  let match: RegExpExecArray | null;
  // 重置 lastIndex
  pattern.lastIndex = 0;
  while ((match = pattern.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, keyword: match[0] });
  }

  if (matches.length === 0) return null;

  // 估算上下文窗口对应的字符数
  // 取中文和英文 token→字符 的平均值做近似估算
  const avgCharsPerToken = (cnCharsPerToken + enCharsPerToken) / 2;
  const contextChars = Math.ceil(contextTokens * avgCharsPerToken);

  // 对每个匹配位置扩展上下文窗口
  const rawRanges: Array<{ start: number; end: number }> = matches.map((m) => ({
    start: Math.max(0, m.start - contextChars),
    end: Math.min(content.length, m.end + contextChars),
  }));

  // 合并重叠区间
  const mergedRanges = mergeRanges(rawRanges);

  // 计算每个区间的"提及密度"（提及次数 / 区间字符数），密度高的优先
  const scoredRanges = mergedRanges.map((range) => {
    const mentionCount = matches.filter(
      (m) => m.start >= range.start && m.end <= range.end,
    ).length;
    const rangeLength = range.end - range.start;
    const density = mentionCount / (rangeLength || 1);
    return { ...range, mentionCount, density };
  });

  // 按密度降序排序，取 top-N
  scoredRanges.sort((a, b) => b.density - a.density);
  const topRanges = scoredRanges.slice(0, maxSnippets);

  // 按文档中的原始位置排序输出
  topRanges.sort((a, b) => a.start - b.start);

  // 构建输出片段
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
      // 有重叠，合并
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}
