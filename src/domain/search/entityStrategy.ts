// ============================================================
// 实体策略（领域规则，纯函数，零基础设施依赖）
// 实体关键词过滤标记 + 文档匹配度加成
// chunk 内容由调用方以 contentMap 注入（原实现内嵌 ChunkStore 单例已移除）
// ============================================================

import type { RetrievalHit } from './types';
import type { DocChunk } from '../document/types';

/** 实体匹配度权重（提升包含查询实体的文档优先级）：每个匹配实体增加的额外分数 */
export const ENTITY_MATCH_WEIGHT = 0.2;

/**
 * Step 1.5: 实体关键词过滤标记
 *
 * 向量搜索基于语义相似度，可能召回语义相似但不包含目标实体的文档。
 * 例如：搜"徐峰负责哪些项目"时，可能召回"碧桂园财务共享中心项目人员清单"
 * （该文档与浦发银行文档结构相似，但实际不包含"徐峰"）。
 *
 * 策略：标记不包含实体关键词的向量结果，在 RRF 融合时将其向量排名设为无效。
 * 这样它们只能靠 BM25 排名贡献分数，大幅降低无关文档的最终排名。
 *
 * @param vectorHits - 向量检索结果
 * @param matchedKeywords - 匹配到的实体关键词
 * @param contentMap - chunkId → 内容（由调用方从 ChunkStore 批量取出）
 * @returns 被过滤的 chunkId 集合；无实体关键字或无需过滤时返回 undefined
 */
export function buildVectorEntityFilter(
  vectorHits: RetrievalHit[],
  matchedKeywords: string[] | undefined,
  contentMap: Map<string, string>
): Set<string> | undefined {
  if (!matchedKeywords || matchedKeywords.length === 0 || vectorHits.length === 0) {
    return undefined;
  }

  const vectorResultsBefore = vectorHits.length;
  // 标记不包含实体关键词的结果
  const excludedIds = new Set<string>();
  let excludedCount = 0;

  for (const vr of vectorHits) {
    const content = contentMap.get(vr.chunkId) || '';
    const hasKeyword = matchedKeywords.some(kw => content.includes(kw));
    if (!hasKeyword) {
      excludedIds.add(vr.chunkId);
      excludedCount++;
    }
  }

  if (excludedCount > 0) {
    console.log(`[Hybrid] 实体关键词过滤: 向量结果 ${vectorResultsBefore} 条中 ${excludedCount} 条不包含 [${matchedKeywords.join(', ')}]，向量排名将不计入 RRF`);
    return excludedIds;
  }

  return undefined;
}

/**
 * Step 4.7: 实体匹配度评分加成（提升包含查询实体的文档优先级）
 *
 * 问题场景：
 * - 查询"国家电网物联网管理平台" → 召回了"物联网管理平台"概念（定义是碧桂园项目）
 * - 查询"中国联通OA办公系统" → 召回了"中信证券OA办公系统"（客户错误）
 *
 * 解决方案：计算每个文档包含多少个查询实体关键词，给予额外分数加成
 * （加成直接并入 hit.scores.rrf，即 RRF 最终值已含加成）
 *
 * @returns 获得加成的文档数
 */
export function applyEntityMatchBoost(
  docChunks: Map<string, Array<{ chunk: DocChunk; hit: RetrievalHit }>>,
  matchedKeywords: string[] | undefined
): number {
  if (!matchedKeywords || matchedKeywords.length === 0) {
    return 0;
  }

  let entityBoostedCount = 0;
  for (const [docId, entries] of docChunks) {
    const content = entries.map(e => e.chunk.content).join(' ');
    const matchedCount = matchedKeywords.filter(kw => content.includes(kw)).length;
    if (matchedCount > 0) {
      const entityBonus = matchedCount * ENTITY_MATCH_WEIGHT;
      entries.forEach(e => {
        e.hit.scores.rrf = (e.hit.scores.rrf ?? 0) + entityBonus;
      });
      entityBoostedCount++;
      console.log(`[Hybrid] 实体匹配度加成: [${docId}] 匹配 ${matchedCount} 个实体关键词，+${entityBonus} 分数`);
    }
  }
  if (entityBoostedCount > 0) {
    console.log(`[Hybrid] 实体匹配度加成: ${entityBoostedCount} 篇文档获得额外分数`);
  }

  return entityBoostedCount;
}
