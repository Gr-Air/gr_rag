// ============================================================
// 索引构建脚本（分批流式处理）
// 用法: npx tsx scripts/buildIndex.ts
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { DocChunk } from '../src/domain/document/types';
import { tokenize } from '../src/infrastructure/tokenizer/tokenizer';

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

const RAW_DIR = path.join(process.cwd(), '..', 'Raw');
const WIKI_DIR = path.join(process.cwd(), '..', 'Wiki');
const DATA_DIR = path.join(process.cwd(), 'src', 'data');

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v4';
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1024', 10);
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';

const DIM = EMBEDDING_DIM;
const PROCESS_BATCH = 500;

async function getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  const BATCH_SIZE = 10;
  const results: number[][] = [];

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

function parseRawFilename(filename: string) {
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

function extractWikiLinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) links.push(match[1].trim());
  return [...new Set(links)];
}

function chunkDocument(
  content: string, docId: string, docTitle: string, docPath: string,
  metadata: DocChunk['metadata']
): DocChunk[] {
  const MAX_CHUNK_SIZE = 800;
  const OVERLAP = 100;
  const sections = content.split(/(?=^## )/m);
  const chunks: DocChunk[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_CHUNK_SIZE) {
      let start = 0;
      while (start < trimmed.length) {
        const end = Math.min(start + MAX_CHUNK_SIZE, trimmed.length);
        const sub = trimmed.slice(start, end);
        chunks.push({
          id: `${docId}_${chunks.length}`, docId, docTitle, docPath,
          chunkIndex: chunks.length, content: sub,
          metadata, wikiLinks: extractWikiLinks(sub),
        });
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

function* generateAllChunks(): Generator<DocChunk> {
  const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.md'));
  for (let fi = 0; fi < rawFiles.length; fi++) {
    const file = rawFiles[fi];
    const content = fs.readFileSync(path.join(RAW_DIR, file), 'utf-8');
    const meta = parseRawFilename(file);
    const firstLine = content.split('\n')[0]?.trim() || '';
    let title: string;
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
    for (const chunk of chunks) yield chunk;

    if ((fi + 1) % 20 === 0) {
      console.log(`  已解析 ${fi + 1}/${rawFiles.length} 个 Raw 文档`);
    }
  }
}

async function main() {
  console.log('========================================');
  console.log('  星辰Wiki 知识库索引构建（流式分批）');
  console.log('========================================\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY.startsWith('sk-你的')) {
    console.error('  ❌ DASHSCOPE_API_KEY 未配置');
    process.exit(1);
  }

  const vecDir = path.join(DATA_DIR, 'vectors');
  const bm25Dir = path.join(DATA_DIR, 'bm25');
  const chunksMetaDir = path.join(DATA_DIR, 'chunks_meta');

  if (fs.existsSync(vecDir)) fs.rmSync(vecDir, { recursive: true });
  if (fs.existsSync(bm25Dir)) fs.rmSync(bm25Dir, { recursive: true });
  if (fs.existsSync(chunksMetaDir)) fs.rmSync(chunksMetaDir, { recursive: true });

  fs.mkdirSync(vecDir, { recursive: true });
  fs.mkdirSync(bm25Dir, { recursive: true });
  fs.mkdirSync(chunksMetaDir, { recursive: true });

  const invIndex = new Map<string, Array<{ chunkId: string; tf: number }>>();
  const docLengths: Record<string, number> = {};
  const vecShardSize = 1000;
  const metaShardSize = 2000;

  let totalChunks = 0;
  let vecShardIndex = 0;
  let metaShardIndex = 0;
  let currentVecs: number[][] = [];
  let currentMeta: Array<{ id: string; docId: string; docTitle: string; docPath: string; metadata: DocChunk['metadata']; content: string; wikiLinks: string[] }> = [];

  const chunkGenerator = generateAllChunks();

  console.log('[阶段 1] 解析文档并构建索引...');
  console.log('  这将分批处理，请耐心等待...\n');

  while (true) {
    const batch: DocChunk[] = [];
    for (let i = 0; i < PROCESS_BATCH; i++) {
      const result = chunkGenerator.next();
      if (result.done) break;
      batch.push(result.value);
    }

    if (batch.length === 0) break;

    console.log(`  处理批次 ${totalChunks + 1}-${totalChunks + batch.length}...`);

    const texts = batch.map(c => c.content.slice(0, 2000));
    const vectors = await getEmbeddingsBatch(texts);

    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      const vec = vectors[i];

      currentVecs.push(vec);
      currentMeta.push({
        id: c.id, docId: c.docId, docTitle: c.docTitle, docPath: c.docPath,
        metadata: c.metadata, content: c.content.slice(0, 3000), wikiLinks: c.wikiLinks,
      });

      if (currentVecs.length >= vecShardSize) {
        fs.writeFileSync(
          path.join(vecDir, `shard_${vecShardIndex}.json`),
          JSON.stringify({ vectors: currentVecs, meta: currentMeta })
        );
        vecShardIndex++;
        currentVecs = [];
        currentMeta = [];
        console.log(`    已写入向量分片 ${vecShardIndex}`);
      }

      const tokens = tokenize(c.content);
      docLengths[c.id] = tokens.length;

      const tfMap = new Map<string, number>();
      for (const t of tokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);
      for (const [term, tf] of tfMap) {
        if (!invIndex.has(term)) invIndex.set(term, []);
        invIndex.get(term)!.push({ chunkId: c.id, tf });
      }

      if (Object.keys(docLengths).length % metaShardSize === 0 && Object.keys(docLengths).length > 0) {
        const shard: Record<string, (typeof currentMeta)[number]> = {};
        const startIdx = Object.keys(docLengths).length - metaShardSize;
        for (let j = startIdx; j < Object.keys(docLengths).length; j++) {
          const idx = Object.keys(docLengths)[j];
          const cm = currentMeta.find(m => m.id === idx);
          if (cm) shard[idx] = cm;
        }
        fs.writeFileSync(path.join(chunksMetaDir, `shard_${metaShardIndex}.json`), JSON.stringify(shard));
        metaShardIndex++;
        console.log(`    已写入元数据分片 ${metaShardIndex}`);
      }
    }

    totalChunks += batch.length;
    console.log(`    累计: ${totalChunks} 个文档块\n`);
  }

  if (currentVecs.length > 0) {
    fs.writeFileSync(
      path.join(vecDir, `shard_${vecShardIndex}.json`),
      JSON.stringify({ vectors: currentVecs, meta: currentMeta })
    );
    vecShardIndex++;
  }

  fs.writeFileSync(path.join(vecDir, 'config.json'), JSON.stringify({
    totalChunks, dim: DIM, shardSize: vecShardSize, totalShards: vecShardIndex,
  }));

  console.log(`  ✅ 向量索引完成: ${totalChunks} 个向量, ${vecShardIndex} 个分片\n`);

  console.log('[阶段 2] 构建 BM25 倒排索引...');

  let totalLen = 0;
  for (const len of Object.values(docLengths)) totalLen += len;
  const avgDocLen = totalChunks > 0 ? totalLen / totalChunks : 0;

  const entries = Array.from(invIndex.entries());
  const bm25ShardSize = 5000;
  for (let i = 0; i < entries.length; i += bm25ShardSize) {
    const shard: Record<string, Array<{ chunkId: string; tf: number }>> = {};
    for (let j = i; j < Math.min(i + bm25ShardSize, entries.length); j++) {
      shard[entries[j][0]] = entries[j][1];
    }
    fs.writeFileSync(path.join(bm25Dir, `shard_${Math.floor(i / bm25ShardSize)}.json`), JSON.stringify(shard));
  }

  fs.writeFileSync(path.join(bm25Dir, 'meta.json'), JSON.stringify({
    docCount: totalChunks, avgDocLen, totalTerms: invIndex.size,
    totalShards: Math.ceil(entries.length / bm25ShardSize),
  }));
  fs.writeFileSync(path.join(bm25Dir, 'doc_lengths.json'), JSON.stringify(docLengths));

  fs.writeFileSync(path.join(chunksMetaDir, 'config.json'), JSON.stringify({
    totalChunks, shardSize: metaShardSize, totalShards: metaShardIndex,
  }));

  console.log(`  ✅ BM25 索引完成: ${totalChunks} 文档, ${invIndex.size} 词项, 平均长度 ${avgDocLen.toFixed(1)}\n`);

  console.log('========================================');
  console.log('  ✅ 全部索引构建完成!');
  console.log('========================================');
  console.log(`  总文档块: ${totalChunks}`);
  console.log(`  向量维度: ${DIM}`);
  console.log(`  BM25 词项: ${invIndex.size}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log('========================================');
}

main().catch(err => {
  console.error('索引构建失败:', err);
  process.exit(1);
});