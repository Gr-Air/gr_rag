// ============================================================
// ChunkStore 测试（Spec 031）
//   JsonChunkStore 实现：getByIds / getAll / 单例缓存
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));
vi.mock('openai', () => ({ default: vi.fn() }));

import fs from 'fs';
import { JsonChunkStore, _resetChunkStoreForTest } from '@/infrastructure/document/jsonChunkStore';
import type { ChunkMeta } from '@/domain/document/types';

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

function makeMeta(docId: string, content: string): ChunkMeta {
  return {
    docId,
    docTitle: `标题-${docId}`,
    docPath: `Raw/${docId}.md`,
    metadata: {},
    content,
    wikiLinks: [],
  };
}

describe('JsonChunkStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetChunkStoreForTest();
  });

  function setupShards(shards: Record<string, ChunkMeta>[]): void {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((p: unknown) => {
      const str = p as string;
      if (str.endsWith('config.json')) {
        return JSON.stringify({ totalShards: shards.length });
      }
      for (let i = 0; i < shards.length; i++) {
        if (str.endsWith(`shard_${i}.json`)) return JSON.stringify(shards[i]);
      }
      return '{}';
    });
  }

  it('getByIds：命中返回对应 DocChunk，未命中跳过', () => {
    setupShards([
      { A: makeMeta('docA', '内容A'), B: makeMeta('docB', '内容B') },
    ]);

    const store = new JsonChunkStore();
    const chunks = store.getByIds(['A', 'X', 'B']);

    expect(chunks).toHaveLength(2);
    expect(chunks.map(c => c.id)).toEqual(['A', 'B']);
    expect(chunks[0].docId).toBe('docA');
    expect(chunks[0].content).toBe('内容A');
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('getAll：返回完整 Map<chunkId, ChunkMeta>', () => {
    setupShards([
      { A: makeMeta('docA', '内容A') },
      { B: makeMeta('docB', '内容B') },
    ]);

    const store = new JsonChunkStore();
    const map = store.getAll();

    expect(map.size).toBe(2);
    expect(map.get('A')?.docId).toBe('docA');
    expect(map.get('B')?.content).toBe('内容B');
  });

  it('单例缓存：getAll 二次调用不重复读磁盘', () => {
    setupShards([{ A: makeMeta('docA', '内容A') }]);

    const store = new JsonChunkStore();
    store.getAll();
    const readCount1 = mockedReadFileSync.mock.calls.length;
    store.getAll();
    const readCount2 = mockedReadFileSync.mock.calls.length;

    expect(readCount2).toBe(readCount1);
  });

  it('config 不存在时返回空集合', () => {
    mockedExistsSync.mockReturnValue(false);

    const store = new JsonChunkStore();
    const map = store.getAll();

    expect(map.size).toBe(0);
    expect(store.getByIds(['A'])).toHaveLength(0);
  });
});
