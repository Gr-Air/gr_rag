#!/usr/bin/env node

// ============================================================
// Wiki 反向链接标注流水线
//
// 读取 Wiki/entity 和 Wiki/concept 中的词条名，
// 在 Raw/*.md 文档中将纯文本词条替换为 [[词条]] wiki 链接，
// 最后输出质量检查报告。
//
// 用法:
//   node scripts/pipeline/link-entities.cjs              # 完整运行
//   node scripts/pipeline/link-entities.cjs --dry-run    # 预览不修改
//   node scripts/pipeline/link-entities.cjs --check-only # 仅质量检查
//   node scripts/pipeline/link-entities.cjs --verbose    # 详细输出
// ============================================================

const fs = require('fs');
const path = require('path');
const linker = require('../lib/linker.cjs');

// ============================================================
// 命令行参数解析
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    checkOnly: args.includes('--check-only'),
    verbose: args.includes('--verbose'),
  };
}

// ============================================================
// Step 1: 加载词条
// ============================================================

function step1_loadEntries() {
  console.log('[1/3] 加载 Wiki 词条...');

  const entries = linker.loadWikiEntries();

  const entityCount = entries.filter(e => e.type === 'entity').length;
  const conceptCount = entries.filter(e => e.type === 'concept').length;

  console.log(`  ✅ 实体词条: ${entityCount} 个`);
  console.log(`  ✅ 概念词条: ${conceptCount} 个`);
  console.log(`  ✅ 总计: ${entries.length} 个\n`);

  return entries;
}

// ============================================================
// Step 2: 反向标注 Raw 文档
// ============================================================

function step2_linkDocuments(entries, opts) {
  console.log('[2/3] 反向标注 Raw 文档...');

  const rawDir = linker.RAW_DIR;
  if (!fs.existsSync(rawDir)) {
    console.log('  ⚠️  Raw 目录不存在，跳过\n');
    return { changed: 0, unchanged: 0, errors: 0, totalLinks: 0 };
  }

  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.md'));

  if (files.length === 0) {
    console.log('  ⚠️  没有 .md 文件，跳过\n');
    return { changed: 0, unchanged: 0, errors: 0, totalLinks: 0 };
  }

  let changed = 0;
  let unchanged = 0;
  let errors = 0;
  let totalLinks = 0;

  for (const file of files) {
    const filePath = path.join(rawDir, file);

    try {
      const result = linker.linkFile(filePath, entries, { dryRun: opts.dryRun });

      if (result.changed) {
        changed++;
        totalLinks += result.linkedCount;

        if (opts.verbose) {
          const preview = result.linkedNames.slice(0, 10).join(', ');
          const suffix = result.linkedNames.length > 10
            ? ` ... 共 ${result.linkedNames.length} 个`
            : '';
          console.log(`  ${opts.dryRun ? '📝 [预览]' : '✏️ '} ${file}: +${result.linkedCount} 链接 (${preview}${suffix})`);
        } else {
          console.log(`  ${opts.dryRun ? '📝 [预览]' : '✏️ '} ${file}: +${result.linkedCount} 链接`);
        }
      } else {
        unchanged++;
      }
    } catch (err) {
      console.error(`  ❌ ${file}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n  📊 标注统计:`);
  console.log(`     修改文件: ${changed}/${files.length}`);
  console.log(`     无变化文件: ${unchanged}/${files.length}`);
  console.log(`     错误文件: ${errors}/${files.length}`);
  console.log(`     总链接数: ${totalLinks}`);
  if (opts.dryRun) {
    console.log(`     ⚠️  预览模式，文件未实际修改`);
  }
  console.log('');

  return { changed, unchanged, errors, totalLinks };
}

// ============================================================
// Step 3: 质量检查
// ============================================================

function step3_qualityCheck(entries, opts) {
  console.log('[3/3] 质量检查...');

  const rawDir = linker.RAW_DIR;
  if (!fs.existsSync(rawDir)) {
    console.log('  ⚠️  Raw 目录不存在，跳过\n');
    return { filesWithMissing: 0, totalMissing: 0, details: [] };
  }

  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.md'));

  /** @type {Array<{file: string, missingCount: number, missingNames: string[]}>} */
  const details = [];
  let filesWithMissing = 0;
  let totalMissing = 0;

  for (const file of files) {
    const filePath = path.join(rawDir, file);
    const result = linker.checkMissing(filePath, entries);

    if (result.missingCount > 0) {
      filesWithMissing++;
      totalMissing += result.missingCount;
      details.push({
        file,
        missingCount: result.missingCount,
        missingNames: result.missingNames,
      });

      if (opts.verbose) {
        console.log(`  ⚠️  ${file}: ${result.missingCount} 个遗漏`);
        for (const name of result.missingNames.slice(0, 10)) {
          console.log(`      - ${name}`);
        }
        if (result.missingNames.length > 10) {
          console.log(`      ... 共 ${result.missingNames.length} 个`);
        }
      }
    }
  }

  // 写入质量报告
  const reportPath = path.join(linker.ROOT, 'link_report.json');
  const report = {
    timestamp: new Date().toISOString(),
    mode: opts.dryRun ? 'dry-run' : opts.checkOnly ? 'check-only' : 'full',
    summary: {
      totalFiles: files.length,
      filesWithMissing,
      totalMissing,
    },
    details: details.slice(0, 50),
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n  📊 质量报告:`);
  console.log(`     遗漏文件: ${filesWithMissing}/${files.length}`);
  console.log(`     遗漏词条: ${totalMissing} 个`);
  console.log(`     报告路径: ${reportPath}\n`);

  return { filesWithMissing, totalMissing, details };
}

// ============================================================
// 主流程
// ============================================================

function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  星辰Wiki 反向链接标注');
  if (opts.dryRun) console.log('  [预览模式 - 不修改文件]');
  if (opts.checkOnly) console.log('  [仅检查模式 - 只做质量检查]');
  console.log('========================================\n');

  // Step 1: 加载词条
  const entries = step1_loadEntries();

  if (entries.length === 0) {
    console.log('❌ 没有找到任何 Wiki 词条，请先运行 extract-entities 或确保 Wiki/ 目录存在');
    process.exit(1);
  }

  // Step 2: 反向标注（check-only 模式跳过）
  let linkResult = null;
  if (!opts.checkOnly) {
    linkResult = step2_linkDocuments(entries, opts);
  }

  // Step 3: 质量检查
  const checkResult = step3_qualityCheck(entries, opts);

  // 最终总结
  console.log('========================================');
  console.log('  ✅ 反向链接标注完成!');
  if (linkResult) {
    console.log(`  📝 标注: ${linkResult.changed} 个文件修改`);
    console.log(`  🔗 新增链接: ${linkResult.totalLinks} 个`);
  }
  console.log(`  🔍 遗漏: ${checkResult.filesWithMissing} 个文件 / ${checkResult.totalMissing} 个词条`);
  console.log('========================================');
}

// 支持独立运行
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ 标注失败:', err);
    process.exit(1);
  }
}

module.exports = { main };
