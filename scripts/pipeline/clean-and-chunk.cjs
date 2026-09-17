#!/usr/bin/env node
// ============================================================
// 文档清洗切分流水线（Stage 1）
// 用法:
//   全量构建:  node scripts/pipeline/clean-and-chunk.cjs
//   增量更新:  node scripts/pipeline/clean-and-chunk.cjs --mode incremental
//   预览不写入: node scripts/pipeline/clean-and-chunk.cjs --dry-run
//   启用概念增强: node scripts/pipeline/clean-and-chunk.cjs --augment-concepts
//   指定概念并发: node scripts/pipeline/clean-and-chunk.cjs --augment-concepts --concept-concurrency 5
//
// 流程: scanner → cleaner → chunker(表格感知) → 概念增强 → 质量校验 → staging(JSONL)
// 概念增强阶段消耗 LLM API，可通过 --no-augment-concepts 跳过
// ============================================================

const fs = require('fs');
const path = require('path');

// 公共模块
const { loadEnv } = require('../lib/envLoader.cjs');
loadEnv();

const { scanAll, WIKI_DIR } = require('../lib/scanner.cjs');
const { cleanDocument } = require('../lib/cleaner.cjs');
const {
  chunkDocument,
  extractTitle,
  parseFilename,
} = require('../lib/chunker.cjs');
const { buildStateSnapshot } = require('../lib/hasher.cjs');
const {
  writeStaging,
  writeManifest,
  writeQualityReport,
  STAGING_DIR,
} = require('../lib/staging.cjs');

const DATA_DIR = path.join(__dirname, '..', '..', 'src', 'data');
const RAW_DIR = path.join(__dirname, '..', '..', '..', 'Raw');
const WIKI_CONCEPT_DIR = path.join(WIKI_DIR, 'concept');

// ============================================================
// 概念知识增强模块
// ============================================================

async function callLLM(prompt, opts = {}) {
  const fetch = require('node-fetch').default;
  const useDashScope = process.env.DASHSCOPE_API_KEY && !process.env.DASHSCOPE_API_KEY.startsWith('sk-你的');
  const apiKey = opts.apiKey || (useDashScope ? process.env.DASHSCOPE_API_KEY : process.env.OPENAI_API_KEY) || '';
  const baseURL = opts.baseURL || (useDashScope ? process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1' : process.env.OPENAI_BASE_URL);
  const model = opts.model || (useDashScope ? 'qwen-plus' : process.env.LLM_MODEL) || 'qwen-plus';

  if (!apiKey) throw new Error('LLM API Key 未配置');

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: '你是一个技术文档写作专家，擅长撰写清晰、准确、专业的技术概念定义文档。输出格式为标准 Markdown。',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 3000,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

function searchRawDocsForConcept(conceptName) {
  const results = [];
  if (!fs.existsSync(RAW_DIR)) return results;

  for (const f of fs.readdirSync(RAW_DIR)) {
    if (!f.endsWith('.md')) continue;
    const filePath = path.join(RAW_DIR, f);
    const content = fs.readFileSync(filePath, 'utf-8');

    if (content.includes(`[[${conceptName}]]`) ||
        content.includes(conceptName) && content.length > 100) {
      const firstLine = content.split('\n')[0]?.trim() || '';
      const title = firstLine.startsWith('# ') ? firstLine.replace(/^#\s+/, '').trim() : f;
      const snippet = content.slice(0, 500).replace(/\n/g, ' ').trim();
      results.push({
        title,
        file: f,
        snippet,
      });
    }
  }

  return results.slice(0, 3);
}

async function generateConceptDoc(conceptName, shortDefinition, rawContexts) {
  const contextStr = rawContexts.length > 0
    ? `\n\n相关项目文档片段：\n${rawContexts.map((c, i) => `${i+1}. ${c.title}: ${c.snippet}`).join('\n')}`
    : '';

  const prompt = `请为以下技术概念撰写一份详细的定义文档，用于企业知识库。

概念名称：${conceptName}
简短定义：${shortDefinition || '暂无'}${contextStr}

文档结构要求：
1. ## 定义：一句话清晰定义该概念
2. ## 核心特征：列出 3-5 个核心特点
3. ## 应用场景：列举常见应用场景
4. ## 相关技术：列出相关技术或工具
5. ## 行业标准：如有相关标准或规范，请列出

写作要求：
- 语言专业但不晦涩，适合技术人员阅读
- 内容准确，基于行业通用认知
- 如果有相关项目文档片段，请结合项目实际使用场景描述
- 输出格式为标准 Markdown
- 不要输出任何前置说明，直接输出 Markdown 内容`;

  const raw = await callLLM(prompt);
  return raw.trim();
}

function writeConceptDoc(name, shortDefinition, frequency, fullContent) {
  if (!fs.existsSync(WIKI_CONCEPT_DIR)) {
    fs.mkdirSync(WIKI_CONCEPT_DIR, { recursive: true });
  }
  const filePath = path.join(WIKI_CONCEPT_DIR, `${name}.md`);

  let content = `# ${name}\n\n> 概念 | 出现频次: ${frequency}\n`;
  if (shortDefinition && shortDefinition.length > 0) {
    content += `> 定义: ${shortDefinition}\n`;
  }
  content += `> 来源: LLM生成\n\n`;
  content += fullContent;

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function checkConceptNeedsAugment(content) {
  const hasFullContent = content.includes('## 定义') || content.includes('## 核心') ||
                        content.includes('## 应用') || content.length > 500;
  return !hasFullContent;
}

async function augmentConceptsIfNeeded(wikiEntries, opts) {
  if (!opts.augmentConcepts) {
    console.log('  概念增强已跳过 (--no-augment-concepts)');
    return wikiEntries;
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey || apiKey.startsWith('sk-你的')) {
    console.log('  概念增强已跳过 (未配置 DASHSCOPE_API_KEY)');
    return wikiEntries;
  }

  const concepts = wikiEntries.filter(e => e.type === 'concept');
  const needsAugment = concepts.filter(c => checkConceptNeedsAugment(c.content));

  if (needsAugment.length === 0) {
    console.log('  所有概念均已增强，无需处理');
    return wikiEntries;
  }

  const MIN_FREQUENCY = opts.minFrequency || 2;
  const needsAugmentFiltered = needsAugment.filter(c => {
    const freqMatch = c.content.match(/出现频次:\s*(\d+)/);
    const freq = freqMatch ? parseInt(freqMatch[1]) : 0;
    return freq >= MIN_FREQUENCY;
  });

  console.log(`\n  需要增强: ${needsAugment.length} 个概念`);
  if (needsAugmentFiltered.length !== needsAugment.length) {
    console.log(`  过滤低频概念 (< ${MIN_FREQUENCY} 次): ${needsAugment.length - needsAugmentFiltered.length} 个`);
    console.log(`  实际处理: ${needsAugmentFiltered.length} 个概念`);
  }

  if (needsAugmentFiltered.length === 0) {
    console.log('  没有符合频次要求的概念需要增强');
    return wikiEntries;
  }

  if (opts.verbose) {
    console.log('  待增强概念列表:');
    for (const c of needsAugmentFiltered) {
      const freqMatch = c.content.match(/出现频次:\s*(\d+)/);
      const freq = freqMatch ? parseInt(freqMatch[1]) : 0;
      console.log(`    ${c.name} (频次: ${freq})`);
    }
  }

  console.log('\n  搜索项目文档上下文...');
  const conceptContexts = new Map();
  for (const c of needsAugmentFiltered) {
    const contexts = searchRawDocsForConcept(c.name);
    conceptContexts.set(c.name, contexts);
    if (contexts.length > 0 && opts.verbose) {
      console.log(`    ${c.name}: 找到 ${contexts.length} 篇相关文档`);
    }
  }

  console.log('\n  LLM 生成详细概念文档...');

  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  const results = [];
  const concurrency = opts.conceptConcurrency || 3;

  for (let i = 0; i < needsAugmentFiltered.length; i += concurrency) {
    const batch = needsAugmentFiltered.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (c) => {
        const defMatch = c.content.match(/> 定义:\s*(.+)/);
        const shortDefinition = defMatch ? defMatch[1].trim() : '';
        const freqMatch = c.content.match(/出现频次:\s*(\d+)/);
        const frequency = freqMatch ? parseInt(freqMatch[1]) : 0;
        const contexts = conceptContexts.get(c.name) || [];
        const doc = await generateConceptDoc(c.name, shortDefinition, contexts);
        return { concept: c, shortDefinition, frequency, doc };
      })
    );

    for (const r of batchResults) {
      completed++;
      if (r.status === 'fulfilled') {
        results.push(r.value);
        succeeded++;
      } else {
        failed++;
        console.log(`    ❌ ${batch[batchResults.indexOf(r)]?.name}: ${r.reason?.message || 'unknown'}`);
      }
      process.stdout.write(`\r  生成进度: ${completed}/${needsAugmentFiltered.length} (成功: ${succeeded}, 失败: ${failed})`);
    }
  }
  console.log('');

  console.log('\n  写入 Wiki 概念目录...');

  if (opts.dryRun) {
    console.log('  (dry-run 模式，不写入文件)');
    for (const r of results) {
      console.log(`    ${r.concept.name}: ${r.doc.length} 字符`);
    }
  } else {
    for (const r of results) {
      writeConceptDoc(r.concept.name, r.shortDefinition, r.frequency, r.doc);
    }
    console.log(`  ✅ 增强完成: ${succeeded} 个概念`);
  }

  if (!opts.dryRun && succeeded > 0) {
    console.log('\n  重新扫描增强后的概念词条...');
    return scanAll().wikiEntries;
  }

  return wikiEntries;
}

// ============================================================
// 质量门禁
// ============================================================

/**
 * 硬拒绝检查
 */
function hardRejectCheck(chunk) {
  if (chunk.content.length < 50) {
    return { reject: true, reason: 'too short (<50 chars)' };
  }
  return { reject: false };
}

/**
 * 软告警检查
 */
function softWarnCheck(chunk) {
  const warnings = [];

  if (chunk.content.length < 100) {
    warnings.push(`short chunk (${chunk.content.length} chars)`);
  }

  const linkChars = (chunk.wikiLinks || []).reduce((sum, l) => sum + l.length + 4, 0);
  const density = chunk.content.length > 0 ? linkChars / chunk.content.length : 0;
  if (density > 0.3) {
    warnings.push(`high wikiLink density (${(density * 100).toFixed(1)}%)`);
  }

  return warnings;
}

/**
 * 构建质量报告
 */
function buildQualityReport(chunks, allDocStats) {
  const sizes = chunks.map(c => c.content.length).sort((a, b) => a - b);
  const pct = (p) => sizes.length > 0 ? sizes[Math.floor(sizes.length * p)] : 0;

  let hardRejected = 0;
  let softWarned = 0;
  for (const stat of allDocStats) {
    hardRejected += stat.hardRejected || 0;
    softWarned += stat.softWarned || 0;
  }

  const docChunkCounts = {};
  for (const c of chunks) {
    const docId = c.parentDocId ? c.parentDocId.replace(/^parent_/, '') : c.docId;
    docChunkCounts[docId] = (docChunkCounts[docId] || 0) + 1;
  }
  const perDocCounts = Object.values(docChunkCounts).sort((a, b) => a - b);

  return {
    pipelineVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    summary: {
      totalDocs: allDocStats.length,
      totalChunks: chunks.length,
      hardRejected,
      softWarned,
      passRate: (chunks.length + hardRejected) > 0
        ? `${((chunks.length / (chunks.length + hardRejected)) * 100).toFixed(1)}%`
        : '100%',
    },
    perDoc: allDocStats,
    distribution: {
      chunkSizes: sizes.length > 0 ? {
        min: sizes[0],
        max: sizes[sizes.length - 1],
        avg: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
        p50: pct(0.5),
        p95: pct(0.95),
      } : { min: 0, max: 0, avg: 0, p50: 0, p95: 0 },
      chunksPerDoc: perDocCounts.length > 0 ? {
        min: perDocCounts[0],
        max: perDocCounts[perDocCounts.length - 1],
        avg: (perDocCounts.reduce((a, b) => a + b, 0) / perDocCounts.length).toFixed(1),
      } : { min: 0, max: 0, avg: 0 },
    },
  };
}

// ============================================================
// CLI 参数解析
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { 
    mode: 'full', 
    dryRun: false, 
    verbose: false,
    augmentConcepts: !args.includes('--no-augment-concepts'),
    conceptConcurrency: 3,
    minFrequency: 2,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      opts.mode = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      opts.verbose = true;
    } else if (args[i] === '--augment-concepts') {
      opts.augmentConcepts = true;
    } else if (args[i] === '--no-augment-concepts') {
      opts.augmentConcepts = false;
    } else if (args[i] === '--concept-concurrency' && args[i + 1]) {
      opts.conceptConcurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--min-frequency' && args[i + 1]) {
      opts.minFrequency = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return opts;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  文档清洗切分流水线 (Stage 1)');
  console.log('========================================\n');
  console.log(`  模式: ${opts.mode}${opts.dryRun ? ' (dry-run)' : ''}`);
  console.log(`  概念入库: 直接入库（不生成详细文档）`);
  if (opts.augmentConcepts) {
    console.log(`  概念并发: ${opts.conceptConcurrency}`);
  }
  console.log('');

  // 1. 扫描文件
  console.log('[1/5] 扫描文件...');
  const { rawDocs, wikiEntries } = scanAll();
  console.log(`  Raw 文档: ${rawDocs.length}`);
  console.log(`  Wiki 词条: ${wikiEntries.length}`);
  console.log(`    - 概念类: ${wikiEntries.filter(e => e.type === 'concept').length}`);
  console.log(`    - 实体类: ${wikiEntries.filter(e => e.type === 'entity').length}`);

  // 增量模式：检测变更（包括 Wiki 词条）
  let docsToProcess = rawDocs;
  let wikiEntriesToProcess = wikiEntries;
  let removedDocIds = [];

  if (opts.mode === 'incremental') {
    console.log('\n  检测增量变更...');
    const stateFile = path.join(DATA_DIR, 'index_state.json');
    let oldState = {};
    if (fs.existsSync(stateFile)) {
      oldState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }

    const currentState = buildStateSnapshot([
      ...rawDocs.map(r => ({ key: r.key, content: r.content })),
      ...wikiEntries.map(w => ({ key: w.key, content: w.content })),
    ]);

    const rawAdded = [];
    const rawModified = [];
    for (const doc of rawDocs) {
      if (!oldState[doc.key]) {
        rawAdded.push(doc);
      } else if (oldState[doc.key] !== currentState[doc.key]) {
        rawModified.push(doc);
      }
    }

    const wikiAdded = [];
    const wikiModified = [];
    for (const entry of wikiEntries) {
      if (!oldState[entry.key]) {
        wikiAdded.push(entry);
      } else if (oldState[entry.key] !== currentState[entry.key]) {
        wikiModified.push(entry);
      }
    }

    for (const oldKey of Object.keys(oldState)) {
      if (!currentState[oldKey]) {
        removedDocIds.push(oldKey);
      }
    }

    docsToProcess = [...rawAdded, ...rawModified];
    wikiEntriesToProcess = [...wikiAdded, ...wikiModified];
    console.log(`  Raw 文档: 新增 ${rawAdded.length}, 修改 ${rawModified.length}`);
    console.log(`  Wiki 词条: 新增 ${wikiAdded.length}, 修改 ${wikiModified.length}`);
    console.log(`  删除: ${removedDocIds.length}`);

    if (docsToProcess.length === 0 && wikiEntriesToProcess.length === 0 && removedDocIds.length === 0) {
      console.log('\n  ✅ 无变更，跳过');
      return;
    }
  }

  // 2. 概念入库（直接使用现有词条，不生成详细文档）
  console.log('\n[2/5] 概念词条入库...');
  const conceptCount = wikiEntries.filter(e => e.type === 'concept').length;
  const entityCount = wikiEntries.filter(e => e.type === 'entity').length;
  console.log(`  概念类: ${conceptCount} 个`);
  console.log(`  实体类: ${entityCount} 个`);
  console.log('  ✅ 直接入库，跳过 LLM 生成');

  let processedWikiEntries = wikiEntries;

  // 3. 清洗 + 分块
  console.log('\n[3/5] 清洗 + 分块...');
  const allChunks = [];
  const allDocStats = [];
  const sourceFiles = [];

  for (let fi = 0; fi < docsToProcess.length; fi++) {
    const { file, content, key: docId } = docsToProcess[fi];
    const filename = path.basename(file);
    const meta = parseFilename(filename);

    const cleaned = cleanDocument(content);
    const title = extractTitle(cleaned.content, filename);
    sourceFiles.push(file);

    const chunks = chunkDocument(cleaned.content, docId, title, file, {
      client: meta.client,
      project: meta.project,
      docType: meta.docType,
      date: meta.date,
    });

    let hardRejected = 0;
    let softWarned = 0;
    const docWarnings = [];
    const seenContents = new Set();

    for (const chunk of chunks) {
      const hr = hardRejectCheck(chunk);
      if (hr.reject) {
        hardRejected++;
        if (opts.verbose) console.log(`    ❌ REJECT: ${chunk.id} (${hr.reason})`);
        continue;
      }

      const contentKey = chunk.content.trim();
      if (seenContents.has(contentKey)) {
        hardRejected++;
        if (opts.verbose) console.log(`    ❌ REJECT: ${chunk.id} (duplicate)`);
        continue;
      }
      seenContents.add(contentKey);

      const warnings = softWarnCheck(chunk);
      if (warnings.length > 0) {
        softWarned++;
        chunk.warnings = warnings;
        docWarnings.push(`${chunk.id}: ${warnings.join(', ')}`);
      }

      allChunks.push(chunk);
    }

    allDocStats.push({
      docPath: file,
      docId,
      chunks: chunks.length,
      hardRejected,
      softWarned,
      warnings: docWarnings,
      cleaningRatio: cleaned.cleaningRatio,
    });

    if ((fi + 1) % 20 === 0 || fi === docsToProcess.length - 1) {
      console.log(`  已处理 ${fi + 1}/${docsToProcess.length}`);
    }
  }

  // 4. 写入中间存储
  console.log('\n[5/5] 写入中间存储...');

  if (opts.dryRun) {
    console.log('\n  (dry-run 模式，不写入文件)');
  } else {
    writeStaging(allChunks);
    console.log(`  ✅ chunks.jsonl: ${allChunks.length} 条`);

    writeManifest({
      totalChunks: allChunks.length,
      totalDocs: docsToProcess.length + processedWikiEntries.length,
      sourceFiles,
      chunkConfig: { minSize: 200, maxSize: 1000, overlap: 0.1 },
      pipelineVersion: '1.1.0',
    });
    console.log(`  ✅ manifest.json`);

    const report = buildQualityReport(allChunks, allDocStats);
    writeQualityReport(report);
    console.log(`  ✅ quality_report.json`);
  }

  console.log('\n========================================');
  console.log('  ✅ 清洗切分流水线完成!');
  console.log('========================================');
  console.log(`  总 chunk 数: ${allChunks.length}`);
  console.log(`  处理文档数: ${docsToProcess.length + processedWikiEntries.length}`);

  const sizes = allChunks.map(c => c.content.length).sort((a, b) => a - b);
  if (sizes.length > 0) {
    console.log(`  chunk 大小: min=${sizes[0]} p50=${sizes[Math.floor(sizes.length * 0.5)]} p95=${sizes[Math.floor(sizes.length * 0.95)]} max=${sizes[sizes.length - 1]}`);
  }

  let totalHard = 0, totalSoft = 0;
  for (const s of allDocStats) {
    totalHard += s.hardRejected || 0;
    totalSoft += s.softWarned || 0;
  }
  console.log(`  硬拒绝: ${totalHard}`);
  console.log(`  软告警: ${totalSoft}`);
  console.log(`  输出目录: ${STAGING_DIR}`);
  console.log('========================================');
}

main().catch(err => {
  console.error('流水线执行失败:', err);
  process.exit(1);
});
