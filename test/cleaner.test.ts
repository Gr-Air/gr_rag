// ============================================================
// cleaner 测试用例
// 测试 scripts/lib/cleaner.cjs 的文档清洗逻辑
// ============================================================

import { describe, it, expect } from 'vitest';
import { cleanDocument, cleanWikiContent } from '../scripts/lib/cleaner.cjs';

describe('cleanDocument', () => {
  describe('BOM 去除', () => {
    it('应去除文件开头的 BOM 字符', () => {
      const input = '\uFEFF# 标题\n正文内容';
      const result = cleanDocument(input);
      expect(result.content.startsWith('\uFEFF')).toBe(false);
      expect(result.content.startsWith('#')).toBe(true);
    });

    it('应去除零宽字符', () => {
      const input = 'Hello\u200BWorld\u200C\u200D';
      const result = cleanDocument(input);
      expect(result.content).toBe('HelloWorld');
    });

    it('应去除控制字符（保留换行和制表符）', () => {
      const input = '文本\x00\x07内容\x1F';
      const result = cleanDocument(input);
      expect(result.content).toBe('文本内容');
    });
  });

  describe('YAML front matter', () => {
    it('应去除 YAML front matter 块', () => {
      const input = '---\ntitle: 测试文档\nauthor: 张三\n---\n# 正文标题\n内容';
      const result = cleanDocument(input);
      expect(result.content.startsWith('---')).toBe(false);
      expect(result.content.startsWith('# 正文标题')).toBe(true);
    });

    it('无 YAML front matter 时不应误删', () => {
      const input = '# 标题\n---\n分隔线后的内容';
      const result = cleanDocument(input);
      expect(result.content).toContain('# 标题');
      expect(result.content).toContain('分隔线后的内容');
    });
  });

  describe('HTML 注释', () => {
    it('应去除 HTML 注释', () => {
      const input = '# 标题\n<!-- 这是注释 -->\n正文';
      const result = cleanDocument(input);
      expect(result.content).not.toContain('<!--');
      expect(result.content).not.toContain('这是注释');
    });

    it('应去除多行 HTML 注释', () => {
      const input = '# 标题\n<!--\n多行注释\n第二行\n-->\n正文';
      const result = cleanDocument(input);
      expect(result.content).not.toContain('多行注释');
    });
  });

  describe('空行规范化', () => {
    it('连续 3+ 空行合并为 2 行', () => {
      const input = '段落一\n\n\n\n\n段落二';
      const result = cleanDocument(input);
      expect(result.content).toBe('段落一\n\n段落二');
    });

    it('应去除首尾空行', () => {
      const input = '\n\n\n# 标题\n正文\n\n\n';
      const result = cleanDocument(input);
      expect(result.content.startsWith('#')).toBe(true);
      expect(result.content.endsWith('正文')).toBe(true);
    });

    it('Windows 换行符统一为 Unix', () => {
      const input = '行一\r\n行二\r\n行三';
      const result = cleanDocument(input);
      expect(result.content).not.toContain('\r\n');
      expect(result.content).toBe('行一\n行二\n行三');
    });
  });

  describe('全角半角纠正', () => {
    it('全角斜杠转半角', () => {
      const input = '路径／文件名';
      const result = cleanDocument(input, { normalizePunctuation: true });
      expect(result.content).toContain('/');
      expect(result.content).not.toContain('／');
    });
  });

  describe('清洗统计', () => {
    it('应正确计算 originalLength 和 cleanedLength', () => {
      const input = '\uFEFF# 标题\n\n\n\n内容';
      const result = cleanDocument(input);
      expect(result.originalLength).toBe(input.length);
      expect(result.cleanedLength).toBe(result.content.length);
      expect(result.cleanedLength).toBeLessThan(result.originalLength);
    });

    it('应计算 cleaningRatio', () => {
      const input = '\uFEFF\u200B\u200B\u200B# 标题'; // 大量不可见字符
      const result = cleanDocument(input);
      expect(result.cleaningRatio).toBeGreaterThan(0);
      expect(result.cleaningRatio).toBeLessThanOrEqual(1);
    });

    it('清洗损失超过 20% 应告警', () => {
      const input = '\uFEFF' + '\u200B'.repeat(100) + '短';
      const result = cleanDocument(input);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w: string) => w.includes('cleaning ratio'))).toBe(true);
    });
  });

  describe('选项控制', () => {
    it('stripFrontMatter=false 时保留 YAML', () => {
      const input = '---\ntitle: test\n---\n# 正文';
      const result = cleanDocument(input, { stripFrontMatter: false });
      expect(result.content).toContain('---');
      expect(result.content).toContain('title: test');
    });

    it('normalizeBlankLines=false 时不合并空行', () => {
      const input = 'a\n\n\n\nb';
      const result = cleanDocument(input, { normalizeBlankLines: false });
      expect(result.content).toBe('a\n\n\n\nb');
    });
  });

  describe('边界情况', () => {
    it('空字符串返回空字符串', () => {
      const result = cleanDocument('');
      expect(result.content).toBe('');
      expect(result.originalLength).toBe(0);
    });

    it('无需清洗的内容返回原样', () => {
      const input = '# 标题\n\n正文段落';
      const result = cleanDocument(input);
      expect(result.content).toBe(input);
      expect(result.cleaningRatio).toBe(0);
    });
  });
});

describe('cleanWikiContent', () => {
  it('应去除"出现频次"行', () => {
    const input = '出现频次: 42\n这是概念描述';
    const result = cleanWikiContent(input);
    expect(result).not.toContain('出现频次');
    expect(result).toContain('概念描述');
  });

  it('应规范化空行', () => {
    const input = '出现频次: 5\n\n\n\n正文';
    const result = cleanWikiContent(input);
    expect(result).not.toContain('\n\n\n');
  });

  it('应去除首尾空白', () => {
    const input = '\n\n出现频次: 5\n正文\n\n';
    const result = cleanWikiContent(input);
    expect(result.startsWith('正文')).toBe(true);
  });
});
