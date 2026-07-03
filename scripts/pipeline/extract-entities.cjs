#!/usr/bin/env node
// ============================================================
// LLM 实体/概念提取流水线
// 用法:
//   全量提取:   node scripts/pipeline/extract-entities.cjs
//   增量提取:   node scripts/pipeline/extract-entities.cjs --mode incremental
//   指定并发:   node scripts/pipeline/extract-entities.cjs --concurrency 5
//   试运行:     node scripts/pipeline/extract-entities.cjs --dry-run
// ============================================================

const { loadEnv } = require('../lib/envLoader.cjs');
loadEnv();

const fs = require('fs');
const path = require('path');

const { readStaging, readManifest, stagingExists } = require('../lib/staging.cjs');
const { extractEntitiesBatch } = require('../lib/entityExtractor.cjs');
const { writeAllWikiEntries, getExistingWikiNames } = require('../lib/wikiWriter.cjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: 'full', concurrency: 3, dryRun: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) { opts.mode = args[i + 1]; i++; }
    else if (args[i] === '--concurrency' && args[i + 1]) { opts.concurrency = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--dry-run') { opts.dryRun = true; }
    else if (args[i] === '--verbose' || args[i] === '-v') { opts.verbose = true; }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  LLM 实体/概念提取流水线');
  console.log('========================================\n');
  console.log(`  模式: ${opts.mode}${opts.dryRun ? ' (dry-run)' : ''}`);
  console.log(`  并发: ${opts.concurrency}\n`);

  if (!stagingExists()) {
    console.error('  ❌ chunks.jsonl 不存在，请先运行: node scripts/pipeline/clean-and-chunk.cjs');
    process.exit(1);
  }

  const manifest = readManifest();
  console.log(`  Staging: ${manifest.totalChunks} chunks, 构建于 ${manifest.builtAt}\n`);

  // [1/4] 读取 chunks
  console.log('[1/4] 读取 chunks.jsonl...');
  const allChunks = readStaging();

  // 增量模式
  let chunksToProcess = allChunks;
  if (opts.mode === 'incremental') {
    const stateFile = path.join(__dirname, '..', '..', 'src', 'data', 'entity_extract_state.json');
    let oldState = {};
    if (fs.existsSync(stateFile)) {
      oldState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
    const processedDocs = oldState.processedDocs || {};
    const currentBatch = manifest.builtAt;
    chunksToProcess = allChunks.filter(chunk => {
      const docId = chunk.parentDocId ? chunk.parentDocId.replace(/^parent_/, '') : chunk.docId;
      return processedDocs[docId] !== currentBatch;
    });
    console.log(`  增量: ${chunksToProcess.length}/${allChunks.length} chunks 待处理`);
    if (chunksToProcess.length === 0) {
      console.log('\n  ✅ 无变更，跳过');
      return;
    }
  }

  // 只处理 Raw 文档的 chunk
  chunksToProcess = chunksToProcess.filter(c => c.docId && c.docId.startsWith('raw_'));
  console.log(`  Raw 文档 chunk: ${chunksToProcess.length}`);

  // [2/4] 加载已有词条
  console.log('\n[2/4] 加载已有 Wiki 词条...');
  const existing = getExistingWikiNames();
  console.log(`  已有概念: ${existing.concepts.size}`);
  console.log(`  已有实体: ${existing.entities.size}`);

  // [3/4] LLM 提取
  console.log('\n[3/4] LLM 实体/概念提取...');
  const { entityMap, conceptMap, errors } = await extractEntitiesBatch(chunksToProcess, {
    concurrency: opts.concurrency,
    onProgress: (done, total) => {
      process.stdout.write(`\r  提取进度: ${done}/${total}`);
    },
  });
  console.log('');

  let newEntities = 0, newConcepts = 0;
  for (const name of entityMap.keys()) {
    if (!existing.entities.has(name)) newEntities++;
  }
  for (const name of conceptMap.keys()) {
    if (!existing.concepts.has(name)) newConcepts++;
  }

  console.log(`  ✅ 提取实体: ${entityMap.size} 个 (新增 ${newEntities}, 更新 ${entityMap.size - newEntities})`);
  console.log(`  ✅ 提取概念: ${conceptMap.size} 个 (新增 ${newConcepts}, 更新 ${conceptMap.size - newConcepts})`);

  if (errors.length > 0) {
    console.log(`  ⚠️ 错误: ${errors.length} 个 chunk 提取失败`);
    if (opts.verbose) {
      for (const e of errors.slice(0, 5)) {
        console.log(`    ${e.chunkId}: ${e.error}`);
      }
    }
  }

  if (opts.verbose) {
    console.log('\n  实体样例:');
    let count = 0;
    for (const [name, info] of entityMap) {
      if (count++ >= 5) break;
      console.log(`    ${name}: ${info.definition} (${info.sources.length} chunks)`);
    }
    console.log('\n  概念样例:');
    count = 0;
    for (const [name, info] of conceptMap) {
      if (count++ >= 5) break;
      console.log(`    ${name}: ${info.definition} (${info.sources.length} chunks)`);
    }
  }

  // [4/4] 写入 Wiki 目录
  console.log('\n[4/4] 写入 Wiki 目录...');
  if (opts.dryRun) {
    console.log('  (dry-run 模式，不写入文件)');
  } else {
    const result = writeAllWikiEntries(entityMap, conceptMap, {
      onProgress: (done, total) => {
        process.stdout.write(`\r  写入进度: ${done}/${total}`);
      },
    });
    console.log('');
    console.log(`  ✅ 新建: ${result.created} 个词条`);
    console.log(`  ✅ 更新: ${result.updated} 个词条`);
  }

  // 保存增量状态
  if (opts.mode === 'incremental' && !opts.dryRun) {
    const stateFile = path.join(__dirname, '..', '..', 'src', 'data', 'entity_extract_state.json');
    const processedDocs = {};
    for (const chunk of allChunks) {
      const docId = chunk.parentDocId ? chunk.parentDocId.replace(/^parent_/, '') : chunk.docId;
      processedDocs[docId] = manifest.builtAt;
    }
    fs.writeFileSync(stateFile, JSON.stringify({
      processedDocs,
      builtAt: new Date().toISOString(),
    }, null, 2));
    console.log('  ✅ 增量状态已保存');
  }

  console.log('\n========================================');
  console.log('  ✅ 实体/概念提取完成!');
  console.log('========================================');
  console.log(`  实体: ${entityMap.size} 个 (新增 ${newEntities})`);
  console.log(`  概念: ${conceptMap.size} 个 (新增 ${newConcepts})`);
  if (errors.length > 0) console.log(`  错误: ${errors.length} 个`);
  console.log('========================================');
  console.log('\n  下一步: 运行 node scripts/pipeline/build-from-staging.cjs 重建索引');
}

main().catch(err => {
  console.error('提取失败:', err);
  process.exit(1);
});
