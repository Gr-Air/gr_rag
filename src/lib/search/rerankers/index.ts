// ============================================================
// 重排器（Spec 029）：QwenReranker（DashScope qwen3-rerank）+ NoopReranker
// Phase 2：rerank 接收 SearchQuery 而非 RetrievalContext
// rerank 由 ragEngine 调用侧持有，输入为含 chunk 的最终 SearchResult
// 召回 10 条 → rerank → 取 top 5
// ============================================================

import { SearchResult } from '../../types';
import type { SearchQuery, Reranker } from '../types';

const RERANK_MODEL = 'qwen3-rerank';
const RERANK_URL = 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks';

interface RerankResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
  usage?: {
    total_tokens: number;
  };
}

/** Qwen 语义重排器：调用 DashScope rerank API，失败时降级为原始排序 */
export class QwenReranker implements Reranker {
  readonly name = 'qwen3-rerank';

  async rerank(
    query: SearchQuery,
    searchResults: SearchResult[],
    topN: number = 5
  ): Promise<SearchResult[]> {
    const apiKey = process.env.DASHSCOPE_API_KEY || '';

    if (searchResults.length === 0) return [];

    if (!apiKey) {
      console.warn('[Reranker] DASHSCOPE_API_KEY 未配置，跳过 rerank');
      return searchResults.slice(0, topN);
    }

    // 如果结果数少于 topN，直接返回
    if (searchResults.length <= topN) {
      return searchResults;
    }

    // 准备文档列表：每条取前 4000 字符作为 rerank 输入（增加长度确保关键信息不被截断）
    const documents = searchResults.map(r => {
      const title = r.chunk.docTitle.replace(/\[\[([^\]]+)\]\]/g, '$1');
      const content = r.chunk.content.replace(/\[\[([^\]]+)\]\]/g, '$1');
      return `[${title}] ${content.slice(0, 4000)}`;
    });

    try {
      console.log(`[Reranker] 开始重排序: ${documents.length} 条文档 → top ${topN}`);

      const response = await fetch(RERANK_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: RERANK_MODEL,
          query: query.query,
          documents,
          top_n: topN,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Rerank API error (${response.status}): ${errText}`);
      }

      const data: RerankResponse = await response.json();

      if (!data.results || data.results.length === 0) {
        console.warn('[Reranker] 重排序返回空结果，使用原始排序');
        return searchResults.slice(0, topN);
      }

      // 按 relevance_score 降序映射回原始 SearchResult
      // 过滤低相关性结果（阈值 0.5），确保不会用低质量结果覆盖高质量检索结果
      // 提升阈值以提高 Context Precision，过滤更多不相关上下文
      // 分数链路：rerank 分写入 scores.rerank，原始 RRF 链路保留不覆盖
      const MIN_RELEVANCE_SCORE = 0.5;
      const filteredReranked = data.results
        .filter(r => r.relevance_score >= MIN_RELEVANCE_SCORE)
        .map(r => ({
          ...searchResults[r.index],
          score: r.relevance_score,
          scores: { ...searchResults[r.index].scores, rerank: r.relevance_score },
        }));

      // 如果过滤后结果不足 topN，补充原始排序的结果
      const finalReranked: SearchResult[] = [...filteredReranked];
      if (filteredReranked.length < topN) {
        const usedIndices = new Set(data.results.map(r => r.index));
        const remaining = searchResults
          .filter((_, idx) => !usedIndices.has(idx))
          .sort((a, b) => b.score - a.score)
          .slice(0, topN - filteredReranked.length);
        finalReranked.push(...remaining);
      }

      console.log(`[Reranker] 重排序完成: ${finalReranked.length} 条（过滤后 ${filteredReranked.length} 条，补充 ${finalReranked.length - filteredReranked.length} 条）`);
      if (data.usage) {
        console.log(`[Reranker] Token 消耗: ${data.usage.total_tokens}`);
      }

      return finalReranked;

    } catch (err) {
      console.error('[Reranker] 重排序失败，降级使用原始排序:', err);
      // 降级：按原始分数排序取 topN
      return [...searchResults]
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
    }
  }
}

/** Noop 重排器：直接截断 topN（无 API key 时的降级，与原先"跳过 rerank"行为一致） */
export class NoopReranker implements Reranker {
  readonly name = 'noop';

  async rerank(
    _query: SearchQuery,
    searchResults: SearchResult[],
    topN: number = 5
  ): Promise<SearchResult[]> {
    return searchResults.slice(0, topN);
  }
}

/** 按环境选择重排器：无 DASHSCOPE_API_KEY 时使用 NoopReranker */
export function getReranker(): Reranker {
  if (!process.env.DASHSCOPE_API_KEY) {
    console.warn('[Reranker] DASHSCOPE_API_KEY 未配置，跳过 rerank');
    return new NoopReranker();
  }
  return new QwenReranker();
}
