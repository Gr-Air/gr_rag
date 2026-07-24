import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const { mockRedisClient } = vi.hoisted(() => ({
  mockRedisClient: {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    isReady: true,
    ft: {
      create: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue({ total: 0, documents: [] }),
    },
    hSet: vi.fn().mockResolvedValue(1),
    sAdd: vi.fn().mockResolvedValue(1),
    sMembers: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('redis', () => ({
  createClient: vi.fn().mockReturnValue(mockRedisClient),
  SCHEMA_FIELD_TYPE: {
    VECTOR: 'VECTOR',
    TEXT: 'TEXT',
  },
}));

const mockUUID = 'test-uuid';
Object.defineProperty(globalThis.crypto, 'randomUUID', {
  value: vi.fn().mockReturnValue(mockUUID),
});

import { initCache, searchCache, saveCache, clearCache } from '@/lib/ragCache';

function getMockClient() {
  return mockRedisClient;
}

describe('ragCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis.crypto.randomUUID as Mock).mockReturnValue(mockUUID);
  });

  describe('initCache', () => {
    it('should create vector index successfully', async () => {
      const client = getMockClient();

      await initCache();

      expect(client.ft.create).toHaveBeenCalledWith(
        'rag:cache:idx',
        expect.objectContaining({
          embedding: expect.objectContaining({
            type: 'VECTOR',
            ALGORITHM: 'HNSW',
            DIM: 1024,
            DISTANCE_METRIC: 'COSINE',
          }),
        }),
        expect.objectContaining({
          ON: 'HASH',
          PREFIX: 'rag:cache:data:',
        })
      );
    });

    it('should ignore error when index already exists', async () => {
      const client = getMockClient();
      client.ft.create.mockRejectedValue(new Error('already exists'));

      await expect(initCache()).resolves.not.toThrow();
    });
  });

  describe('searchCache', () => {
    it('should return null when no results', async () => {
      const client = getMockClient();
      client.ft.search.mockResolvedValue({ total: 0, documents: [] });

      const result = await searchCache([0.1, 0.2, 0.3]);

      expect(result).toBeNull();
    });

    it('should return cache entry when similarity >= 0.9', async () => {
      const client = getMockClient();
      client.ft.search.mockResolvedValue({
        total: 1,
        documents: [{
          id: 'rag:cache:data:test-uuid',
          score: '0.05',
          value: {
            query: '项目经理是谁',
            embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
            answer: '项目经理是张三',
            contexts: JSON.stringify(['context1']),
            sources: JSON.stringify(['source1']),
            timestamp: '1234567890',
            topK: '5',
          },
        }],
      });

      const result = await searchCache([0.1, 0.2, 0.3]);

      expect(result).not.toBeNull();
      expect(result!.answer).toBe('项目经理是张三');
      expect(result!.query).toBe('项目经理是谁');
      expect(result!.embedding).toHaveLength(3);
    });

    it('should return null when similarity < 0.9', async () => {
      const client = getMockClient();
      client.ft.search.mockResolvedValue({
        total: 1,
        documents: [{
          id: 'rag:cache:data:test-uuid',
          score: '0.15',
          value: {
            query: '项目经理是谁',
            embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
            answer: '项目经理是张三',
            contexts: JSON.stringify(['context1']),
            sources: JSON.stringify(['source1']),
            timestamp: '1234567890',
            topK: '5',
          },
        }],
      });

      const result = await searchCache([0.1, 0.2, 0.3]);

      expect(result).toBeNull();
    });
  });

  describe('saveCache', () => {
    it('should save cache entry successfully', async () => {
      const client = getMockClient();

      await saveCache({
        query: '项目经理是谁',
        embedding: [0.1, 0.2, 0.3],
        answer: '项目经理是张三',
        contexts: ['context1'],
        sources: ['source1'],
        timestamp: 1234567890,
        topK: 5,
      });

      expect(client.hSet).toHaveBeenCalledWith(
        'rag:cache:data:test-uuid',
        expect.objectContaining({
          query: '项目经理是谁',
          answer: '项目经理是张三',
        })
      );
      expect(client.sAdd).toHaveBeenCalledWith('rag:cache:ids', 'test-uuid');
      expect(client.expire).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearCache', () => {
    it('should clear all cache entries', async () => {
      const client = getMockClient();
      client.sMembers.mockResolvedValue(['uuid1', 'uuid2']);

      await clearCache();

      expect(client.sMembers).toHaveBeenCalledWith('rag:cache:ids');
      expect(client.del).toHaveBeenCalledTimes(2);
      expect(client.sRem).toHaveBeenCalledWith('rag:cache:ids', ['uuid1', 'uuid2']);
    });
  });
});
