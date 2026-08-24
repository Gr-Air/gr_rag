#!/usr/bin/env node
// ============================================================
// 从 staging 中间产物构建索引（Stage 2）
// 用法:
//   全量构建:  node scripts/pipeline/build-from-staging.cjs
//   跳过向量:  node scripts/pipeline/build-from-staging.cjs --skip-vectors
//   跳过BM25:  node scripts/pipeline/build-from-staging.cjs --skip-bm25
//   跳过SQLite: node scripts/pipeline/build-from-staging.cjs --skip-sqlite
//
// 从 chunks.jsonl 读取 Stage 1 产出的 chunk，执行:
//   [1/4] 读取 chunks.jsonl
//   [2/4] 向量嵌入 → LanceDB
//   [3/4] BM25 倒排索引 + chunks_meta + parents
//   [4/4] 结构化数据库（SQLite）
// ============================================================

const fs = require('fs');
const path = require('path');

// 加载环境变量
const { loadEnv } = require('../lib/envLoader.cjs');
loadEnv();

// 公共模块
const { tokenizeAll, tokenizeAllFiltered } = require('../lib/tokenizer.cjs');
const { getEmbeddingsBatch } = require('../lib/embedder.cjs');
const { extractWikiLinks, parseFilename, extractTitle } = require('../lib/chunker.cjs');
const { buildStateSnapshot } = require('../lib/hasher.cjs');
const {
  writeChunksMeta,
  writeBM25Index,
  writeParents,
  writeVectorConfig,
  DATA_DIR,
} = require('../lib/indexWriter.cjs');
const { readStaging, readManifest, stagingExists } = require('../lib/staging.cjs');

const LANCEDB_DIR = path.join(DATA_DIR, 'lancedb');
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1024', 10);
const DIM = EMBEDDING_DIM;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

function logMem(label) {
  const used = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.log(`  [${label}] heap: ${used} MB`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    skipVectors: args.includes('--skip-vectors'),
    skipBm25: args.includes('--skip-bm25'),
    skipSqlite: args.includes('--skip-sqlite'),
  };
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  从 Staging 构建索引 (Stage 2)');
  console.log('========================================\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // ===== 检查 staging 是否存在 =====
  if (!stagingExists()) {
    console.error('  ❌ chunks.jsonl 或 manifest.json 不存在');
    console.error('  请先运行: node scripts/pipeline/clean-and-chunk.cjs');
    process.exit(1);
  }

  const manifest = readManifest();
  console.log(`  Staging 版本: ${manifest.pipelineVersion}`);
  console.log(`  构建时间: ${manifest.builtAt}`);
  console.log(`  Git Commit: ${manifest.gitCommit}`);
  console.log(`  chunk 配置: ${JSON.stringify(manifest.chunkConfig)}\n`);

  // ===== [1/4] 读取 chunks.jsonl =====
  console.log('[1/4] 读取 chunks.jsonl...');
  const allChunks = readStaging();
  console.log(`  ✅ 读取 ${allChunks.length} 个 chunk`);

  // 过滤 wiki 概念/实体短词条：它们已在 SQLite struct DB 中用于实体查询，
  // 不再参与向量/BM25 语义检索（短词条 avg 32 tokens，稀释搜索结果）
  const indexChunks = allChunks.filter(c => !c.docId?.startsWith('wiki_'));
  const wikiCount = allChunks.length - indexChunks.length;
  console.log(`  过滤 wiki 短词条: ${wikiCount} 个，保留 ${indexChunks.length} 个 Raw 文档 chunk`);

  // 按 docId 分组，用于构建 parents
  const docMap = new Map();
  for (const chunk of allChunks) {
    const docId = chunk.parentDocId
      ? chunk.parentDocId.replace(/^parent_/, '')
      : chunk.docId;
    if (!docMap.has(docId)) {
      docMap.set(docId, {
        docId,
        title: chunk.docTitle || '',
        path: chunk.docPath || '',
        metadata: chunk.metadata || {},
        childChunkIds: [],
      });
    }
    docMap.get(docId).childChunkIds.push(chunk.id);
  }
  console.log(`  ✅ 涉及 ${docMap.size} 个文档`);
  logMem('after load');

  // ===== [2/4] 向量索引 =====
  if (opts.skipVectors) {
    console.log('\n[2/4] 向量索引 (--skip-vectors，跳过)');
  } else {
    console.log('\n[2/4] 构建向量索引（DashScope Embedding → LanceDB）...');

    if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY.startsWith('sk-你的')) {
      console.error('  ❌ DASHSCOPE_API_KEY 未配置，请在 .env 中设置');
      console.error('  或使用 --skip-vectors 跳过向量索引');
      process.exit(1);
    }

    // 准备文本：使用原始 chunk.content 做 embedding
    // 注意：曾尝试用 chunk.summary 提升语义匹配，但评测显示摘要丢失
    // 了具体术语（人名、日期、技术名词等），导致向量检索召回率暴跌
    const vecTexts = indexChunks.map(c => {
      return (c.content || '').slice(0, 2000);
    });
    console.log(`  共 ${vecTexts.length} 条文本待向量化，维度: ${DIM}`);

    // 批量调用 embedding API
    const allVectors = await getEmbeddingsBatch(vecTexts);
    console.log(`  ✅ Embedding 完成: ${allVectors.length} 个向量`);

    // 写入 LanceDB
    const lancedb = require('@lancedb/lancedb');

    if (fs.existsSync(LANCEDB_DIR)) {
      console.log('  清空旧 LanceDB 数据...');
      fs.rmSync(LANCEDB_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(LANCEDB_DIR, { recursive: true });

    const db = await lancedb.connect(LANCEDB_DIR);
    console.log('  LanceDB 已连接');

    // 准备表数据
    const tableData = indexChunks.map((chunk, i) => ({
      id: chunk.id,
      docId: chunk.docId,
      docTitle: chunk.docTitle || '',
      docPath: chunk.docPath || '',
      chunkIndex: chunk.chunkIndex ?? 0,
      content: chunk.content.slice(0, 3000),
      summary: chunk.summary || '',
      keywords: JSON.stringify(chunk.keywords || []),
      entities: JSON.stringify(chunk.entities || []),
      vector: allVectors[i],
      metadata_client: chunk.metadata?.client || '',
      metadata_project: chunk.metadata?.project || '',
      metadata_docType: chunk.metadata?.docType || '',
      metadata_date: chunk.metadata?.date || '',
      wikiLinks: JSON.stringify(chunk.wikiLinks || []),
      parentDocId: chunk.parentDocId || '',
    }));

    const table = await db.createTable('chunks', tableData, { mode: 'overwrite' });
    console.log(`  ✅ LanceDB 表已创建: ${tableData.length} 条记录`);

    // 创建 IVF_PQ 向量索引
    try {
      const numPartitions = Math.min(Math.max(Math.floor(indexChunks.length / 20), 4), 256);
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

    // 向量索引配置
    writeVectorConfig(indexChunks.length, DIM);
    logMem('after lanceDB');
  }

  // ===== [3/4] BM25 倒排索引 + chunks_meta + parents =====
  if (opts.skipBm25) {
    console.log('\n[3/4] BM25 索引 (--skip-bm25，跳过)');
  } else {
    console.log('\n[3/4] 构建 BM25 倒排索引...');

    const invIndex = new Map();
    const docLengths = {};

    for (let i = 0; i < indexChunks.length; i++) {
      const c = indexChunks[i];
      const tokens = tokenizeAllFiltered(c.content);
      docLengths[c.id] = tokens.length;

      const tfMap = new Map();
      for (const t of tokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);
      for (const [term, tf] of tfMap) {
        if (!invIndex.has(term)) invIndex.set(term, []);
        invIndex.get(term).push({ chunkId: c.id, tf });
      }
      if ((i + 1) % 500 === 0) {
        console.log(`  已索引 ${i + 1}/${indexChunks.length}, ${invIndex.size} 词项`);
        logMem(`bm25 ${i + 1}`);
      }
    }

    writeBM25Index(invIndex, docLengths);

    // chunks_meta 写入
    writeChunksMeta(allChunks);

    // parents 写入
    console.log('\n  保存父文档...');
    const parentDocMap = new Map();
    for (const [docId, doc] of docMap) {
      parentDocMap.set(docId, {
        docId,
        title: doc.title,
        path: doc.path,
        metadata: doc.metadata,
        childChunkIds: doc.childChunkIds,
      });
    }
    writeParents(parentDocMap);

    logMem('final');
    console.log(`\n  ✅ BM25 完成: ${allChunks.length} chunk, ${invIndex.size} 词项`);
  }

  // ===== [4/4] 结构化数据库（SQLite） =====
  if (opts.skipSqlite) {
    console.log('\n[4/4] 结构化数据库 (--skip-sqlite，跳过)');
  } else {
    console.log('\n[4/4] 构建结构化数据库（词条/实体 → 文档关联 → SQLite）...');
    try {
      // buildStructDb.cjs 从文件系统读取 Wiki/ 和 Raw/
      // 它独立扫描，不依赖 staging，直接调用即可
      const { main: buildStructDb } = require('../buildStructDb.cjs');
      buildStructDb();
    } catch (err) {
      console.warn('  ⚠️ 结构化数据库构建失败（不影响核心检索）:', err.message);
      console.warn('  可单独运行: node scripts/buildStructDb.cjs');
    }
  }

  // ===== 保存增量状态快照 =====
  console.log('\n  保存增量索引状态快照...');
  // 从 staging manifest 获取源文件列表，用文件内容计算 hash
  const { scanAll } = require('../lib/scanner.cjs');
  const { rawDocs, wikiEntries } = scanAll();
  const allFiles = [
    ...rawDocs.map(r => ({ key: r.key, content: r.content })),
    ...wikiEntries.map(w => ({ key: w.key, content: w.content })),
  ];
  const indexState = buildStateSnapshot(allFiles);
  fs.writeFileSync(path.join(DATA_DIR, 'index_state.json'), JSON.stringify(indexState, null, 2));
  console.log(`  ✅ 增量状态快照已保存: ${Object.keys(indexState).length} 个文件`);

  // ===== 汇总 =====
  console.log('\n========================================');
  console.log('  ✅ Stage 2 索引构建完成!');
  console.log('========================================');
  console.log(`  总 chunk 数: ${indexChunks.length} (向量+BM25) / ${allChunks.length} (含wiki元数据)`);
  console.log(`  文档数: ${docMap.size}`);
  if (!opts.skipVectors) {
    console.log(`  向量维度: ${DIM}`);
    console.log(`  向量引擎: LanceDB (IVF_PQ)`);
  }
  console.log(`  LanceDB 路径: src/data/lancedb/`);
  console.log(`  增量状态: src/data/index_state.json`);
  console.log('========================================');
}

main().catch(err => {
  console.error('构建失败:', err);
  process.exit(1);
});
