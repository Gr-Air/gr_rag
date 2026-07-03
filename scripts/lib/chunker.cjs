// ============================================================
// 统一文档分块器（CommonJS）
// 供 clean-and-chunk.cjs / buildIndex.cjs / buildIncremental.cjs 共用
//
// 分块策略（v2 — 表格感知）：
//   1. 按 ## 标题粗切为 sections
//   2. 在每个 section 内按段落/句子边界细切
//      ★ 表格行（| 开头）作为一个不可分割单元，不被句子切分打断
//   3. 将单元合并为 chunk（MIN~MAX 大小，带重叠）
//      ★ 大表格（> MAX）单独成 chunk
//   4. 跨 section 全局统一 chunkIndex
//   5. 合并过短的相邻 chunk
//   6. 记录 sectionTitle（所属 ## 标题）
// ============================================================

/**
 * 提取文档中所有 [[wikiLinks]]
 * @param {string} content
 * @returns {string[]}
 */
function extractWikiLinks(content) {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) links.add(match[1].trim());
  return [...links];
}

/**
 * 解析 Raw 文件名元数据
 * 格式：{客户}_{项目系统}_{文档类型}_{日期}.md
 * @param {string} filename
 * @returns {{ client: string, project: string, docType: string, date: string }}
 */
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

/**
 * 从文档内容中提取标题
 * @param {string} content - 文档原始内容
 * @param {string} filename - 文件名（作为降级标题）
 * @returns {string}
 */
function extractTitle(content, filename) {
  const firstLine = content.split('\n')[0]?.trim() || '';
  if (firstLine.startsWith('# ')) {
    return firstLine.replace(/^#\s+/, '').trim();
  }
  // 排除表格头、分隔线、空行等非标题内容
  if (firstLine.startsWith('|') || firstLine.startsWith('---') || firstLine.startsWith('###') || !firstLine) {
    const h1Match = content.match(/^# (.+)$/m);
    return h1Match ? h1Match[1].trim() : filename;
  }
  return firstLine.replace(/^#\s+/, '').trim() || filename;
}

// ============================================================
// 表格感知辅助函数
// ============================================================

/**
 * 判断一行是否为 markdown 表格行
 * @param {string} line
 * @returns {boolean}
 */
function isTableLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

/**
 * 判断一段文本是否为完整的表格（所有非空行都是表格行，至少 2 行）
 * @param {string} text
 * @returns {boolean}
 */
function isTableBlock(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return false;
  return lines.every(l => isTableLine(l));
}

/**
 * 判断表格是否包含"合计"行（用于判断表格是否完整结束）
 * @param {string} tableText
 * @returns {boolean}
 */
function hasTotalRow(tableText) {
  return /合计|小计|总计/.test(tableText);
}

/**
 * 将 section 内容按段落切分，表格作为一个不可分割的段落保留
 * 表格内的空行不中断表格（处理生成文档中表格中间有空行的情况）
 * @param {string} sectionText - 一个 section 的文本
 * @returns {string[]} 段落数组
 */
function splitParagraphsTableAware(sectionText) {
  const lines = sectionText.split('\n');
  const paragraphs = [];
  let currentPara = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTbl = isTableLine(line);

    if (isTbl) {
      // 进入或继续表格
      inTable = true;
      currentPara.push(line);
    } else if (inTable && line.trim() === '') {
      // 表格内遇到空行：检查后续非空行是否还是表格行
      // 如果是，则空行属于表格内部，不中断表格
      let nextNonEmptyIdx = i + 1;
      while (nextNonEmptyIdx < lines.length && lines[nextNonEmptyIdx].trim() === '') {
        nextNonEmptyIdx++;
      }
      if (nextNonEmptyIdx < lines.length && isTableLine(lines[nextNonEmptyIdx])) {
        // 下一行还是表格行，空行属于表格内部
        currentPara.push(line);
      } else {
        // 表格真正结束
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join('\n'));
          currentPara = [];
        }
        inTable = false;
      }
    } else {
      if (inTable) {
        // 表格结束
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join('\n'));
          currentPara = [];
        }
        inTable = false;
      }

      // 空行 = 段落分隔
      if (line.trim() === '') {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join('\n'));
          currentPara = [];
        }
      } else {
        currentPara.push(line);
      }
    }
  }

  // 处理最后一段
  if (currentPara.length > 0) {
    paragraphs.push(currentPara.join('\n'));
  }

  return paragraphs.filter(p => p.trim().length > 0);
}

/**
 * 从段落中提取 section 标题
 * @param {string} sectionText
 * @returns {string}
 */
function extractSectionTitle(sectionText) {
  const firstLine = sectionText.split('\n')[0]?.trim() || '';
  if (firstLine.startsWith('## ')) {
    return firstLine.replace(/^##\s+/, '').trim();
  }
  return '';
}

/**
 * 语义分块（表格感知版）：按句子边界切分文档
 *
 * @param {string} content - 文档内容
 * @param {string} docId - 文档 ID（如 raw_xxx）
 * @param {string} docTitle - 文档标题
 * @param {string} docPath - 文档路径（如 Raw/xxx.md）
 * @param {{ client: string, project: string, docType: string, date: string }} metadata
 * @param {object} [options]
 * @param {number} [options.minChunkSize=200] - 最小 chunk 大小
 * @param {number} [options.maxChunkSize=1000] - 最大 chunk 大小
 * @returns {Array<{ id: string, docId: string, docTitle: string, docPath: string, chunkIndex: number, content: string, metadata: object, wikiLinks: string[], parentDocId: string, sectionTitle?: string }>}
 */
function chunkDocument(content, docId, docTitle, docPath, metadata, options) {
  const MIN_CHUNK_SIZE = options?.minChunkSize ?? 200;
  const MAX_CHUNK_SIZE = options?.maxChunkSize ?? 1000;
  const parentDocId = `parent_${docId}`;

  // Step 1: 按 ## 标题粗切
  const sections = content.split(/(?=^## )/m);

  // 收集所有"分块单元"：每个单元是 { text, isTable, sectionTitle }
  const units = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const sectionTitle = extractSectionTitle(trimmed);

    // 表格感知段落切分
    const paragraphs = splitParagraphsTableAware(trimmed);

    for (const para of paragraphs) {
      if (isTableBlock(para)) {
        // 表格作为一个整体单元
        units.push({ text: para, isTable: true, sectionTitle });
      } else {
        // 非表格段落：按句子边界细切
        const parts = para.split(/(?<=[。！？])\s*|(?<=\.)\s+(?=[A-Z])|(?<=[!?])\s+(?=[A-Z])/);
        for (const part of parts) {
          const s = part.trim();
          if (s.length > 0) {
            units.push({ text: s, isTable: false, sectionTitle });
          }
        }
      }
    }
  }

  if (units.length === 0) {
    // 降级：按固定大小切分
    const chunks = [];
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
    return chunks;
  }

  // Step 2: 将单元合并为 chunk
  const chunks = [];
  let currentChunk = '';
  let currentSectionTitle = '';
  let chunkIdx = 0;
  const OVERLAP_CHARS = Math.round((MIN_CHUNK_SIZE + MAX_CHUNK_SIZE) / 2 * 0.1);

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];

    // 记录 chunk 的 sectionTitle（取第一个单元的）
    if (currentChunk.length === 0) {
      currentSectionTitle = unit.sectionTitle;
    }

    // 大表格单独成 chunk
    if (unit.isTable && unit.text.length > MAX_CHUNK_SIZE) {
      // 先把当前积累的内容保存
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
          sectionTitle: currentSectionTitle,
        });
        chunkIdx++;
        currentChunk = '';
      }

      // 大表格作为独立 chunk
      chunks.push({
        id: `${docId}_${chunkIdx}`,
        docId,
        docTitle,
        docPath,
        chunkIndex: chunkIdx,
        content: unit.text,
        metadata,
        wikiLinks: extractWikiLinks(unit.text),
        parentDocId,
        sectionTitle: unit.sectionTitle,
      });
      chunkIdx++;
      continue;
    }

    // 检查加入当前单元是否会超出上限
    if (currentChunk.length + unit.text.length > MAX_CHUNK_SIZE && currentChunk.length >= MIN_CHUNK_SIZE) {
      // 保存当前 chunk
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
        sectionTitle: currentSectionTitle,
      });
      chunkIdx++;

      // 重叠：从上一个 chunk 末尾往前取完整单元
      let overlapChars = 0;
      let overlapIdx = i;
      while (overlapIdx > 0 && overlapChars < OVERLAP_CHARS) {
        overlapIdx--;
        overlapChars += units[overlapIdx].text.length;
      }
      // 重叠时不跨表格（避免表格被重叠切碎）
      const overlapUnits = units.slice(overlapIdx, i).filter(u => !u.isTable);
      currentChunk = overlapUnits.map(u => u.text).join('\n') + '\n' + unit.text + '\n';
      currentSectionTitle = unit.sectionTitle;
    } else {
      currentChunk += unit.text + '\n';
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
      sectionTitle: currentSectionTitle,
    });
    chunkIdx++;
  }

  // Step 3: 合并过短的相邻 chunk
  const mergedChunks = [];
  for (const chunk of chunks) {
    const last = mergedChunks[mergedChunks.length - 1];
    if (last && (last.content.length < MIN_CHUNK_SIZE || chunk.content.length < MIN_CHUNK_SIZE)) {
      last.content = last.content + '\n\n' + chunk.content;
      last.wikiLinks = [...new Set([...last.wikiLinks, ...chunk.wikiLinks])];
    } else {
      mergedChunks.push({ ...chunk });
    }
  }

  // 重新编号 chunkIndex（合并后可能有空缺）
  for (let i = 0; i < mergedChunks.length; i++) {
    mergedChunks[i].chunkIndex = i;
  }

  return mergedChunks;
}

/**
 * 构建 Wiki 词条的 chunk 对象（v2 — 保留正文内容）
 * @param {string} name - 词条名
 * @param {'concept'|'entity'} type - 词条类型
 * @param {string} file - 文件路径（如 Wiki/entity/xxx.md）
 * @param {string} content - 文件原始内容
 * @returns {{ id: string, docId: string, docTitle: string, docPath: string, chunkIndex: number, content: string, metadata: object, wikiLinks: string[], parentDocId: undefined }}
 */
function buildWikiChunk(name, type, file, content) {
  const sub = file.includes('/entity/') ? 'entity' : 'concept';
  const freqMatch = content.match(/出现频次:\s*(\d+)/);
  const freq = freqMatch ? parseInt(freqMatch[1]) : 0;

  // 清洗内容：去除频次行，保留实际内容
  let body = content.replace(/\r\n/g, '\n');
  body = body.replace(/^出现频次:\s*\d+\s*$/m, '');
  body = body.trim();
  body = body.replace(/\n{3,}/g, '\n\n');

  // 如果清洗后没有实质内容，降级为只保留标题和频次
  const hasBody = body.length > 0 && body !== `# ${name}`;
  const text = hasBody
    ? `# ${name}\n${body}`
    : `# ${name}\n${sub === 'concept' ? '概念' : '实体'} | 出现频次: ${freq}`;

  return {
    id: `wiki_${name}`,
    docId: `wiki_${name}`,
    docTitle: name,
    docPath: file,
    chunkIndex: 0,
    content: text,
    metadata: { client: '', project: '', docType: sub === 'concept' ? '概念' : '实体', date: '' },
    wikiLinks: [name],
    parentDocId: undefined,
  };
}

module.exports = {
  extractWikiLinks,
  parseFilename,
  extractTitle,
  chunkDocument,
  buildWikiChunk,
  // 导出表格感知辅助函数（供测试/调试）
  isTableLine,
  isTableBlock,
  splitParagraphsTableAware,
};
