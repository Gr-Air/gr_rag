// ============================================================
// SearchResultAssembler 测试（Spec 031）
//   RetrievalHit[] → SearchResult[] 组装逻辑：
//   chunk 附着 / 文档聚合 / boost / 归一化 / 高亮 / source 判定
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('openai', () => ({ default: vi.fn() }));

import { SearchResultAssembler } from '@/application/search/assembler';
import type { ChunkStore, ChunkMeta, DocChunk } from '@/domain/document/types';
import type { RetrievalHit, SearchQuery, QueryAnalysis } from '@/domain/search/types';

function makeChunk(id: string, content: string, docId?: string): DocChunk {
  return {
    id,
    docId: docId ?? id.replace(/_\d+$/, ''),
    docTitle: `标题-${docId ?? id}`,
    docPath: `Raw/${docId ?? id}.md`,
    chunkIndex: 0,
    content,
    metadata: {},
    wikiLinks: [],
  };
}

function makeHit(chunkId: string, rrf: number, ranks: RetrievalHit['ranks'] = {}): RetrievalHit {
  return {
    chunkId,
    scores: { rrf },
    ranks,
    source: 'rrf',
  };
}

/** mock ChunkStore：按 contentMap 构建 getByIds 返回 */
function makeMockChunkStore(contentMap: Record<string, string>): ChunkStore {
  return {
    getByIds: (ids: string[]): DocChunk[] =>
      ids
        .map(id => {
          const content = contentMap[id];
          if (content === undefined) return undefined;
          return makeChunk(id, content);
        })
        .filter((c): c is DocChunk => c !== undefined),
    getAll: vi.fn(() => new Map<string, ChunkMeta>()),
  };
}

const q = (query: string): SearchQuery => ({ query });
const a = (matchedKeywords?: string[]): QueryAnalysis => ({ matchedKeywords });

describe('SearchResultAssembler', () => {
  let assembler: SearchResultAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('chunk 附着', () => {
    it('ChunkStore 中存在的 chunkId 才会出现在结果中', () => {
      const store = makeMockChunkStore({ A: '内容A', B: '内容B' });
      assembler = new SearchResultAssembler(store);
      const hits = [makeHit('A', 0.03), makeHit('B', 0.02), makeHit('X', 0.01)];

      const results = assembler.assemble(hits, q('q'), a(), 10);

      expect(results.map(r => r.chunk.id)).toEqual(['A', 'B']);
    });
  });

  describe('文档聚合', () => {
    it('宽泛查询：同 docId 最多 5 chunk，按 rrf 降序', () => {
      const store = makeMockChunkStore({
        A_0: '标题A\n内容0', A_1: '标题A\n内容1', A_2: '标题A\n内容2',
        A_3: '标题A\n内容3', A_4: '标题A\n内容4', A_5: '标题A\n内容5',
        B_0: '标题B\n内容0',
      });
      assembler = new SearchResultAssembler(store);
      const hits = [
        makeHit('A_0', 0.03), makeHit('A_1', 0.029), makeHit('A_2', 0.028),
        makeHit('A_3', 0.027), makeHit('A_4', 0.026), makeHit('A_5', 0.025),
        makeHit('B_0', 0.024),
      ];

      const results = assembler.assemble(hits, q('宽泛查询'), a(), 10);

      const docAResults = results.filter(r => r.chunk.docId === 'A');
      expect(docAResults.length).toBeLessThanOrEqual(5);
      expect(results.some(r => r.chunk.id === 'B_0')).toBe(true);
    });

    it('实体查询：同 docId 只取 1 chunk', () => {
      const store = makeMockChunkStore({
        A_0: '内容0', A_1: '内容1', A_2: '内容2',
      });
      assembler = new SearchResultAssembler(store);
      const hits = [makeHit('A_0', 0.03), makeHit('A_1', 0.029), makeHit('A_2', 0.028)];

      const results = assembler.assemble(hits, q('实体查询'), a(['徐峰']), 10);

      expect(results).toHaveLength(1);
      expect(results[0].chunk.id).toBe('A_0');
    });

    it('同标题重复 chunk 跳过（避免近似重复内容）', () => {
      const store = makeMockChunkStore({
        A_0: '相同标题\n内容0', A_1: '相同标题\n内容1',
        B_0: '不同标题\n内容0',
      });
      assembler = new SearchResultAssembler(store);
      const hits = [makeHit('A_0', 0.03), makeHit('A_1', 0.029), makeHit('B_0', 0.028)];

      const results = assembler.assemble(hits, q('宽泛查询'), a(), 10);

      const docA = results.filter(r => r.chunk.docId === 'A');
      expect(docA).toHaveLength(1);
    });
  });

  describe('归一化', () => {
    it('RRF 原始值映射到 0.05~0.95 区间，最高分为 0.95', () => {
      const store = makeMockChunkStore({ A: '内容A', B: '内容B', C: '内容C' });
      assembler = new SearchResultAssembler(store);
      const hits = [makeHit('A', 0.03), makeHit('B', 0.02), makeHit('C', 0.01)];

      const results = assembler.assemble(hits, q('q'), a(), 10);

      expect(results[0].score).toBeCloseTo(0.95, 4);
      expect(results[results.length - 1].score).toBeCloseTo(0.05, 4);
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.05);
        expect(r.score).toBeLessThanOrEqual(0.95);
      }
    });

    it('所有分数相同时取中间值 0.50', () => {
      const store = makeMockChunkStore({ A: '内容A' });
      assembler = new SearchResultAssembler(store);
      const hits = [makeHit('A', 0.03)];

      const results = assembler.assemble(hits, q('q'), a(), 10);

      expect(results[0].score).toBeCloseTo(0.50, 4);
    });
  });

  describe('source 判定', () => {
    it('仅向量命中的 hit → source = vector', () => {
      const store = makeMockChunkStore({ A: '内容A' });
      assembler = new SearchResultAssembler(store);
      const hits: RetrievalHit[] = [{
        chunkId: 'A',
        scores: { rrf: 0.03, vector: 0.9 },
        ranks: { vector: 1 },
        source: 'rrf',
      }];

      const results = assembler.assemble(hits, q('q'), a(), 10);

      expect(results[0].source).toBe('vector');
    });

    it('仅 BM25 命中的 hit → source = bm25', () => {
      const store = makeMockChunkStore({ A: '内容A' });
      assembler = new SearchResultAssembler(store);
      const hits: RetrievalHit[] = [{
        chunkId: 'A',
        scores: { rrf: 0.03, bm25: 10 },
        ranks: { bm25: 1 },
        source: 'rrf',
      }];

      const results = assembler.assemble(hits, q('q'), a(), 10);

      expect(results[0].source).toBe('bm25');
    });

    it('双边命中的 hit → source = hybrid', () => {
      const store = makeMockChunkStore({ A: '内容A' });
      assembler = new SearchResultAssembler(store);
      const hits: RetrievalHit[] = [{
        chunkId: 'A',
        scores: { rrf: 0.03, vector: 0.9, bm25: 10 },
        ranks: { vector: 1, bm25: 1 },
        source: 'rrf',
      }];

      const results = assembler.assemble(hits, q('q'), a(), 10);

      expect(results[0].source).toBe('hybrid');
    });
  });

  describe('高亮', () => {
    it('结果包含 highlight 字段', () => {
      const store = makeMockChunkStore({ A: '这是徐峰的文档内容' });
      assembler = new SearchResultAssembler(store);
      const hits = [makeHit('A', 0.03)];

      const results = assembler.assemble(hits, q('徐峰'), a(), 10);

      expect(results[0].highlight).toBeDefined();
      expect(results[0].highlight).toContain('徐峰');
    });
  });

  describe('空输入', () => {
    it('空 hits 返回空数组', () => {
      const store = makeMockChunkStore({});
      assembler = new SearchResultAssembler(store);

      const results = assembler.assemble([], q('q'), a(), 10);

      expect(results).toEqual([]);
    });
  });
});
