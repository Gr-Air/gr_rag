// ============================================================
// 索引写入器（CommonJS）
// 统一 LanceDB / BM25 / chunks_meta / parents / vectors 的写入逻辑
// 供 buildIndex / buildIncremental 共用
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'src', 'data');

/**
 * 将 chunk 数据写入 chunks_meta 分片
 * @param {Array} allChunks - 所有 chunk 对象
 * @param {number} [shardSize=2000] - 每个分片的最大记录数
 */
function writeChunksMeta(allChunks, shardSize = 2000) {
  const metaDir = path.join(DATA_DIR, 'chunks_meta');
  if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

  let metaShardIdx = 0;
  for (let i = 0; i < allChunks.length; i += shardSize) {
    const shard = {};
    for (let j = i; j < Math.min(i + shardSize, allChunks.length); j++) {
      const c = allChunks[j];
      shard[c.id] = {
        docId: c.docId,
        docTitle: c.docTitle,
        docPath: c.docPath,
        metadata: c.metadata,
        content: c.content.slice(0, 3000),
        wikiLinks: c.wikiLinks,
        parentDocId: c.parentDocId,
      };
    }
    fs.writeFileSync(path.join(metaDir, `shard_${metaShardIdx}.json`), JSON.stringify(shard));
    metaShardIdx++;
  }

  // 清理多余的分片文件
  const existingShards = fs.readdirSync(metaDir).filter(f => f.startsWith('shard_') && f.endsWith('.json'));
  for (const sf of existingShards) {
    const idx = parseInt(sf.replace('shard_', '').replace('.json', ''));
    if (idx >= metaShardIdx) {
      fs.unlinkSync(path.join(metaDir, sf));
    }
  }

  fs.writeFileSync(path.join(metaDir, 'config.json'), JSON.stringify({
    totalChunks: allChunks.length,
    shardSize,
    totalShards: metaShardIdx,
  }));

  console.log(`  ✅ chunks_meta: ${allChunks.length} 条记录, ${metaShardIdx} 个分片`);
  return metaShardIdx;
}

/**
 * 写入 BM25 倒排索引
 * @param {Map<string, Array<{ chunkId: string, tf: number }>>} invIndex - 倒排索引
 * @param {Record<string, number>} docLengths - chunkId → token数
 * @param {number} [shardSize=5000] - 每个分片的词项数
 */
function writeBM25Index(invIndex, docLengths, shardSize = 5000) {
  const bm25Dir = path.join(DATA_DIR, 'bm25');
  if (!fs.existsSync(bm25Dir)) fs.mkdirSync(bm25Dir, { recursive: true });

  const entries = Array.from(invIndex.entries());
  let bm25ShardIdx = 0;
  for (let i = 0; i < entries.length; i += shardSize) {
    const shard = {};
    for (let j = i; j < Math.min(i + shardSize, entries.length); j++) {
      shard[entries[j][0]] = entries[j][1];
    }
    fs.writeFileSync(path.join(bm25Dir, `shard_${bm25ShardIdx}.json`), JSON.stringify(shard));
    bm25ShardIdx++;
  }

  // 清理多余的分片文件
  const existingShards = fs.readdirSync(bm25Dir).filter(f => f.startsWith('shard_') && f.endsWith('.json'));
  for (const sf of existingShards) {
    const idx = parseInt(sf.replace('shard_', '').replace('.json', ''));
    if (idx >= bm25ShardIdx) {
      fs.unlinkSync(path.join(bm25Dir, sf));
    }
  }

  const chunkIds = Object.keys(docLengths);
  let totalLen = 0;
  for (const len of Object.values(docLengths)) totalLen += len;
  const avgDocLen = chunkIds.length > 0 ? totalLen / chunkIds.length : 0;

  fs.writeFileSync(path.join(bm25Dir, 'meta.json'), JSON.stringify({
    docCount: chunkIds.length,
    avgDocLen,
    totalTerms: invIndex.size,
    totalShards: bm25ShardIdx,
  }));
  fs.writeFileSync(path.join(bm25Dir, 'doc_lengths.json'), JSON.stringify(docLengths));

  console.log(`  ✅ BM25: ${chunkIds.length} chunk, ${invIndex.size} 词项, ${bm25ShardIdx} 个分片`);
  return bm25ShardIdx;
}

/**
 * 写入 parents.json（父文档映射）
 * @param {Map<string, { docId: string, title: string, path: string, metadata: object, childChunkIds: string[] }>} parentDocMap
 */
function writeParents(parentDocMap) {
  const parentsDir = path.join(DATA_DIR, 'parents');
  if (!fs.existsSync(parentsDir)) fs.mkdirSync(parentsDir, { recursive: true });

  fs.writeFileSync(
    path.join(parentsDir, 'parents.json'),
    JSON.stringify(Object.fromEntries(parentDocMap))
  );
  console.log(`  ✅ parents: ${parentDocMap.size} 个父文档`);
}

/**
 * 写入 vectors/config.json（向量索引配置）
 * @param {number} totalChunks
 * @param {number} dim
 * @param {string} [indexType='IVF_PQ']
 */
function writeVectorConfig(totalChunks, dim, indexType = 'IVF_PQ') {
  const vecDir = path.join(DATA_DIR, 'vectors');
  if (!fs.existsSync(vecDir)) fs.mkdirSync(vecDir, { recursive: true });

  fs.writeFileSync(path.join(vecDir, 'config.json'), JSON.stringify({
    totalChunks,
    dim,
    engine: 'lancedb',
    indexType,
    totalShards: 1,
  }));
  console.log(`  ✅ vectors/config: ${totalChunks} chunk, dim=${dim}`);
}

module.exports = {
  writeChunksMeta,
  writeBM25Index,
  writeParents,
  writeVectorConfig,
  DATA_DIR,
};
