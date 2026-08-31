// ============================================================
// Markdown 文档解析器
// 功能：解析 Raw/ 和 Wiki/ 下的 md 文件，提取结构化信息
// 支持语义分块 + 父子文档结构
// ============================================================

import fs from 'fs';
import path from 'path';
import { ParsedDoc, DocChunk, WikiEntry, WikiStats } from './types';

const RAW_DIR = path.join(process.cwd(), '..', 'Raw');
const WIKI_DIR = path.join(process.cwd(), '..', 'Wiki');

/** 解析 Raw 文件名：{客户}_{项目系统}_{文档类型}_{日期}.md */
function parseRawFilename(filename: string) {
  const name = filename.replace(/\.md$/, '');
  const parts = name.split('_');
  if (parts.length >= 4) {
    const datePart = parts[parts.length - 1];
    const docType = parts[parts.length - 2];
    const project = parts[parts.length - 3];
    const client = parts.slice(0, parts.length - 3).join('_');
    return { client, project, docType, date: datePart };
  }
  return { client: '', project: '', docType: '', date: '' };
}

/** 提取文档中所有 [[wiki链接]] */
function extractWikiLinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return [...new Set(links)];
}

/**
 * 语义分块：按自然段落/句子边界切分，避免在句子中间截断
 *
 * 策略（与 scripts/lib/chunker.cjs 保持一致）：
 * 1. 首先按 ## 标题切分为粗粒度段落
 * 2. 在段落内按自然边界（段落/句子）进一步切分，跨 section 统一收集所有句子
 * 3. 全局统一 chunkIndex（避免不同 section 重复）
 * 4. 合并短段落，确保每个 chunk 有足够的语义信息
 * 5. 同时保留完整原始文档作为"父文档"
 */
function semanticChunkDocument(
  content: string,
  docId: string,
  docTitle: string,
  docPath: string,
  metadata: DocChunk['metadata']
): { chunks: DocChunk[]; parentDocId: string } {
  const MIN_CHUNK_SIZE = 200;   // 最小 chunk 大小（字符）
  const MAX_CHUNK_SIZE = 1000;  // 最大 chunk 大小（字符）
  const OVERLAP_CHARS = Math.round((MIN_CHUNK_SIZE + MAX_CHUNK_SIZE) / 2 * 0.1); // 平均 chunk 大小的 10%

  const parentDocId = `parent_${docId}`;
  const chunks: DocChunk[] = [];

  // Step 1: 按 ## 标题粗切
  const sections = content.split(/(?=^## )/m);

  // Step 2: 跨 section 统一收集所有句子
  const allSentences: string[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // 按段落边界切分（空行分隔）
    const paragraphs = trimmed.split(/\n\s*\n/).filter(p => p.trim().length > 0);

    // 进一步按句子边界切分（中英文句号、换行等）
    for (const para of paragraphs) {
      const parts = para.split(/(?<=[。！？])\s*|(?<=\.)\s+(?=[A-Z])|(?<=[!?])\s+(?=[A-Z])/);
      for (const part of parts) {
        const s = part.trim();
        if (s.length > 0) allSentences.push(s);
      }
    }
  }

  if (allSentences.length === 0) {
    // 降级：按固定大小切分
    for (let i = 0; i < content.length; i += MAX_CHUNK_SIZE) {
      const sub = content.slice(i, i + MAX_CHUNK_SIZE);
      if (!sub.trim()) continue;
      chunks.push({
        id: `${docId}_${chunks.length}`,
        docId,
        docTitle,
        docPath,
        chunkIndex: chunks.length,
        content: sub,
        metadata,
        wikiLinks: extractWikiLinks(sub),
        parentDocId,
      });
    }
    return { chunks, parentDocId };
  }

  // Step 3: 将句子合并为 chunk（保持语义完整性，全局统一 chunkIndex）
  let currentChunk = '';
  let chunkIdx = 0;

  for (let i = 0; i < allSentences.length; i++) {
    const sentence = allSentences[i];

    if (currentChunk.length + sentence.length > MAX_CHUNK_SIZE && currentChunk.length >= MIN_CHUNK_SIZE) {
      const chunkContent = currentChunk.trim();
      chunks.push({
        id: `${docId}_${chunkIdx}`,
        docId,
        docTitle,
        docPath,
        chunkIndex: chunkIdx,
        content: chunkContent,
        metadata,
        wikiLinks: extractWikiLinks(chunkContent),
        parentDocId,
      });
      chunkIdx++;

      // 重叠：从上一个 chunk 末尾往前取完整句子，使得重叠字符数 >= OVERLAP_CHARS
      let overlapChars = 0;
      let overlapIdx = i;
      while (overlapIdx > 0 && overlapChars < OVERLAP_CHARS) {
        overlapIdx--;
        overlapChars += allSentences[overlapIdx].length;
      }
      const overlapSentences = allSentences.slice(overlapIdx, i);
      currentChunk = overlapSentences.join('\n') + '\n' + sentence + '\n';
    } else {
      currentChunk += sentence + '\n';
    }
  }

  // 最后一个 chunk
  if (currentChunk.trim().length > 0) {
    const chunkContent = currentChunk.trim();
    chunks.push({
      id: `${docId}_${chunkIdx}`,
      docId,
      docTitle,
      docPath,
      chunkIndex: chunkIdx,
      content: chunkContent,
      metadata,
      wikiLinks: extractWikiLinks(chunkContent),
      parentDocId,
    });
    chunkIdx++;
  }

  // Step 4: 合并过短的相邻 chunk（< MIN_CHUNK_SIZE）
  const mergedChunks: DocChunk[] = [];
  for (const chunk of chunks) {
    const last = mergedChunks[mergedChunks.length - 1];
    if (last && (last.content.length < MIN_CHUNK_SIZE || chunk.content.length < MIN_CHUNK_SIZE)) {
      last.content = last.content + '\n\n' + chunk.content;
      last.wikiLinks = [...new Set([...last.wikiLinks, ...chunk.wikiLinks])];
    } else {
      mergedChunks.push({ ...chunk });
    }
  }

  return { chunks: mergedChunks, parentDocId };
}

/**
 * 固定大小分块（降级方案，用于非常简单的文档）
 */
function chunkDocument(
  content: string,
  docId: string,
  docTitle: string,
  docPath: string,
  metadata: DocChunk['metadata']
): DocChunk[] {
  const MAX_CHUNK_SIZE = 800;
  const OVERLAP = 100;

  // 按 ## 标题切分
  const sections = content.split(/(?=^## )/m);
  const chunks: DocChunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // 如果段落太长，进一步按固定大小切分
    if (trimmed.length > MAX_CHUNK_SIZE) {
      let start = 0;
      while (start < trimmed.length) {
        const end = Math.min(start + MAX_CHUNK_SIZE, trimmed.length);
        const chunkContent = trimmed.slice(start, end);
        chunks.push({
          id: `${docId}_${chunks.length}`,
          docId,
          docTitle,
          docPath,
          chunkIndex: chunks.length,
          content: chunkContent,
          metadata,
          wikiLinks: extractWikiLinks(chunkContent),
        });
        if (end >= trimmed.length) break;
        start = end - OVERLAP;
      }
    } else {
      chunks.push({
        id: `${docId}_${chunks.length}`,
        docId,
        docTitle,
        docPath,
        chunkIndex: chunks.length,
        content: trimmed,
        metadata,
        wikiLinks: extractWikiLinks(trimmed),
      });
    }
  }

  return chunks;
}

/** 解析单个 Raw 文档 */
function parseRawDoc(filePath: string): ParsedDoc {
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const meta = parseRawFilename(filename);

  const lines = content.split('\n');
  const title = lines[0]?.replace(/^#\s+/, '').trim() || filename;

  const docId = `raw_${filename.replace(/\.md$/, '')}`;
  const docPath = `Raw/${filename}`;

  const metadata = {
    client: meta.client,
    project: meta.project,
    docType: meta.docType,
    date: meta.date,
  };

  // 使用语义分块（代替原有的固定大小分块）
  const { chunks, parentDocId } = semanticChunkDocument(content, docId, title, docPath, metadata);
  const wikiLinks = extractWikiLinks(content);

  return { id: docId, title, path: docPath, rawContent: content, chunks, metadata, wikiLinks };
}

/** 获取所有文档的父文档映射（docId -> 完整文档内容） */
export function getAllParentDocs(): Map<string, { content: string; title: string; path: string; metadata: DocChunk['metadata'] }> {
  const docs = loadAllRawDocs();
  const map = new Map<string, { content: string; title: string; path: string; metadata: DocChunk['metadata'] }>();
  for (const doc of docs) {
    map.set(doc.id, {
      content: doc.rawContent,
      title: doc.title,
      path: doc.path,
      metadata: doc.metadata,
    });
  }
  return map;
}

/** 解析 Wiki 词条 */
function parseWikiEntry(filePath: string, type: 'concept' | 'entity'): WikiEntry {
  const filename = path.basename(filePath);
  const name = filename.replace(/\.md$/, '');
  const content = fs.readFileSync(filePath, 'utf-8');

  // 提取频次
  const freqMatch = content.match(/出现频次:\s*(\d+)/);
  const frequency = freqMatch ? parseInt(freqMatch[1]) : 0;

  const category = type === 'entity' ? guessEntityCategory(name) : undefined;

  return {
    name,
    type,
    frequency,
    category,
    path: type === 'concept' ? `Wiki/concept/${filename}` : `Wiki/entity/${filename}`,
  };
}

/** 猜测实体类别 */
function guessEntityCategory(name: string): string {
  const clients = [
    '万科集团', '中信证券', '中化集团', '中国中车', '中国中铁', '中国建筑',
    '中国电科', '中国石油', '中国移动', '中国联通', '中国航发', '中国航天',
    '中国船舶', '中国银行', '中粮集团', '中钢集团', '华润置地', '华能集团',
    '南方电网', '国家电网', '国泰君安', '太平洋保险', '宝武钢铁', '招商银行',
    '浦发银行', '碧桂园', '融创中国', '龙湖集团',
  ];
  const techComponents = [
    'Redis', 'MySQL', 'PostgreSQL', 'MongoDB', 'Kafka', 'RabbitMQ', 'RocketMQ',
    'Elasticsearch', 'Nginx', 'Docker', 'Kubernetes', 'Jenkins', 'GitLab',
    'Spring', 'SpringCloud', 'Vue', 'React', 'Node.js', 'Python', 'Java',
    '阿里云', '腾讯云', '华为云', 'AWS', 'Azure', '高斯DB', 'MinIO',
  ];
  const departments = [
    '产品设计部', '人力资源部', '商务拓展部', '技术研发部',
    '财务管理部', '质量保障部', '项目管理部',
  ];

  if (clients.includes(name)) return '客户企业';
  if (techComponents.includes(name)) return '技术组件';
  if (departments.includes(name)) return '部门';
  // 粗略判断：中文2-3字可能是人名
  if (/^[\u4e00-\u9fa5]{2,3}$/.test(name)) return '人员';
  return '项目系统';
}

/** 加载所有原始文档 */
export function loadAllRawDocs(): ParsedDoc[] {
  const docs: ParsedDoc[] = [];
  if (!fs.existsSync(RAW_DIR)) return docs;

  const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const filePath = path.join(RAW_DIR, file);
    docs.push(parseRawDoc(filePath));
  }
  return docs;
}

/** 加载所有 Wiki 词条 */
export function loadAllWikiEntries(): WikiEntry[] {
  const entries: WikiEntry[] = [];

  const conceptDir = path.join(WIKI_DIR, 'concept');
  if (fs.existsSync(conceptDir)) {
    fs.readdirSync(conceptDir)
      .filter(f => f.endsWith('.md'))
      .forEach(f => entries.push(parseWikiEntry(path.join(conceptDir, f), 'concept')));
  }

  const entityDir = path.join(WIKI_DIR, 'entity');
  if (fs.existsSync(entityDir)) {
    fs.readdirSync(entityDir)
      .filter(f => f.endsWith('.md'))
      .forEach(f => entries.push(parseWikiEntry(path.join(entityDir, f), 'entity')));
  }

  return entries;
}

/** 获取知识库统计信息 */
export function getWikiStats(): WikiStats {
  const rawDocs = loadAllRawDocs();
  const wikiEntries = loadAllWikiEntries();

  const concepts = wikiEntries.filter(e => e.type === 'concept').sort((a, b) => b.frequency - a.frequency);
  const entities = wikiEntries.filter(e => e.type === 'entity').sort((a, b) => b.frequency - a.frequency);

  // 收集去重的元数据
  const clientSet = new Set<string>();
  const projectSet = new Set<string>();
  const docTypeSet = new Set<string>();

  for (const doc of rawDocs) {
    if (doc.metadata.client) clientSet.add(doc.metadata.client);
    if (doc.metadata.project) projectSet.add(doc.metadata.project);
    if (doc.metadata.docType) docTypeSet.add(doc.metadata.docType);
  }

  const totalChunks = rawDocs.reduce((sum, d) => sum + d.chunks.length, 0);

  return {
    totalDocs: rawDocs.length,
    totalChunks,
    totalConcepts: concepts.length,
    totalEntities: entities.length,
    totalClients: clientSet.size,
    totalProjects: projectSet.size,
    totalDocTypes: docTypeSet.size,
    topConcepts: concepts.slice(0, 20),
    topEntities: entities.slice(0, 20),
    clients: Array.from(clientSet).sort(),
    projects: Array.from(projectSet).sort(),
    docTypes: Array.from(docTypeSet).sort(),
  };
}

/** 获取所有文档块（用于建索引） */
export function getAllChunks(): DocChunk[] {
  const docs = loadAllRawDocs();
  return docs.flatMap(d => d.chunks);
}

/** 获取所有文档块 + wiki 词条块（统一用于建索引） */
export function getAllIndexableChunks(): DocChunk[] {
  const chunks = getAllChunks();

  // 将 wiki 词条也作为可检索块
  const wikiEntries = loadAllWikiEntries();
  for (const entry of wikiEntries) {
    const content = `# ${entry.name}\n${entry.type === 'concept' ? '概念' : '实体'} | 出现频次: ${entry.frequency}${entry.category ? ` | 类别: ${entry.category}` : ''}`;
    chunks.push({
      id: `wiki_${entry.name}`,
      docId: `wiki_${entry.name}`,
      docTitle: entry.name,
      docPath: entry.path,
      chunkIndex: 0,
      content,
      metadata: { client: '', project: '', docType: entry.category || entry.type, date: '' },
      wikiLinks: [entry.name],
    });
  }

  return chunks;
}
