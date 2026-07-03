#!/usr/bin/env node
// ============================================================
// chunk 调试预览工具
// 用法:
//   查看某文档的 chunk:  node scripts/pipeline/inspect-chunks.cjs --doc raw_中信证券_数据中台_来往账目_20250407
//   查看所有文档列表:    node scripts/pipeline/inspect-chunks.cjs --list
//   查看质量报告:        node scripts/pipeline/inspect-chunks.cjs --report
//   查看全局统计:        node scripts/pipeline/inspect-chunks.cjs --stats
// ============================================================

const { readStaging, readQualityReport, readManifest, getChunksByDocId } = require('../lib/staging.cjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { doc: null, list: false, report: false, stats: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--doc' && args[i + 1]) {
      opts.doc = args[i + 1];
      i++;
    } else if (args[i] === '--list') {
      opts.list = true;
    } else if (args[i] === '--report') {
      opts.report = true;
    } else if (args[i] === '--stats') {
      opts.stats = true;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      opts.verbose = true;
    }
  }
  return opts;
}

function showList() {
  console.log('文档列表:\n');
  const seen = new Map();
  readStaging(chunk => {
    const docId = chunk.parentDocId
      ? chunk.parentDocId.replace(/^parent_/, '')
      : chunk.docId;
    if (!seen.has(docId)) {
      seen.set(docId, { path: chunk.docPath, count: 0 });
    }
    seen.get(docId).count++;
  });
  for (const [docId, info] of seen) {
    console.log(`  ${docId}  (${info.count} chunks)  →  ${info.path}`);
  }
  console.log(`\n共 ${seen.size} 个文档`);
}

function showDoc(docId) {
  const chunks = getChunksByDocId(docId);
  if (chunks.length === 0) {
    console.log(`未找到文档: ${docId}`);
    console.log('使用 --list 查看所有可用文档');
    return;
  }

  chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

  console.log(`\n文档: ${docId}`);
  console.log(`路径: ${chunks[0].docPath}`);
  console.log(`标题: ${chunks[0].docTitle}`);
  console.log(`chunk 数: ${chunks.length}\n`);

  for (const chunk of chunks) {
    console.log(`--- chunk ${chunk.chunkIndex} | 长度: ${chunk.content.length} | wikiLinks: ${(chunk.wikiLinks || []).length} ---`);

    if (chunk.sectionTitle) {
      console.log(`  [section: ${chunk.sectionTitle}]`);
    }

    if (chunk.warnings && chunk.warnings.length > 0) {
      console.log(`  ⚠️  ${chunk.warnings.join(', ')}`);
    }

    // 检测表格完整性
    const lines = chunk.content.split('\n');
    const tableLines = lines.filter(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
    if (tableLines.length > 0) {
      const lastLine = lines[lines.length - 1];
      const isComplete = lastLine.includes('合计') || lastLine.includes('小计') || lastLine.includes('总计') || !lastLine.trim().startsWith('|');
      console.log(`  [表格: ${tableLines.length} 行${isComplete ? ' ✅ 完整' : ' ⚠️ 可能不完整'}]`);
    }

    // 显示内容预览
    if (chunk.content.length > 300) {
      console.log(`  ${chunk.content.slice(0, 150).replace(/\n/g, '\\n ')}`);
      console.log(`  ... (${chunk.content.length - 300} chars omitted) ...`);
      console.log(`  ${chunk.content.slice(-150).replace(/\n/g, '\\n ')}`);
    } else {
      console.log(`  ${chunk.content.replace(/\n/g, '\n  ')}`);
    }
    console.log('');
  }
}

function showReport() {
  const report = readQualityReport();
  if (!report) {
    console.log('未找到质量报告，请先运行 clean-and-chunk.cjs');
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

function showStats() {
  const manifest = readManifest();
  if (!manifest) {
    console.log('未找到 manifest，请先运行 clean-and-chunk.cjs');
    return;
  }

  console.log('========================================');
  console.log('  Staging 统计');
  console.log('========================================\n');
  console.log(`  Pipeline 版本: ${manifest.pipelineVersion}`);
  console.log(`  构建时间: ${manifest.builtAt}`);
  console.log(`  Git Commit: ${manifest.gitCommit}`);
  console.log(`  总 chunk 数: ${manifest.totalChunks}`);
  console.log(`  总文档数: ${manifest.totalDocs}`);
  console.log(`  源文件数: ${manifest.sourceFiles.length}`);
  console.log(`  chunk 配置: ${JSON.stringify(manifest.chunkConfig)}`);

  // 统计表格切断情况：检查相邻 chunk 是否有表格被拆开
  const allChunks = readStaging();
  const byDoc = {};
  for (const c of allChunks) {
    const docId = c.parentDocId ? c.parentDocId.replace(/^parent_/, '') : c.docId;
    if (!byDoc[docId]) byDoc[docId] = [];
    byDoc[docId].push(c);
  }

  let tableChunks = 0;
  let cutTableChunks = 0;
  let totalChunks = allChunks.length;

  for (const c of allChunks) {
    const lines = c.content.split('\n');
    const tableLines = lines.filter(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
    if (tableLines.length > 0) tableChunks++;
  }

  // 真正的切断：当前 chunk 末行是表格行，且下一个 chunk 首行也是表格行
  for (const docChunks of Object.values(byDoc)) {
    docChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    for (let i = 0; i < docChunks.length - 1; i++) {
      const curLast = docChunks[i].content.split('\n').pop().trim();
      const nextFirst = docChunks[i + 1].content.split('\n')[0].trim();
      if (curLast.startsWith('|') && curLast.endsWith('|') &&
          nextFirst.startsWith('|') && nextFirst.endsWith('|')) {
        cutTableChunks++;
      }
    }
  }

  console.log(`\n  表格感知统计:`);
  console.log(`    含表格 chunk: ${tableChunks} (${totalChunks > 0 ? (tableChunks / totalChunks * 100).toFixed(1) : 0}%)`);
  console.log(`    表格被切断: ${cutTableChunks} (${totalChunks > 0 ? (cutTableChunks / totalChunks * 100).toFixed(1) : 0}%)`);
  console.log('\n========================================');
}

// ============================================================

const opts = parseArgs();

if (opts.stats) {
  showStats();
} else if (opts.report) {
  showReport();
} else if (opts.list) {
  showList();
} else if (opts.doc) {
  showDoc(opts.doc);
} else {
  console.log('用法:');
  console.log('  node scripts/pipeline/inspect-chunks.cjs --list              查看所有文档');
  console.log('  node scripts/pipeline/inspect-chunks.cjs --doc <docId>       查看某文档的 chunk');
  console.log('  node scripts/pipeline/inspect-chunks.cjs --stats             查看全局统计');
  console.log('  node scripts/pipeline/inspect-chunks.cjs --report            查看质量报告');
}
