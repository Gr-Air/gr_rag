// ============================================================
// 检索结果缓存（Infrastructure 层，Spec 030：进程内 LRU 语义缓存）
//
// 实现 Application 层的 SearchCachePort。
// 只缓存 hybridSearch 输出（pre-rerank SearchResult[]），
// rerank 和 LLM 永远重新执行（保持模型相关性/非确定性）。
//
// 两级匹配：
//   精确 O(1)：hash(query + kbVersion + policyVersion + sorted(entities))
//   语义 O(n)：COSINE(queryEmbedding, entry.embedding) ≥ 0.92
//
// kbVersion 来自 index_manifest.json 的 builtAt（Spec 026），
// 索引重建后 builtAt 变化 → getKbVersion() 重新读取 →
// 检测到变化时 clearCache() 自动失效（无需 rebuild route 通知）。
// ============================================================

import type { SearchResult } from '@/domain/search/types';
import type { SearchCachePort, CacheContext } from '@/application/ports';
import { getIndexManifest } from '../index/indexManager';

/** 语义命中阈值：COSINE ≥ 0.92 视为相同意图 */
export const SIMILARITY_THRESHOLD = 0.92;
/** LRU 容量上限 */
const MAX_ENTRIES = 200;

interface CacheEntry {
  key: string;  // 精确 key（用于 LRU 提升时反查 Map）
  query: string;
  embedding: Float32Array;
  results: SearchResult[];
  kbVersion: string;
  policyVersion: string;
  entitiesHash: string;
}

// LRU 实现：Map 保持插入顺序，访问时 delete+set 提升到末尾（最久未访问在头部）
const cache = new Map<string, CacheEntry>();

// 缓存当前进程读到的 kbVersion；与 manifest 实际值不一致时触发整体失效
let cachedKbVersion: string | null = null;

/** 从 index_manifest.json 读取 kbVersion（builtAt） */
function readKbVersion(): string {
  const manifest = getIndexManifest();
  return manifest?.builtAt ?? 'unknown';
}

/**
 * 获取当前 kbVersion，并与缓存内记录对比。
 * 不一致（索引已重建）时自动清空缓存。
 */
function getKbVersion(): string {
  const current = readKbVersion();
  if (cachedKbVersion !== null && cachedKbVersion !== current) {
    console.log(`[Cache] kbVersion 变化（${cachedKbVersion} → ${current}），清空缓存`);
    cache.clear();
  }
  cachedKbVersion = current;
  return current;
}

/** 精确 key：normalize(query) + 版本 + 实体集合 */
function exactKey(
  query: string,
  entities: string[],
  kbVersion: string,
  policyVersion: string
): string {
  const normalized = query.trim().toLowerCase();
  const entitiesHash = [...entities].sort().join(',');
  return `${normalized}|${kbVersion}|${policyVersion}|${entitiesHash}`;
}

/** COSINE 相似度（两向量已归一化要求不严，这里用标准 COSINE 公式） */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 查询缓存：精确 → 语义两级匹配
 *
 * @returns 命中时返回缓存的 SearchResult[]；未命中返回 null
 */
export function searchCache(
  query: string,
  embedding: number[],
  ctx: CacheContext
): SearchResult[] | null {
  try {
    const kbVersion = getKbVersion();
    const key = exactKey(query, ctx.entities, kbVersion, ctx.policyVersion);

    // 精确命中（O(1)）
    const exact = cache.get(key);
    if (exact) {
      // LRU 提升：delete + set 移到末尾
      cache.delete(key);
      cache.set(key, exact);
      console.log(`[Cache] 精确命中: "${query.slice(0, 30)}..."`);
      return exact.results;
    }

    // 语义命中（O(n) COSINE 扫描，仅扫描版本一致的 entries）
    const queryVec = new Float32Array(embedding);
    let bestEntry: CacheEntry | null = null;
    let bestSim = 0;
    for (const entry of cache.values()) {
      if (entry.kbVersion !== kbVersion) continue;
      if (entry.policyVersion !== ctx.policyVersion) continue;
      const sim = cosineSimilarity(queryVec, entry.embedding);
      if (sim >= SIMILARITY_THRESHOLD && sim > bestSim) {
        bestSim = sim;
        bestEntry = entry;
      }
    }

    if (bestEntry) {
      // LRU 提升
      cache.delete(bestEntry.key);
      cache.set(bestEntry.key, bestEntry);
      console.log(`[Cache] 语义命中: "${query.slice(0, 30)}..." (COSINE=${bestSim.toFixed(4)})`);
      return bestEntry.results;
    }

    return null;
  } catch (err) {
    console.warn('[Cache] 查询失败，降级:', err);
    return null;
  }
}

/**
 * 写入缓存（满时 LRU 淘汰最久未访问）
 */
export function saveCache(
  query: string,
  embedding: number[],
  results: SearchResult[],
  ctx: CacheContext
): void {
  try {
    const kbVersion = getKbVersion();
    const key = exactKey(query, ctx.entities, kbVersion, ctx.policyVersion);
    const entitiesHash = [...ctx.entities].sort().join(',');

    cache.set(key, {
      key,
      query,
      embedding: new Float32Array(embedding),
      results,
      kbVersion,
      policyVersion: ctx.policyVersion,
      entitiesHash,
    });

    // LRU 淘汰：Map 的 keys() 按插入顺序，第一个即最久未访问
    while (cache.size > MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  } catch (err) {
    console.warn('[Cache] 写入失败:', err);
  }
}

/** 手动清空缓存 + 重置 kbVersion（索引重建后调用） */
export function clearCache(): void {
  cache.clear();
  cachedKbVersion = null;
}

/** 当前缓存条目数（调试/测试用） */
export function getCacheSize(): number {
  return cache.size;
}

// ============================================================
// SearchCachePort 适配
// ============================================================

/** 进程内 LRU 语义缓存（Spec 030），实现 application/ports 的 SearchCachePort */
export class LruSearchCache implements SearchCachePort {
  lookup(query: string, embedding: number[], ctx: CacheContext): SearchResult[] | null {
    return searchCache(query, embedding, ctx);
  }

  save(query: string, embedding: number[], results: SearchResult[], ctx: CacheContext): void {
    saveCache(query, embedding, results, ctx);
  }
}
