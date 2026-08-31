// ============================================================
// search pipeline 测试（Spec 029 / 031 / Phase 2）
//   Part 1: 用 mock Retriever / Fusion 驱动固定管线
//           （编排顺序 / 单路失败降级 / keywords 透传 / filteredChunkIds / 空结果提前返回）
//           031 起 pipeline 返回 RetrievalHit[]（组装移至 Assembler）
//           Phase 2 起 RetrievalContext 拆为 RetrievalRequest（query + analysis + filter）
//   Part 2: NoopReranker 截断与 getReranker 选择
//   Part 3: StructRetriever hit 组装
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/vectorEngine', () => ({
  vectorSearch: vi.fn(),
}));
vi.mock('@/lib/bm25Engine', () => ({
  bm25Search: vi.fn(),
  isBM25Ready: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/structSearchEngine', () => ({
  executeStructuredQuery: vi.fn(),
}));
vi.mock('openai', () => ({ default: vi.fn() }));

import { runSearchPipeline } from '@/lib/search/pipeline';
import { NoopReranker, QwenReranker, getReranker } from '@/lib/search/rerankers';
import { StructRetriever } from '@/lib/search/retrievers/struct';
import { executeStructuredQuery } from '@/lib/structSearchEngine';
import type {
  Retriever,
  Fusion,
  QueryAnalysis,
  RetrievalRequest,
} from '@/lib/search/types';
import type { RetrievalHit, SearchResult, DocChunk } from '@/lib/types';

const mockedExecuteStructuredQuery = vi.mocked(executeStructuredQuery);

function makeChunk(id: string, content: string): DocChunk {
  return {
    id,
    docId: id.replace(/_\d+$/, ''),
    docTitle: `标题-${id}`,
    docPath: `Raw/${id.replace(/_\d+$/, '')}.md`,
    chunkIndex: 0,
    content,
    metadata: {},
    wikiLinks: [],
  };
}

function makeHit(chunkId: string, source: 'vector' | 'bm25', score: number): RetrievalHit {
  return source === 'vector'
    ? { chunkId, scores: { vector: score }, ranks: {}, source }
    : { chunkId, scores: { bm25: score }, ranks: {}, source };
}

interface FusionCall {
  hitLists: RetrievalHit[][];
  analysis: QueryAnalysis;
  topK: number;
}

/** mock Retriever：返回固定 hits 或抛错 */
function makeRetriever(name: 'vector' | 'bm25', hits: RetrievalHit[] | Error): Retriever {
  const search = vi.fn(async () => {
    if (hits instanceof Error) throw hits;
    return hits;
  });
  return { name, search } as Retriever;
}

/** mock Fusion：记录调用参数，按输入顺序编造 rrf 分数与排名 */
function makeMockFusion(calls: FusionCall[]): Fusion {
  return {
    name: 'mock-rrf',
    fuse: vi.fn((hitLists: RetrievalHit[][], analysis: QueryAnalysis, topK: number): RetrievalHit[] => {
      calls.push({ hitLists, analysis, topK });
      return hitLists.flat().map((h, i) => ({
        chunkId: h.chunkId,
        scores: { ...h.scores, rrf: 0.03 - i * 0.001 },
        ranks: {
          vector: h.scores.vector !== undefined ? 1 : undefined,
          bm25: h.scores.bm25 !== undefined ? 1 : undefined,
        },
        source: 'rrf' as const,
      }));
    }),
  };
}

const baseParams = { topK: 5, vectorTopN: 20, bm25TopN: 20 };

// ============================================================
// Part 1: 固定编排
// ============================================================

describe('runSearchPipeline（固定编排）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('编排顺序：两路 retriever 收到 SearchQuery + 放大后的 topN，结果按序传入 fusion', async () => {
    const calls: FusionCall[] = [];
    const vectorRetriever = makeRetriever('vector', [makeHit('v1', 'vector', 0.9)]);
    const bm25Retriever = makeRetriever('bm25', [makeHit('b1', 'bm25', 10)]);
    const fusion = makeMockFusion(calls);
    const request: RetrievalRequest = { query: { query: '测试查询' } };

    const hits = await runSearchPipeline(request, baseParams, {
      retrievers: [vectorRetriever, bm25Retriever],
      fusion,
    });

    // 非实体查询：各路 topN ×2
    expect(vectorRetriever.search).toHaveBeenCalledWith(
      { query: '测试查询' },
      expect.objectContaining({ topN: 40 })
    );
    expect(bm25Retriever.search).toHaveBeenCalledWith(
      { query: '测试查询' },
      expect.objectContaining({ topN: 40 })
    );
    // fusion 收到 [vectorHits, bm25Hits] 顺序 + QueryAnalysis + topK*3
    expect(calls).toHaveLength(1);
    expect(calls[0].hitLists).toEqual([
      [makeHit('v1', 'vector', 0.9)],
      [makeHit('b1', 'bm25', 10)],
    ]);
    expect(calls[0].analysis.matchedKeywords).toBeUndefined();
    expect(calls[0].topK).toBe(15);
    // 031 起 pipeline 返回 RetrievalHit[]（v1 的 mock rrf 分更高）
    expect(hits.map(h => h.chunkId)).toEqual(['v1', 'b1']);
  });

  it('单路失败降级：vector 抛错按空继续，bm25 结果正常返回', async () => {
    const calls: FusionCall[] = [];
    const vectorRetriever = makeRetriever('vector', new Error('向量引擎挂了'));
    const bm25Retriever = makeRetriever('bm25', [makeHit('b1', 'bm25', 10)]);
    const fusion = makeMockFusion(calls);

    const hits = await runSearchPipeline(
      { query: { query: '测试查询' } },
      baseParams,
      { retrievers: [vectorRetriever, bm25Retriever], fusion }
    );

    expect(vectorRetriever.search).toHaveBeenCalled();
    expect(calls[0].hitLists[0]).toEqual([]);
    expect(calls[0].hitLists[1]).toHaveLength(1);
    expect(hits.map(h => h.chunkId)).toEqual(['b1']);
  });

  it('keywords 透传：matchedKeywords 传给 retriever 与 fusion，实体查询不放大 topN', async () => {
    const calls: FusionCall[] = [];
    const vectorRetriever = makeRetriever('vector', [makeHit('v1', 'vector', 0.9)]);
    const bm25Retriever = makeRetriever('bm25', []);
    const fusion = makeMockFusion(calls);
    const request: RetrievalRequest = {
      query: { query: '徐峰的文档' },
      analysis: { matchedKeywords: ['徐峰'] },
    };

    await runSearchPipeline(request, baseParams, { retrievers: [vectorRetriever, bm25Retriever], fusion });

    expect(vectorRetriever.search).toHaveBeenCalledWith(
      { query: '徐峰的文档' },
      expect.objectContaining({ topN: 20, keywords: ['徐峰'] })
    );
    expect(bm25Retriever.search).toHaveBeenCalledWith(
      { query: '徐峰的文档' },
      expect.objectContaining({ topN: 20, keywords: ['徐峰'] })
    );
    expect(calls[0].analysis).toEqual({ matchedKeywords: ['徐峰'] });
    // 实体查询：fusionTopK = topK
    expect(calls[0].topK).toBe(5);
  });

  it('filteredChunkIds：管线在 fusion 之前按 chunkId 过滤各路结果', async () => {
    const calls: FusionCall[] = [];
    const vectorRetriever = makeRetriever('vector', [
      makeHit('v1', 'vector', 0.9),
      makeHit('v2', 'vector', 0.8),
    ]);
    const bm25Retriever = makeRetriever('bm25', [makeHit('v2', 'bm25', 10)]);
    const fusion = makeMockFusion(calls);

    const hits = await runSearchPipeline(
      { query: { query: '测试查询' }, filter: { filteredChunkIds: ['v2'] } },
      baseParams,
      { retrievers: [vectorRetriever, bm25Retriever], fusion }
    );

    expect(calls[0].hitLists).toEqual([
      [makeHit('v2', 'vector', 0.8)],
      [makeHit('v2', 'bm25', 10)],
    ]);
    // mock fusion flat 后 v2 出现两次（真实 RRF 会合并同 chunkId，去重在 assembler）
    expect(hits.map(h => h.chunkId)).toEqual(['v2', 'v2']);
  });

  it('空结果提前返回：所有检索路为空时 fusion 不被调用', async () => {
    const calls: FusionCall[] = [];
    const vectorRetriever = makeRetriever('vector', []);
    const bm25Retriever = makeRetriever('bm25', []);
    const fusion = makeMockFusion(calls);

    const hits = await runSearchPipeline(
      { query: { query: '测试查询' } },
      baseParams,
      { retrievers: [vectorRetriever, bm25Retriever], fusion }
    );

    expect(hits).toEqual([]);
    expect(fusion.fuse).not.toHaveBeenCalled();
  });
});

// ============================================================
// Part 2: Rerankers
// ============================================================

describe('Rerankers', () => {
  const makeResults = (n: number): SearchResult[] =>
    Array.from({ length: n }, (_, i) => ({
      chunk: makeChunk(`doc_${i}`, `内容 ${i}`),
      score: 0.9 - i * 0.1,
      scores: { rrf: 0.03 - i * 0.001 },
      source: 'hybrid' as const,
    }));

  it('NoopReranker：直接截断 topN 且保持原顺序', async () => {
    const results = makeResults(5);
    const reranked = await new NoopReranker().rerank({ query: 'q' }, results, 3);
    expect(reranked.map(r => r.chunk.id)).toEqual(['doc_0', 'doc_1', 'doc_2']);
  });

  it('QwenReranker：无 API key 时降级为截断（与原"跳过 rerank"行为一致）', async () => {
    const prev = process.env.DASHSCOPE_API_KEY;
    try {
      delete process.env.DASHSCOPE_API_KEY;
      const results = makeResults(8);
      const reranked = await new QwenReranker().rerank({ query: 'q' }, results, 5);
      expect(reranked).toHaveLength(5);
      expect(reranked[0].chunk.id).toBe('doc_0');
    } finally {
      if (prev === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = prev;
    }
  });

  it('getReranker：无 DASHSCOPE_API_KEY 返回 Noop，有 key 返回 Qwen', () => {
    const prev = process.env.DASHSCOPE_API_KEY;
    try {
      delete process.env.DASHSCOPE_API_KEY;
      expect(getReranker()).toBeInstanceOf(NoopReranker);
      process.env.DASHSCOPE_API_KEY = 'test-key';
      expect(getReranker()).toBeInstanceOf(QwenReranker);
    } finally {
      if (prev === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = prev;
    }
  });
});

// ============================================================
// Part 3: StructRetriever hit 组装
// ============================================================

describe('StructRetriever（hit 组装）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const entry = {
    id: 1,
    name: '徐峰',
    type: 'entity' as const,
    category: 'person',
    frequency: 37,
    path: 'Raw/x.md',
    definition: '',
    attributes: '',
    source: '',
  };

  it('按 options.keywords 查询并组装 RetrievalHit', async () => {
    mockedExecuteStructuredQuery.mockResolvedValue([
      {
        entry,
        chunks: [
          { entry_id: 1, chunk_id: 'c1', context: '' },
          { entry_id: 1, chunk_id: 'c2', context: '' },
        ],
        matchType: 'exact' as const,
      },
    ]);

    const hits = await new StructRetriever().search(
      { query: '徐峰' },
      { topN: 10, keywords: ['徐峰'] }
    );

    expect(mockedExecuteStructuredQuery).toHaveBeenCalledWith(['徐峰']);
    expect(hits).toEqual([
      { chunkId: 'c1', scores: { struct: 37 }, ranks: {}, source: 'entity' },
      { chunkId: 'c2', scores: { struct: 37 }, ranks: {}, source: 'entity' },
    ]);
  });

  it('跨词条 chunk 去重并截断 topN', async () => {
    mockedExecuteStructuredQuery.mockResolvedValue([
      { entry, chunks: [{ entry_id: 1, chunk_id: 'c1', context: '' }], matchType: 'exact' as const },
      {
        entry: { ...entry, id: 2, name: '浦发银行', frequency: 20 },
        chunks: [
          { entry_id: 2, chunk_id: 'c1', context: '' },
          { entry_id: 2, chunk_id: 'c3', context: '' },
        ],
        matchType: 'exact' as const,
      },
    ]);

    const hits = await new StructRetriever().search(
      { query: '徐峰 浦发银行' },
      { topN: 1, keywords: ['徐峰', '浦发银行'] }
    );

    expect(hits).toEqual([
      { chunkId: 'c1', scores: { struct: 37 }, ranks: {}, source: 'entity' },
    ]);
  });

  it('无 keywords 时直接返回空，不触发查询', async () => {
    const hits = await new StructRetriever().search(
      { query: '宽泛查询' },
      { topN: 10 }
    );
    expect(hits).toEqual([]);
    expect(mockedExecuteStructuredQuery).not.toHaveBeenCalled();
  });

  it('查询异常时内部 catch 返回空', async () => {
    mockedExecuteStructuredQuery.mockRejectedValue(new Error('db 挂了'));
    const hits = await new StructRetriever().search(
      { query: 'q' },
      { topN: 10, keywords: ['徐峰'] }
    );
    expect(hits).toEqual([]);
  });
});
