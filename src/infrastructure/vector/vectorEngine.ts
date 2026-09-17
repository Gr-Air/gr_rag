// ============================================================
// 向量检索引擎（基于 LanceDB 向量数据库）
// 使用阿里云 DashScope Embedding API
// ============================================================

import path from 'path';
import { getQueryEmbedding } from '../embedding/embedding';

// LanceDB 最小结构类型（仅声明本模块用到的方法）
interface LanceQueryBuilder {
  distanceType(type: string): LanceQueryBuilder;
  limit(n: number): LanceQueryBuilder;
  select(columns: string[]): LanceQueryBuilder;
  toArray(): Promise<Record<string, unknown>[]>;
}
interface LanceTable {
  countRows(): Promise<number>;
  search(vector: number[]): LanceQueryBuilder;
}
interface LanceConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable>;
}
// 暴力搜索路径需要的 select 能力（SDK 类型未在 Table 上声明）
type SelectableTable = LanceTable & {
  select(columns: string[]): { toArray(): Promise<Record<string, unknown>[]> };
};

/** 从 unknown 错误中提取 message */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 动态 import LanceDB（ESM 兼容）；SDK 类型与本模块最小接口不完全一致，收窄到所需能力
type LanceDBModule = { connect(path: string): Promise<LanceConnection> };
let lanceDBModule: LanceDBModule | null = null;
async function getLanceDB(): Promise<LanceDBModule> {
  if (!lanceDBModule) {
    lanceDBModule = (await import('@lancedb/lancedb')) as unknown as LanceDBModule;
  }
  return lanceDBModule;
}

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const LANCEDB_DIR = path.join(DATA_DIR, 'lancedb');

// 连接和表缓存
let dbConnection: LanceConnection | null = null;
let chunksTable: LanceTable | null = null;

/** 获取 LanceDB 连接 */
async function getConnection(): Promise<LanceConnection> {
  if (dbConnection) return dbConnection;
  const lancedb = await getLanceDB();
  const conn = await lancedb.connect(LANCEDB_DIR);
  dbConnection = conn;
  return conn;
}

/** 获取 chunks 表 */
async function getTable(): Promise<LanceTable | null> {
  if (chunksTable) {
    try {
      // 验证表仍然可用
      await chunksTable.countRows();
      return chunksTable;
    } catch {
      chunksTable = null;
    }
  }

  const conn = await getConnection();
  const tableNames = await conn.tableNames();
  if (tableNames.includes('chunks')) {
    const table = await conn.openTable('chunks');
    chunksTable = table;
    return table;
  }
  return null;
}

// Query embedding 缓存（相同 query 不重复调用 API）
const queryEmbeddingCache: Map<string, number[]> = new Map();

/**
 * 预热 query embedding 缓存（Spec 030）：
 * 检索缓存层已为 query 调用过 getQueryEmbedding，这里写入可避免
 * vectorSearch 未命中时重复调用 embedding API。
 */
export function prewarmQueryEmbedding(query: string, embedding: number[]): void {
  queryEmbeddingCache.set(query, embedding);
}

/**
 * 向量检索
 *
 * 使用 LanceDB 的 IVF_PQ 索引（或降级为暴力搜索）进行近似最近邻检索
 */
export async function vectorSearch(
  query: string,
  topK: number = 20
): Promise<Array<{ chunkId: string; score: number; parentDocId?: string }>> {
  const table = await getTable();
  if (!table) {
    console.warn('[vectorSearch] LanceDB 索引未构建，请先运行: node scripts/buildIndex.cjs');
    return [];
  }

  // 获取 query 向量（带缓存）
  let queryVec: number[];
  if (queryEmbeddingCache.has(query)) {
    queryVec = queryEmbeddingCache.get(query)!;
  } else {
    try {
      queryVec = await getQueryEmbedding(query);
      queryEmbeddingCache.set(query, queryVec);
    } catch {
      console.warn('[vectorSearch] Embedding API 调用失败，跳过向量检索');
      return [];
    }
  }

  // 使用 LanceDB 向量检索
  try {
    const results = await table
      .search(queryVec)
      .distanceType('cosine')
      .limit(topK)
      .select(['id', 'docId', 'docTitle', 'docPath', 'content', 'parentDocId'])
      .toArray();

    return results.map(row => {
      const distance = row._distance as number | undefined;
      const fallbackScore = (row.score as number) || 0;
      return {
        chunkId: row.id as string,
        score: distance !== undefined ? 1 - distance : fallbackScore,
        parentDocId: (row.parentDocId as string) || undefined,
      };
    });
  } catch (err) {
    // 如果没有向量索引，降级为全量扫描
    const msg = errMsg(err);
    if (msg.includes('no vector index') || msg.includes('not indexed')) {
      return bruteForceSearch(table, queryVec, topK);
    }
    console.error('[vectorSearch] LanceDB 检索失败:', msg);
    return [];
  }
}

/**
 * 暴力全量搜索（降级方案）
 */
async function bruteForceSearch(
  table: LanceTable,
  queryVec: number[],
  topK: number
): Promise<Array<{ chunkId: string; score: number; parentDocId?: string }>> {
  console.log('[vectorSearch] 使用暴力搜索（无向量索引）');
  try {
    const allRows = await (table as SelectableTable).select(['id', 'vector', 'parentDocId']).toArray();

    const results = allRows.map(row => {
      const sim = cosineSimilarity(queryVec, (row.vector as number[]) || []);
      return { chunkId: row.id as string, score: sim, parentDocId: (row.parentDocId as string) || undefined };
    });

    return results.sort((a: { chunkId: string; score: number }, b: { chunkId: string; score: number }) => b.score - a.score).slice(0, topK);
  } catch (err) {
    console.error('[vectorSearch] 暴力搜索失败:', errMsg(err));
    return [];
  }
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 检查 LanceDB 索引是否就绪
 */
export async function isVectorReady(): Promise<boolean> {
  try {
    const table = await getTable();
    if (!table) return false;
    const count = await table.countRows();
    return count > 0;
  } catch {
    return false;
  }
}
