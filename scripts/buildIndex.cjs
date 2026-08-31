// ============================================================
// 索引构建脚本 (CommonJS 版本，兼容性好)
// 用法: node scripts/buildIndex.cjs
// 向量索引: LanceDB（带 IVF_PQ 索引加速）
// Embedding: 阿里云 DashScope API
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
const { buildStateSnapshot } = require('./lib/hasher.cjs');
const {
  writeChunksMeta,
  writeBM25Index,
  writeParents,
  writeVectorConfig,
  DATA_DIR,
} = require('./lib/indexWriter.cjs');
const { writeManifestAfterBuild } = require('./lib/manifest.cjs');

const ROOT = path.join(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, 'Raw');
const WIKI_DIR = path.join(ROOT, 'Wiki');
const LANCEDB_DIR = path.join(DATA_DIR, 'lancedb');

const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1024', 10);
const DIM = EMBEDDING_DIM;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

function logMem(label) {
  const used = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.log(`  [${label}] heap: ${used} MB`);
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('========================================');
  console.log('  星辰Wiki 知识库索引构建 (LanceDB)');
  console.log('========================================\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // ===== 阶段1：解析文档 =====
  console.log('[1/4] 解析文档并分块...');
  const { rawDocs, wikiEntries } = scanAll();
  const allChunks = [];

  for (let fi = 0; fi < rawDocs.length; fi++) {
    const { file, content, key: docId } = rawDocs[fi];
    const filename = path.basename(file);
    const meta = parseFilename(filename);
    const title = extractTitle(content, filename);
    const chunks = chunkDocument(content, docId, title, file, {
      client: meta.client, project: meta.project, docType: meta.docType, date: meta.date,
    });
    allChunks.push(...chunks);
    if ((fi + 1) % 20 === 0) console.log(`  已解析 ${fi + 1}/${rawDocs.length}`);
  }

  
  console.log(`  ✅ 共 ${allChunks.length} 个文档块`);
  logMem('after parse');

  // ===== 阶段2：向量索引（使用阿里 DashScope Embedding + LanceDB）=====
  console.log('\n[2/4] 构建向量索引（阿里 DashScope Embedding → LanceDB）...');

  if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY.startsWith('sk-你的')) {
    console.error('  ❌ DASHSCOPE_API_KEY 未配置，请在 .env 中设置有效的 API Key');
    process.exit(1);
  }

  // 准备所有文本（取前 2000 字符用于向量化）
  const vecTexts = allChunks.map(c => c.content.slice(0, 2000));
  console.log(`  共 ${vecTexts.length} 条文本待向量化，维度: ${DIM}`);

  // 批量调用阿里 embedding API
  const allVectors = await getEmbeddingsBatch(vecTexts);
  console.log(`  ✅ Embedding 完成: ${allVectors.length} 个向量`);

  // ========================================
  // 写入 LanceDB
  // ========================================
  const lancedb = require('@lancedb/lancedb');

  // 清空旧数据
  if (fs.existsSync(LANCEDB_DIR)) {
    console.log('  清空旧 LanceDB 数据...');
    fs.rmSync(LANCEDB_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(LANCEDB_DIR, { recursive: true });

  const db = await lancedb.connect(LANCEDB_DIR);
  console.log('  LanceDB 已连接');

  // 准备表数据
  const tableData = allChunks.map((chunk, i) => ({
    id: chunk.id,
    docId: chunk.docId,
    docTitle: chunk.docTitle,
    docPath: chunk.docPath,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content.slice(0, 3000),
    vector: allVectors[i],
    metadata_client: chunk.metadata.client || '',
    metadata_project: chunk.metadata.project || '',
    metadata_docType: chunk.metadata.docType || '',
    metadata_date: chunk.metadata.date || '',
    wikiLinks: JSON.stringify(chunk.wikiLinks || []),
    parentDocId: chunk.parentDocId || '',
  }));

  // 创建 LanceDB 表
  const table = await db.createTable('chunks', tableData, { mode: 'overwrite' });
  console.log(`  ✅ LanceDB 表已创建: ${tableData.length} 条记录`);

  // 创建 IVF_PQ 向量索引
  try {
    const numPartitions = Math.min(Math.max(Math.floor(allChunks.length / 20), 4), 256);
    console.log(`  创建 IVF_PQ 向量索引 (num_partitions=${numPartitions})...`);
    await table.createIndex('vector', {
      config: lancedb.Index.ivfPq({
        numPartitions,
        numSubVectors: Math.min(DIM / 8, 64),
        maxIterations: 50,
        distanceType: 'cosine',
      }),
      replace: true,
    });
    console.log('  ✅ IVF_PQ 向量索引创建完成');
  } catch (err) {
    console.warn(`  ⚠️ IVF_PQ 索引创建失败（将使用暴力搜索）: ${err.message}`);
  }

  logMem('after lanceDB');

  // ===== 阶段3：BM25 索引 =====
  console.log('\n[3/4] 构建 BM25 倒排索引...');

  const invIndex = new Map();
  const docLengths = {};

  for (let i = 0; i < allChunks.length; i++) {
    const c = allChunks[i];
    const tokens = tokenizeAll(c.content);
    docLengths[c.id] = tokens.length;

    const tfMap = new Map();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);
    for (const [term, tf] of tfMap) {
      if (!invIndex.has(term)) invIndex.set(term, []);
      invIndex.get(term).push({ chunkId: c.id, tf });
    }
    if ((i + 1) % 500 === 0) {
      console.log(`  已索引 ${i + 1}/${allChunks.length}, ${invIndex.size} 词项`);
      logMem(`bm25 ${i + 1}`);
    }
  }

  writeBM25Index(invIndex, docLengths);

  // chunks_meta 写入
  writeChunksMeta(allChunks);

  // 保存父文档
  console.log('\n  保存父文档...');
  const parentDocMap = new Map();
  for (const { file, content, key: docId } of rawDocs) {
    const filename = path.basename(file);
    const meta = parseFilename(filename);
    const title = extractTitle(content, filename);
    parentDocMap.set(docId, {
      docId,
      title,
      path: file,
      metadata: { client: meta.client, project: meta.project, docType: meta.docType, date: meta.date },
      childChunkIds: allChunks.filter(c => c.parentDocId === `parent_${docId}`).map(c => c.id),
    });
  }
  writeParents(parentDocMap);

  // 向量索引配置
  writeVectorConfig(allChunks.length, DIM);

  logMem('final');
  console.log(`\n  ✅ BM25 完成: ${allChunks.length} 文档, ${invIndex.size} 词项\n`);

  // ===== 阶段4：构建结构化数据库 =====
  console.log('[4/4] 构建结构化数据库（概念/实体 → 文档关联）...');
  let structDbOk = false;
  try {
    const { main: buildStructDb } = require('./buildStructDb.cjs');
    await buildStructDb(); // 等待完成，确保写 manifest 时 structDb 状态已确定
    structDbOk = true;
  } catch (err) {
    console.warn('  ⚠️ 结构化数据库构建失败（不影响核心检索）:', err.message);
    console.warn('  可单独运行: node scripts/buildStructDb.cjs');
  }

  // ===== 保存增量状态快照 =====
  console.log('\n  保存增量索引状态快照...');
  const allFiles = [
    ...rawDocs.map(r => ({ key: r.key, content: r.content })),
    ...wikiEntries.map(w => ({ key: w.key, content: w.content })),
  ];
  const indexState = buildStateSnapshot(allFiles);
  fs.writeFileSync(path.join(DATA_DIR, 'index_state.json'), JSON.stringify(indexState, null, 2));
  console.log(`  ✅ 增量状态快照已保存: ${Object.keys(indexState).length} 个文件`);

  // ===== 写入索引 manifest（所有必需 store 缺一则拒绝写入，保留旧版本） =====
  console.log('\n  写入索引 manifest...');
  const manifest = writeManifestAfterBuild(DATA_DIR, { buildMode: 'full' });
  if (manifest) {
    console.log(`  ✅ index_manifest.json 已写入 (v${manifest.indexVersion}, 构建于 ${manifest.builtAt})`);
  } else {
    console.error('  ❌ 必需 store 存在缺失，manifest 未写入（保留旧版本）');
  }

  console.log('\n========================================');
  console.log('  ✅ 全部索引构建完成! (LanceDB)');
  console.log('========================================');
  console.log(`  总块数: ${allChunks.length}`);
  console.log(`  向量维度: ${DIM}`);
  console.log(`  向量引擎: LanceDB (IVF_PQ)`);
  console.log(`  BM25 词项: ${invIndex.size}`);
  console.log(`  LanceDB 路径: src/data/lancedb/`);
  console.log(`  增量状态: src/data/index_state.json`);
  console.log(`  索引版本: src/data/index_manifest.json (v${manifest ? manifest.indexVersion : '未写入'})`);
  console.log('========================================');
}

main().catch(err => {
  console.error('构建失败:', err);
  process.exit(1);
});
