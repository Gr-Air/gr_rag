#!/usr/bin/env node
// ============================================================
// 概念知识增强流水线
// 为 Wiki/concept 中缺少详细定义的概念生成完整解释
// 使用 LLM 生成技术概念的详细定义文档
//
// 用法:
//   全量增强:   node scripts/pipeline/augment-concepts.cjs
//   增量增强:   node scripts/pipeline/augment-concepts.cjs --mode incremental
//   指定并发:   node scripts/pipeline/augment-concepts.cjs --concurrency 5
//   试运行:     node scripts/pipeline/augment-concepts.cjs --dry-run
//   指定概念:   node scripts/pipeline/augment-concepts.cjs --concepts RAG,Kubernetes,Docker
// ============================================================

const { loadEnv } = require('../lib/envLoader.cjs');
loadEnv();

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;

const ROOT = path.join(__dirname, '..', '..', '..');
const WIKI_CONCEPT_DIR = path.join(ROOT, 'Wiki', 'concept');
const RAW_DIR = path.join(ROOT, 'Raw');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { 
    mode: 'full', 
    concurrency: 3, 
    dryRun: false, 
    verbose: false,
    concepts: [],
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) { opts.mode = args[i + 1]; i++; }
    else if (args[i] === '--concurrency' && args[i + 1]) { opts.concurrency = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--dry-run') { opts.dryRun = true; }
    else if (args[i] === '--verbose' || args[i] === '-v') { opts.verbose = true; }
    else if (args[i] === '--concepts' && args[i + 1]) { 
      opts.concepts = args[i + 1].split(',').map(c => c.trim()).filter(Boolean); 
      i++; 
    }
  }
  return opts;
}

async function callLLM(prompt, opts = {}) {
  const apiKey = opts.apiKey || process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseURL = opts.baseURL || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model = opts.model || process.env.LLM_MODEL || 'qwen-plus';



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

function getExistingConcepts() {
  const concepts = new Map();
  if (!fs.existsSync(WIKI_CONCEPT_DIR)) return concepts;

  for (const f of fs.readdirSync(WIKI_CONCEPT_DIR)) {
    if (!f.endsWith('.md')) continue;
    const filePath = path.join(WIKI_CONCEPT_DIR, f);
    const content = fs.readFileSync(filePath, 'utf-8');
    const name = f.replace(/\.md$/, '');
    
    const freqMatch = content.match(/出现频次:\s*(\d+)/);
    const freq = freqMatch ? parseInt(freqMatch[1]) : 0;
    
    const defMatch = content.match(/> 定义:\s*(.+)/);
    const definition = defMatch ? defMatch[1].trim() : '';
    
    const hasFullContent = content.includes('## 定义') || content.includes('## 核心') || 
                          content.includes('## 应用') || content.length > 500;
    
    concepts.set(name, {
      name,
      filePath,
      frequency: freq,
      shortDefinition: definition,
      hasFullContent,
      content,
    });
  }
  
  return concepts;
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

async function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  概念知识增强流水线');
  console.log('========================================\n');
  console.log(`  模式: ${opts.mode}${opts.dryRun ? ' (dry-run)' : ''}`);
  console.log(`  并发: ${opts.concurrency}`);
  if (opts.concepts.length > 0) {
    console.log(`  指定概念: ${opts.concepts.join(', ')}`);
  }
  console.log('');

  // [1/4] 加载已有概念
  console.log('[1/4] 加载已有概念词条...');
  const concepts = getExistingConcepts();
  console.log(`  共 ${concepts.size} 个概念词条`);

  // [2/4] 筛选需要增强的概念
  let toAugment = [];
  if (opts.concepts.length > 0) {
    for (const name of opts.concepts) {
      if (concepts.has(name)) {
        toAugment.push(concepts.get(name));
      } else {
        console.log(`  ⚠️ 概念 "${name}" 不存在，将创建新词条`);
        toAugment.push({
          name,
          filePath: null,
          frequency: 0,
          shortDefinition: '',
          hasFullContent: false,
          content: '',
        });
      }
    }
  } else {
    for (const [name, info] of concepts) {
      if (!info.hasFullContent || info.content.length < 500) {
        toAugment.push(info);
      }
    }
  }

  console.log(`  需要增强: ${toAugment.length} 个概念`);
  
  if (toAugment.length === 0) {
    console.log('\n  ✅ 所有概念均已增强，无需处理');
    return;
  }

  if (opts.verbose) {
    console.log('\n  待增强概念列表:');
    for (const c of toAugment) {
      console.log(`    ${c.name} (频次: ${c.frequency}, ${c.hasFullContent ? '已有内容' : '缺内容'})`);
    }
  }

  // [3/4] 搜索项目文档上下文
  console.log('\n[2/4] 搜索项目文档上下文...');
  const conceptContexts = new Map();
  for (const c of toAugment) {
    const contexts = searchRawDocsForConcept(c.name);
    conceptContexts.set(c.name, contexts);
    if (contexts.length > 0 && opts.verbose) {
      console.log(`    ${c.name}: 找到 ${contexts.length} 篇相关文档`);
    }
  }

  // [3/4] LLM 生成详细定义
  console.log('\n[3/4] LLM 生成详细概念文档...');
  
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  const results = [];

  for (let i = 0; i < toAugment.length; i += opts.concurrency) {
    const batch = toAugment.slice(i, i + opts.concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (c) => {
        const contexts = conceptContexts.get(c.name) || [];
        const doc = await generateConceptDoc(c.name, c.shortDefinition, contexts);
        return { concept: c, doc };
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
      process.stdout.write(`\r  生成进度: ${completed}/${toAugment.length} (成功: ${succeeded}, 失败: ${failed})`);
    }
  }
  console.log('');

  // [4/4] 写入 Wiki 目录
  console.log('\n[4/4] 写入 Wiki 概念目录...');
  
  if (opts.dryRun) {
    console.log('  (dry-run 模式，不写入文件)');
    for (const r of results) {
      console.log(`    ${r.concept.name}: ${r.doc.length} 字符`);
    }
  } else {
    if (!fs.existsSync(WIKI_CONCEPT_DIR)) {
      fs.mkdirSync(WIKI_CONCEPT_DIR, { recursive: true });
    }
    
    let created = 0;
    let updated = 0;
    
    for (const r of results) {
      const isNew = !r.concept.filePath || !fs.existsSync(r.concept.filePath);
      writeConceptDoc(r.concept.name, r.concept.shortDefinition, r.concept.frequency, r.doc);
      if (isNew) created++;
      else updated++;
    }
    
    console.log(`  ✅ 新建: ${created} 个概念文档`);
    console.log(`  ✅ 更新: ${updated} 个概念文档`);
  }

  // 保存增强状态
  if (!opts.dryRun) {
    const stateFile = path.join(__dirname, '..', '..', 'src', 'data', 'concept_augment_state.json');
    const augmentedNames = new Set();
    if (fs.existsSync(stateFile)) {
      const oldState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      for (const name of oldState.augmentedNames || []) {
        augmentedNames.add(name);
      }
    }
    for (const r of results) {
      augmentedNames.add(r.concept.name);
    }
    fs.writeFileSync(stateFile, JSON.stringify({
      augmentedNames: Array.from(augmentedNames),
      builtAt: new Date().toISOString(),
      totalAugmented: augmentedNames.size,
    }, null, 2));
    console.log('  ✅ 增强状态已保存');
  }

  console.log('\n========================================');
  console.log('  ✅ 概念知识增强完成!');
  console.log('========================================');
  console.log(`  成功: ${succeeded} 个`);
  console.log(`  失败: ${failed} 个`);
  console.log(`  新建: ${results.filter(r => !r.concept.filePath).length} 个`);
  console.log(`  更新: ${results.filter(r => r.concept.filePath).length} 个`);
  console.log('========================================');
  console.log('\n  下一步: 运行 npx tsx scripts/buildIndex.ts 重建索引');
}

main().catch(err => {
  console.error('概念增强失败:', err);
  process.exit(1);
});