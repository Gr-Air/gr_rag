// ============================================================
// hybridSearch 测试
//   Part 1: rrfFusion 纯函数测试（直接 import 真实实现，spec 029 起接收 RetrievalHit[]）
//   Part 2: hybridSearch 集成测试（分数链路：mock 检索引擎）
//   Part 3: queryPolicy 纯函数测试（宽泛查询识别与 topK 调整）
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/vectorEngine', () => ({
  vectorSearch: vi.fn(),
}));
vi.mock('@/lib/bm25Engine', () => ({
  bm25Search: vi.fn(),
  isBM25Ready: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/document/chunkStore', () => ({
  getChunkStore: vi.fn(),
}));
vi.mock('openai', () => ({ default: vi.fn() }));

import { hybridSearch, _resetAssemblerForTest } from '@/lib/search';
import { rrfFusion } from '@/lib/search/fusion';
import { isBroadQuery, adjustTopKForBroadQuery, BROAD_QUERY_TOPK } from '@/lib/search/queryPolicy';
import { vectorSearch } from '@/lib/vectorEngine';
import { bm25Search } from '@/lib/bm25Engine';
import { getChunkStore } from '@/lib/document/chunkStore';
import type { ChunkStore } from '@/lib/document/types';
import type { DocChunk, RetrievalHit } from '@/lib/types';

const mockedVectorSearch = vi.mocked(vectorSearch);
const mockedBm25Search = vi.mocked(bm25Search);
const mockedGetChunkStore = vi.mocked(getChunkStore);

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

/** 构造向量路 RetrievalHit（Spec 029 起 rrfFusion 接收 RetrievalHit[]） */
function vhit(chunkId: string, score: number): RetrievalHit {
  return { chunkId, scores: { vector: score }, ranks: {}, source: 'vector' };
}

/** 构造 BM25 路 RetrievalHit */
function bhit(chunkId: string, score: number): RetrievalHit {
  return { chunkId, scores: { bm25: score }, ranks: {}, source: 'bm25' };
}

// ============================================================
// Part 1: rrfFusion 纯函数测试（真实实现）
// ============================================================

describe('rrfFusion', () => {
  describe('基本融合逻辑', () => {
    it('两条独立结果列表应正确融合排序', () => {
      const vectorResults = [vhit('A', 0.95), vhit('B', 0.80)];
      const bm25Results = [bhit('C', 10), bhit('D', 8)];

      const result = rrfFusion(vectorResults, bm25Results, 10);

      expect(result).toHaveLength(4);
      // 各条目的排名：A(vec#1), B(vec#2), C(bm25#1), D(bm25#2)
      // RRF_A = 1/(60+1) = 0.01639
      // RRF_B = 1/(60+2) = 0.01613
      // RRF_C = 1/(60+1) = 0.01639
      // RRF_D = 1/(60+2) = 0.01613
      // A 和 C 同分，按排序稳定性取决于 map 顺序
      expect(result[0].scores.rrf).toBeCloseTo(1 / 61, 5);
      expect(result[result.length - 1].scores.rrf).toBeCloseTo(1 / 62, 5);
    });

    it('同一 chunk 在两边都命中时，RRF 分数应累加', () => {
      const vectorResults = [vhit('A', 0.95), vhit('B', 0.80)];
      const bm25Results = [bhit('A', 10), bhit('C', 8)];

      const result = rrfFusion(vectorResults, bm25Results, 10);

      // A 在两边都命中：RRF = 1/61 + 1/61 = 2/61 ≈ 0.03279
      const aResult = result.find(r => r.chunkId === 'A')!;
      expect(aResult.ranks.vector).toBe(1);
      expect(aResult.ranks.bm25).toBe(1);
      expect(aResult.scores.rrf).toBeCloseTo(2 / 61, 5);
    });

    it('BM25 单边命中时 vectorRank 缺省', () => {
      const vectorResults: RetrievalHit[] = [];
      const bm25Results = [bhit('X', 10)];

      const result = rrfFusion(vectorResults, bm25Results, 10);

      expect(result).toHaveLength(1);
      expect(result[0].chunkId).toBe('X');
      expect(result[0].ranks.vector).toBeUndefined();
      expect(result[0].ranks.bm25).toBe(1);
    });

    it('向量单边命中时 bm25Rank 缺省', () => {
      const vectorResults = [vhit('Y', 0.95)];
      const bm25Results: RetrievalHit[] = [];

      const result = rrfFusion(vectorResults, bm25Results, 10);

      expect(result).toHaveLength(1);
      expect(result[0].chunkId).toBe('Y');
      expect(result[0].ranks.vector).toBe(1);
      expect(result[0].ranks.bm25).toBeUndefined();
    });
  });

  describe('topK 截断', () => {
    it('topK=3 只返回前 3 条', () => {
      const vectorResults = [vhit('A', 0.9), vhit('B', 0.8)];
      const bm25Results = [bhit('C', 9), bhit('D', 8), bhit('E', 7)];

      const result = rrfFusion(vectorResults, bm25Results, 3);

      expect(result).toHaveLength(3);
    });

    it('结果数少于 topK 时返回所有结果', () => {
      const vectorResults = [vhit('A', 0.9)];
      const bm25Results: RetrievalHit[] = [];

      const result = rrfFusion(vectorResults, bm25Results, 10);

      expect(result).toHaveLength(1);
    });
  });

  describe('实体关键词过滤', () => {
    it('被过滤的 chunk 不应贡献向量排名', () => {
      const vectorResults = [vhit('A', 0.95), vhit('B', 0.80), vhit('C', 0.70)];
      const bm25Results = [bhit('A', 10)];

      // 过滤 B：B 不包含实体关键词
      const filter = new Set<string>(['B']);

      const result = rrfFusion(vectorResults, bm25Results, 10, filter);

      // B 的 vectorRank 应缺省（被过滤），但原始向量分仍保留
      const bResult = result.find(r => r.chunkId === 'B')!;
      expect(bResult.ranks.vector).toBeUndefined();
      expect(bResult.ranks.bm25).toBeUndefined();
      expect(bResult.scores.vector).toBe(0.80);

      // A 的向量排名不受 B 过滤影响（effectiveVecRank 跳过 B）
      const aResult = result.find(r => r.chunkId === 'A')!;
      expect(aResult.ranks.vector).toBe(1); // 仍然是 #1
      expect(aResult.scores.rrf).toBeCloseTo(2 / 61, 5); // vec#1 + bm25#1
    });

    it('多个被过滤的 chunk 不影响未过滤的排名', () => {
      const vectorResults = [
        vhit('A', 0.9),
        vhit('B', 0.8), // 过滤
        vhit('C', 0.7),
        vhit('D', 0.6), // 过滤
        vhit('E', 0.5),
      ];
      const bm25Results: RetrievalHit[] = [];

      const filter = new Set<string>(['B', 'D']);

      const result = rrfFusion(vectorResults, bm25Results, 10, filter);

      // A: effectiveVecRank=1, RRF=1/61
      // C: effectiveVecRank=2, RRF=1/62
      // E: effectiveVecRank=3, RRF=1/63
      const aResult = result.find(r => r.chunkId === 'A')!;
      const cResult = result.find(r => r.chunkId === 'C')!;
      const eResult = result.find(r => r.chunkId === 'E')!;

      expect(aResult.scores.rrf).toBeCloseTo(1 / 61, 5);
      expect(cResult.scores.rrf).toBeCloseTo(1 / 62, 5);
      expect(eResult.scores.rrf).toBeCloseTo(1 / 63, 5);

      // B 和 D 的 vectorRank 缺省
      expect(result.find(r => r.chunkId === 'B')!.ranks.vector).toBeUndefined();
      expect(result.find(r => r.chunkId === 'D')!.ranks.vector).toBeUndefined();
    });

    it('被过滤的 chunk 仍有 BM25 排名', () => {
      const vectorResults = [vhit('A', 0.9)];
      const bm25Results = [bhit('A', 10), bhit('B', 8)];

      // A 不包含实体关键词，在向量中被过滤
      const filter = new Set<string>(['A']);

      const result = rrfFusion(vectorResults, bm25Results, 10, filter);

      const aResult = result.find(r => r.chunkId === 'A')!;
      expect(aResult.ranks.vector).toBeUndefined(); // 向量被过滤
      expect(aResult.ranks.bm25).toBe(1);           // BM25 不受影响
      expect(aResult.scores.rrf).toBeCloseTo(1 / 61, 5); // 仅 BM25 贡献
    });
  });

  describe('RRF 数学性质', () => {
    it('排名越靠前 RRF 分数越高', () => {
      const vectorResults = [vhit('R1', 0.9), vhit('R2', 0.8), vhit('R3', 0.7)];
      const bm25Results: RetrievalHit[] = [];

      const result = rrfFusion(vectorResults, bm25Results, 10);

      // RRF 分数应递减
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i].scores.rrf!).toBeGreaterThan(result[i + 1].scores.rrf!);
      }
    });

    it('空输入返回空数组', () => {
      const result = rrfFusion([], [], 10);

      expect(result).toEqual([]);
    });

    it('原始分数不参与计算，仅排名影响结果', () => {
      // 极高分数 vs 极低分数，但排名相同 → 结果应相同
      const r1 = rrfFusion([vhit('A', 0.999)], [], 10);
      const r2 = rrfFusion([vhit('A', 0.001)], [], 10);

      expect(r1[0].scores.rrf).toBe(r2[0].scores.rrf);
    });
  });

  describe('排名顺序一致性', () => {
    it('向量和 BM25 的排名编号从 1 开始', () => {
      const vectorResults = [vhit('V1', 0.9)];
      const bm25Results = [bhit('B1', 10)];

      const result = rrfFusion(vectorResults, bm25Results, 10);

      const v1 = result.find(r => r.chunkId === 'V1')!;
      const b1 = result.find(r => r.chunkId === 'B1')!;

      expect(v1.ranks.vector).toBe(1);
      expect(b1.ranks.bm25).toBe(1);
    });
  });
});

// ============================================================
// Part 2: hybridSearch 集成测试（spec 027 分数链路）
// ============================================================

describe('hybridSearch 分数链路（spec 027）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAssemblerForTest();
  });

  it('返回值含完整分数链路：vector/bm25/rrf 均可追溯', async () => {
    mockedVectorSearch.mockResolvedValue([
      { chunkId: 'docA_0', score: 0.95 },
      { chunkId: 'docB_0', score: 0.80 },
    ]);
    mockedBm25Search.mockResolvedValue([
      { chunkId: 'docA_0', score: 10 },
      { chunkId: 'docC_0', score: 8 },
    ]);
    mockedGetChunkStore.mockReturnValue({
      getByIds: (ids: string[]) => ids.map(id => makeChunk(id, `${id} 的内容`)),
      getAll: vi.fn(),
    } as unknown as ChunkStore);

    const results = await hybridSearch('测试查询', 5, 20, 20);

    // 所有结果都有 scores 对象
    for (const r of results) {
      expect(r.scores).toBeDefined();
      expect(typeof r.score).toBe('number');
    }

    // docA_0 双边命中：scores.vector/bm25 为原始分，scores.rrf ≈ 1/61 + 1/61
    const docA = results.find(r => r.chunk.id === 'docA_0')!;
    expect(docA.scores.vector).toBe(0.95);
    expect(docA.scores.bm25).toBe(10);
    expect(docA.scores.rrf).toBeCloseTo(2 / 61, 5);

    // docC_0 仅 BM25 命中（rank 2）：scores.vector 缺省
    const docC = results.find(r => r.chunk.id === 'docC_0')!;
    expect(docC.scores.vector).toBeUndefined();
    expect(docC.scores.bm25).toBe(8);
    expect(docC.scores.rrf).toBeCloseTo(1 / 62, 5);

    // 双边命中的文档排序第一（RRF 分最高）
    expect(results[0].chunk.id).toBe('docA_0');
  });

  it('实体匹配度加成并入 scores.rrf（含加成后的最终值）', async () => {
    mockedVectorSearch.mockResolvedValue([
      { chunkId: 'docA_0', score: 0.95 },
      { chunkId: 'docB_0', score: 0.80 },
    ]);
    mockedBm25Search.mockResolvedValue([]);
    mockedGetChunkStore.mockReturnValue({
      getByIds: (ids: string[]) => ids.map(id => makeChunk(id, id === 'docA_0' ? '徐峰负责的项目文档内容' : '其他无关内容')),
      getAll: vi.fn(),
    } as unknown as ChunkStore);

    const results = await hybridSearch('徐峰负责哪些项目', 5, 20, 20, {
      matchedKeywords: ['徐峰'],
    });

    const docA = results.find(r => r.chunk.id === 'docA_0')!;
    const docB = results.find(r => r.chunk.id === 'docB_0')!;

    // docA 内容含"徐峰"：rrf = 基础 1/61 + 加成 0.2
    expect(docA.scores.rrf).toBeCloseTo(1 / 61 + 0.2, 5);
    // docB 内容不含关键词 → 向量排名被过滤且无 BM25 → 无 RRF 贡献，但 vector 原始分保留
    expect(docB.scores.rrf).toBeUndefined();
    expect(docB.scores.vector).toBe(0.80);
  });

  it('实体过滤：被过滤的向量结果不贡献 RRF，scores.vector 仍保留原始分', async () => {
    mockedVectorSearch.mockResolvedValue([
      { chunkId: 'docA_0', score: 0.95 },
      { chunkId: 'docB_0', score: 0.80 },
    ]);
    mockedBm25Search.mockResolvedValue([
      { chunkId: 'docB_0', score: 9 },
    ]);
    mockedGetChunkStore.mockReturnValue({
      getByIds: (ids: string[]) => ids.map(id => makeChunk(id, id === 'docB_0' ? '无关内容' : '徐峰相关内容')),
      getAll: vi.fn(),
    } as unknown as ChunkStore);

    const results = await hybridSearch('徐峰的文档', 5, 20, 20, {
      matchedKeywords: ['徐峰'],
    });

    // docB：向量排名被过滤（RRF 仅来自 BM25 #1），但 scores.vector 原始分保留
    const docB = results.find(r => r.chunk.id === 'docB_0')!;
    expect(docB.scores.vector).toBe(0.80);
    expect(docB.scores.rrf).toBeCloseTo(1 / 61, 5);
  });
});

// ============================================================
// Part 3: queryPolicy 纯函数测试（宽泛查询识别与 topK 调整）
// ============================================================

describe('queryPolicy', () => {
  describe('isBroadQuery', () => {
    it('命中宽泛查询规则表', () => {
      expect(isBroadQuery('相关的项目文档有哪些')).toBe(true);
      expect(isBroadQuery('有哪些项目')).toBe(true);
      expect(isBroadQuery('哪些文档涉及数据中台')).toBe(true);
      expect(isBroadQuery('知识库有多少文档')).toBe(true);
    });

    it('具体查询不命中', () => {
      expect(isBroadQuery('项目经理是谁')).toBe(false);
      expect(isBroadQuery('徐峰负责的工作')).toBe(false);
      expect(isBroadQuery('预算金额是多少')).toBe(false);
    });
  });

  describe('adjustTopKForBroadQuery', () => {
    it('宽泛查询且 topK 较大时收敛到 BROAD_QUERY_TOPK', () => {
      expect(adjustTopKForBroadQuery('相关的项目文档有哪些', 10)).toBe(BROAD_QUERY_TOPK);
      expect(adjustTopKForBroadQuery('有哪些项目', 5)).toBe(BROAD_QUERY_TOPK);
    });

    it('宽泛查询但 topK 已不大于阈值时保持不变', () => {
      expect(adjustTopKForBroadQuery('相关的项目文档有哪些', 3)).toBe(3);
      expect(adjustTopKForBroadQuery('相关的项目文档有哪些', 2)).toBe(2);
    });

    it('具体查询保持原 topK', () => {
      expect(adjustTopKForBroadQuery('项目经理是谁', 10)).toBe(10);
      expect(adjustTopKForBroadQuery('徐峰的文档', 5)).toBe(5);
    });
  });
});
