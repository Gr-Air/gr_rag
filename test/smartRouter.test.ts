// ============================================================
// smartRouter - 兼容层测试
//
// smartRouter.ts 已精简为纯 re-export 兼容层。
// 实际路由逻辑（LLM-first + 正则 fallback）的测试见 queryRewriter.test.ts。
// 结构化查询工具函数的测试见 structSearchEngine。
// ============================================================

import { describe, it, expect } from 'vitest';
import { executeStructuredQuery } from '@/lib/smartRouter';

describe('smartRouter 兼容层', () => {
  describe('re-export 可用性', () => {
    it('executeStructuredQuery 应从 structSearchEngine 正确导出', () => {
      expect(typeof executeStructuredQuery).toBe('function');
    });
  });
});
