// ============================================================
// RAG 问答引擎
// 流程：用户问题 -> 混合检索(top5) -> Small-to-Big扩展 -> 构建prompt -> LLM流式回答
// 支持多轮对话和上下文压缩
// ============================================================

import { hybridSearch, expandToParentContext, adaptiveContextWindow } from './hybridSearch';
import { SearchResult } from './types';
import OpenAI from 'openai';
import { isFollowUpQuery } from './sessionManager';
import { rerank } from './reranker';

/** 构建 RAG Prompt（全量加载所有 chunk，不做截断） */
function buildRAGPrompt(
  query: string,
  searchResults: SearchResult[],
  options?: {
    structSummary?: string;
    entityDocsContent?: string;
    conversationContext?: string;
    isFollowUp?: boolean;
  }
): { systemPrompt: string; userPrompt: string } {
  const structSummary = options?.structSummary;
  const entityDocsContent = options?.entityDocsContent;
  const conversationContext = options?.conversationContext;
  const isFollowUp = options?.isFollowUp;

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

  let context = contextParts.join('\n\n---\n\n');

  // 如果有匹配实体的 Raw 文档全文，最优先注入（最重要、最完整的上下文）
  if (entityDocsContent) {
    context = `## 实体关联文档全文\n\n${entityDocsContent}\n\n---\n\n${structSummary ? '## 结构化关联查询结果\n\n' + structSummary + '\n\n---\n\n' : ''}## 语义检索文档内容\n\n${context}`;
  } else if (structSummary) {
    // 如果有结构化数据库查询结果，作为提示词前置注入
    context = `## 结构化关联查询结果\n\n${structSummary}\n\n---\n\n## 语义检索文档内容\n\n${context}`;
  }

  const systemPrompt = `你是一个企业内部项目文档知识库的智能助手，名为"星辰Wiki助手"。
你的知识来源于企业项目文档库，包括技术方案、架构设计、需求文档、测试报告、项目进度等。

回答规则：
1. 基于提供的文档上下文回答问题，不要编造信息
2. 如果文档上下文中没有相关信息，诚实告知用户"当前知识库中暂无相关信息"
3. 回答要简洁、专业，适合企业内部使用
4. 引用文档时，注明文档标题和来源
5. 如果涉及多个文档的信息，综合归纳后给出答案
6. 对于技术问题，给出具体的技术细节
7. 对于项目进度/人员相关问题，基于文档中的具体数据回答
8. 使用中文回答
9. 如果上下文中有"实体关联文档全文"，这些是与问题实体直接相关的完整文档，优先基于这些文档回答
10. 如果上下文中有"结构化关联查询结果"，优先用它来回答文档列表/关联类问题
11. 如果上下文中包含对话历史，请结合历史理解用户的追问意图，但不要重复引用历史的完整内容`;

  let userPrompt = '请基于以下文档内容回答用户的问题。\n\n';

  // 如果有对话历史上下文，前置添加
  if (conversationContext) {
    userPrompt += `${conversationContext}\n\n---\n\n`;
  }

  userPrompt += `## 参考文档\n\n${context}\n\n## 用户问题\n\n${query}\n\n请基于上述文档内容，给出准确、专业的回答：`;

  return { systemPrompt, userPrompt };
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
    /** 结构化查询结果摘要 */
    structSummary?: string;
    /** 实体关联的 Raw 文档全文内容 */
    entityDocsContent?: string;
    /** 对话历史上下文（用于多轮对话） */
    conversationContext?: string;
    /** 是否为追问 */
    isFollowUp?: boolean;
    /** 是否启用 Small-to-Big 扩展 */
    enableExpansion?: boolean;
    /** 匹配到的实体关键字（用于自适应窗口判断） */
    matchedKeywords?: string[];
    /** LLM 路由决策的窗口大小（优先于 adaptiveWindow 内部判断，避免二次 LLM 调用） */
    contextWindowOverride?: number;
  }
): AsyncGenerator<{ type: 'context' | 'token' | 'done' | 'error'; content?: string; results?: SearchResult[] }> {
  const topK = options?.topK || 5;
  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  const baseURL = options?.baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || '';
  const model = options?.model || process.env.LLM_MODEL || 'gpt-3.5-turbo';
  const enableExpansion = options?.enableExpansion !== false; // 默认开启

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

  // Step 1.5: Small-to-Big 扩展（将子 chunk 扩展到父文档上下文）
  if (enableExpansion && searchResults.length > 0) {
    try {
      // 优先使用 LLM 路由决策传入的窗口大小，避免二次 LLM 调用
      let window: number;
      if (options?.contextWindowOverride && [1, 2, 3].includes(options.contextWindowOverride)) {
        window = options.contextWindowOverride;
        console.log(`[RAG] 使用 LLM 路由决策窗口: contextWindow=${window} (query="${query.slice(0, 50)}")`);
      } else {
        // fallback: 本地规则优先，不确定时 LLM 判断
        window = await adaptiveContextWindow(query, {
          matchedKeywords: options?.matchedKeywords,
          structSummary: options?.structSummary,
          apiKey: options?.apiKey,
          baseURL: options?.baseURL,
          model: options?.model,
        });
        console.log(`[RAG] 自适应窗口: contextWindow=${window} (query="${query.slice(0, 50)}")`);
      }
      const expandedResults = expandToParentContext(searchResults, window);
      if (expandedResults.length > 0) {
        console.log(`[RAG] Small-to-Big 扩展: ${searchResults.length} → ${expandedResults.length} 个上下文块 (窗口±${window})`);
        searchResults = expandedResults;
      }
    } catch (err) {
      console.warn('[RAG] Small-to-Big 扩展失败，使用原始结果:', err);
    }
  }

  // 检查检索结果（如果有实体文档内容，允许跳过语义检索结果）
  if (searchResults.length === 0 && !options?.entityDocsContent) {
    yield { type: 'error', content: '未找到相关文档，请尝试更换查询关键词' };
    return;
  }

  // 返回检索上下文给前端展示（Rerank 之前，保留完整数量）
  yield { type: 'context', results: searchResults };

  // Step 1.6: Rerank 重排序（语义相关性精排，仅用于 LLM prompt，不影响前端展示）
  let promptResults = searchResults;
  if (searchResults.length > 3) {
    try {
      const rerankedResults = await rerank(query, searchResults, 3);
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
    structSummary: options?.structSummary,
    entityDocsContent: options?.entityDocsContent,
    conversationContext: options?.conversationContext,
    isFollowUp: options?.isFollowUp,
  });

  // Step 3: 调用 LLM 流式输出
  if (!apiKey) {
    yield* noLLMFallback(searchResults, options?.structSummary);
    return;
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: baseURL || undefined,
    });

    const isReasoningModel = model.toLowerCase().includes('mimo') || model.toLowerCase().includes('reasoning');

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

    yield { type: 'done' };
  } catch (err: any) {
    console.error('[RAG] LLM 调用失败:', err);
    yield { type: 'error', content: `LLM 调用失败: ${err.message || '未知错误'}` };
  }
}

/** 无 LLM 时的降级方案：基于检索结果生成结构化摘要 */
async function* noLLMFallback(
  searchResults: SearchResult[],
  _structSummary?: string
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
