// ============================================================
// structSearchEngine 导出可用性测试
//
// smartRouter.ts 兼容层已随 src/lib 分层迁移删除。
// 实际路由逻辑（LLM-first + 正则 fallback）的测试见 queryRewriter.test.ts。
// 结构化查询核心逻辑的测试见 structSearchEngine。
// ============================================================

import { describe, it, expect } from 'vitest';
import { executeStructuredQuery } from '@/infrastructure/struct/structSearchEngine';

describe('structSearchEngine 导出', () => {
  describe('导出可用性', () => {
    it('executeStructuredQuery 应正确导出', () => {
      expect(typeof executeStructuredQuery).toBe('function');
    });
  });
});
