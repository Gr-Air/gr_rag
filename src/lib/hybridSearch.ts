// ============================================================
// 混合检索引擎（向量 + BM25 + RRF 融合 + Small-to-Big 检索）
// 核心检索策略：
//   1. 向量检索 top20（子文档/精准）
//   2. BM25 检索 top20
//   3. RRF (Reciprocal Rank Fusion) 加权融合
//   4. Small-to-Big: 用子 chunk 检索，返回父文档扩展上下文
//   5. 返回 topK 文档块（含扩展上下文）
// ============================================================

import fs from 'fs';
import path from 'path';
import { DocChunk, SearchResult } from './types';
import { vectorSearch } from './vectorEngine';
import { bm25Search, getChunksByIds, isBM25Ready } from './bm25Engine';
import OpenAI from 'openai';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const PARENTS_DIR = path.join(DATA_DIR, 'parents');

/** RRF 融合参数 */
const RRF_K = 60; // RRF 平滑参数

/** 实体匹配度权重（提升包含查询实体的文档优先级） */
const ENTITY_MATCH_WEIGHT = 0.2; // 每个匹配实体增加 0.2 的额外分数

/**
 * RRF (Reciprocal Rank Fusion) 算法
 * 
 * 公式: RRF(d) = Σ 1/(k + rank_i(d))
 * 
 * 其中:
 * - d 是文档
 * - rank_i(d) 是文档 d 在第 i 个检索系统中的排名（从1开始）
 * - k 是平滑参数（默认60）
 * 
 * 优点:
 * - 不依赖原始分数的量纲，直接基于排名融合
 * - 对异常分数不敏感
 * - 简单高效
 */
function rrfFusion(
  vectorResults: Array<{ chunkId: string; score: number }>,
  bm25Results: Array<{ chunkId: string; score: number }>,
  topK: number = 10,
  /** 向量搜索结果中不包含实体关键词的 chunkId 集合，这些结果的向量排名不计入 RRF */
  vectorEntityFilter?: Set<string>
): Array<{ chunkId: string; rrfScore: number; vectorRank: number | null; bm25Rank: number | null }> {
  const rrfScores = new Map<string, { vectorRank: number | null; bm25Rank: number | null }>();

  // 向量检索排名（跳过被实体过滤的结果）
  let effectiveVecRank = 0;
  vectorResults.forEach((result, index) => {
    const rank = index + 1;
    // 如果该结果不包含实体关键词，跳过其向量排名贡献
    if (vectorEntityFilter?.has(result.chunkId)) {
      // 仍然记录 chunkId，但 vectorRank 设为 null（不贡献 RRF 分数）
      if (!rrfScores.has(result.chunkId)) {
        rrfScores.set(result.chunkId, { vectorRank: null, bm25Rank: null });
      }
      return;
    }

    effectiveVecRank++;
    const rrf = 1 / (RRF_K + effectiveVecRank);
    if (!rrfScores.has(result.chunkId)) {
      rrfScores.set(result.chunkId, { vectorRank: rank, bm25Rank: null });
    } else {
      const entry = rrfScores.get(result.chunkId)!;
      entry.vectorRank = rank;
    }
    const entry = rrfScores.get(result.chunkId)!;
    (entry as any)._rrf = ((entry as any)._rrf || 0) + rrf;
  });

  // BM25 检索排名
  bm25Results.forEach((result, index) => {
    const rank = index + 1;
    const rrf = 1 / (RRF_K + rank);
    if (!rrfScores.has(result.chunkId)) {
      rrfScores.set(result.chunkId, { vectorRank: null, bm25Rank: rank });
    } else {
      const entry = rrfScores.get(result.chunkId)!;
      entry.bm25Rank = rank;
    }
    const entry = rrfScores.get(result.chunkId)!;
    (entry as any)._rrf = ((entry as any)._rrf || 0) + rrf;
  });

  // 按 RRF 分数排序
  const ranked = Array.from(rrfScores.entries())
    .map(([chunkId, info]) => ({
      chunkId,
      rrfScore: (info as any)._rrf || 0,
      vectorRank: info.vectorRank,
      bm25Rank: info.bm25Rank,
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);

  return ranked;
}

/**
 * 混合检索主函数
 * 
 * @param query - 用户查询
 * @param topK - 返回文档数（默认5）
 * @param vectorTopN - 向量检索召回数（默认20）
 * @param bm25TopN - BM25 检索召回数（默认20）
 * @param options - 可选参数
 * @param options.matchedKeywords - 实体关键字，用于过滤向量检索的噪音结果
 * @returns topK 个搜索结果
 */
export async function hybridSearch(
  query: string,
  topK: number = 10,
  vectorTopN: number = 20,
  bm25TopN: number = 20,
  options?: {
    matchedKeywords?: string[];
    filteredChunkIds?: string[];
  }
): Promise<SearchResult[]> {
  console.log(`[Hybrid] 查询: "${query}", topK=${topK}`);

  const matchedKeywords = options?.matchedKeywords;
  const isEntityQuery = matchedKeywords && matchedKeywords.length > 0;

  // 查询类型识别和动态 topK
  // 宽泛查询（如"相关的项目文档有哪些？"）使用更小的 topK，避免召回过多不相关上下文
  // 具体查询（如"项目经理是谁？"）保持原有 topK
  const broadQueryPatterns = [
    /相关的.*文档有哪些/,
    /有哪些.*项目/,
    /包含.*的文档/,
    /涉及.*的项目/,
    /哪些.*文档/,
    /哪些.*项目/,
    /有.*多少.*文档/,
    /有.*多少.*项目/,
  ];
  const isBroadQuery = broadQueryPatterns.some(p => p.test(query));
  if (isBroadQuery && topK > 3) {
    console.log(`[Hybrid] 检测到宽泛查询，topK 从 ${topK} 调整为 3`);
    topK = 3;
  }

  // Step 1: 并行执行向量检索和 BM25 检索
  // 对于无实体匹配的概括性查询，增加检索召回数量，确保能覆盖更多文档章节
  const effectiveVectorTopN = isEntityQuery ? vectorTopN : vectorTopN * 2;
  const effectiveBm25TopN = isEntityQuery ? bm25TopN : bm25TopN * 2;
  
  let [vectorResults, bm25Results] = await Promise.all([
    vectorSearch(query, effectiveVectorTopN).catch(err => {
      console.error('[Hybrid] 向量检索失败:', err);
      return [] as Array<{ chunkId: string; score: number }>;
    }),
    bm25Search(query, effectiveBm25TopN).catch(err => {
      console.error('[Hybrid] BM25 检索失败:', err);
      return [] as Array<{ chunkId: string; score: number }>;
    }),
  ]);

  console.log(`[Hybrid] 向量检索: ${vectorResults.length} 条, BM25 检索: ${bm25Results.length} 条`);

  // Step 1.1: 按 docType 过滤（如果调用方传入了 filteredChunkIds）
  const filteredChunkIds = options?.filteredChunkIds;
  if (filteredChunkIds && filteredChunkIds.length > 0) {
    const filterSet = new Set(filteredChunkIds);
    const vecBefore = vectorResults.length;
    const bm25Before = bm25Results.length;
    vectorResults = vectorResults.filter(r => filterSet.has(r.chunkId));
    bm25Results = bm25Results.filter(r => filterSet.has(r.chunkId));
    console.log(`[Hybrid] docType 过滤: vec ${vecBefore}→${vectorResults.length}, bm25 ${bm25Before}→${bm25Results.length}`);
  }

  // Step 1.5: 如果有实体关键字，对向量搜索结果做关键词过滤
  // 向量搜索基于语义相似度，可能召回语义相似但不包含目标实体的文档
  // 例如：搜"徐峰负责哪些项目"时，可能召回"碧桂园财务共享中心项目人员清单"
  // （该文档与浦发银行文档结构相似，但实际不包含"徐峰"）
  // 
  // 策略：标记不包含实体关键词的向量结果，在 RRF 融合时将其向量排名设为无效
  // 这样它们只能靠 BM25 排名贡献分数，大幅降低无关文档的最终排名
  let vectorEntityFilter: Set<string> | undefined;

  if (matchedKeywords && matchedKeywords.length > 0 && vectorResults.length > 0) {
    const vectorResultsBefore = vectorResults.length;
    // 加载 chunks meta 检查向量搜索结果是否包含实体关键字
    const vectorChunks = getChunksByIds(vectorResults.map(r => r.chunkId));
    const chunkContentMap = new Map<string, string>();
    vectorChunks.forEach(c => chunkContentMap.set(c.id, c.content));

    // 标记不包含实体关键词的结果
    const excludedIds = new Set<string>();
    let excludedCount = 0;

    for (const vr of vectorResults) {
      const content = chunkContentMap.get(vr.chunkId) || '';
      const hasKeyword = matchedKeywords.some(kw => content.includes(kw));
      if (!hasKeyword) {
        excludedIds.add(vr.chunkId);
        excludedCount++;
      }
    }

    if (excludedCount > 0) {
      vectorEntityFilter = excludedIds;
      console.log(`[Hybrid] 实体关键词过滤: 向量结果 ${vectorResultsBefore} 条中 ${excludedCount} 条不包含 [${matchedKeywords.join(', ')}]，向量排名将不计入 RRF`);
    }
  }

  // Step 2: RRF 融合（传入实体过滤集合）
  const fusionTopK = isEntityQuery ? topK : topK * 3;
  const fused = rrfFusion(vectorResults, bm25Results, fusionTopK, vectorEntityFilter);

  console.log(`[Hybrid] RRF 融合后 top${topK}:`);
  fused.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.chunkId}] RRF=${r.rrfScore.toFixed(6)} (vec#${r.vectorRank ?? '-'} bm25#${r.bm25Rank ?? '-'})`);
  });

  // Step 3: 获取完整文档块信息
  const chunkIds = fused.map(f => f.chunkId);
  const chunks = getChunksByIds(chunkIds);
  const chunkMap = new Map<string, DocChunk>();
  chunks.forEach(c => chunkMap.set(c.id, c));

  // Step 4: 按文档聚合 chunks
  // 策略：有实体匹配时每个文档取最佳 chunk（精准匹配）
  //       无实体匹配时每个文档取多个 chunks（支持概括性查询）
  const MAX_CHUNKS_PER_DOC = isEntityQuery ? 1 : 5;

  const docChunks = new Map<string, Array<{
    chunk: DocChunk;
    rrfScore: number;
    vectorRank: number | null;
    bm25Rank: number | null;
  }>>();
  
  const seenChunkIds = new Set<string>();
  
  for (const f of fused) {
    const chunk = chunkMap.get(f.chunkId);
    if (!chunk) continue;
    if (seenChunkIds.has(f.chunkId)) continue;
    seenChunkIds.add(f.chunkId);

    const docId = chunk.docId || f.chunkId.replace(/_\d+$/, '');
    if (!docChunks.has(docId)) {
      docChunks.set(docId, []);
    }

    const existingList = docChunks.get(docId)!;
    if (existingList.length < MAX_CHUNKS_PER_DOC) {
      const chunkTitle = chunk.content.split('\n')[0]?.trim() || '';
      const hasSameTitle = existingList.some(e => {
        const existingTitle = e.chunk.content.split('\n')[0]?.trim() || '';
        return chunkTitle === existingTitle;
      });
      if (!hasSameTitle) {
        existingList.push({ chunk, rrfScore: f.rrfScore, vectorRank: f.vectorRank, bm25Rank: f.bm25Rank });
      }
    }
  }

  

  // Step 4.7: 实体匹配度评分（提升包含查询实体的文档优先级）
  // 问题场景：
  // - 查询"国家电网物联网管理平台" → 召回了"物联网管理平台"概念（定义是碧桂园项目）
  // - 查询"中国联通OA办公系统" → 召回了"中信证券OA办公系统"（客户错误）
  // 解决方案：计算每个文档包含多少个查询实体关键词，给予额外分数加成
  let entityBoostedCount = 0;
  if (matchedKeywords && matchedKeywords.length > 0) {
    for (const [docId, entries] of docChunks) {
      const content = entries.map(e => e.chunk.content).join(' ');
      const matchedCount = matchedKeywords.filter(kw => content.includes(kw)).length;
      if (matchedCount > 0) {
        const entityBonus = matchedCount * ENTITY_MATCH_WEIGHT;
        entries.forEach(e => e.rrfScore += entityBonus);
        entityBoostedCount++;
        console.log(`[Hybrid] 实体匹配度加成: [${docId}] 匹配 ${matchedCount} 个实体关键词，+${entityBonus} 分数`);
      }
    }
    if (entityBoostedCount > 0) {
      console.log(`[Hybrid] 实体匹配度加成: ${entityBoostedCount} 篇文档获得额外分数`);
    }
  }

  // Step 5: 组装最终结果（按 RRF 分数排序，归一化放大到 0~1 区间）
  const allChunks = Array.from(docChunks.values()).flat();
  const finalTopK = isEntityQuery ? topK : topK * 2;
  const sortedDocs = allChunks
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, finalTopK);

  // RRF 分数归一化：RRF 原始值范围约 0.016~0.033，对用户不直观
  // 将最高分映射到 ~0.95，最低分保持相对比例
  const maxRrf = sortedDocs.length > 0 ? sortedDocs[0].rrfScore : 0.001;
  const minRrf = sortedDocs.length > 0 ? sortedDocs[sortedDocs.length - 1].rrfScore : 0;

  const results: SearchResult[] = sortedDocs.map(({ chunk, rrfScore, vectorRank, bm25Rank }) => {
    // 判断来源（已在上一步合并了同一文档多 chunk 的排名信息）
    let source: SearchResult['source'] = 'hybrid';
    if (vectorRank !== null && bm25Rank === null) source = 'vector';
    if (bm25Rank !== null && vectorRank === null) source = 'bm25';
    if (vectorRank !== null && bm25Rank !== null) source = 'hybrid';

    // 归一化到 0.05~0.95 区间（避免出现 0 或 1 的极端值）
    const normalizedScore = maxRrf > minRrf
      ? 0.05 + ((rrfScore - minRrf) / (maxRrf - minRrf)) * 0.90
      : 0.50; // 所有分数相同时取中间值

    const highlight = generateHighlight(chunk.content, query);

    return {
      chunk,
      score: Math.round(normalizedScore * 10000) / 10000, // 保留4位小数
      source,
      highlight,
    };
  });

  return results;
}

/**
 * 生成搜索结果高亮片段
 */
function generateHighlight(content: string, query: string): string {
  const MAX_HIGHLIGHT_LEN = 300;
  const queryChars = query.replace(/\s+/g, '');

  if (!queryChars) {
    return content.slice(0, MAX_HIGHLIGHT_LEN) + (content.length > MAX_HIGHLIGHT_LEN ? '...' : '');
  }

  // 查找第一个匹配位置
  let bestIdx = 0;
  for (const char of queryChars) {
    const idx = content.indexOf(char);
    if (idx !== -1) {
      bestIdx = idx;
      break;
    }
  }

  const start = Math.max(0, bestIdx - 50);
  const end = Math.min(content.length, start + MAX_HIGHLIGHT_LEN);
  let snippet = content.slice(start, end);

  // 高亮查询词
  const queryWords = query.split(/\s+/).filter(w => w.length > 0);
  for (const word of queryWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    snippet = snippet.replace(new RegExp(`(${escaped})`, 'gi'), '**$1**');
  }

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

/**
 * 轻量搜索：仅返回 chunkId 和分数（用于调试）
 */
export async function hybridSearchLight(
  query: string,
  topK: number = 10
): Promise<Array<{ chunkId: string; rrfScore: number }>> {
  const results = await hybridSearch(query, topK);
  return results.map(r => ({ chunkId: r.chunk.id, rrfScore: r.score }));
}

// ============================================================
// Small-to-Big 检索：子 chunk 命中 → 扩展到父文档上下文
// ============================================================

interface ParentDoc {
  docId: string;
  title: string;
  path: string;
  metadata: DocChunk['metadata'];
  childChunkIds: string[];
}

let parentDocsCache: Map<string, ParentDoc> | null = null;

/** 加载所有父文档 */
function loadParentDocs(): Map<string, ParentDoc> {
  if (parentDocsCache) return parentDocsCache;

  const parentsPath = path.join(PARENTS_DIR, 'parents.json');
  if (!fs.existsSync(parentsPath)) {
    parentDocsCache = new Map();
    return parentDocsCache;
  }

  const data = JSON.parse(fs.readFileSync(parentsPath, 'utf-8'));
  parentDocsCache = new Map(Object.entries(data) as [string, any][]);
  return parentDocsCache;
}

/**
 * 自适应窗口（本地规则部分）：
 * 用正则快速匹配常见查询模式，判断窗口大小。
 * 返回 null 表示本地规则无法确定，需要 LLM 判断。
 *
 * @returns contextWindow 值（1-3），或 null 表示不确定
 */
function localAdaptiveWindow(
  query: string,
  options?: {
    matchedKeywords?: string[];
  }
): number | null {
  const q = query.trim();
  const qLen = q.length;

  // ================================================================
  // 规则 1: 数据/表格查询 → 最大窗口 ±3
  // ================================================================
  const dataPatterns = [
    /多少[钱费]|金额|费用|成本|预算|报价/,
    /数量|个数|几次|多少[个次台套项]/,
    /统计|汇总|合计|总计|平均/,
    /表格|列表|清单|明细|账[目户单]|发票|回款|付款|应收|应付/,
    /数据.*查询|查.*数据|查询.*数据/,
    /进度|完成率|达成率|百分比/,
    /具体.*多少|一共.*多少/,
  ];
  if (dataPatterns.some(p => p.test(q))) {
    return 3;
  }

  // ================================================================
  // 规则 2: 综合分析/对比问题 → 中等窗口 ±2
  // ================================================================
  const analysisPatterns = [
    /对比|比较|区别|差异|异同/,
    /总结|归纳|概括|综述/,
    /分析|评估|评价/,
    /建议|推荐|方案|规划/,
    /优缺点|优劣|好处|坏处|利弊/,
    /架构|设计.*方案|技术.*选型/,
    /.*是(什么|谁|多少)/,
    /怎么(做|实现|配置|部署|处理|解决)/,
    /如何|为什么|原因/,
  ];
  if (analysisPatterns.some(p => p.test(q))) {
    return 2;
  }

  // ================================================================
  // 规则 3: 多关键词匹配 → ±2（需要更多关联信息）
  // ================================================================
  if (options?.matchedKeywords && options.matchedKeywords.length >= 2) {
    return 2;
  }

  // ================================================================
  // 规则 4: 简单事实查询 → 最小窗口 ±1
  // ================================================================
  const simplePatterns = [
    /^(什么|谁|哪[个家些]|有没有|是否|能不能)/,
    /[是什么谁]$/,
    /在哪里|在哪/,
    /时间|日期|什么时候/,
    /电话|邮箱|联系[人方式]/,
    /负责人|谁负责/,
  ];
  if (simplePatterns.some(p => p.test(q))) {
    return 1;
  }

  // ================================================================
  // 规则 5: 根据 query 长度自适应
  // ================================================================
  if (qLen <= 5) return 1;
  if (qLen <= 15) return 1;
  if (qLen >= 40) return 2;

  // ================================================================
  // 本地规则无法确定，返回 null 交给 LLM
  // ================================================================
  return null;
}

/**
 * LLM 智能判断窗口大小（本地规则无法确定时的 fallback）
 */
async function llmAdaptiveWindow(
  query: string,
  options?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    matchedKeywords?: string[];
  }
): Promise<number> {
  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  const baseURL = options?.baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || '';
  const model = options?.model || process.env.LLM_MODEL || 'gpt-3.5-turbo';

  // 无 API Key 时降级为默认窗口
  if (!apiKey) {
    console.log('[AdaptiveWindow] 无 LLM API Key，使用默认窗口 ±2');
    return 2;
  }

  const keywordsHint = options?.matchedKeywords?.length
    ? `\n匹配到的实体关键字: ${options.matchedKeywords.slice(0, 10).join(', ')}`
    : '';

  const systemPrompt = `你是一个查询复杂度分析器。根据用户的问题，判断需要多宽的上下文窗口来准确回答。

## 窗口大小说明
- 1（小窗口）：简单事实查询，答案通常在一两句话内，不需要跨段落上下文
  - 例如："Redis是什么"、"负责人是谁"、"项目什么时候开始"
- 2（中窗口）：需要理解一个完整小节或几个相关段落
  - 例如："微服务架构的设计原则"、"这个项目的技术栈是什么"、"对比MySQL和Redis"
- 3（大窗口）：涉及数据/表格、需要完整上下文，答案可能分散在多个段落
  - 例如："回款金额多少"、"统计各项目进度"、"发票明细有哪些"

## 输出要求
只输出一个数字（1、2 或 3），不要其他内容。`;

  const userPrompt = `用户查询: "${query}"${keywordsHint}

请判断该查询需要多大的上下文窗口（1/2/3），只输出数字。`;

  try {
    const client = new OpenAI({ apiKey, baseURL: baseURL || undefined });
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 5,
    });

    const content = response.choices[0]?.message?.content?.trim() || '';
    const match = content.match(/[123]/);
    if (match) {
      const window = parseInt(match[0]);
      console.log(`[AdaptiveWindow] LLM 判断: 窗口=${window} (query="${query.slice(0, 50)}")`);
      return window;
    }

    console.warn(`[AdaptiveWindow] LLM 返回格式异常: "${content}"，降级为默认窗口 ±2`);
    return 2;
  } catch (err: any) {
    console.warn(`[AdaptiveWindow] LLM 调用失败: ${err.message}，降级为默认窗口 ±2`);
    return 2;
  }
}

/**
 * 自适应窗口：本地规则优先，不确定时 LLM 智能判断
 *
 * 策略：
 * 1. 本地正则匹配常见查询模式（零延迟、零成本）
 * 2. 无法匹配时，用 LLM 分析 query 语义决定窗口大小
 * 3. LLM 不可用时降级为默认窗口 ±2
 *
 * @returns contextWindow 值（1-3）
 */
export async function adaptiveContextWindow(
  query: string,
  options?: {
    matchedKeywords?: string[];
    /** LLM 配置（本地规则无法确定时需要） */
    apiKey?: string;
    baseURL?: string;
    model?: string;
  }
): Promise<number> {
  // Step 1: 本地规则快速判断
  const localResult = localAdaptiveWindow(query, {
    matchedKeywords: options?.matchedKeywords,
  });
  if (localResult !== null) {
    console.log(`[AdaptiveWindow] 本地规则命中: 窗口=${localResult} (query="${query.slice(0, 50)}")`);
    return localResult;
  }

  // Step 2: 本地规则无法确定，用 LLM 判断
  console.log(`[AdaptiveWindow] 本地规则未命中，调用 LLM 判断...`);
  return llmAdaptiveWindow(query, {
    apiKey: options?.apiKey,
    baseURL: options?.baseURL,
    model: options?.model,
    matchedKeywords: options?.matchedKeywords,
  });
}

/**
 * Small-to-Big 扩展：从子 chunk 扩展到父文档的相邻上下文
 *
 * 策略：
 * - 检索时用子 chunk（语义粒度小，精准匹配）
 * - 返回时用父文档的相邻 chunk 扩展上下文（更大窗口）
 * - 每个命中的子 chunk，返回其前后各 N 个相邻 chunk 的内容
 * - 支持自适应窗口（通过 adaptiveContextWindow 动态决定窗口大小）
 */
export function expandToParentContext(
  searchResults: SearchResult[],
  contextWindow: number = 2  // 前后各取几个相邻 chunk
): SearchResult[] {
  const parentDocs = loadParentDocs();
  if (parentDocs.size === 0) return searchResults;

  const expandedResults: SearchResult[] = [];
  const seenChunkIds = new Set<string>();

  for (const result of searchResults) {
    const chunk = result.chunk;
    if (!chunk.parentDocId) {
      // 无父文档的 chunk（如 Wiki 词条），直接保留
      if (!seenChunkIds.has(chunk.id)) {
        expandedResults.push(result);
        seenChunkIds.add(chunk.id);
      }
      continue;
    }

    // 从 parentDocId 反推 docId
    const docId = chunk.parentDocId.replace(/^parent_/, '');
    const parent = parentDocs.get(docId);
    if (!parent) {
      if (!seenChunkIds.has(chunk.id)) {
        expandedResults.push(result);
        seenChunkIds.add(chunk.id);
      }
      continue;
    }

    // 收集该父文档下相邻的子 chunk
    const childIds = parent.childChunkIds;
    const hitIdx = childIds.indexOf(chunk.id);

    if (hitIdx === -1) {
      if (!seenChunkIds.has(chunk.id)) {
        expandedResults.push(result);
        seenChunkIds.add(chunk.id);
      }
      continue;
    }

    // 取前后 contextWindow 个相邻 chunk
    const start = Math.max(0, hitIdx - contextWindow);
    const end = Math.min(childIds.length, hitIdx + contextWindow + 1);
    const adjacentIds = childIds.slice(start, end);

    // 合并相邻 chunk 的内容，作为一个扩展结果
    const adjacentChunks = getChunksByIds(adjacentIds);

    if (adjacentChunks.length > 0) {
      // 用相邻 chunk 的合并内容替换原 chunk 内容
      const expandedContent = adjacentChunks
        .map(c => c.content)
        .join('\n\n---\n\n');

      // 创建一个扩展后的 chunk
      const expandedChunk: DocChunk = {
        ...adjacentChunks[0],
        id: chunk.id,  // 保持原 chunk ID
        content: expandedContent,
        wikiLinks: [...new Set(adjacentChunks.flatMap(c => c.wikiLinks))],
      };

      if (!seenChunkIds.has(chunk.id)) {
        expandedResults.push({
          ...result,
          chunk: expandedChunk,
          highlight: generateHighlight(expandedContent, ''),
        });
        seenChunkIds.add(chunk.id);
      }
    } else {
      if (!seenChunkIds.has(chunk.id)) {
        expandedResults.push(result);
        seenChunkIds.add(chunk.id);
      }
    }
  }

  return expandedResults;
}

/**
 * 带 Small-to-Big 扩展的混合检索
 */
export async function hybridSearchExpanded(
  query: string,
  topK: number = 5,
  vectorTopN: number = 20,
  bm25TopN: number = 20,
  contextWindow: number = 2
): Promise<SearchResult[]> {
  const results = await hybridSearch(query, topK, vectorTopN, bm25TopN);
  return expandToParentContext(results, contextWindow);
}
