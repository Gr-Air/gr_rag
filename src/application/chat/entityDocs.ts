// ============================================================
// 实体关联文档加载（Application 层 Use Case）
// 从 chat/eval route 中拆出的业务流程：
//   查结构化库（StructQueryPort）→ 读 Raw/Wiki 文件（DocumentFileStore Port）
//   → 短文档全文注入 / 长文档片段提取（算法在 domain/entity/snippets）
// ============================================================

import type { StructQueryPort } from '@/domain/entity/types';
import { estimateTokens, extractEntitySnippets } from '@/domain/entity/snippets';
import type { DocumentFileStore } from '../ports';

// ============================================================
// 常量
// ============================================================

const SHORT_DOC_TOKEN_LIMIT = 3000;
const CONTEXT_WINDOW = 200;
const MAX_SNIPPETS_PER_DOC = 3;
const CHARS_PER_TOKEN_CN = 1.5;
const CHARS_PER_TOKEN_EN = 4;

/** 清理 wiki 链接语法 */
function cleanWikiLinks(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, '$1');
}

// ============================================================
// Chat 变体：短文档全文 / 长文档片段（无 Wiki 词条）
// ============================================================

/**
 * 加载实体关联文档内容（chat 路径）
 *
 * 策略：
 * - 短文档（< 3000 token）：全文注入，保留完整上下文
 * - 长文档（≥ 3000 token）：提取实体关键字上下 ±200 token 的片段，
 *   每个文档最多取 3 个片段，重叠区间自动合并
 *
 * @returns docsContent（文档全文/片段），或 undefined
 */
export async function loadEntityDocsContent(
  structQuery: StructQueryPort,
  fileStore: DocumentFileStore,
  matchedKeywords: string[],
): Promise<{ docsContent: string } | undefined> {
  // 1. 查结构化数据库，获取关联文档列表
  if (!structQuery.isReady()) {
    console.warn('[Chat] 结构化数据库未就绪');
    return undefined;
  }

  // 多实体时优先用 AND 精准匹配（避免短词如 "ERP" 匹配到无关文档），
  // AND 无结果时降级为 OR
  const useAndFirst = matchedKeywords.length > 1;
  let structResults = await structQuery.query(matchedKeywords, useAndFirst ? 'and' : 'or');

  if (structResults.length === 0 && useAndFirst) {
    console.log(`[Chat] 结构化数据库 AND 查询未命中，降级 OR 查询...`);
    structResults = await structQuery.query(matchedKeywords, 'or');
  }

  if (structResults.length === 0) {
    console.log(`[Chat] 结构化数据库未查到 [${matchedKeywords.join(', ')}] 的关联文档`);
    return undefined;
  }

  console.log(`[Chat] 结构化数据库查询命中: [${matchedKeywords.join(', ')}]，${structResults.length} 条结果`);

  // 2. 收集所有关联文档名（去重）
  const docNames = new Set<string>();
  for (const r of structResults) {
    for (const chunk of r.chunks) {
      const docId = chunk.chunk_id.replace(/_\d+$/, '');
      if (docId.startsWith('raw_')) {
        docNames.add(docId.slice(4));
      }
    }
  }

  if (docNames.size === 0) return undefined;

  // 3. 读 Raw 文件，按策略注入
  const parts: string[] = [];
  let shortCount = 0;
  let snippetCount = 0;

  for (const docName of docNames) {
    const rawContent = fileStore.readRawDoc(docName);
    if (rawContent === null) {
      console.warn(`[Chat] Raw 文档不存在: ${docName}.md`);
      continue;
    }

    try {
      const content = cleanWikiLinks(rawContent);
      const docTokens = estimateTokens(content);

      if (docTokens < SHORT_DOC_TOKEN_LIMIT) {
        parts.push(`### ${docName}（全文，${docTokens} token）\n\n${content}`);
        shortCount++;
      } else {
        const snippets = extractEntitySnippets(
          content, docName, matchedKeywords,
          CONTEXT_WINDOW, MAX_SNIPPETS_PER_DOC,
          CHARS_PER_TOKEN_CN, CHARS_PER_TOKEN_EN,
        );
        if (snippets) {
          parts.push(snippets);
          snippetCount++;
        }
      }
    } catch (err) {
      console.warn(`[Chat] 读取 Raw 文档失败: ${docName}.md`, err);
    }
  }

  if (shortCount === 0 && snippetCount === 0) return undefined;

  console.log(
    `[Chat] 实体关联文档加载: ${shortCount} 篇全文 + ${snippetCount} 篇片段 (共 ${docNames.size} 篇)`,
  );

  return {
    docsContent: parts.join('\n\n---\n\n'),
  };
}

// ============================================================
// Eval 变体：Wiki 词条 + Raw 文档（AND/OR 双向降级）
// ============================================================

/**
 * 加载实体关联文档内容（eval 路径，完整策略）
 *
 * 与 chat 变体的差异：
 * - 额外加载关联的 Wiki 词条全文
 * - AND 未命中时会再尝试 OR，OR 未命中时也会尝试 AND
 *
 * @returns docsContent + sources（文档名列表），或 undefined
 */
export async function loadEntityDocsContentForEval(
  structQuery: StructQueryPort,
  fileStore: DocumentFileStore,
  matchedKeywords: string[],
): Promise<{ docsContent: string; sources: string[] } | undefined> {
  if (!structQuery.isReady()) {
    console.warn('[Eval] 结构化数据库未就绪');
    return undefined;
  }

  // 多实体时优先用 AND 精准匹配（避免短词如 "ERP" 匹配到无关文档），
  // AND 无结果时降级为 OR
  const useAndFirst = matchedKeywords.length > 1;
  let structResults = await structQuery.query(matchedKeywords, useAndFirst ? 'and' : 'or');

  const hasChunks = structResults.some(r => r.chunks.length > 0);

  if (!hasChunks && useAndFirst) {
    console.log(`[Eval] 结构化数据库 AND 查询未命中，降级 OR 查询...`);
    structResults = await structQuery.query(matchedKeywords, 'or');
  } else if (!hasChunks && !useAndFirst) {
    console.log(`[Eval] 结构化数据库 OR 查询未命中，尝试 AND 查询...`);
    structResults = await structQuery.query(matchedKeywords, 'and');
  }

  if (structResults.length === 0 || !structResults.some(r => r.chunks.length > 0)) {
    console.log(`[Eval] 结构化数据库未查到 [${matchedKeywords.join(', ')}] 的关联文档`);
    return undefined;
  }

  console.log(`[Eval] 结构化数据库查询命中: [${matchedKeywords.join(', ')}]，${structResults.length} 条结果`);

  const docNames = new Set<string>();
  const wikiEntries = new Map<string, string>();

  for (const r of structResults) {
    for (const chunk of r.chunks) {
      const docId = chunk.chunk_id.replace(/_\d+$/, '');
      if (docId.startsWith('raw_')) {
        docNames.add(docId.replace(/^raw_/, ''));
      } else if (docId.startsWith('wiki_')) {
        wikiEntries.set(r.entry.name, r.entry.path || '');
      }
    }
    if (r.entry.type === 'concept' && r.entry.path) {
      wikiEntries.set(r.entry.name, r.entry.path);
    }
  }

  const parts: string[] = [];
  let shortCount = 0;
  let snippetCount = 0;
  let wikiCount = 0;

  // Wiki 词条全文
  for (const [entryName, entryPath] of wikiEntries) {
    const content = fileStore.readWikiDoc(entryPath);
    if (content !== null) {
      try {
        parts.push(`### Wiki 词条：${entryName}\n\n${cleanWikiLinks(content)}`);
        wikiCount++;
      } catch (err) {
        console.warn(`[Eval] 读取 Wiki 词条失败: ${entryPath}`, err);
      }
    }
  }

  // Raw 文档（短文档全文 / 长文档片段）
  for (const docName of docNames) {
    const rawContent = fileStore.readRawDoc(docName);
    if (rawContent === null) continue;

    try {
      const content = cleanWikiLinks(rawContent);
      const docTokens = estimateTokens(content);

      if (docTokens < SHORT_DOC_TOKEN_LIMIT) {
        parts.push(`### ${docName}（全文，${docTokens} token）\n\n${content}`);
        shortCount++;
      } else {
        const snippets = extractEntitySnippets(
          content, docName, matchedKeywords,
          CONTEXT_WINDOW, MAX_SNIPPETS_PER_DOC,
          CHARS_PER_TOKEN_CN, CHARS_PER_TOKEN_EN,
        );
        if (snippets) {
          parts.push(snippets);
          snippetCount++;
        }
      }
    } catch (err) {
      console.warn(`[Eval] 读取 Raw 文档失败: ${docName}.md`, err);
    }
  }

  if (shortCount === 0 && snippetCount === 0 && wikiCount === 0) return undefined;

  console.log(
    `[Eval] 实体关联文档加载: ${wikiCount} 篇 Wiki + ${shortCount} 篇全文 + ${snippetCount} 篇片段`,
  );

  const sources = [...docNames, ...wikiEntries.keys()];

  return {
    docsContent: parts.join('\n\n---\n\n'),
    sources,
  };
}

// ============================================================
// docType 过滤（chat/eval 共用）
// ============================================================

/**
 * 根据文档类型过滤 chunk ID 列表
 * @param docTypes - LLM 推荐的文档类型列表
 * @returns 匹配的 chunkId 数组，如果 docTypes 为空则返回 null（不过滤）
 */
export function filterChunksByDocTypes(
  chunkStore: { getAll(): Map<string, { metadata: { docType?: string } }> },
  docTypes: string[],
  logPrefix: string = '[Chat]',
): string[] | null {
  if (!docTypes || docTypes.length === 0) return null;
  const allChunks = chunkStore.getAll();
  const filtered = [...allChunks.entries()]
    .filter(([_, chunk]) => chunk.metadata.docType && docTypes.includes(chunk.metadata.docType))
    .map(([chunkId]) => chunkId);
  console.log(`${logPrefix} docType 过滤: types=[${docTypes.join(',')}] → ${filtered.length} chunks`);
  return filtered.length > 0 ? filtered : null;
}
