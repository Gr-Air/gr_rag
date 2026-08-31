// ============================================================
// chunker 测试用例（表格感知版）
// 测试 scripts/lib/chunker.cjs 的分块逻辑
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  chunkDocument,
  extractWikiLinks,
  parseFilename,
  extractTitle,
  isTableLine,
  isTableBlock,
  splitParagraphsTableAware,
} from '../scripts/lib/chunker.cjs';

const META = { client: '测试客户', project: '测试项目', docType: '技术方案', date: '20240101' };

// ============================================================
// 表格感知辅助函数
// ============================================================

describe('isTableLine', () => {
  it('识别标准表格行', () => {
    expect(isTableLine('| 列1 | 列2 |')).toBe(true);
    expect(isTableLine('|---|---|')).toBe(true);
    expect(isTableLine('| 合计 | 100 |')).toBe(true);
  });

  it('非表格行返回 false', () => {
    expect(isTableLine('普通文本')).toBe(false);
    expect(isTableLine('# 标题')).toBe(false);
    expect(isTableLine('')).toBe(false);
    expect(isTableLine('| 不完整')).toBe(false);
  });

  it('trim 后判断', () => {
    expect(isTableLine('  | 列1 | 列2 |  ')).toBe(true);
  });
});

describe('isTableBlock', () => {
  it('多行表格返回 true', () => {
    const table = '| 列1 | 列2 |\n|---|---|\n| 值1 | 值2 |';
    expect(isTableBlock(table)).toBe(true);
  });

  it('单行返回 false（至少需要 2 行）', () => {
    expect(isTableBlock('| 单行 |')).toBe(false);
  });

  it('非表格文本返回 false', () => {
    expect(isTableBlock('普通段落\n第二行')).toBe(false);
  });
});

describe('splitParagraphsTableAware', () => {
  it('表格作为一个段落保留', () => {
    const text = '说明文字\n\n| 列1 | 列2 |\n|---|---|\n| 值1 | 值2 |\n\n后续文字';
    const paras = splitParagraphsTableAware(text);
    expect(paras.length).toBe(3);
    expect(isTableBlock(paras[1])).toBe(true);
  });

  it('表格内空行不中断表格（50行大表格场景）', () => {
    // 模拟生成文档中表格中间有空行的情况
    const text = '| 列1 | 列2 |\n|---|---|\n| 值1 | 值2 |\n\n| 值3 | 值4 |\n| 合计 | 100 |';
    const paras = splitParagraphsTableAware(text);
    // 空行后还是表格行，应该合并为一个表格段落
    expect(paras.length).toBe(1);
    expect(isTableBlock(paras[0])).toBe(true);
    expect(paras[0]).toContain('合计');
  });

  it('表格与表格之间用非表格行分隔时各自独立', () => {
    const text = '| A1 | A2 |\n|---|---|\n| 1 | 2 |\n\n说明文字\n\n| B1 | B2 |\n|---|---|\n| 3 | 4 |';
    const paras = splitParagraphsTableAware(text);
    expect(paras.length).toBe(3);
    expect(isTableBlock(paras[0])).toBe(true);
    expect(isTableBlock(paras[1])).toBe(false);
    expect(isTableBlock(paras[2])).toBe(true);
  });
});

// ============================================================
// chunkDocument 表格感知
// ============================================================

describe('chunkDocument 表格感知', () => {
  it('表格不应被从中间切断', () => {
    const content = `# 测试文档

## 1. 表格章节

| 序号 | 名称 | 金额 | 备注 |
|------|------|------|------|
| 1 | 项目A | 1,000,000.00 | 测试备注1 |
| 2 | 项目B | 2,000,000.00 | 测试备注2 |
| 3 | 项目C | 3,000,000.00 | 测试备注3 |
| 合计 | - | 6,000,000.00 | - |

## 2. 后续章节

这是后续章节的正文内容，用于测试表格是否被完整保留。
需要足够的文字来确保分块器在表格之后产生新的 chunk。`;
    const chunks = chunkDocument(content, 'test_doc', '测试文档', 'test.md', META);

    const tableChunks = chunks.filter(c => c.content.includes('| 序号'));
    expect(tableChunks.length).toBe(1);
    expect(tableChunks[0].content).toContain('合计');
    expect(tableChunks[0].content).toContain('6,000,000.00');
  });

  it('大表格单独成 chunk', () => {
    let tableRows = '| 序号 | 名称 | 金额 | 描述 |\n|------|------|------|------|\n';
    for (let i = 1; i <= 30; i++) {
      tableRows += `| ${i} | 项目${i} | ${i * 1000}.00 | 这是一个很长的描述用于测试大表格单独成chunk的场景描述描述描述 |\n`;
    }

    const content = `# 测试文档\n\n## 大表格\n${tableRows}\n## 后续\n后续文字内容。`;
    const chunks = chunkDocument(content, 'test_big', '测试', 'test.md', META, { minChunkSize: 200, maxChunkSize: 500 });

    const tableChunk = chunks.find(c => c.content.includes('| 序号'));
    expect(tableChunk).toBeDefined();
    expect(tableChunk!.content.includes('| 1 |')).toBe(true);
    expect(tableChunk!.content.includes('| 30 |')).toBe(true);
  });

  it('相邻 chunk 之间不应有表格被拆开', () => {
    const content = `# 文档

## 1. 应收
| 序号 | 金额 |
|------|------|
| 1 | 100 |
| 2 | 200 |
| 合计 | 300 |

## 2. 应付
| 序号 | 金额 |
|------|------|
| 1 | 50 |
| 2 | 75 |
| 合计 | 125 |

## 3. 说明
这是一段说明文字，确保产生足够的 chunk 来验证表格完整性。`;

    const chunks = chunkDocument(content, 'test_split', '测试', 'test.md', META);

    for (let i = 0; i < chunks.length - 1; i++) {
      const curLastLine = chunks[i].content.split('\n').pop().trim();
      const nextFirstLine = chunks[i + 1].content.split('\n')[0].trim();

      const curIsTable = curLastLine.startsWith('|') && curLastLine.endsWith('|');
      const nextIsTable = nextFirstLine.startsWith('|') && nextFirstLine.endsWith('|');
      expect(curIsTable && nextIsTable).toBe(false);
    }
  });

  it('chunk 应包含 sectionTitle', () => {
    // 构造足够长的文本，确保产生多个 chunk
    const longText1 = '这是项目背景的详细描述文字内容。'.repeat(40);
    const longText2 = '这是技术方案的详细描述文字内容。'.repeat(40);
    const content = `# 文档

## 1. 项目背景

${longText1}

## 2. 技术方案

${longText2}`;

    const chunks = chunkDocument(content, 'test_section', '测试', 'test.md', META);
    expect(chunks.length).toBeGreaterThan(1);

    // 至少有一个 chunk 应该有非空 sectionTitle（第二个 chunk 会记录 "2. 技术方案"）
    const chunksWithTitle = chunks.filter(c => c.sectionTitle && c.sectionTitle.length > 0);
    expect(chunksWithTitle.length).toBeGreaterThan(0);

    // 包含"技术方案"section 的 chunk 应该记录了 sectionTitle
    const techChunk = chunks.find(c => c.sectionTitle && c.sectionTitle.includes('技术方案'));
    expect(techChunk).toBeDefined();
  });
});

// ============================================================
// chunkDocument 基本逻辑（向后兼容）
// ============================================================

describe('chunkDocument 基本逻辑', () => {
  it('按 ## 标题切分', () => {
    const content = `# 标题

## 第一节
内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一。

## 第二节
内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二。`;
    const chunks = chunkDocument(content, 'test_basic', '标题', 'test.md', META);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    chunks.forEach(c => {
      expect(c.id).toMatch(/^test_basic_\d+$/);
      expect(c.docId).toBe('test_basic');
      expect(c.parentDocId).toBe('parent_test_basic');
      expect(c.metadata).toEqual(META);
    });
  });

  it('合并过短的相邻 chunk', () => {
    const content = `# 标题

## 1
短内容。

## 2
短内容。

## 3
短内容。`;
    const chunks = chunkDocument(content, 'test_merge', '标题', 'test.md', META, { minChunkSize: 200 });
    expect(chunks.length).toBeLessThan(4);
  });

  it('chunkIndex 连续编号', () => {
    const content = `# 标题\n\n## 1\n${'内容'.repeat(100)}\n\n## 2\n${'内容'.repeat(100)}\n\n## 3\n${'内容'.repeat(100)}`;
    const chunks = chunkDocument(content, 'test_idx', '标题', 'test.md', META);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it('空内容返回空数组', () => {
    const chunks = chunkDocument('', 'test_empty', '标题', 'test.md', META);
    expect(chunks).toEqual([]);
  });

  it('wikiLinks 正确提取', () => {
    const content = '# 标题\n\n## 1\n这是包含 [[链接1]] 和 [[链接2]] 的文本内容，需要足够长来形成 chunk。';
    const chunks = chunkDocument(content, 'test_wiki', '标题', 'test.md', META);
    const allLinks = chunks.flatMap(c => c.wikiLinks);
    expect(allLinks).toContain('链接1');
    expect(allLinks).toContain('链接2');
  });
});

// ============================================================
// 辅助函数
// ============================================================

describe('extractWikiLinks', () => {
  it('提取所有 [[wikiLinks]] 并去重', () => {
    const content = '文本包含 [[链接1]] 和 [[链接2]] 以及 [[链接1]]';
    const links = extractWikiLinks(content);
    expect(links).toHaveLength(2);
    expect(links).toContain('链接1');
    expect(links).toContain('链接2');
  });

  it('无链接返回空数组', () => {
    expect(extractWikiLinks('普通文本')).toEqual([]);
  });
});

describe('parseFilename', () => {
  it('正确解析标准文件名', () => {
    const meta = parseFilename('中信证券_数据中台_来往账目_20250407.md');
    expect(meta.client).toBe('中信证券');
    expect(meta.project).toBe('数据中台');
    expect(meta.docType).toBe('来往账目');
    expect(meta.date).toBe('20250407');
  });

  it('客户名含下划线时正确解析', () => {
    const meta = parseFilename('中国_建筑_数字孪生_技术方案_20240926.md');
    expect(meta.client).toBe('中国_建筑');
    expect(meta.project).toBe('数字孪生');
    expect(meta.docType).toBe('技术方案');
    expect(meta.date).toBe('20240926');
  });

  it('不足 4 段时返回空值', () => {
    const meta = parseFilename('短文件名.md');
    expect(meta.client).toBe('');
    expect(meta.project).toBe('');
  });
});

describe('extractTitle', () => {
  it('从 # 标题提取', () => {
    expect(extractTitle('# 项目技术方案\n正文', 'fallback.md')).toBe('项目技术方案');
  });

  it('首行非标题时降级查找', () => {
    const content = '---\n分隔线\n\n# 真正的标题\n正文';
    const title = extractTitle(content, 'fallback.md');
    expect(title).toBe('真正的标题');
  });

  it('无 # 标题时返回首行或文件名', () => {
    // extractTitle 对非标题首行：返回首行本身（现有行为）
    const title = extractTitle('只有正文没有标题', 'fallback.md');
    expect(typeof title).toBe('string');
    expect(title.length).toBeGreaterThan(0);
  });
});
