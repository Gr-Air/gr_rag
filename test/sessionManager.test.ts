// ============================================================
// sessionManager 测试用例
// 测试会话创建/管理/追问检测/上下文压缩等逻辑
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn(),
}));

import {
  createSession,
  getOrCreateSession,
  getSession,
  addMessage,
  saveLastSearchResults,
  getLastSearchResults,
  isFollowUpQuery,
  getConversationContext,
  deleteSession,
  getActiveSessionCount,
  clearAllSessions,
} from '@/application/chat/sessionManager';
import type { DocChunk } from '@/domain/document/types';
import type { SearchResult } from '@/domain/search/types';

function makeChunk(id: string): DocChunk {
  return {
    id,
    docId: `doc_${id}`,
    docTitle: 'Test',
    docPath: `Raw/doc_${id}.md`,
    chunkIndex: 0,
    content: 'test',
    metadata: {},
    wikiLinks: [],
  };
}

describe('sessionManager', () => {
  beforeEach(() => {
    clearAllSessions();
  });

  describe('createSession', () => {
    it('应创建唯一 ID 的会话', () => {
      const s1 = createSession();
      const s2 = createSession();

      expect(s1.id).not.toBe(s2.id);
      expect(s1.id).toMatch(/^sess_/);
    });

    it('会话应包含默认字段', () => {
      const session = createSession();

      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBeGreaterThan(0);
    });

    it('新创建的会话应可通过 getSession 获取', () => {
      const session = createSession();
      const retrieved = getSession(session.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(session.id);
    });
  });

  describe('getOrCreateSession', () => {
    it('已存在的 sessionId 应返回已有会话', () => {
      const session = createSession();
      const result = getOrCreateSession(session.id);

      expect(result.id).toBe(session.id);
    });

    it('不存在的 sessionId 应创建新会话', () => {
      const result = getOrCreateSession('nonexistent');

      expect(result).toBeDefined();
      expect(result.id).not.toBe('nonexistent');
    });

    it('无 sessionId 时应创建新会话', () => {
      const result = getOrCreateSession();

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^sess_/);
    });
  });

  describe('addMessage', () => {
    it('应正确添加用户和助手消息', () => {
      const session = createSession();

      addMessage(session.id, 'user', '什么是微服务');
      addMessage(session.id, 'assistant', '微服务是一种架构风格...');

      const retrieved = getSession(session.id)!;
      expect(retrieved.messages).toHaveLength(2);
      expect(retrieved.messages[0].role).toBe('user');
      expect(retrieved.messages[0].content).toBe('什么是微服务');
      expect(retrieved.messages[1].role).toBe('assistant');
    });

    it('消息应有时间戳', () => {
      const session = createSession();

      addMessage(session.id, 'user', 'test');

      const retrieved = getSession(session.id)!;
      expect(retrieved.messages[0].timestamp).toBeGreaterThan(0);
    });

    it('不存在的 session 不应报错', () => {
      expect(() => {
        addMessage('nonexistent', 'user', 'test');
      }).not.toThrow();
    });
  });

  describe('saveLastSearchResults / getLastSearchResults', () => {
    it('应保存和获取搜索结果', () => {
      const session = createSession();
      const mockResults: SearchResult[] = [
        { chunk: makeChunk('1'), score: 0.9, scores: { rrf: 0.0328 }, source: 'hybrid', highlight: '**test**' },
      ];

      saveLastSearchResults(session.id, '微服务', mockResults, 'rrf');

      const saved = getLastSearchResults(session.id)!;
      expect(saved.query).toBe('微服务');
      expect(saved.method).toBe('rrf');
      expect(saved.results).toHaveLength(1);
    });

    it('分数链路（scores）应随检索结果完整往返', () => {
      const session = createSession();
      const mockResults: SearchResult[] = [
        {
          chunk: makeChunk('1'),
          score: 0.92,
          scores: { vector: 0.95, bm25: 10, rrf: 0.0328, rerank: 0.92 },
          source: 'hybrid',
        },
      ];

      saveLastSearchResults(session.id, '查询', mockResults, 'rrf');

      const saved = getLastSearchResults(session.id)!;
      expect(saved.results[0].scores.vector).toBe(0.95);
      expect(saved.results[0].scores.bm25).toBe(10);
      expect(saved.results[0].scores.rrf).toBe(0.0328);
      expect(saved.results[0].scores.rerank).toBe(0.92);
    });

    it('不存在的 session 返回 undefined', () => {
      const result = getLastSearchResults('nonexistent');

      expect(result).toBeUndefined();
    });
  });

  describe('isFollowUpQuery', () => {
    it('"那第二个呢？" 应识别为追问', () => {
      expect(isFollowUpQuery('那第二个呢？')).toBe(true);
    });

    it('"详细说说" 应识别为追问', () => {
      expect(isFollowUpQuery('详细说说')).toBe(true);
    });

    it('"还有呢" 应识别为追问', () => {
      expect(isFollowUpQuery('还有呢')).toBe(true);
    });

    it('"它和XX比呢" 应识别为追问', () => {
      expect(isFollowUpQuery('它和Redis比呢')).toBe(true);
    });

    it('"上面提到的" 应识别为追问', () => {
      expect(isFollowUpQuery('上面提到的是什么')).toBe(true);
    });

    it('"继续说说" 应识别为追问', () => {
      expect(isFollowUpQuery('继续说')).toBe(true);
    });

    it('独立完整问题不应识别为追问', () => {
      expect(isFollowUpQuery('微服务架构的核心设计原则是什么')).toBe(false);
    });

    it('"Redis是什么" 不应识别为追问', () => {
      expect(isFollowUpQuery('Redis是什么')).toBe(false);
    });

    it('"国家电网的项目有哪些" 不应识别为追问', () => {
      expect(isFollowUpQuery('国家电网的项目有哪些')).toBe(false);
    });

    it('空字符串不应识别为追问', () => {
      expect(isFollowUpQuery('')).toBe(false);
    });

    it('"能详细说说吗" 应识别为追问', () => {
      expect(isFollowUpQuery('能详细说说吗')).toBe(true);
    });

    it('"什么意思" 应识别为追问', () => {
      expect(isFollowUpQuery('什么意思')).toBe(true);
    });
  });

  describe('getConversationContext', () => {
    it('空会话应返回空上下文', () => {
      const session = createSession();
      const ctx = getConversationContext(session.id);

      expect(ctx.historyText).toBe('');
      expect(ctx.hasFollowUp).toBe(false);
    });

    it('有对话历史时应返回格式化文本', () => {
      const session = createSession();
      addMessage(session.id, 'user', '什么是微服务');
      addMessage(session.id, 'assistant', '微服务是一种架构风格');

      const ctx = getConversationContext(session.id);

      expect(ctx.historyText).toContain('什么是微服务');
      expect(ctx.historyText).toContain('微服务是一种架构风格');
    });

    it('有助手回复后应有追问标记', () => {
      const session = createSession();
      addMessage(session.id, 'user', '什么是微服务');
      addMessage(session.id, 'assistant', '微服务是...');
      // 需要再来一轮，让倒数第二条是 assistant
      addMessage(session.id, 'user', '那它的优缺点呢');

      const ctx = getConversationContext(session.id);

      expect(ctx.hasFollowUp).toBe(true);
    });

    it('不存在的 session 应返回空', () => {
      const ctx = getConversationContext('nonexistent');

      expect(ctx.historyText).toBe('');
    });
  });

  describe('deleteSession', () => {
    it('应删除指定会话', () => {
      const session = createSession();

      deleteSession(session.id);

      expect(getSession(session.id)).toBeUndefined();
    });

    it('删除不存在的 session 不应报错', () => {
      expect(() => deleteSession('nonexistent')).not.toThrow();
    });
  });

  describe('getActiveSessionCount', () => {
    it('应返回活跃会话数', () => {
      expect(getActiveSessionCount()).toBe(0);

      createSession();
      expect(getActiveSessionCount()).toBe(1);

      createSession();
      createSession();
      expect(getActiveSessionCount()).toBe(3);
    });
  });

  describe('clearAllSessions', () => {
    it('应清空所有会话', () => {
      createSession();
      createSession();

      clearAllSessions();

      expect(getActiveSessionCount()).toBe(0);
    });
  });
});
