import { createClient, RedisClientType, SCHEMA_FIELD_TYPE } from 'redis';
import { getEmbeddingDim } from './embedding';

let client: RedisClientType | null = null;

function getClient(): RedisClientType {
  if (client) return client;

  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  client = createClient({ url });

  client.on('error', err => {
    console.error('[Redis] 连接错误:', err);
  });

  client.connect().catch(() => {});

  return client;
}

export interface CacheEntry {
  id: string;
  query: string;
  embedding: number[];
  answer: string;
  contexts: string[];
  sources: string[];
  timestamp: number;
  topK: number;
}

const INDEX_NAME = 'rag:cache:idx';
const SIMILARITY_THRESHOLD = 0.9;
const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 将 embedding number[] 序列化为 Redis VECTOR(FLOAT32) 索引要求的连续二进制 Buffer。
 * Redis 向量字段（HNSW + FLOAT32）必须以 little-endian 的 Float32 字节数组存储/查询，
 * 不能使用 JSON 字符串。
 */
function embeddingToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * 将 Redis 返回的 FLOAT32 二进制 Buffer 还原为 number[]。
 * 注意：Buffer 可能是更大 ArrayBuffer 的切片视图，需用 byteOffset 正确偏移。
 */
function bufferToEmbedding(buf: Buffer | string): number[] {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Array.from(
    new Float32Array(b.buffer, b.byteOffset, b.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );
}

export async function initCache(): Promise<void> {
  const client = getClient();

  try {
    await client.ft.create(INDEX_NAME, {
      embedding: {
        type: SCHEMA_FIELD_TYPE.VECTOR,
        ALGORITHM: 'HNSW',
        TYPE: 'FLOAT32',
        DIM: getEmbeddingDim(),
        DISTANCE_METRIC: 'COSINE',
      },
      query: {
        type: SCHEMA_FIELD_TYPE.TEXT,
      },
    }, {
      ON: 'HASH',
      PREFIX: 'rag:cache:data:',
    });
    console.log('[Redis] 向量索引创建成功:', INDEX_NAME);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      console.log('[Redis] 向量索引已存在:', INDEX_NAME);
    } else {
      console.warn('[Redis] 向量索引创建失败:', err);
    }
  }
}

export async function searchCache(embedding: number[]): Promise<CacheEntry | null> {
  const client = getClient();

  try {
    const results = await client.ft.search(INDEX_NAME,
      `(*)=>[KNN 1 @embedding $vec AS score]`,
      {
        PARAMS: { vec: embeddingToBuffer(embedding) },
        DIALECT: 2,
        RETURN: ['query', 'answer', 'contexts', 'sources', 'timestamp', 'topK', 'embedding'],
      }
    );

    if (results.total === 0) return null;

    const hit = results.documents[0] as unknown as {
      id: string;
      value: {
        query: string;
        answer: string;
        contexts: string;
        sources: string;
        timestamp: string;
        topK: string;
        embedding: Buffer | string;
      };
      score?: string;
    };

    const distance = hit.score ? parseFloat(hit.score) : 1;
    const similarity = 1 - distance;

    if (similarity < SIMILARITY_THRESHOLD) {
      console.log(`[Redis] 相似度 ${similarity.toFixed(4)} < ${SIMILARITY_THRESHOLD}，未命中缓存`);
      return null;
    }

    const data = hit.value;

    return {
      id: hit.id.replace('rag:cache:data:', ''),
      query: data.query,
      embedding: bufferToEmbedding(data.embedding),
      answer: data.answer,
      contexts: JSON.parse(data.contexts),
      sources: JSON.parse(data.sources),
      timestamp: parseInt(data.timestamp, 10),
      topK: parseInt(data.topK, 10),
    };
  } catch (err) {
    console.warn('[Redis] 缓存查询失败:', err);
    return null;
  }
}

export async function saveCache(entry: Omit<CacheEntry, 'id'>): Promise<void> {
  const client = getClient();
  const id = crypto.randomUUID();

  try {
    await client.hSet(`rag:cache:data:${id}`, {
      query: entry.query,
      embedding: embeddingToBuffer(entry.embedding),
      answer: entry.answer,
      contexts: JSON.stringify(entry.contexts),
      sources: JSON.stringify(entry.sources),
      timestamp: entry.timestamp.toString(),
      topK: entry.topK.toString(),
    });

    await client.expire(`rag:cache:data:${id}`, TTL_SECONDS);

    await client.sAdd('rag:cache:ids', id);
    await client.expire('rag:cache:ids', TTL_SECONDS + 3600);

    console.log(`[Redis] 缓存写入成功: "${entry.query.slice(0, 30)}..."`);
  } catch (err) {
    console.warn('[Redis] 缓存写入失败:', err);
  }
}

export async function clearCache(): Promise<void> {
  const client = getClient();

  try {
    const ids = await client.sMembers('rag:cache:ids');

    for (const id of ids) {
      await client.del(`rag:cache:data:${id}`);
    }

    if (ids.length > 0) {
      await client.sRem('rag:cache:ids', ids);
    }

    console.log(`[Redis] 缓存已清空，共删除 ${ids.length} 条`);
  } catch (err) {
    console.warn('[Redis] 缓存清空失败:', err);
  }
}

export function isRedisAvailable(): boolean {
  return client !== null && client.isReady;
}
