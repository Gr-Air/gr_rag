// ============================================================
// RAG 问答引擎（Application 层 Use Case）
// 流程：用户问题 -> [可选]混合检索 -> Rerank -> 构建 prompt -> LLM 流式回答
// 支持多轮对话和上下文压缩
//
// 架构分层：
//   - LLM 调用走 LlmClient Port（OpenAI 实现在 infrastructure，由 Composition 注入）
//   - 重排走 Reranker Port（注入）
//   - 检索走注入的 hybridSearch Use Case
// ============================================================

import type { SearchResult, Reranker } from '@/domain/search/types';
import type { LlmClient } from '../ports';
import type { HybridSearchFn } from '../search/hybridSearch';
import { PromptTemplate } from './promptTemplate';

/** 提示词模板实例（复用） */
const promptTemplate = new PromptTemplate();

/** RAG 流事件 */
export interface RagChatEvent {
  type: 'context' | 'token' | 'done' | 'error' | 'no-llm';
  content?: string;
  results?: SearchResult[];
}

export interface RagChatOptions {
  /** 覆盖默认 LlmClient（前端自定义配置时由 route 创建传入） */
  llm?: LlmClient;
  topK?: number;
  /** 预检索结果，如果提供则跳过检索步骤 */
  preSearchResults?: SearchResult[];
  /** 实体关联的 Raw 文档全文内容 */
  entityDocsContent?: string;
  /** 对话历史上下文（用于多轮对话） */
  conversationContext?: string;
  /** 是否为追问 */
  isFollowUp?: boolean;
  /** 匹配到的实体关键字 */
  matchedKeywords?: string[];
}

export type RagChatStreamFn = (
  query: string,
  options?: RagChatOptions
) => AsyncGenerator<RagChatEvent>;

/** 构建 RAG Prompt（全量加载所有 chunk，不做截断） */
function buildRAGPrompt(
  query: string,
  searchResults: SearchResult[],
  options?: {
    entityDocsContent?: string;
    conversationContext?: string;
    isFollowUp?: boolean;
    intent?: string;
  }
): { systemPrompt: string; userPrompt: string } {
  // 构建文档上下文（混合检索结果 + 可选的数据库查询提示词）
  const sorted = [...searchResults].sort((a, b) => b.score - a.score);
  const contextParts: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const result = sorted[i];
    const chunk = result.chunk;
    const meta = chunk.metadata;

    let header = `### 文档 ${i + 1}: ${chunk.docTitle}`;
    const metaParts: string[] = [];
    if (meta.client) metaParts.push(`客户: ${meta.client}`);
    if (meta.project) metaParts.push(`项目: ${meta.project}`);
    if (meta.docType) metaParts.push(`类型: ${meta.docType}`);
    if (meta.date) metaParts.push(`日期: ${meta.date}`);
    if (metaParts.length > 0) {
      header += ` (${metaParts.join(' | ')})`;
    }

    contextParts.push(`${header}\n${chunk.content}`);
  }

  const context = contextParts.join('\n\n---\n\n');

  return promptTemplate.build({
    context,
    query,
    conversationContext: options?.conversationContext,
    isFollowUp: options?.isFollowUp,
    intent: options?.intent,
    entityDocsContent: options?.entityDocsContent,
  });
}

/**
 * 创建流式 RAG 回答 Use Case
 *
 * @param deps - llm（LlmClient Port，默认实例）+ rerankerFactory（按需创建 Reranker）+ hybridSearch
 */
export function createRagChatStream(deps: {
  llm: LlmClient;
  rerankerFactory: () => Reranker;
  hybridSearch: HybridSearchFn;
}): RagChatStreamFn {
  const { llm: defaultLlm, rerankerFactory, hybridSearch } = deps;

  return async function* ragChatStream(
    query: string,
    options?: RagChatOptions
  ): AsyncGenerator<RagChatEvent> {
    const topK = options?.topK || 5;
    const llm = options?.llm ?? defaultLlm;

    // Step 1: 检索（如果已有预检索结果则跳过；如果有实体文档内容也跳过）
    let searchResults: SearchResult[];
    if (options?.preSearchResults && options.preSearchResults.length > 0) {
      searchResults = options.preSearchResults;
      console.log(`[RAG] 使用预检索结果: ${searchResults.length} 个文档块`);
    } else if (options?.entityDocsContent) {
      // 有实体关联文档内容时，跳过语义检索，直接用空结果（prompt 中会以实体文档为主）
      searchResults = [];
      console.log('[RAG] 已加载实体关联文档，跳过语义检索');
    } else {
      try {
        searchResults = await hybridSearch(query, topK, 20, 20, {
          matchedKeywords: options?.matchedKeywords,
        });
        console.log(`[RAG] 检索到 ${searchResults.length} 个相关文档块`);
      } catch (err) {
        console.error('[RAG] 检索失败:', err);
        yield { type: 'error', content: '文档检索失败，请检查知识库索引是否已初始化' };
        return;
      }
    }

    // 检查检索结果（如果有实体文档内容，允许跳过语义检索结果）
    if (searchResults.length === 0 && !options?.entityDocsContent) {
      yield { type: 'error', content: '未找到相关文档，请尝试更换查询关键词' };
      return;
    }

    // 返回检索上下文给前端展示（Rerank 之前，保留完整数量）
    yield { type: 'context', results: searchResults };

    // Step 1.5: Rerank 重排序（语义相关性精排，仅用于 LLM prompt，不影响前端展示）
    let promptResults = searchResults;
    if (searchResults.length > 5) {
      try {
        const rerankedResults = await rerankerFactory().rerank({ query }, searchResults, 5);
        if (rerankedResults.length > 0) {
          console.log(`[RAG] Rerank 重排序: ${searchResults.length} → ${rerankedResults.length} 个文档块（仅影响 LLM prompt）`);
          promptResults = rerankedResults;
        }
      } catch (err) {
        console.warn('[RAG] Rerank 失败，使用原始结果:', err);
      }
    }

    // Step 2: 构建 prompt（传入对话历史上下文和追问标记，使用精排后的结果）
    const { systemPrompt, userPrompt } = buildRAGPrompt(query, promptResults, {
      entityDocsContent: options?.entityDocsContent,
      conversationContext: options?.conversationContext,
      isFollowUp: options?.isFollowUp,
    });

    // Step 3: 调用 LLM 流式输出（无 LLM 时降级为 no-llm 事件，由前端处理展示）
    if (!llm.available) {
      yield { type: 'no-llm', results: searchResults };
      return;
    }

    try {
      const stream = llm.stream({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      for await (const content of stream) {
        if (content) {
          yield { type: 'token', content };
        }
      }

      yield { type: 'done', results: searchResults };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[RAG] LLM 调用失败:', error);
      yield { type: 'error', content: `LLM 调用失败: ${error.message || '未知错误'}` };
    }
  };
}
