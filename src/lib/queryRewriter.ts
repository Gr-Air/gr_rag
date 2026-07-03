// ============================================================
// Query Rewriting：LLM 改写用户 query + 统一路由决策
//
// 策略：
//   1. 优先用 LLM 改写 query + 同时输出路由决策（追问/路由/窗口/index章节）
//   2. LLM 不可用时降级为本地硬编码规则（各模块保留正则作为 fallback）
//   3. 一次 LLM 调用覆盖 queryRewriter + isFollowUp + smartRouter + adaptiveWindow + indexLookup
// ============================================================

import OpenAI from 'openai';
import type { KnownEntityInfo } from './structSearchEngine';

// ============================================================
// 类型定义
// ============================================================

/** 检索路由决策 */
export type RouteDecision = 'structured' | 'semantic' | 'hybrid';

/** 上下文窗口大小 */
export type ContextWindow = 1 | 2 | 3;

export interface RewrittenQuery {
  /** 改写后的查询语句（用于向量/BM25 检索） */
  rewritten: string;
  /** 提取到的实体关键词列表（用于 SQLite 结构化查询） */
  entities: string[];
  /** 查询意图类型 */
  intent: 'fact' | 'list' | 'compare' | 'summary' | 'analysis' | 'other';
  /** 改写理由（用于调试） */
  reason: string;
}

/**
 * LLM 统一路由决策结果
 * 一次 LLM 调用覆盖：追问检测、检索路由、上下文窗口、index 章节
 */
export interface LlmRouteDecision {
  /** 是否为追问（指代上一轮内容或纠错） */
  isFollowUp: boolean;
  /** 检索路由：structured(查关联文档列表) / semantic(语义检索) / hybrid(混合) */
  route: RouteDecision;
  /** Small-to-Big 上下文窗口大小 */
  contextWindow: ContextWindow;
  /** index.md 命中的章节标题（如"客户列表"），无匹配时为 null */
  indexSection: string | null;
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

  return `你是一个知识库查询改写与路由助手。你的任务是：
1. 改写用户的自然语言查询，使其更精准、更适合检索
2. 从查询中提取结构化的实体关键词
3. 判断查询的检索路由策略

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

### route（检索路由）
- structured：查询想获取某概念/实体关联的文档列表（如"有哪些文档"、"哪些项目用了"、"徐峰负责哪些"、"有没有ERP相关"）
- semantic：查询想理解内容、获取答案、分析总结（如"微服务是什么"、"为什么选择这个架构"、"对比方案"）
- hybrid：既需要文档列表又需要内容分析（如"哪些客户做了ERP，进展如何"）

### contextWindow（上下文窗口）
- 1（小窗口）：简单事实查询，一两句话能回答（如"负责人是谁"、"什么时候开始"）
- 2（中窗口）：需要理解完整段落（如"架构设计原则"、"对比两个方案"、"流程是什么"）
- 3（大窗口）：需要跨段落数据或表格信息（如"回款金额多少"、"统计各项目进度"、"具体费用明细"）

### indexSection（index.md章节命中）
如果用户明确在问知识库的元信息（如"有哪些客户"、"知识库有多少文档"），填入对应的章节名；否则为 null。
可匹配的章节：客户列表、文档类型、项目类型、概念索引、实体索引、客户企业、技术组件、项目系统、人员、部门、全部原始文档、知识库概览

## 输出格式

严格输出一个 JSON 对象，不要有任何其他内容：

{
  "rewritten": "改写后的查询语句",
  "entities": ["实体1", "实体2"],
  "intent": "fact|list|compare|summary|analysis|other",
  "isFollowUp": true或false,
  "route": "structured|semantic|hybrid",
  "contextWindow": 1或2或3,
  "indexSection": "章节名或null",
  "reason": "改写理由（中文，不超过20字）"
}

### intent 说明
- fact: 查询具体事实/数值（如"徐峰负责什么"、"项目有多少人"）
- list: 列举/统计（如"有哪些项目"、"多少家公司"）
- compare: 对比分析（如"对比两个方案"）
- summary: 总结概括（如"总结项目进展"）
- analysis: 分析评估（如"为什么选择这个架构"）
- other: 其他`;
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
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content || '';
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

    // 解析路由决策字段
    const route = ['structured', 'semantic', 'hybrid'].includes(parsed.route)
      ? (parsed.route as RouteDecision)
      : undefined;
    const contextWindow = [1, 2, 3].includes(parsed.contextWindow)
      ? (parsed.contextWindow as ContextWindow)
      : undefined;
    const indexSection = typeof parsed.indexSection === 'string' && parsed.indexSection.toLowerCase() !== 'null'
      ? parsed.indexSection
      : null;

    const result: RewrittenQuery = {
      rewritten: parsed.rewritten || query,
      entities: allEntities,
      intent: ['fact', 'list', 'compare', 'summary', 'analysis', 'other'].includes(parsed.intent)
        ? parsed.intent
        : 'other',
      reason: parsed.reason || 'LLM 改写',
    };

    const routeResult: LlmRouteDecision = {
      isFollowUp: parsed.isFollowUp === true,
      route: route || 'semantic',
      contextWindow: contextWindow || 2,
      indexSection,
    };

    console.log(`[QueryRewriter] 改写: "${query}" → "${result.rewritten}"`);
    console.log(`[QueryRewriter] 实体: [${result.entities.join(', ')}] (已知:${validatedEntities.length} 未知:${unknownEntities.length})`);
    console.log(`[QueryRewriter] 意图: ${result.intent} | 理由: ${result.reason}`);
    console.log(`[QueryRewriter] 路由: followUp=${routeResult.isFollowUp} route=${routeResult.route} window=${routeResult.contextWindow} indexSection=${routeResult.indexSection || '-'}`);

    return { ...result, routeDecision: routeResult } as RewrittenQuery & { routeDecision: LlmRouteDecision };
  } catch (err: any) {
    console.warn(`[QueryRewriter] LLM 调用失败: ${err.message}`);
    return null;
  }
}

// ============================================================
// 降级策略：正则路由判断（LLM 不可用时）
// ============================================================

/**
 * 结构化查询正则模式（LLM 降级策略）
 * 迁移自 smartRouter.ts，补充 spec 分析中识别的高频遗漏模式
 */
const STRUCTURED_PATTERNS = [
  /有哪些.*文档/,
  /关联.*文档/,
  /涉及.*(?:哪些|什么|多少).*文档/,
  /列出.*(?:所有|全部).*文档/,
  /.*相关的.*(?:所有|全部|哪些).*文档/,
  /查.*文档列表/,
  /.*的文档有哪些/,
  /.*涉及了哪些/,
  /哪些.*项目.*用到了/,
  /哪些.*客户.*做/,
  /.*在哪些.*中/,
  /.*出现在.*哪些/,
  /统计.*数量/,
  /有多少.*文档/,
  /有(?:哪|多少)(?:几?家|些|个)/,
  /哪些.*(?:公司|项目|客户|部门|团队|系统|平台|产品|服务|应用)/,
  /(?:公司|项目|客户|部门|团队).*用(?:了|过|到)/,
  /(?:多少|几个).*(?:公司|项目|客户)/,
  /(?:属于|归属).*(?:哪些|哪个|什么)/,
  /(?:做了|在做|做过).*(?:哪些|什么)/,
  /.*被.*(?:哪些|多少).*使用/,
  /.*在.*哪些.*(?:公司|项目|客户)/,
  // 补充：谁负责/谁在做类
  /谁.*(?:负责|在做|参与)/,
  /(?:负责|参与|做了).*(?:哪些|什么)/,
  // 补充：有没有/是否存在类
  /有没有.*(?:关于|相关|的).*(?:文档|资料)/,
  /是否存在.*(?:相关|的).*(?:文档|资料)/,
];

/**
 * 语义查询正则模式（LLM 降级策略）
 * 迁移自 smartRouter.ts，补充 spec 分析中识别的高频遗漏模式
 */
const SEMANTIC_PATTERNS = [
  /.*是(?:什么|谁|多少)/,
  /怎么(?:做|实现|配置|部署)/,
  /如何/,
  /为什么/,
  /对比|比较|区别|差异/,
  /总结|归纳|概括/,
  /分析|评估/,
  /建议|推荐/,
  /.*(?:好不好|行不行|可不可以)/,
  /.*的意思/,
  /解释/,
  // 补充：介绍一下/讲一下类
  /(?:介绍|讲讲|说说|讲一下|说一下).*/,
];

export interface FallbackRouteResult {
  route: RouteDecision;
  matchedEntries: string[];
  reason: string;
}

/**
 * 正则降级路由判断
 * 当 LLM routeDecision 不可用时，用正则匹配作为降级策略
 *
 * @param query - 用户原始查询
 * @param matchedEntries - 已匹配的实体列表
 * @returns 路由决策结果
 */
export function fallbackRoute(query: string, matchedEntries: string[]): FallbackRouteResult {
  // 无实体匹配时，走语义检索
  if (matchedEntries.length === 0) {
    // 检查是否为 index.md 元信息查询
    // 注意：isIndexQuery 仍然在 indexLookup 中独立判断，这里不做重复
    return {
      route: 'semantic',
      matchedEntries: [],
      reason: '未匹配到任何已知概念/实体，降级为语义检索',
    };
  }

  // 结构化模式优先检查
  const isStructured = STRUCTURED_PATTERNS.some(p => p.test(query));
  if (isStructured) {
    return {
      route: 'structured',
      matchedEntries,
      reason: `查询匹配结构化模式（文档列表/关联查询），匹配词条: [${matchedEntries.join(', ')}]`,
    };
  }

  // 语义模式检查
  const isSemantic = SEMANTIC_PATTERNS.some(p => p.test(query));
  if (isSemantic) {
    return {
      route: 'semantic',
      matchedEntries,
      reason: '查询匹配语义分析模式（理解/解释/对比），降级为语义检索',
    };
  }

  // 有实体但未命中任何模式 → 混合检索
  return {
    route: 'hybrid',
    matchedEntries,
    reason: `匹配到实体词条 [${matchedEntries.join(', ')}]，降级为混合检索（数据库+语义）`,
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
  };
}
