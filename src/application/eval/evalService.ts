// ============================================================
// Eval Use Case（Application 层）
// 从 eval/route.ts 拆出的评估流程编排：
//   query 改写 → 实体关联文档（含 Wiki）/ 语义检索 → RAG 回答
//   → 输出 answer/contexts/sources/逐条分数链路
// ============================================================

import type { SearchResult } from '@/domain/search/types';
import type { ChunkStore } from '@/domain/document/types';
import type { StructQueryPort, EntityRepository } from '@/domain/entity/types';
import type { LlmClient, DocumentFileStore } from '../ports';
import type { HybridSearchFn } from '../search/hybridSearch';
import type { SmartRewriter } from '../search/queryRewriter';
import type { RagChatStreamFn } from '../chat/ragEngine';
import { loadEntityDocsContentForEval, filterChunksByDocTypes } from '../chat/entityDocs';

export interface EvalRequest {
  query: string;
  topK?: number;
  llm?: LlmClient;
}

export interface EvalResult {
  query: string;
  answer: string;
  contexts: string[];
  sources: string[];
  searchMethod: 'rrf' | 'entity';
  numResults: number;
  matchedEntities: string[];
  /** 逐条分数链路（score/scores 与 contexts 一一对应），供评估追溯 RRF→rerank 打分过程 */
  resultScores: Array<{ score: number; scores: SearchResult['scores'] }>;
}

/** 客户企业特征正则（判断是否走结构化检索） */
const ENTERPRISE_PATTERN = /集团|公司|银行|证券|电力|保险|能源|通信|钢铁|船舶|置地|宝武|中车|中化|中钢|招商局|华润|中信|浦发|招商|万科|中粮|南方电网|国家电网|中国移动|中国联通|中国电信|中国银行|建设银行|农业银行|工商银行|交通银行|国泰君安|华泰|光大|民生|平安|太平洋|新华|人寿/;

export interface EvalService {
  evaluate(req: EvalRequest): Promise<EvalResult>;
}

export function createEvalService(deps: {
  llm: LlmClient;
  chunkStore: ChunkStore;
  structQuery: StructQueryPort;
  entityRepo: EntityRepository;
  fileStore: DocumentFileStore;
  hybridSearch: HybridSearchFn;
  smartRewriter: SmartRewriter;
  ragChatStream: RagChatStreamFn;
}): EvalService {
  const {
    llm: defaultLlm,
    chunkStore,
    structQuery,
    entityRepo,
    fileStore,
    hybridSearch,
    smartRewriter,
    ragChatStream,
  } = deps;

  function extractEnterpriseEntities(matchedEntities: string[]): string[] {
    if (!structQuery.isReady()) return [];

    const knownEntities = entityRepo.getKnownEntities();
    const entityMap = new Map<string, { type: string; category: string }>();
    for (const e of knownEntities) {
      entityMap.set(e.name.toLowerCase(), { type: e.type, category: e.category });
    }

    const results: string[] = [];
    for (const entity of matchedEntities) {
      const info = entityMap.get(entity.toLowerCase());
      if (info && info.type === 'entity' && ENTERPRISE_PATTERN.test(entity)) {
        results.push(entity);
      }
    }

    return results;
  }

  function shouldUseStructuredSearch(matchedEntities: string[]): boolean {
    return extractEnterpriseEntities(matchedEntities).length > 0;
  }

  return {
    async evaluate(req: EvalRequest): Promise<EvalResult> {
      const {
        query,
        topK = 10,
        llm,
      } = req;
      const clientLlm = llm ?? defaultLlm;

      const trimmedQuery = query.trim();

      const rewriteResult = await smartRewriter.rewrite(trimmedQuery, {
        llm: clientLlm,
        previousQuery: undefined,
      });
      const matched = rewriteResult.entities;
      const rewrittenQuery = rewriteResult.rewrittenQuery;

      let results: SearchResult[] = [];
      let entityDocsContent: string | undefined;
      let entitySources: string[] = [];
      let searchMethod: 'rrf' | 'entity' = 'rrf';

      // 实体关联文档加载（完整策略：Wiki 词条 + 短文档全文，长文档片段提取）
      // 使用所有匹配的实体进行 OR 查询，确保精确匹配到目标文档
      if (matched.length > 0 && shouldUseStructuredSearch(matched)) {
        const entityResult = await loadEntityDocsContentForEval(structQuery, fileStore, matched);
        if (entityResult) {
          entityDocsContent = entityResult.docsContent;
          entitySources = entityResult.sources;
          searchMethod = 'entity';
        }
      }

      // 降级为语义检索
      if (!entityDocsContent) {
        const filteredChunkIds = rewriteResult.relevantDocTypes?.length > 0
          ? filterChunksByDocTypes(chunkStore, rewriteResult.relevantDocTypes, '[Eval]')
          : null;
        const semanticResults = await hybridSearch(rewrittenQuery || trimmedQuery, topK, 20, 20, {
          matchedKeywords: matched.length > 0 ? matched : undefined,
          filteredChunkIds: filteredChunkIds ?? undefined,
        });
        results = semanticResults;
        searchMethod = 'rrf';
      }

      let answer = '';
      let finalResults: SearchResult[] = results;

      if (results.length > 0 || entityDocsContent) {
        const generator = ragChatStream(trimmedQuery, {
          llm: clientLlm,
          topK,
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

      return {
        query: trimmedQuery,
        answer,
        contexts: contextChunks,
        sources: finalSources,
        searchMethod,
        numResults: finalNumResults,
        matchedEntities: matched,
        resultScores: finalResults.slice(0, topK).map(r => ({
          score: r.score,
          scores: r.scores ?? {},
        })),
      };
    },
  };
}
