// ============================================================
// tokenizer 测试用例
// 策略：mock @node-rs/jieba 的 cut() 方法，
// 专注验证 tokenize 自身的过滤/去重/去空白逻辑
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock jieba cut 方法
const mockCut = vi.fn();
vi.mock('@node-rs/jieba', () => ({
  Jieba: {
    withDict: vi.fn(() => ({
      cut: mockCut,
    })),
  },
}));
vi.mock('@node-rs/jieba/dict', () => ({
  dict: Buffer.from('mock dict'),
}));

import { tokenize, createTokenizer } from '@/infrastructure/tokenizer/tokenizer';

describe('tokenize', () => {
  beforeEach(() => {
    mockCut.mockReset();
  });

  describe('基本分词', () => {
    it('应返回去重后的分词结果', () => {
      mockCut.mockReturnValue(['微服务', '架构', '微服务', '设计']);

      const result = tokenize('微服务架构设计');

      expect(result).toHaveLength(3);
      expect(result).toContain('微服务');
      expect(result).toContain('架构');
      expect(result).toContain('设计');
    });

    it('应过滤空字符串', () => {
      mockCut.mockReturnValue(['微服务', '', '  ', '架构']);

      const result = tokenize('微服务 架构');

      // 空串和纯空格被过滤
      expect(result).toContain('微服务');
      expect(result).toContain('架构');
      expect(result).not.toContain('');
      expect(result).not.toContain('  ');
    });

    it('应过滤空白 token 但保留 trim 后有效的内容', () => {
      mockCut.mockReturnValue(['  微服务  ', ' 架构 ', '   ']);

      const result = tokenize('微服务 架构');

      expect(result).toHaveLength(2);
      // trim 后保存
      expect(result.some(t => t.includes('微服务'))).toBe(true);
      expect(result.some(t => t.includes('架构'))).toBe(true);
    });
  });

  describe('去重逻辑', () => {
    it('重复 token 只保留一个', () => {
      mockCut.mockReturnValue(['Redis', 'Redis', 'Redis', '缓存']);

      const result = tokenize('Redis Redis Redis 缓存');

      expect(result).toHaveLength(2);
      expect(result).toContain('Redis');
      expect(result).toContain('缓存');
    });

    it('不同空白量的 token trim 后相同应去重', () => {
      mockCut.mockReturnValue(['微服务', ' 微服务', '微服务 ', ' 微服务 ']);

      const result = tokenize('微服务 微服务 微服务 微服务');

      // trim 后都是 '微服务'，去重后只剩 1 个
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('微服务');
    });
  });

  describe('边界情况', () => {
    it('空字符串返回空数组', () => {
      mockCut.mockReturnValue([]);

      const result = tokenize('');

      expect(result).toEqual([]);
    });

    it('所有 token 都是空白时返回空数组', () => {
      mockCut.mockReturnValue(['', ' ', '  ', '\t', '\n']);

      const result = tokenize('     ');

      expect(result).toEqual([]);
    });

    it('单字 token 应保留（jieba 已分词，不过滤单字）', () => {
      mockCut.mockReturnValue(['我', '爱', '北京']);

      const result = tokenize('我爱北京');

      expect(result).toHaveLength(3);
      expect(result).toContain('我');
      expect(result).toContain('爱');
    });

    it('混合中英文 token', () => {
      mockCut.mockReturnValue(['Docker', 'Kubernetes', '部署', '方案']);

      const result = tokenize('Docker Kubernetes 部署方案');

      expect(result).toHaveLength(4);
      expect(result).toContain('Docker');
      expect(result).toContain('Kubernetes');
      expect(result).toContain('部署');
      expect(result).toContain('方案');
    });

    it('特殊字符 token', () => {
      mockCut.mockReturnValue(['C++', 'C#', '开发']);

      const result = tokenize('C++ C# 开发');

      expect(result).toHaveLength(3);
      expect(result).toContain('C++');
      expect(result).toContain('C#');
    });
  });
});

describe('createTokenizer', () => {
  beforeEach(() => {
    mockCut.mockReset();
  });

  it('返回一个可复用的分词函数', () => {
    mockCut.mockReturnValue(['微服务', '架构']);

    const tokenizerFn = createTokenizer();

    const result1 = tokenizerFn('微服务架构');
    const result2 = tokenizerFn('Docker 部署');

    expect(result1).toHaveLength(2);
    expect(result2).toHaveLength(2);
    expect(mockCut).toHaveBeenCalledTimes(2);
  });

  it('复用同一个 jieba 实例', () => {
    mockCut
      .mockReturnValueOnce(['Redis', '缓存'])
      .mockReturnValueOnce(['MySQL', '数据库']);

    const tokenizerFn = createTokenizer();

    const r1 = tokenizerFn('Redis 缓存');
    const r2 = tokenizerFn('MySQL 数据库');

    expect(r1).toEqual(['Redis', '缓存']);
    expect(r2).toEqual(['MySQL', '数据库']);
  });

  it('同样去重和过滤空白', () => {
    mockCut.mockReturnValue(['微服务', '', '微服务', '   ']);

    const tokenizerFn = createTokenizer();
    const result = tokenizerFn('微服务 微服务');

    expect(result).toHaveLength(1);
    expect(result[0]).toBe('微服务');
  });
});
