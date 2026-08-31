// ============================================================
// 增量索引构建脚本
// 检测 Raw/ 和 Wiki/entity/ Wiki/concept/ 中新增/修改的文件
// 增量添加到 LanceDB + BM25 + SQLite 各存储中
//
// 用法: node scripts/buildIncremental.cjs
//
// 原理：
//   1. 读取 index_state.json（记录上次构建的文件→hash 快照）
//   2. 扫描 Raw/Wiki 目录，对比 hash 找出新增/修改/删除的文件
//   3. 对新增/修改的文件：分块 → Embedding → 追加到 LanceDB/BM25/parents
//   4. 对删除的文件：从各存储中移除对应数据
//   5. 更新 index_state.json
//
// v2: 重构使用 scripts/lib/ 公共模块
// ============================================================

const fs = require('fs');
const path = require('path');

// 加载环境变量
const { loadEnv } = require('./lib/envLoader.cjs');
loadEnv();

// 公共模块
const { tokenizeAll } = require('./lib/tokenizer.cjs');
const { getEmbeddingsBatch } = require('./lib/embedder.cjs');
const { chunkDocument, extractTitle, parseFilename } = require('./lib/chunker.cjs');
const { scanAll } = require('./lib/scanner.cjs');
const { fileHash, buildStateSnapshot } = require('./lib/hasher.cjs');
const {
  writeChunksMeta,
  writeBM25Index,
  writeParents,
  writeVectorConfig,
  DATA_DIR,
} = require('./lib/indexWriter.cjs');
const { writeManifestAfterBuild } = require('./lib/manifest.cjs');

const STATE_PATH = path.join(DATA_DIR, 'index_state.json');
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1024', 10);
const DIM = EMBEDDING_DIM;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

// ============================================================
// 变更检测：扫描文件并对比 hash
// ============================================================

/**
 * 返回 { added: [], modified: [], deleted: [], unchanged: [] }
 * 每项格式：{ key, file, hash, content }
 */
function detectChanges() {
  // 加载旧状态
  let oldState = {};
  if (fs.existsSync(STATE_PATH)) {
    oldState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  }

  // 扫描当前所有文件
  const { rawDocs, wikiEntries } = scanAll();
  const allFiles = [...rawDocs, ...wikiEntries];
  const currentFiles = {};
  for (const f of allFiles) {
    currentFiles[f.key] = {
      key: f.key,
      file: f.file,
      hash: fileHash(f.content),
      content: f.content,
    };
  }

  // 对比差异
  const added = [];
  const modified = [];
  const deleted = [];
  const unchanged = [];

  const oldKeys = new Set(Object.keys(oldState));
  const newKeys = new Set(Object.keys(currentFiles));

  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      added.push(currentFiles[key]);
    } else if (currentFiles[key].hash !== oldState[key]) {
      modified.push(currentFiles[key]);
    } else {
      unchanged.push(key);
    }
  }

  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      deleted.push(key);
    }
  }

  return { added, modified, deleted, unchanged };
}

// ============================================================
// 增量更新各存储
// ============================================================

/**
 * 增量更新 LanceDB：
 * - 删除旧 chunk（按 docId 前缀匹配删除）
 * - 追加新 chunk
 * - 重建 IVF_PQ 索引
 */
async function updateLanceDB(changes) {
  const lancedb = require('@lancedb/lancedb');
  const LANCEDB_DIR = path.join(DATA_DIR, 'lancedb');

  if (!fs.existsSync(LANCEDB_DIR)) {
    console.log('  ⚠️ LanceDB 目录不存在，跳过增量更新（请先全量构建）');
    return [];
  }

  const db = await lancedb.connect(LANCEDB_DIR);
  const tableNames = await db.tableNames();
  if (!tableNames.includes('chunks')) {
    console.log('  ⚠️ chunks 表不存在，跳过增量更新（请先全量构建）');
    return [];
  }

  const table = await db.openTable('chunks');

  // 收集所有需要新增的 chunk
  const allNewChunks = [];
  const allIdsToDelete = [];

  // 处理新增/修改的文件（修改 = 删除旧 + 添加新）
  const toProcess = [...changes.added, ...changes.modified];
  for (const item of toProcess) {
    const isRaw = item.key.startsWith('raw_');

    if (isRaw) {
      // Raw 文档：分块处理
      const filename = path.basename(item.file);
      const meta = parseFilename(filename);
      const docId = item.key;
      const title = extractTitle(item.content, filename);
      const chunks = chunkDocument(item.content, docId, title, item.file, {
        client: meta.client, project: meta.project, docType: meta.docType, date: meta.date,
      });

      allIdsToDelete.push(docId);
      allNewChunks.push(...chunks);
    }
  }

  // 处理删除的文件
  for (const key of changes.deleted) {
    allIdsToDelete.push(key);
  }

  // 执行 LanceDB 删除
  let deletedCount = 0;
  if (allIdsToDelete.length > 0) {
    console.log(`  从 LanceDB 删除 ${allIdsToDelete.length} 个 docId 对应的旧 chunk...`);
    for (const docId of allIdsToDelete) {
      const prefix = docId + '_';
      try {
        await table.delete(`id LIKE '${prefix}%' OR id = '${docId}'`);
        deletedCount++;
      } catch (err) {
        // 可能没有匹配的行，忽略
      }
    }
    console.log(`  ✅ 已删除 ${deletedCount} 个文档的旧 chunk`);
  }

  // 如果有新 chunk，做 embedding 并追加
  if (allNewChunks.length > 0) {
    console.log(`  ${allNewChunks.length} 个新 chunk 待 embedding...`);
    const vecTexts = allNewChunks.map(c => c.content.slice(0, 2000));
    const vectors = await getEmbeddingsBatch(vecTexts);

    const tableData = allNewChunks.map((chunk, i) => ({
      id: chunk.id,
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      docPath: chunk.docPath,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content.slice(0, 3000),
      vector: vectors[i],
      metadata_client: chunk.metadata.client || '',
      metadata_project: chunk.metadata.project || '',
      metadata_docType: chunk.metadata.docType || '',
      metadata_date: chunk.metadata.date || '',
      wikiLinks: JSON.stringify(chunk.wikiLinks || []),
      parentDocId: chunk.parentDocId || '',
    }));

    await table.add(tableData);
    console.log(`  ✅ LanceDB 追加 ${tableData.length} 条记录`);

    // 重建 IVF_PQ 索引
    try {
      const count = await table.countRows();
      const numPartitions = Math.min(Math.max(Math.floor(count / 20), 4), 256);
      console.log(`  重建 IVF_PQ 向量索引 (num_partitions=${numPartitions})...`);
      await table.createIndex('vector', {
        config: lancedb.Index.ivfPq({
          numPartitions,
          numSubVectors: Math.min(DIM / 8, 64),
          maxIterations: 50,
          distanceType: 'cosine',
        }),
        replace: true,
      });
      console.log('  ✅ IVF_PQ 索引重建完成');
    } catch (err) {
      console.warn(`  ⚠️ IVF_PQ 索引重建失败（将使用暴力搜索）: ${err.message}`);
    }
  }

  return allNewChunks;
}

/**
 * 增量更新 BM25 倒排索引 + chunks_meta 分片 + parents.json
 * 策略：读取现有数据 → 移除旧条目 → 追加新条目 → 重写分片
 */
function updateBM25AndMeta(changes, newLanceChunks) {
  const bm25Dir = path.join(DATA_DIR, 'bm25');
  const metaDir = path.join(DATA_DIR, 'chunks_meta');
  const parentsDir = path.join(DATA_DIR, 'parents');

  // 收集所有要删除的 chunk ID 前缀
  const deletePrefixes = [];
  for (const key of [...changes.deleted, ...changes.added.map(a => a.key), ...changes.modified.map(m => m.key)]) {
    deletePrefixes.push(key);
  }

  // ===== BM25：重建倒排索引 =====
  console.log('  更新 BM25 倒排索引...');

  let allInvEntries = [];
  let allDocLengths = {};

  if (fs.existsSync(bm25Dir)) {
    const shardFiles = fs.readdirSync(bm25Dir).filter(f => f.startsWith('shard_') && f.endsWith('.json'));
    for (const sf of shardFiles) {
      const shard = JSON.parse(fs.readFileSync(path.join(bm25Dir, sf), 'utf-8'));
      for (const [term, postings] of Object.entries(shard)) {
        allInvEntries.push({ term, postings });
      }
    }
    if (fs.existsSync(path.join(bm25Dir, 'doc_lengths.json'))) {
      allDocLengths = JSON.parse(fs.readFileSync(path.join(bm25Dir, 'doc_lengths.json'), 'utf-8'));
    }
  }

  const invIndex = new Map();
  for (const { term, postings } of allInvEntries) {
    invIndex.set(term, postings);
  }

  // 删除旧 chunk 的倒排条目
  const deleteSet = new Set(deletePrefixes);
  for (const [term, postings] of invIndex) {
    const filtered = postings.filter(p => {
      return !deleteSet.has(p.chunkId) && !deletePrefixes.some(prefix => p.chunkId.startsWith(prefix + '_'));
    });
    if (filtered.length === 0) {
      invIndex.delete(term);
    } else {
      invIndex.set(term, filtered);
    }
  }

  // 删除旧 chunk 的 doc_lengths
  for (const chunkId of Object.keys(allDocLengths)) {
    if (deleteSet.has(chunkId) || deletePrefixes.some(prefix => chunkId.startsWith(prefix + '_'))) {
      delete allDocLengths[chunkId];
    }
  }

  // 追加新 chunk 的 BM25 数据
  for (const chunk of newLanceChunks) {
    const tokens = tokenizeAll(chunk.content);
    allDocLengths[chunk.id] = tokens.length;
    const tfMap = new Map();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);
    for (const [term, tf] of tfMap) {
      if (!invIndex.has(term)) invIndex.set(term, []);
      invIndex.get(term).push({ chunkId: chunk.id, tf });
    }
  }

  writeBM25Index(invIndex, allDocLengths);

  // ===== chunks_meta：更新元数据分片 =====
  console.log('  更新 chunks_meta 分片...');

  let existingMeta = {};
  if (fs.existsSync(metaDir)) {
    const metaShardFiles = fs.readdirSync(metaDir).filter(f => f.startsWith('shard_') && f.endsWith('.json'));
    for (const sf of metaShardFiles) {
      const shard = JSON.parse(fs.readFileSync(path.join(metaDir, sf), 'utf-8'));
      Object.assign(existingMeta, shard);
    }
  }

  // 删除旧条目
  for (const chunkId of Object.keys(existingMeta)) {
    if (deleteSet.has(chunkId) || deletePrefixes.some(prefix => chunkId.startsWith(prefix + '_'))) {
      delete existingMeta[chunkId];
    }
  }

  // 追加新条目
  for (const chunk of newLanceChunks) {
    existingMeta[chunk.id] = {
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      docPath: chunk.docPath,
      metadata: chunk.metadata,
      content: chunk.content.slice(0, 3000),
      wikiLinks: chunk.wikiLinks,
      parentDocId: chunk.parentDocId,
    };
  }

  // 重写分片
  const allMetaEntries = Object.entries(existingMeta);
  const META_SHARD = 2000;
  let metaShardIdx = 0;
  for (let i = 0; i < allMetaEntries.length; i += META_SHARD) {
    const shard = {};
    for (let j = i; j < Math.min(i + META_SHARD, allMetaEntries.length); j++) {
      shard[allMetaEntries[j][0]] = allMetaEntries[j][1];
    }
    fs.writeFileSync(path.join(metaDir, `shard_${metaShardIdx}.json`), JSON.stringify(shard));
    metaShardIdx++;
  }
  // 清理多余 shard
  const existingMetaShards = fs.readdirSync(metaDir).filter(f => f.startsWith('shard_') && f.endsWith('.json'));
  for (const sf of existingMetaShards) {
    const idx = parseInt(sf.replace('shard_', '').replace('.json', ''));
    if (idx >= metaShardIdx) {
      fs.unlinkSync(path.join(metaDir, sf));
    }
  }

  fs.writeFileSync(path.join(metaDir, 'config.json'), JSON.stringify({
    totalChunks: allMetaEntries.length, shardSize: META_SHARD, totalShards: metaShardIdx,
  }));

  console.log(`  ✅ chunks_meta 更新完成: ${allMetaEntries.length} 条记录`);

  // ===== parents.json：更新父文档映射 =====
  console.log('  更新 parents.json...');

  let existingParents = {};
  if (fs.existsSync(path.join(parentsDir, 'parents.json'))) {
    existingParents = JSON.parse(fs.readFileSync(path.join(parentsDir, 'parents.json'), 'utf-8'));
  }

  // 删除旧父文档条目
  for (const key of [...changes.deleted, ...changes.added.map(a => a.key), ...changes.modified.map(m => m.key)]) {
    if (key.startsWith('raw_')) {
      delete existingParents[key];
    }
  }

  // 追加新父文档条目（仅 Raw 文档有 parentDocId）
  const rawItems = [...changes.added, ...changes.modified].filter(item => item.key.startsWith('raw_'));
  for (const item of rawItems) {
    const filename = path.basename(item.file);
    const meta = parseFilename(filename);
    const docId = item.key;
    const title = extractTitle(item.content, filename);
    const childChunkIds = newLanceChunks
      .filter(c => c.parentDocId === `parent_${docId}`)
      .map(c => c.id);
    existingParents[docId] = {
      docId,
      title,
      path: item.file,
      metadata: { client: meta.client, project: meta.project, docType: meta.docType, date: meta.date },
      childChunkIds,
    };
  }

  writeParents(new Map(Object.entries(existingParents)));

  // ===== vectors/config.json：更新索引配置 =====
  writeVectorConfig(allMetaEntries.length, DIM);

  return allMetaEntries.length;
}

/**
 * 增量更新 SQLite 结构化数据库
 * 策略：全量重建（数据量小，200+ 词条，重建很快）
 */
async function updateStructDb() {
  console.log('  更新 SQLite 结构化数据库...');
  const { main: buildStructDb } = require('./buildStructDb.cjs');
  await buildStructDb(); // 等待完成，确保写 manifest 时 structDb 状态已确定
  console.log('  ✅ SQLite 结构化数据库更新完成');
}

/**
 * 保存索引状态
 */
function saveState(changes) {
  const currentFilesForState = {};

  // 新增/修改的文件
  for (const item of [...changes.added, ...changes.modified]) {
    currentFilesForState[item.key] = item.hash;
  }

  // 未变更的文件（从旧状态保留）
  if (fs.existsSync(STATE_PATH)) {
    const oldState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    for (const key of changes.unchanged) {
      if (oldState[key]) {
        currentFilesForState[key] = oldState[key];
      }
    }
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(currentFilesForState, null, 2));
  console.log(`  ✅ 索引状态已保存: ${Object.keys(currentFilesForState).length} 个文件`);
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('========================================');
  console.log('  星辰Wiki 增量索引构建');
  console.log('========================================\n');

  if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY.startsWith('sk-你的')) {
    console.error('  ❌ DASHSCOPE_API_KEY 未配置，请在 .env 中设置有效的 API Key');
    process.exit(1);
  }

  // Step 1: 检测变更
  console.log('[1/5] 检测文件变更...');
  const changes = detectChanges();

  console.log(`  📁 新增: ${changes.added.length} 个文件`);
  if (changes.added.length > 0) {
    changes.added.forEach(f => console.log(`     + ${f.file}`));
  }
  console.log(`  📝 修改: ${changes.modified.length} 个文件`);
  if (changes.modified.length > 0) {
    changes.modified.forEach(f => console.log(`     ~ ${f.file}`));
  }
  console.log(`  🗑️  删除: ${changes.deleted.length} 个文件`);
  if (changes.deleted.length > 0) {
    changes.deleted.forEach(f => console.log(`     - ${f}`));
  }
  console.log(`  ✅ 未变更: ${changes.unchanged.length} 个文件`);

  const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length;
  if (totalChanges === 0) {
    console.log('\n  ✅ 没有检测到任何变更，索引已是最新状态');
    return;
  }

  console.log(`\n  共 ${totalChanges} 个文件需要更新`);

  // Step 2: 更新 LanceDB
  console.log('\n[2/5] 更新 LanceDB 向量索引...');
  const newLanceChunks = await updateLanceDB(changes);

  // Step 3: 更新 BM25 + chunks_meta + parents
  console.log('\n[3/5] 更新 BM25 倒排索引 & 元数据...');
  const totalChunks = updateBM25AndMeta(changes, newLanceChunks);

  // Step 4: 更新 SQLite
  console.log('\n[4/5] 更新 SQLite 结构化数据库...');
  await updateStructDb();

  // Step 5: 保存状态
  console.log('\n[5/5] 保存索引状态...');
  saveState(changes);

  // Step 6: 写入索引 manifest（必需 store 缺一则拒绝写入，保留旧版本）
  console.log('  写入索引 manifest...');
  const manifest = writeManifestAfterBuild(DATA_DIR, { buildMode: 'incremental' });
  if (manifest) {
    console.log(`  ✅ index_manifest.json 已写入 (v${manifest.indexVersion}, 构建于 ${manifest.builtAt})`);
  } else {
    console.error('  ❌ 必需 store 存在缺失，manifest 未写入（保留旧版本）');
  }

  console.log('\n========================================');
  console.log('  ✅ 增量索引构建完成!');
  console.log('========================================');
  console.log(`  索引版本: v${manifest ? manifest.indexVersion : '未写入'}`);
  console.log(`  新增 chunk: ${newLanceChunks.length}`);
  console.log(`  总 chunk 数: ${totalChunks}`);
  console.log(`  新增文件: ${changes.added.length}`);
  console.log(`  修改文件: ${changes.modified.length}`);
  console.log(`  删除文件: ${changes.deleted.length}`);
  console.log('========================================');
}

main().catch(err => {
  console.error('增量构建失败:', err);
  process.exit(1);
});
