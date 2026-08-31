// ============================================================
// Chat Use Case（Application 层）
// 从 chat/route.ts 拆出的业务流程编排：
//   会话管理 → query 改写 → 缓存检查 → 实体关联文档 → 混合检索
//   → RAG 流式回答 → 会话记录
//
// 依赖全部为 Port / Domain 抽象 / 注入的 Use Case，
// Presentation（route）只做 SSE 事件映射
// ============================================================

import type { SearchResult } from '@/domain/search/types';
import { POLICY_VERSION } from '@/domain/search/queryPolicy';
import type { ChunkStore } from '@/domain/document/types';
import type { StructQueryPort } from '@/domain/entity/types';
import type {
  LlmClient,
  EmbeddingPort,
  SearchCachePort,
  DocumentFileStore,
} from '../ports';
import type { HybridSearchFn } from '../search/hybridSearch';
import type { SmartRewriter, SmartRewriteOptions } from '../search/queryRewriter';
import type { RagChatStreamFn } from './ragEngine';
import { loadEntityDocsContent, filterChunksByDocTypes } from './entityDocs';
import {
  getOrCreateSession,
  addMessage,
  saveLastSearchResults,
  getLastSearchResults,
  getConversationContext,
  isFollowUpQuery,
  compressConversation,
} from './sessionManager';

// ============================================================
// 流事件类型（route 负责映射为 SSE payload）
// ============================================================

export type ChatStreamEvent =
  | {
      type: 'method';
      method: 'rrf' | 'entity';
      matchedKeywords?: string[];
      entityDocsContent?: string;
      sessionId: string;
      rewriteMethod: 'llm' | 'fallback';
      rewrittenQuery?: string;
    }
  | { type: 'context'; sessionId: string; results: SearchResult[] }
  | { type: 'token'; content?: string }
  | { type: 'error'; content?: string }
  | { type: 'done'; sessionId: string };

export interface ChatRequestOptions extends SmartRewriteOptions {
  topK?: number;
  sessionId?: string;
}

export interface ChatService {
  /**
   * 执行完整 chat 流程，产出流事件
   *
   * @param query - 用户问题（调用方保证非空）
   */
  chat(query: string, options?: ChatRequestOptions): AsyncGenerator<ChatStreamEvent>;
}

// ============================================================
// 工厂
// ============================================================

export function createChatService(deps: {
  llm: LlmClient;
  embedding: EmbeddingPort;
  cache: SearchCachePort;
  chunkStore: ChunkStore;
  structQuery: StructQueryPort;
  fileStore: DocumentFileStore;
  hybridSearch: HybridSearchFn;
  smartRewriter: SmartRewriter;
  ragChatStream: RagChatStreamFn;
}): ChatService {
  const {
    llm,
    embedding,
    cache,
    chunkStore,
    structQuery,
    fileStore,
    hybridSearch,
    smartRewriter,
    ragChatStream,
  } = deps;

  return {
    async *chat(query: string, options?: ChatRequestOptions): AsyncGenerator<ChatStreamEvent> {
      const {
        topK = 10,
        sessionId,
        apiKey,
        baseURL,
        model,
      } = options ?? {};

      // ================================================================
      // 多轮对话：获取或创建会话
      // ================================================================
      const session = getOrCreateSession(sessionId);

      // 对话压缩（异步触发，不阻塞当前请求）
      compressConversation(session.id, { apiKey, baseURL, model }, llm).catch(() => {});

      // 获取对话历史上下文
      const { historyText } = getConversationContext(session.id);

      // 添加用户消息
      addMessage(session.id, 'user', query);

      // 0. Query Rewriting + 统一路由决策（一次 LLM 调用覆盖全部判断）
      const rewriteResult = await smartRewriter.rewrite(query, {
        apiKey, baseURL, model,
        previousQuery: getLastSearchResults(session.id)?.query,
      });
      const matched = rewriteResult.entities;
      const rewrittenQuery = rewriteResult.rewrittenQuery;

      // 解析路由决策：LLM 成功时使用 LLM 结果，失败时降级为本地硬编码
      const routeDecision = rewriteResult.routeDecision;
      const isFollowUp = routeDecision
        ? routeDecision.isFollowUp
        : isFollowUpQuery(query); // fallback: 本地硬编码追问检测

      // 0.5. 检索结果缓存检查（非追问 && LLM 改写 && 非实体路径）
      //   缓存对象：hybridSearch 输出的 SearchResult[]（pre-rerank）
      //   命中后：跳过 hybridSearch，仍执行 rerank + LLM（保持模型相关性）
      let cachedResults: SearchResult[] | null = null;
      let queryEmbedding: number[] | null = null;
      if (!isFollowUp && rewriteResult.method === 'llm') {
        try {
          queryEmbedding = await embedding.embed(rewrittenQuery);
          cachedResults = cache.lookup(rewrittenQuery, queryEmbedding, {
            entities: matched,
            policyVersion: POLICY_VERSION,
          });
        } catch {
          // embedding 生成失败，跳过缓存
        }
      }

      // 追问时补充上下文
      let enrichedQuery = query;
      if (isFollowUp) {
        const lastResults = getLastSearchResults(session.id);
        if (lastResults) {
          enrichedQuery = `[上文: 用户之前问"${lastResults.query}"] ${query}`;
          console.log(`[Chat] 检测到追问，补充上下文: "${lastResults.query}"`);
        }
      }

      // 1. 统一检索策略：优先实体关联文档，无实体命中时走语义检索
      let results: SearchResult[] = [];
      let entityDocsContent: string | undefined;
      let searchMethod: 'rrf' | 'entity' = 'rrf';

      if (matched.length > 0) {
        // 有实体关键词命中：从 SQLite 查关联文档列表，加载 Raw 全文/片段
        const entityResult = await loadEntityDocsContent(structQuery, fileStore, matched);
        if (entityResult) {
          entityDocsContent = entityResult.docsContent;
          searchMethod = 'entity';
          console.log(`[Chat] 实体关联命中: [${matched.join(', ')}] (${rewriteResult.method})，跳过语义检索`);
        }
      }

      // 如果实体关联无结果，降级为语义检索（使用改写后的 query）
      if (!entityDocsContent) {
        if (cachedResults) {
          // 缓存命中：跳过 hybridSearch，直接用缓存结果
          console.log(`[Chat] 检索缓存命中，跳过 hybridSearch`);
          results = cachedResults;
        } else {
          const searchQuery = rewriteResult.method === 'llm' ? rewrittenQuery : enrichedQuery;
          console.log(`[Chat] 无实体关联结果，降级为语义检索（向量+BM25），query="${searchQuery.slice(0, 50)}"`);
          // 如果有 LLM 推荐的文档类型，先过滤 chunk 再检索
          const filteredChunkIds = rewriteResult.relevantDocTypes?.length > 0
            ? filterChunksByDocTypes(chunkStore, rewriteResult.relevantDocTypes)
            : null;
          results = await hybridSearch(searchQuery, topK, 20, 20, {
            matchedKeywords: matched.length > 0 ? matched : undefined,
            filteredChunkIds: filteredChunkIds ?? undefined,
          });
          // 缓存写入（仅 LLM 改写 + 非追问 + 已计算 embedding 时）
          if (queryEmbedding && rewriteResult.method === 'llm' && !isFollowUp) {
            cache.save(rewrittenQuery, queryEmbedding, results, {
              entities: matched,
              policyVersion: POLICY_VERSION,
            });
            // 预热向量引擎的 embedding 缓存，避免 vectorSearch 重复调用 API
            embedding.prewarm(
              rewriteResult.method === 'llm' ? rewrittenQuery : enrichedQuery,
              queryEmbedding
            );
          }
        }
        searchMethod = 'rrf';
      }

      // 保存检索结果到会话（用于后续追问）
      saveLastSearchResults(session.id, query, results, searchMethod);

      // 发送检索方法信息
      yield {
        type: 'method',
        method: searchMethod,
        matchedKeywords: matched.length > 0 ? matched : undefined,
        entityDocsContent: entityDocsContent || undefined,
        sessionId: session.id,
        rewriteMethod: rewriteResult.method,
        rewrittenQuery: rewriteResult.method === 'llm' ? rewrittenQuery : undefined,
      };

      // 用改写后的 query 或原始 query 调用 RAG
      const finalQuery = rewriteResult.method === 'llm' ? rewrittenQuery : query;
      const generator = ragChatStream(finalQuery, {
        topK,
        apiKey,
        baseURL,
        model,
        preSearchResults: results,
        entityDocsContent,
        conversationContext: historyText || undefined,
        isFollowUp,
        matchedKeywords: matched.length > 0 ? matched : undefined,
      });

      let fullAnswer = '';
      for await (const event of generator) {
        if (event.type === 'context') {
          yield { type: 'context', sessionId: session.id, results: event.results ?? [] };
        } else if (event.type === 'token') {
          fullAnswer += event.content || '';
          yield { type: 'token', content: event.content };
        } else if (event.type === 'error') {
          yield { type: 'error', content: event.content };
        } else if (event.type === 'done') {
          // 保存助手回复
          if (fullAnswer) {
            addMessage(session.id, 'assistant', fullAnswer);
          }
          yield { type: 'done', sessionId: session.id };
        }
      }
    },
  };
}
