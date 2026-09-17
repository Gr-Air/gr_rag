// ============================================================
// 索引构建脚本（独立纯 JS，使用 jieba 分词 + 阿里 DashScope Embedding）
// 用法: node scripts/buildIndex.mjs
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, 'Raw');
const WIKI_DIR = path.join(ROOT, 'Wiki');
const DATA_DIR = path.join(__dirname, '..', 'src', 'data');

// 加载 .env 环境变量
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// 阿里 DashScope Embedding 配置
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v4';
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1024', 10);
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';

const DIM = EMBEDDING_DIM;

// ============================================================
// jieba 分词（合并默认词典 + 业务自定义词典）
// ============================================================

const CUSTOM_WORDS = [
  '微服务 100', '架构设计 100', '数字孪生 100', '云原生 100',
  '负载均衡 100', '消息队列 100', '注册中心 100', '配置中心 100',
  '分布式 100', '容器 100', '网关 100', '中台 100',
  'Docker 100', 'Kubernetes 100', 'Redis 100', 'MySQL 100',
  'Kafka 100', 'Nginx 100', 'Elasticsearch 100', 'Spring 100',
  'Vue 100', 'React 100', 'RabbitMQ 100', 'RocketMQ 100',
  'Jenkins 100', 'GitLab 100', 'MinIO 100', 'MongoDB 100',
  'PostgreSQL 100',
  '国家电网 100', '中国移动 100', '中国联通 100', '中国石油 100',
  '中国建筑 100', '中国航天 100', '中国航发 100', '中国船舶 100',
  '中国电科 100', '中国中铁 100', '中国银行 100', '中信证券 100',
  '万科集团 100', '碧桂园 100', '龙湖集团 100', '华润置地 100',
  '华能集团 100', '融创中国 100', '招商银行 100', '国泰君安 100',
  '浦发银行 100', '太平洋保险 100', '宝武钢铁 100', '中钢集团 100',
  '中粮集团 100', '中化集团 100', '南方电网 100',
  'ERP 100', 'CRM 100', 'OA 100', 'AI质检 100', '电子签章 100',
  '统一身份认证 100', '风控系统 100', '智能客服 100',
  '数据中台 100', '物联网管理平台 100', '供应链管理平台 100',
  '项目管理系统 100', '人力资源系统 100', '财务共享中心 100',
  '智慧园区平台 100', '移动办公APP 100',
  '阿里云 100', '腾讯云 100', '华为云 100',
  '技术架构设计 100', '技术方案 100', '需求规格说明书 100',
  '项目管理计划 100', '项目进度汇报 100', '项目人员清单 100',
  '项目费用结算 100', '系统测试报告 100', '客户项目验收 100',
  '来往账目 100',
  '星辰数智 100', '等保2.0 100', '微服务架构改造 100',
  '技术研发部 100', '产品设计部 100', '项目管理部 100',
  '质量保障部 100', '财务管理部 100', '人力资源部 100',
  '商务拓展部 100',
];

const defaultDictStr = dict.toString('utf-8');
const customStr = CUSTOM_WORDS.join('\n');
const mergedDict = Buffer.from(defaultDictStr + '\n' + customStr, 'utf-8');
const jieba = Jieba.withDict(mergedDict);

function tokenize(text) {
  const result = jieba.cut(text, false);
  const tokens = new Set();
  for (const token of result) {
    const trimmed = token.trim();
    if (trimmed.length >= 1) tokens.add(trimmed);
  }
  return [...tokens];
}

// ============================================================
// 阿里 DashScope Embedding 批量调用
// ============================================================

async function getEmbeddingsBatch(texts) {
  const BATCH_SIZE = 10; // DashScope text-embedding-v4 限制单次最多 10 条
  const results = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch(DASHSCOPE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: { texts: batch },
        parameters: { text_type: 'document' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DashScope API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    for (const emb of data.output.embeddings) {
      results.push(emb.embedding);
    }

    console.log(`  Embedding: ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
  }

  return results;
}

// ============================================================
// 解析
// ============================================================

function parseFilename(filename) {
  const name = filename.replace(/\.md$/, '');
  const parts = name.split('_');
  if (parts.length >= 4) {
    return {
      client: parts.slice(0, parts.length - 3).join('_'),
      project: parts[parts.length - 3],
      docType: parts[parts.length - 2],
      date: parts[parts.length - 1],
    };
  }
  return { client: '', project: '', docType: '', date: '' };
}

function extractWikiLinks(content) {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) links.add(match[1].trim());
  return [...links];
}

function chunkDocument(content, docId, docTitle, docPath, metadata) {
  const MAX_CHUNK = 800;
  const OVERLAP = 100;
  const sections = content.split(/(?=^## )/m);
  const chunks = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_CHUNK) {
      let start = 0;
      while (start < trimmed.length) {
        const end = Math.min(start + MAX_CHUNK, trimmed.length);
        const sub = trimmed.slice(start, end);
        chunks.push({
          id: `${docId}_${chunks.length}`, docId, docTitle, docPath,
          chunkIndex: chunks.length, content: sub,
          metadata, wikiLinks: extractWikiLinks(sub),
        });
        if (end >= trimmed.length) break;
        start = end - OVERLAP;
      }
    } else {
      chunks.push({
        id: `${docId}_${chunks.length}`, docId, docTitle, docPath,
        chunkIndex: chunks.length, content: trimmed,
        metadata, wikiLinks: extractWikiLinks(trimmed),
      });
    }
  }
  return chunks;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('========================================');
  console.log('  星辰Wiki 知识库索引构建');
  console.log('========================================\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // ===== 阶段1：解析文档 =====
  console.log('[1/3] 解析文档并分块...');
  const allChunks = [];
  const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.md'));

  for (let fi = 0; fi < rawFiles.length; fi++) {
    const file = rawFiles[fi];
    const content = fs.readFileSync(path.join(RAW_DIR, file), 'utf-8');
    const meta = parseFilename(file);
    const firstLine = content.split('\n')[0]?.trim() || '';
    let title;
    if (firstLine.startsWith('# ')) {
      title = firstLine.replace(/^#\s+/, '').trim();
    } else if (firstLine.startsWith('|') || firstLine.startsWith('---') || firstLine.startsWith('###') || !firstLine) {
      const h1Match = content.match(/^# (.+)$/m);
      title = h1Match ? h1Match[1].trim() : file;
    } else {
      title = firstLine.replace(/^#\s+/, '').trim() || file;
    }
    const docId = `raw_${file.replace(/\.md$/, '')}`;
    const chunks = chunkDocument(content, docId, title, `Raw/${file}`, {
      client: meta.client, project: meta.project, docType: meta.docType, date: meta.date,
    });
    allChunks.push(...chunks);
    if ((fi + 1) % 20 === 0) console.log(`  已解析 ${fi + 1}/${rawFiles.length}`);
  }

  // Wiki 词条
  console.log('  添加 Wiki 词条...');
  for (const sub of ['concept', 'entity']) {
    const dir = path.join(WIKI_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    for (const wf of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const wContent = fs.readFileSync(path.join(dir, wf), 'utf-8');
      const name = wf.replace(/\.md$/, '');
      const freqMatch = wContent.match(/出现频次:\s*(\d+)/);
      const freq = freqMatch ? parseInt(freqMatch[1]) : 0;
      const text = `# ${name}\n${sub === 'concept' ? '概念' : '实体'} | 出现频次: ${freq}`;
      allChunks.push({
        id: `wiki_${name}`, docId: `wiki_${name}`, docTitle: name,
        docPath: `Wiki/${sub}/${wf}`, chunkIndex: 0, content: text,
        metadata: { client: '', project: '', docType: sub === 'concept' ? '概念' : '实体', date: '' },
        wikiLinks: [name],
      });
    }
  }
  console.log(`  ✅ 共 ${allChunks.length} 个文档块\n`);

  // ===== 阶段2：向量索引（使用阿里 DashScope Embedding）=====
  console.log('[2/3] 构建向量索引（阿里 DashScope Embedding）...');
  const vecDir = path.join(DATA_DIR, 'vectors');
  if (!fs.existsSync(vecDir)) fs.mkdirSync(vecDir, { recursive: true });

  if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY.startsWith('sk-你的')) {
    console.error('  ❌ DASHSCOPE_API_KEY 未配置，请在 .env 中设置有效的 API Key');
    process.exit(1);
  }

  // 准备所有文本（取前 2000 字符）
  const vecTexts = allChunks.map(c => c.content.slice(0, 2000));
  console.log(`  共 ${vecTexts.length} 条文本待向量化，维度: ${DIM}`);

  // 批量调用阿里 embedding API
  const allVectors = await getEmbeddingsBatch(vecTexts);
  console.log(`  ✅ Embedding 完成: ${allVectors.length} 个向量`);

  // 分片保存
  const VEC_SHARD = 1000;
  let shardIdx = 0;

  for (let i = 0; i < allChunks.length; i += VEC_SHARD) {
    const shardVecs = allVectors.slice(i, i + VEC_SHARD);
    const shardMeta = allChunks.slice(i, i + VEC_SHARD).map(c => ({
      id: c.id, docId: c.docId, docTitle: c.docTitle, docPath: c.docPath,
      metadata: c.metadata, content: c.content.slice(0, 3000), wikiLinks: c.wikiLinks,
    }));

    fs.writeFileSync(
      path.join(vecDir, `shard_${shardIdx}.json`),
      JSON.stringify({ vectors: shardVecs, meta: shardMeta })
    );
    console.log(`  分片 ${shardIdx}: ${shardVecs.length} 条`);
    shardIdx++;
  }

  fs.writeFileSync(path.join(vecDir, 'config.json'), JSON.stringify({
    totalChunks: allChunks.length, dim: DIM,
    shardSize: VEC_SHARD, totalShards: shardIdx,
  }));
  console.log(`  ✅ 向量索引完成: ${allChunks.length} 条, ${shardIdx} 个分片\n`);

  // ===== 阶段3：BM25 索引 =====
  console.log('[3/3] 构建 BM25 倒排索引...');
  const bm25Dir = path.join(DATA_DIR, 'bm25');
  if (!fs.existsSync(bm25Dir)) fs.mkdirSync(bm25Dir, { recursive: true });

  const invIndex = new Map();
  const docLengths = {};

  for (let i = 0; i < allChunks.length; i++) {
    const c = allChunks[i];
    const tokens = tokenize(c.content);
    docLengths[c.id] = tokens.length;

    const tfMap = new Map();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);
    for (const [term, tf] of tfMap) {
      if (!invIndex.has(term)) invIndex.set(term, []);
      invIndex.get(term).push({ chunkId: c.id, tf });
    }
    if ((i + 1) % 500 === 0) console.log(`  已索引 ${i + 1}/${allChunks.length}`);
  }

  // 保存倒排索引分片
  const entries = Array.from(invIndex.entries());
  const BM25_SHARD = 5000;
  let bm25ShardIdx = 0;
  for (let i = 0; i < entries.length; i += BM25_SHARD) {
    const shard = {};
    for (let j = i; j < Math.min(i + BM25_SHARD, entries.length); j++) {
      shard[entries[j][0]] = entries[j][1];
    }
    fs.writeFileSync(path.join(bm25Dir, `shard_${bm25ShardIdx}.json`), JSON.stringify(shard));
    bm25ShardIdx++;
  }

  let totalLen = 0;
  for (const len of Object.values(docLengths)) totalLen += len;
  const avgDocLen = allChunks.length > 0 ? totalLen / allChunks.length : 0;

  fs.writeFileSync(path.join(bm25Dir, 'meta.json'), JSON.stringify({
    docCount: allChunks.length, avgDocLen, totalTerms: invIndex.size, totalShards: bm25ShardIdx,
  }));
  fs.writeFileSync(path.join(bm25Dir, 'doc_lengths.json'), JSON.stringify(docLengths));

  // chunks 元数据
  const metaDir = path.join(DATA_DIR, 'chunks_meta');
  if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

  const META_SHARD = 2000;
  let metaShardIdx = 0;
  for (let i = 0; i < allChunks.length; i += META_SHARD) {
    const shard = {};
    for (let j = i; j < Math.min(i + META_SHARD, allChunks.length); j++) {
      const c = allChunks[j];
      shard[c.id] = {
        docId: c.docId, docTitle: c.docTitle, docPath: c.docPath,
        metadata: c.metadata, content: c.content.slice(0, 3000), wikiLinks: c.wikiLinks,
      };
    }
    fs.writeFileSync(path.join(metaDir, `shard_${metaShardIdx}.json`), JSON.stringify(shard));
    metaShardIdx++;
  }
  fs.writeFileSync(path.join(metaDir, 'config.json'), JSON.stringify({
    totalChunks: allChunks.length, shardSize: META_SHARD, totalShards: metaShardIdx,
  }));

  console.log(`  ✅ BM25 完成: ${allChunks.length} 文档, ${invIndex.size} 词项\n`);

  console.log('========================================');
  console.log('  ✅ 全部索引构建完成!');
  console.log('========================================');
  console.log(`  总块数: ${allChunks.length}`);
  console.log(`  向量维度: ${DIM}`);
  console.log(`  BM25 词项: ${invIndex.size}`);
  console.log('========================================');
}

main().catch(err => {
  console.error('构建失败:', err);
  process.exit(1);
});
