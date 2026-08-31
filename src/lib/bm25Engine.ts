// ============================================================
// BM25 检索引擎（从文件系统读取预构建索引）
// ============================================================

import fs from 'fs';
import path from 'path';
import { tokenizeFiltered } from './tokenizer';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const BM25_DIR = path.join(DATA_DIR, 'bm25');

interface BM25Meta {
  docCount: number;
  avgDocLen: number;
  totalTerms: number;
  totalShards: number;
}

let bm25Meta: BM25Meta | null = null;
let docLengths: Record<string, number> | null = null;

/** 加载 BM25 元数据 */
function getBM25Meta(): BM25Meta | null {
  if (bm25Meta) return bm25Meta;
  const metaPath = path.join(BM25_DIR, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  bm25Meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  return bm25Meta;
}

/** 加载文档长度 */
function getDocLengths(): Record<string, number> | null {
  if (docLengths) return docLengths;
  const path_ = path.join(BM25_DIR, 'doc_lengths.json');
  if (!fs.existsSync(path_)) return null;
  docLengths = JSON.parse(fs.readFileSync(path_, 'utf-8'));
  return docLengths;
}

/** 加载倒排索引分片 */
function loadBM25Shard(shardIdx: number): Record<string, Array<{ chunkId: string; tf: number }>> | null {
  const shardPath = path.join(BM25_DIR, `shard_${shardIdx}.json`);
  if (!fs.existsSync(shardPath)) return null;
  return JSON.parse(fs.readFileSync(shardPath, 'utf-8'));
}

/** BM25 检索 */
export async function bm25Search(
  query: string,
  topK: number = 20
): Promise<Array<{ chunkId: string; score: number }>> {
  const meta = getBM25Meta();
  const lengths = getDocLengths();
  if (!meta || !lengths) return [];

  const tokens = tokenizeFiltered(query);
  const scores = new Map<string, number>();
  const k1 = 1.5;
  const b = 0.75;

  for (const token of tokens) {
    // 在所有分片中查找该词项
    let postings: Array<{ chunkId: string; tf: number }> | null = null;

    for (let s = 0; s < meta.totalShards; s++) {
      const shard = loadBM25Shard(s);
      if (shard && shard[token]) {
        if (!postings) postings = [];
        postings.push(...shard[token]);
      }
    }

    if (!postings || postings.length === 0) continue;

    const df = postings.length;
    const idf = Math.log(1 + (meta.docCount - df + 0.5) / (df + 0.5));

    for (const posting of postings) {
      const docLen = lengths[posting.chunkId] || meta.avgDocLen;
      const tf = posting.tf;
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLen / meta.avgDocLen));
      const score = idf * (numerator / denominator);
      scores.set(posting.chunkId, (scores.get(posting.chunkId) || 0) + score);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([chunkId, score]) => ({ chunkId, score }));
}

/** 检查 BM25 索引是否就绪 */
export function isBM25Ready(): boolean {
  return getBM25Meta() !== null;
}
