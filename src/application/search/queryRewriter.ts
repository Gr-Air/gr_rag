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
import { extractMatchingKeywords, decomposeEntity } from '@/domain/entity/keywordMatcher';
import { isReasoningModel, type LlmClient } from '../ports';

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
  apiKey?: string;
  baseURL?: string;
  model?: string;
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

/** 已知文档类型白名单（校验 LLM 输出） */
const KNOWN_DOC_TYPES = new Set([
  '客户项目验收', '技术方案', '技术架构设计', '来往账目', '系统测试报告',
  '需求规格说明书', '项目人员清单', '项目管理计划', '项目费用结算', '项目进度汇报', '大型台账',
]);

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
 * 构建 LLM system prompt（动态注入已知实体列表作为参考 + 路由决策指令）
 */
function buildRewritePrompt(entitiesWithMeta: Array<{ name: string; type: 'concept' | 'entity'; category: string }>): string {
  // 按 category 字段分组
  const personEntities = entitiesWithMeta.filter(e => e.category === '人员').map(e => e.name);
  const clientEntities = entitiesWithMeta.filter(e => e.category === '客户企业').map(e => e.name);
  const techEntities = entitiesWithMeta.filter(e => e.category === '技术组件').map(e => e.name);
  const deptEntities = entitiesWithMeta.filter(e => e.category === '部门').map(e => e.name);
  const conceptEntities = entitiesWithMeta.filter(e => e.type === 'concept').map(e => e.name);
  const projectEntities = entitiesWithMeta.filter(e => e.category === '项目系统').map(e => e.name);

  // 取代表性样本（避免 prompt 过长）
  const sample = (arr: string[], max: number) => arr.slice(0, max).join('、');

  return `你是一个知识库查询改写与实体提取助手。你的任务是：
1. 改写用户的自然语言查询，使其更精准、更适合检索
2. 从查询中提取结构化的实体关键词

## 知识库包含的实体类型

已知的部分实体（供参考，用户可能使用同义词或简称）：
- 客户企业：${sample(clientEntities, 15)}
- 技术组件：${sample(techEntities, 15)}
- 项目系统：${sample(projectEntities, 10)}
- 人员：${sample(personEntities, 8)}
- 部门：${sample(deptEntities, 8)}
- 概念：${sample(conceptEntities, 10)}

知识库的 index.md 包含以下章节可查询元信息：
客户列表、文档类型、项目类型、概念索引、实体索引、客户企业、技术组件、项目系统、人员、部门、全部原始文档、知识库概览

## 知识库文档类型

知识库中的文档按以下类型分类（文件名中的 docType 字段）：
客户项目验收、技术方案、技术架构设计、来往账目、系统测试报告、需求规格说明书、项目人员清单、项目管理计划、项目费用结算、项目进度汇报、大型台账

## 改写规则

1. **补全隐含实体**：如果用户说"上次那个项目"，结合上下文补全为具体项目名
2. **术语标准化**：将口语化表达转为标准术语（如"钱收回来没"→"回款金额"）
3. **同义词展开**：将简称/别名展开为知识库中的标准名称
4. **多实体拆分**：明确区分多个独立实体
5. **保持简洁**：不要添加原始 query 中没有的信息，不要编造

## 路由决策规则

### isFollowUp（追问检测）
判断当前 query 是否依赖上一轮对话才能理解。以下情况应为 true：
- 包含指代词："那个"、"这个"、"它"、"他"、"她"、"这些"
- 省略追问："那进度呢"、"那人呢"、"那成本呢"
- 纠错/否定："不对，我说的是..."、"不是这个意思"、"重新查一下"
- 确认反问："就这些？"、"没了吗？"
- 展开/继续："详细说说"、"然后呢"、"还有呢"、"继续说"
- 序号追问："第二个呢"、"第三个怎么样"
- 比较追问："它和XX比呢"

## 输出格式

严格输出一个 JSON 对象，不要有任何其他内容：

{
  "rewritten": "改写后的查询语句",
  "entities": ["实体1", "实体2"],
  "intent": "fact|list|compare|summary|analysis|other",
  "relevantDocTypes": ["文档类型1", "文档类型2"],
  "isFollowUp": true或false,
  "reason": "改写理由（中文，不超过20字）"
}

### intent 说明
- fact: 查询具体事实/数值（如"徐峰负责什么"、"项目有多少人"）
- list: 列举/统计（如"有哪些项目"、"多少家公司"）
- compare: 对比分析（如"对比两个方案"）
- summary: 总结概括（如"总结项目进展"）
- analysis: 分析评估（如"为什么选择这个架构"）
- other: 其他

### relevantDocTypes 说明
根据查询语义，判断哪些文档类型最可能包含答案，从上述文档类型列表中选择1-3个。
如果查询与具体文档类型无关（如纯概念查询），输出空数组 []。
例如：
- "项目验收进度" → ["客户项目验收", "项目进度汇报"]
- "Redis怎么配置" → ["技术方案", "技术架构设计"]
- "上月付款了多少" → ["来往账目", "项目费用结算"]
- "CRM是什么" → []（概念查询，不限定文档类型）`;
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
    const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
    const baseURL = options?.baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || '';
    const model = options?.model || process.env.LLM_MODEL || 'gpt-3.5-turbo';

    if (!apiKey) {
      console.log('[QueryRewriter] 无 LLM API Key，跳过改写');
      return null;
    }

    const entitiesWithMeta = entityRepo.getKnownEntities();
    const systemPrompt = buildRewritePrompt(entitiesWithMeta);
    const contextHint = options?.previousQuery
      ? `\n对话历史：用户上一轮问了"${options.previousQuery}"`
      : '';

    const userPrompt = `用户查询: "${query}"${contextHint}

请改写查询并提取实体，输出 JSON。`;

    try {
      // 推理模型（如 deepseek-r1 等）会将大部分 token 消耗在 reasoning_content 上，
      // 需要预留足够 token 给最终的 content 输出；同时推理模型不支持 temperature 参数
      const reasoning = isReasoningModel(model);

      const content = await llm.complete({
        apiKey,
        baseURL: baseURL || undefined,
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        // 推理模型不携带 temperature/max_tokens，让模型自然结束
        ...(reasoning ? {} : { temperature: 0, maxTokens: 300 }),
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
