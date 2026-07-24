#!/usr/bin/env node
// ============================================================
// Chunk 摘要流水线（Stage 1.5）
// 用法:
//   全量摘要:  node scripts/pipeline/summarize-chunks.cjs
//   试运行:    node scripts/pipeline/summarize-chunks.cjs --dry-run
//   指定并发:  node scripts/pipeline/summarize-chunks.cjs --concurrency 3
//
// 流程: chunks.jsonl → LLM 摘要(DashScope) → 写回 chunks.jsonl
// 每个 chunk 追加 summary/keywords/entities 字段
//
// 前置条件: 已运行 clean-and-chunk.cjs（需要 chunks.jsonl）
// 后续步骤: 运行 build-from-staging.cjs 重建索引
// ============================================================

const fs = require('fs');
const path = require('path');

// 加载环境变量
const { loadEnv } = require('../lib/envLoader.cjs');
loadEnv();

// 公共模块
const { readStaging, writeStaging, readManifest, stagingExists } = require('../lib/staging.cjs');
const { summarizeChunksBatch, isSummarizerAvailable } = require('../lib/summarizer.cjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { concurrency: 5, dryRun: false, verbose: false, force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--concurrency' && args[i + 1]) {
      opts.concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      opts.verbose = true;
    } else if (args[i] === '--force') {
      opts.force = true;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  Chunk 摘要流水线 (Stage 1.5)');
  console.log('========================================\n');
  console.log(`  模式: ${opts.dryRun ? 'dry-run' : 'normal'}`);
  console.log(`  并发: ${opts.concurrency}`);
  console.log(`  强制重跑: ${opts.force}\n`);

  // 检查 LLM 可用性
  if (!isSummarizerAvailable()) {
    console.error('  ❌ LLM API Key 未配置，请在 .env 中设置 DASHSCOPE_API_KEY');
    process.exit(1);
  }

  // 检查 staging
  if (!stagingExists()) {
    console.error('  ❌ chunks.jsonl 不存在，请先运行: node scripts/pipeline/clean-and-chunk.cjs');
    process.exit(1);
  }

  const manifest = readManifest();
  console.log(`  Staging: ${manifest.totalChunks} chunks, 构建于 ${manifest.builtAt}\n`);

  // [1/3] 读取 chunks
  console.log('[1/3] 读取 chunks.jsonl...');
  const allChunks = readStaging();
  console.log(`  ✅ 读取 ${allChunks.length} 个 chunk`);

  // 过滤：只处理 Raw 文档的 chunk（Wiki 词条已有独立定义）
  const rawChunks = allChunks.filter(c => c.docId && c.docId.startsWith('raw_'));
  console.log(`  Raw 文档 chunk: ${rawChunks.length}`);

  // 增量检测：跳过已有 summary 的 chunk（除非 --force）
  let chunksToProcess = rawChunks;
  if (!opts.force) {
    const alreadySummarized = rawChunks.filter(c => c.summary && c.summary.length > 0);
    chunksToProcess = rawChunks.filter(c => !c.summary || c.summary.length === 0);
    console.log(`  已有摘要: ${alreadySummarized.length}`);
    console.log(`  待摘要: ${chunksToProcess.length}`);
  }

  if (chunksToProcess.length === 0) {
    console.log('\n  ✅ 所有 chunk 已有摘要，跳过');
    return;
  }

  // [2/3] LLM 摘要
  console.log(`\n[2/3] LLM 摘要（DashScope qwen-plus）...`);
  const startTime = Date.now();

  const { results, errors } = await summarizeChunksBatch(
    chunksToProcess.map(c => ({ id: c.id, content: c.content })),
    {
      concurrency: opts.concurrency,
      onProgress: (done, total) => {
        process.stdout.write(`\r  摘要进度: ${done}/${total}`);
      },
    }
  );
  console.log('');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ✅ 摘要完成: ${results.size} 个 chunk, 耗时 ${elapsed}s`);
  if (errors > 0) {
    console.log(`  ⚠️ 错误: ${errors} 个 chunk 摘要失败`);
  }

  // 统计
  let withSummary = 0, withKeywords = 0, withEntities = 0;
  for (const [id, result] of results) {
    if (result.summary) withSummary++;
    if (result.keywords.length > 0) withKeywords++;
    if (result.entities.length > 0) withEntities++;
  }
  console.log(`  有摘要: ${withSummary}, 有关键词: ${withKeywords}, 有实体: ${withEntities}`);

  if (opts.verbose) {
    console.log('\n  摘要样例:');
    let count = 0;
    for (const [id, result] of results) {
      if (count++ >= 3) break;
      console.log(`    [${id}]`);
      console.log(`      摘要: ${result.summary.slice(0, 80)}...`);
      console.log(`      关键词: ${result.keywords.join(', ')}`);
      console.log(`      实体: ${result.entities.map(e => `${e.name}(${e.type})`).join(', ')}`);
    }
  }

  // [3/3] 写回 chunks.jsonl
  console.log('\n[3/3] 写回 chunks.jsonl...');

  if (opts.dryRun) {
    console.log('  (dry-run 模式，不写入文件)');
  } else {
    // 合并摘要结果到 chunks
    let updatedCount = 0;
    for (const chunk of allChunks) {
      const result = results.get(chunk.id);
      if (result) {
        chunk.summary = result.summary;
        chunk.keywords = result.keywords;
        chunk.entities = result.entities;
        updatedCount++;
      }
    }

    // 写回
    writeStaging(allChunks);
    console.log(`  ✅ 更新 ${updatedCount} 个 chunk 的摘要`);

    // 更新 manifest
    manifest.summaryApplied = true;
    manifest.summaryModel = 'qwen-plus';
    manifest.summaryVersion = '1.0.0';
    manifest.summaryAppliedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(__dirname, '..', '..', 'src', 'data', 'chunks_staging', 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
    console.log('  ✅ manifest.json 已更新');
  }

  console.log('\n========================================');
  console.log('  ✅ Chunk 摘要完成!');
  console.log('========================================');
  console.log(`  处理 chunk: ${chunksToProcess.length}`);
  console.log(`  成功摘要: ${results.size - errors}`);
  console.log(`  错误: ${errors}`);
  console.log('========================================');
  console.log('\n  下一步: 运行 node scripts/pipeline/build-from-staging.cjs 重建索引');
}

main().catch(err => {
  console.error('摘要失败:', err);
  process.exit(1);
});
