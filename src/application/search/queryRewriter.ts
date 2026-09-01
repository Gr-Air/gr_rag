// ============================================================
// Query Rewriting：LLM 改写用户 query + 统一路由决策（Application 层 Use Case）
//
// 策略：
//   1. 优先用 LLM 改写 query + 同时输出路由决策（追问/文档类型过滤）
//   2. LLM 不可用时降级为本地硬编码规则
//   3. 一次 LLM 调用覆盖 queryRewriter + isFollowUp + docType 过滤
//
// 架构分层：
//   - LLM 调用走 LlmClient Port（实现由 Composition Root 注入）
//   - 已知实体来自 EntityRepository Port（SQLite 实现在 infrastructure）
//   - 实体匹配/分解算法在 domain/entity/keywordMatcher.ts（纯领域规则）
// ============================================================

import type { EntityRepository } from '@/domain/entity/types';
import { KNOWN_DOC_TYPES } from '@/domain/document/types';
import { extractMatchingKeywords, decomposeEntity } from '@/domain/entity/keywordMatcher';
import type { LlmClient } from '../ports';
import { PromptTemplate } from '../chat/promptTemplate';

/** 提示词模板实例（复用） */
const promptTemplate = new PromptTemplate();

// ============================================================
// 类型定义
// ============================================================

export interface RewrittenQuery {
  /** 改写后的查询语句（用于向量/BM25 检索） */
  rewritten: string;
  /** 提取到的实体关键词列表（用于 SQLite 结构化查询） */
  entities: string[];
  /** 查询意图类型 */
  intent: 'fact' | 'list' | 'compare' | 'summary' | 'analysis' | 'other';
  /** 最可能包含答案的文档类型（用于无实体命中时缩小检索范围） */
  relevantDocTypes: string[];
  /** 改写理由（用于调试） */
  reason: string;
}

/**
 * LLM 统一路由决策结果
 * 一次 LLM 调用覆盖：追问检测、index 章节匹配
 */
export interface LlmRouteDecision {
  /** 是否为追问（指代上一轮内容或纠错） */
  isFollowUp: boolean;
  /** 最可能包含答案的文档类型（用于无实体命中时缩小检索范围） */
  relevantDocTypes: string[];
}

export interface FallbackRouteResult {
  matchedEntries: string[];
  reason: string;
}

export interface SmartRewriteOptions {
  /** 覆盖默认 LlmClient（前端自定义配置时由 route 创建传入） */
  llm?: LlmClient;
  /** 对话历史中的上一轮 query（用于补全指代） */
  previousQuery?: string;
}

export interface SmartRewriteResult {
  rewrittenQuery: string;
  entities: string[];
  intent: RewrittenQuery['intent'];
  method: 'llm' | 'fallback';
  /** LLM 路由决策（LLM 成功时有效，fallback 时为 null） */
  routeDecision: LlmRouteDecision | null;
  /** LLM 推荐的文档类型过滤（仅 LLM 成功时有值） */
  relevantDocTypes: string[];
}

// ============================================================
// 降级策略：正则路由判断（LLM 不可用时，纯函数）
// ============================================================

/**
 * 正则降级路由：判断 query 是否匹配到实体词条
 *
 * @param query - 用户原始查询
 * @param matchedEntries - 已匹配的实体列表
 * @returns 匹配结果
 */
export function fallbackRoute(query: string, matchedEntries: string[]): FallbackRouteResult {
  return {
    matchedEntries,
    reason: matchedEntries.length > 0
      ? `匹配到实体词条 [${matchedEntries.join(', ')}]`
      : '未匹配到任何已知概念/实体',
  };
}

// ============================================================
// Smart Rewriter（LLM-first + 字典匹配 fallback）
// ============================================================

export interface SmartRewriter {
  /**
   * 智能改写查询并提取实体 + 路由决策
   *
   * 流程：
   *   1. 尝试 LLM 改写（返回 rewritten query + 结构化实体列表 + 路由决策）
   *   2. LLM 失败时降级为字典匹配（domain extractMatchingKeywords）
   */
  rewrite(query: string, options?: SmartRewriteOptions): Promise<SmartRewriteResult>;
}

/**
 * 创建 Smart Rewriter
 *
 * @param deps - llm（LlmClient Port）+ entityRepo（EntityRepository Port）
 */
export function createSmartRewriter(deps: {
  llm: LlmClient;
  entityRepo: EntityRepository;
}): SmartRewriter {
  const { llm, entityRepo } = deps;

  /** LLM 改写 query 并提取实体，失败时返回 null */
  async function rewriteQuery(
    query: string,
    options?: SmartRewriteOptions
  ): Promise<(RewrittenQuery & { routeDecision: LlmRouteDecision }) | null> {
    const clientLlm = options?.llm ?? llm;
    if (!clientLlm.available) {
      console.log('[QueryRewriter] 无 LLM，跳过改写');
      return null;
    }

    const entitiesWithMeta = entityRepo.getKnownEntities();
    const systemPrompt = promptTemplate.buildRewritePrompt(entitiesWithMeta);
    const contextHint = options?.previousQuery
      ? `\n对话历史：用户上一轮问了"${options.previousQuery}"`
      : '';

    const userPrompt = `用户查询: "${query}"${contextHint}

请改写查询并提取实体，输出 JSON。`;

    try {
      const content = await clientLlm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        maxTokens: 300,
      });

      if (!content) {
        console.warn('[QueryRewriter] LLM 返回空 content');
        return null;
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[QueryRewriter] LLM 返回格式异常:', content.slice(0, 200));
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // 校验 entities 是否在 SQLite 已知列表中（不在的也保留，可能是同义词）
      const knownSet = new Set(entitiesWithMeta.map(e => e.name.toLowerCase()));
      const validatedEntities: string[] = [];
      const unknownEntities: string[] = [];

      for (const e of (parsed.entities || [])) {
        if (knownSet.has(e.toLowerCase())) {
          validatedEntities.push(e);
        } else {
          unknownEntities.push(e);
        }
      }

      // 实体分解：当未知实体在已知列表中找不到时，尝试分解为更小的实体
      // 例如："南方电网供应链管理平台项目" → ["南方电网", "供应链管理平台"]
      const decomposedEntities: string[] = [];
      for (const unknown of unknownEntities) {
        const decomposed = decomposeEntity(unknown, knownSet);
        if (decomposed.length > 0) {
          decomposedEntities.push(...decomposed);
          console.log(`[QueryRewriter] 实体分解: "${unknown}" → [${decomposed.join(', ')}]`);
        }
      }

      // 合并所有实体（去重）
      const allEntities = [...new Set([...validatedEntities, ...unknownEntities, ...decomposedEntities])];

      // 校验 relevantDocTypes：只保留已知的文档类型
      const relevantDocTypes = Array.isArray(parsed.relevantDocTypes)
        ? parsed.relevantDocTypes.filter((t: string) => KNOWN_DOC_TYPES.has(t))
        : [];

      const routeResult: LlmRouteDecision = {
        isFollowUp: parsed.isFollowUp === true,
        relevantDocTypes,
      };

      const result: RewrittenQuery = {
        rewritten: parsed.rewritten || query,
        entities: allEntities,
        intent: ['fact', 'list', 'compare', 'summary', 'analysis', 'other'].includes(parsed.intent)
          ? parsed.intent
          : 'other',
        relevantDocTypes,
        reason: parsed.reason || 'LLM 改写',
      };

      console.log(`[QueryRewriter] 改写: "${query}" → "${result.rewritten}"`);
      console.log(`[QueryRewriter] 实体: [${result.entities.join(', ')}] (已知:${validatedEntities.length} 未知:${unknownEntities.length})`);
      console.log(`[QueryRewriter] 意图: ${result.intent} | 理由: ${result.reason}`);
      console.log(`[QueryRewriter] 路由: followUp=${routeResult.isFollowUp}`);

      return { ...result, routeDecision: routeResult };
    } catch (err) {
      console.warn(`[QueryRewriter] LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  return {
    async rewrite(query: string, options?: SmartRewriteOptions): Promise<SmartRewriteResult> {
      // Step 1: 尝试 LLM 改写
      const llmResult = await rewriteQuery(query, options);

      if (llmResult) {
        return {
          rewrittenQuery: llmResult.rewritten,
          entities: llmResult.entities,
          intent: llmResult.intent,
          method: 'llm',
          routeDecision: llmResult.routeDecision || null,
          relevantDocTypes: llmResult.relevantDocTypes || [],
        };
      }

      // Step 2: LLM 不可用，降级为字典匹配 + 本地硬编码规则
      console.log('[QueryRewriter] LLM 改写不可用，降级为字典匹配 + 本地硬编码路由');
      const keywords = entityRepo.getKnownEntities()
        .filter(e => e.type === 'entity')
        .map(e => e.name);
      const fallbackEntities = extractMatchingKeywords(query, keywords);

      return {
        rewrittenQuery: query, // 降级时不改写，保持原 query
        entities: fallbackEntities,
        intent: 'other',
        method: 'fallback',
        routeDecision: null, // null 表示调用方自行用硬编码判断
        relevantDocTypes: [],
      };
    },
  };
}
