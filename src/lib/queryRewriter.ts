// ============================================================
// Query Rewriting：LLM 改写用户 query + 统一路由决策
//
// 策略：
//   1. 优先用 LLM 改写 query + 同时输出路由决策（追问/文档类型过滤）
//   2. LLM 不可用时降级为本地硬编码规则（各模块保留正则作为 fallback）
//   3. 一次 LLM 调用覆盖 queryRewriter + isFollowUp + docType 过滤
// ============================================================

import OpenAI from 'openai';
import type { KnownEntityInfo } from './structSearchEngine';

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

// ============================================================
// 实体关键词缓存（从 SQLite 加载，用于 prompt 和 fallback 校验）
// ============================================================

let knownEntitiesCache: string[] | null = null;
let knownEntitiesWithMeta: import('./structSearchEngine').KnownEntityInfo[] | null = null;

/** 从 SQLite 加载所有已知实体/概念名称及元信息 */
function loadKnownEntitiesWithMeta(): import('./structSearchEngine').KnownEntityInfo[] {
  if (knownEntitiesWithMeta) return knownEntitiesWithMeta;

  try {
    const { getKnownEntityNames, isStructDbReady } = require('./structSearchEngine');
    if (isStructDbReady()) {
      knownEntitiesWithMeta = getKnownEntityNames() as KnownEntityInfo[] | null;
      if (knownEntitiesWithMeta) {
        knownEntitiesCache = knownEntitiesWithMeta.map(e => e.name);
        console.log(`[QueryRewriter] 从 SQLite 加载 ${knownEntitiesWithMeta.length} 个实体/概念`);
        return knownEntitiesWithMeta;
      }
    }
  } catch (err) {
    console.warn('[QueryRewriter] 无法从 SQLite 加载实体，降级为空列表:', err);
  }

  // SQLite 不可用时的降级
  knownEntitiesWithMeta = [];
  knownEntitiesCache = [];
  return knownEntitiesWithMeta;
}

/** 加载所有已知实体/概念名称（纯名称列表，保持向后兼容） */
function loadKnownEntities(): string[] {
  if (knownEntitiesCache) return knownEntitiesCache;
  loadKnownEntitiesWithMeta();
  return knownEntitiesCache || [];
}

/**
 * 实体分解：将未知实体分解为已知实体的组合
 * 策略：从已知实体列表中查找所有是未知实体子串的实体
 * 例如："南方电网供应链管理平台项目" → ["南方电网", "供应链管理平台"]
 */
function decomposeEntity(unknown: string, knownSet: Set<string>): string[] {
  const results: string[] = [];
  const unknownLower = unknown.toLowerCase();
  
  for (const known of knownSet) {
    if (known.length >= 2 && unknownLower.includes(known)) {
      if (!results.some(r => r.includes(known))) {
        results.push(known);
      }
    }
  }
  
  return results.sort((a, b) => b.length - a.length);
}

// ============================================================
// LLM Query Rewriting
// ============================================================

/**
 * 构建 LLM system prompt（动态注入已知实体列表作为参考 + 路由决策指令）
 */
function buildRewritePrompt(): string {
  const entitiesWithMeta = loadKnownEntitiesWithMeta();

  // 按 SQLite 中的 category 字段分组
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
 * LLM 改写 query 并提取实体
 *
 * @param query - 原始用户查询
 * @param options - LLM 配置
 * @returns 改写结果，失败时返回 null
 */
export async function rewriteQuery(
  query: string,
  options?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    /** 对话历史中的上一轮 query（用于补全指代） */
    previousQuery?: string;
  }
): Promise<RewrittenQuery | null> {
  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  const baseURL = options?.baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || '';
  const model = options?.model || process.env.LLM_MODEL || 'gpt-3.5-turbo';

  if (!apiKey) {
    console.log('[QueryRewriter] 无 LLM API Key，跳过改写');
    return null;
  }

  const systemPrompt = buildRewritePrompt();
  const contextHint = options?.previousQuery
    ? `\n对话历史：用户上一轮问了"${options.previousQuery}"`
    : '';

  const userPrompt = `用户查询: "${query}"${contextHint}

请改写查询并提取实体，输出 JSON。`;

  try {
    const client = new OpenAI({ apiKey, baseURL: baseURL || undefined });

    // 推理模型（如 deepseek-r1 等）会将大部分 token 消耗在 reasoning_content 上，
    // 需要预留足够 token 给最终的 content 输出；同时推理模型不支持 temperature 参数
    const isReasoningModel = model.toLowerCase().includes('reasoning') || model.toLowerCase().includes('deepseek-r1');

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...(isReasoningModel ? {} : { temperature: 0 }),
      // 推理模型：不设 max_tokens 让模型自然结束；
      // 非推理模型：300 token 足够输出 JSON
      ...(isReasoningModel ? {} : { max_tokens: 300 }),
    });

    let content = response.choices[0]?.message?.content || '';

    // 推理模型有时 content 为空但 reasoning_content 中有内容（max_tokens 不足时）
    // 此时放弃解析，直接降级
    if (!content) {
      const reasonLen = (response.choices[0]?.message as any)?.reasoning_content?.length || 0;
      console.warn(`[QueryRewriter] LLM 返回空 content (reasoning_content 长度: ${reasonLen})`);
      return null;
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[QueryRewriter] LLM 返回格式异常:', content.slice(0, 200));
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // 校验 entities 是否在 SQLite 已知列表中（不在的也保留，可能是同义词）
    const knownSet = new Set(loadKnownEntities().map(e => e.toLowerCase()));
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
    const knownDocTypes = new Set([
      '客户项目验收', '技术方案', '技术架构设计', '来往账目', '系统测试报告',
      '需求规格说明书', '项目人员清单', '项目管理计划', '项目费用结算', '项目进度汇报', '大型台账',
    ]);
    const relevantDocTypes = Array.isArray(parsed.relevantDocTypes)
      ? parsed.relevantDocTypes.filter((t: string) => knownDocTypes.has(t))
      : [];

    const result: RewrittenQuery = {
      rewritten: parsed.rewritten || query,
      entities: allEntities,
      intent: ['fact', 'list', 'compare', 'summary', 'analysis', 'other'].includes(parsed.intent)
        ? parsed.intent
        : 'other',
      relevantDocTypes,
      reason: parsed.reason || 'LLM 改写',
    };

    const routeResult: LlmRouteDecision = {
      isFollowUp: parsed.isFollowUp === true,
      relevantDocTypes,
    };

    console.log(`[QueryRewriter] 改写: "${query}" → "${result.rewritten}"`);
    console.log(`[QueryRewriter] 实体: [${result.entities.join(', ')}] (已知:${validatedEntities.length} 未知:${unknownEntities.length})`);
    console.log(`[QueryRewriter] 意图: ${result.intent} | 理由: ${result.reason}`);
    console.log(`[QueryRewriter] 路由: followUp=${routeResult.isFollowUp}`);

    return { ...result, routeDecision: routeResult } as RewrittenQuery & { routeDecision: LlmRouteDecision };
  } catch (err: any) {
    console.warn(`[QueryRewriter] LLM 调用失败: ${err.message}`);
    return null;
  }
}

// ============================================================
// 降级策略：正则路由判断（LLM 不可用时）
// ============================================================

export interface FallbackRouteResult {
  matchedEntries: string[];
  reason: string;
}

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
// 降级策略：jieba + 字典匹配（当 LLM 不可用时）
// ============================================================

/**
 * 用 jieba 分词 + 字典匹配降级提取实体
 * 直接复用 entityRouter 的 extractEntityKeywords
 */
export async function fallbackExtract(query: string): Promise<string[]> {
  const { extractEntityKeywords } = await import('./entityRouter');
  return extractEntityKeywords(query);
}

// ============================================================
// 主入口：智能改写 + 实体提取
// ============================================================

/**
 * 智能改写查询并提取实体 + 路由决策
 *
 * 流程：
 *   1. 尝试 LLM 改写（返回 rewritten query + 结构化实体列表 + 路由决策）
 *   2. LLM 失败时降级为 jieba + 字典匹配 + 本地硬编码规则
 *   3. 返回改写后的 query、实体列表和路由决策
 */
export async function smartRewrite(
  query: string,
  options?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    previousQuery?: string;
  }
): Promise<{
  rewrittenQuery: string;
  entities: string[];
  intent: RewrittenQuery['intent'];
  method: 'llm' | 'fallback';
  /** LLM 路由决策（LLM 成功时有效，fallback 时为 null） */
  routeDecision: LlmRouteDecision | null;
  /** LLM 推荐的文档类型过滤（仅 LLM 成功时有值） */
  relevantDocTypes: string[];
}> {
  // Step 1: 尝试 LLM 改写
  const llmResult = await rewriteQuery(query, options);

  if (llmResult) {
    const withRoute = llmResult as RewrittenQuery & { routeDecision: LlmRouteDecision };
    return {
      rewrittenQuery: withRoute.rewritten,
      entities: withRoute.entities,
      intent: withRoute.intent,
      method: 'llm',
      routeDecision: withRoute.routeDecision || null,
      relevantDocTypes: withRoute.relevantDocTypes || [],
    };
  }

  // Step 2: LLM 不可用，降级为 jieba + 字典匹配 + 本地硬编码规则
  console.log('[QueryRewriter] LLM 改写不可用，降级为 jieba + 字典匹配 + 本地硬编码路由');
  const fallbackEntities = await fallbackExtract(query);

  return {
    rewrittenQuery: query, // 降级时不改写，保持原 query
    entities: fallbackEntities,
    intent: 'other',
    method: 'fallback',
    routeDecision: null, // null 表示需要 chat/route.ts 自行用硬编码判断
    relevantDocTypes: [],
  };
}
