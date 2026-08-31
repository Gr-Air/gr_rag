// ============================================================
// RAG 问答引擎
// 流程：用户问题 -> 混合检索(top5) -> Rerank(top5) -> 构建prompt -> LLM流式回答
// 支持多轮对话和上下文压缩
// ============================================================

import { hybridSearch } from './search';
import { SearchResult } from './types';
import OpenAI from 'openai';
import { getReranker } from './search/rerankers';
import { PromptTemplate } from './promptTemplate';

/** 提示词模板实例（复用） */
const promptTemplate = new PromptTemplate();

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

/** 流式 RAG 回答 */
export async function* ragChatStream(
  query: string,
  options?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
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
): AsyncGenerator<{ type: 'context' | 'token' | 'done' | 'error'; content?: string; results?: SearchResult[] }> {
  const topK = options?.topK || 5;
  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  const baseURL = options?.baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || '';
  const model = options?.model || process.env.LLM_MODEL || 'gpt-3.5-turbo';

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
      const rerankedResults = await getReranker().rerank({ query }, searchResults, 5);
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

  // Step 3: 调用 LLM 流式输出
  if (!apiKey) {
    yield* noLLMFallback(searchResults);
    return;
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: baseURL || undefined,
    });

    const isReasoningModel = model.toLowerCase().includes('reasoning') || model.toLowerCase().includes('deepseek-r1');

    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: true,
      ...(isReasoningModel ? {} : { temperature: 0.3 }),
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      const content = delta.content;
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
}

/** 无 LLM 时的降级方案：基于检索结果生成结构化摘要 */
async function* noLLMFallback(
  searchResults: SearchResult[]
): AsyncGenerator<{ type: 'context' | 'token' | 'done' | 'error'; content?: string; results?: SearchResult[] }> {
  yield {
    type: 'token',
    content: '⚠️ 未配置 LLM API Key，以下为基于知识库检索结果的文档汇总：\n\n',
  };

  // 汇总统计
  const clients = new Set<string>();
  const projects = new Set<string>();
  const docTypes = new Set<string>();

  for (const r of searchResults) {
    const meta = r.chunk.metadata;
    if (meta.client) clients.add(meta.client);
    if (meta.project) projects.add(meta.project);
    if (meta.docType) docTypes.add(meta.docType);
  }

  yield {
    type: 'token',
    content: `共检索到 **${searchResults.length}** 篇相关文档，涉及 ${clients.size} 个客户、${projects.size} 个项目。\n\n---\n\n`,
  };

  for (let i = 0; i < searchResults.length; i++) {
    const r = searchResults[i];
    const meta = r.chunk.metadata;
    // 清理 wiki 链接语法，让显示更干净
    const cleanTitle = r.chunk.docTitle.replace(/\[\[([^\]]+)\]\]/g, '$1');
    const cleanContent = r.chunk.content.replace(/\[\[([^\]]+)\]\]/g, '$1');
    // 取前800字符作为摘要
    const snippet = cleanContent.slice(0, 800).replace(/\n+/g, '\n').trim();

    yield {
      type: 'token',
      content: `### 📄 ${cleanTitle}\n`,
    };
    const metaSource = [meta.client, meta.project, meta.docType].filter(Boolean).join(' | ') || '知识库';
    yield {
      type: 'token',
      content: `> 来源: ${metaSource} | 相关性: ${(r.score * 100).toFixed(1)}%\n\n`,
    };
    yield {
      type: 'token',
      content: `${snippet}${cleanContent.length > 800 ? '\n\n*(内容已截断)*' : ''}\n\n`,
    };
    if (i < searchResults.length - 1) {
      yield { type: 'token', content: '---\n\n' };
    }
  }

  yield {
    type: 'token',
    content: '\n> 💡 **提示**：点击右上角「设置」配置 LLM API Key（兼容 OpenAI API），即可启用 AI 智能问答，由 LLM 基于以上文档内容生成精准回答。',
  };
  yield { type: 'done' };
}
