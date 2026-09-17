// ============================================================
// queryRewriter - fallbackRoute 实体匹配降级测试
//
// 测试 fallbackRoute 函数：当 LLM 不可用时，返回实体匹配结果
// 检索路径仅两条：entity（命中实体）或 rrf（无实体命中时语义检索）
// ============================================================

import { describe, it, expect } from 'vitest';
import { fallbackRoute } from '@/application/search/queryRewriter';

describe('fallbackRoute', () => {
  describe('无匹配实体', () => {
    it('空实体列表应返回空 matchedEntries', () => {
      const result = fallbackRoute('微服务架构的核心设计原则是什么', []);
      expect(result.matchedEntries).toEqual([]);
      expect(result.reason).toContain('未匹配');
    });

    it('复杂查询无实体也应返回空', () => {
      const result = fallbackRoute('如何配置 Nginx 反向代理', []);
      expect(result.matchedEntries).toEqual([]);
    });
  });

  describe('有匹配实体', () => {
    it('单个实体应正确返回', () => {
      const result = fallbackRoute('国家电网', ['国家电网']);
      expect(result.matchedEntries).toEqual(['国家电网']);
      expect(result.reason).toContain('国家电网');
    });

    it('多个实体应正确返回', () => {
      const result = fallbackRoute('对比 MySQL 和 Redis', ['MySQL', 'Redis']);
      expect(result.matchedEntries).toEqual(['MySQL', 'Redis']);
      expect(result.reason).toContain('MySQL');
      expect(result.reason).toContain('Redis');
    });
  });

  describe('边界情况', () => {
    it('空查询无实体', () => {
      const result = fallbackRoute('', []);
      expect(result.matchedEntries).toEqual([]);
    });

    it('纯数字 query 无实体', () => {
      const result = fallbackRoute('12345', []);
      expect(result.matchedEntries).toEqual([]);
    });

    it('特殊字符 query 无实体', () => {
      const result = fallbackRoute('@#$%', []);
      expect(result.matchedEntries).toEqual([]);
    });
  });

  describe('返回类型校验', () => {
    it('应包含 matchedEntries 和 reason 两个字段且 matchedEntries 为数组', () => {
      const result = fallbackRoute('测试查询', ['测试']);
      expect(result).toHaveProperty('matchedEntries');
      expect(result).toHaveProperty('reason');
      expect(Array.isArray(result.matchedEntries)).toBe(true);
    });
  });
});
