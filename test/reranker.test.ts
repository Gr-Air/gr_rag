// ============================================================
// reranker 测试：分数链路（spec 027，spec 029 起逻辑位于 search/rerankers/）
//   - rerank 分写入 scores.rerank，原始 RRF 链路保留不覆盖
//   - 相关性过滤后回补的原始结果：score/scores 保持归一化 RRF 值，无 rerank 分
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SearchResult } from '@/domain/search/types';

const fetchMock = vi.fn();

async function loadReranker(apiKey: string | undefined) {
  if (apiKey === undefined) {
    vi.stubEnv('DASHSCOPE_API_KEY', '');
  } else {
    vi.stubEnv('DASHSCOPE_API_KEY', apiKey);
  }
  vi.stubGlobal('fetch', fetchMock);
  const { QwenReranker } = await import('@/infrastructure/search/rerankers');
  return (query: string, results: SearchResult[], topN: number) =>
    new QwenReranker().rerank({ query }, results, topN);
}

function makeResult(id: string, score: number, rrf: number): SearchResult {
  return {
    chunk: {
      id,
      docId: `doc_${id}`,
      docTitle: `文档${id}`,
      docPath: `Raw/doc${id}.md`,
      chunkIndex: 0,
      content: `文档${id}的内容，长度足够参与重排序。`,
      metadata: {},
      wikiLinks: [],
    },
    score,
    scores: { rrf, vector: 0.9 },
    source: 'hybrid',
    highlight: 'test',
  };
}

describe('reranker 分数链路', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('rerank 后 scores.rerank 写入且 scores.rrf 保留（不覆盖丢失）', async () => {
    const rerank = await loadReranker('test-key');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 0.92 },
          { index: 1, relevance_score: 0.85 },
        ],
        usage: { total_tokens: 100 },
      }),
    });

    // 3 条输入，topN=2：r2 被 rerank 过滤后回补
    const input = [
      makeResult('A', 0.90, 0.0328),
      makeResult('B', 0.80, 0.0164),
      makeResult('C', 0.70, 0.0082),
    ];

    const output = await rerank('查询', input, 2);

    // A、B 通过 rerank：score = rerank 分，scores.rerank 写入，rrf 保留
    const a = output.find(r => r.chunk.id === 'A')!;
    expect(a.score).toBe(0.92);
    expect(a.scores.rerank).toBe(0.92);
    expect(a.scores.rrf).toBe(0.0328);
    expect(a.scores.vector).toBe(0.9);
  });

  it('被相关性阈值过滤后回补的结果：score/scores 保持原始值且无 rerank 分', async () => {
    const rerank = await loadReranker('test-key');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 0.95 }, // A 通过
          { index: 1, relevance_score: 0.30 }, // B 低于 0.5，被过滤
        ],
        usage: { total_tokens: 100 },
      }),
    });

    const input = [
      makeResult('A', 0.90, 0.0328),
      makeResult('B', 0.80, 0.0164),
      makeResult('C', 0.70, 0.0082),
    ];

    const output = await rerank('查询', input, 2);

    expect(output).toHaveLength(2);
    // A：rerank 通过
    const a = output.find(r => r.chunk.id === 'A')!;
    expect(a.scores.rerank).toBe(0.95);
    expect(a.scores.rrf).toBe(0.0328);

    // B 被过滤且 index 已 used，不回补；回补的是未参与 rerank 的 C：
    // score 仍为归一化 RRF 值，scores 无 rerank 字段
    expect(output.find(r => r.chunk.id === 'B')).toBeUndefined();
    const c = output.find(r => r.chunk.id === 'C')!;
    expect(c.score).toBe(0.70);
    expect(c.scores.rerank).toBeUndefined();
    expect(c.scores.rrf).toBe(0.0082);
  });

  it('无 API key 时跳过 rerank，原样截断（分数链路不动）', async () => {
    const rerank = await loadReranker(undefined);
    const input = [makeResult('A', 0.90, 0.0328), makeResult('B', 0.80, 0.0164)];

    const output = await rerank('查询', input, 1);

    expect(output).toHaveLength(1);
    expect(output[0].score).toBe(0.90);
    expect(output[0].scores.rerank).toBeUndefined();
    expect(output[0].scores.rrf).toBe(0.0328);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Rerank API 失败时降级按原始分数排序（分数链路不动）', async () => {
    const rerank = await loadReranker('test-key');
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });

    // 3 条输入（> topN=2）才会进入 rerank 流程；失败后按原始 score 降序取 topN
    const input = [
      makeResult('A', 0.70, 0.0082),
      makeResult('B', 0.90, 0.0328),
      makeResult('C', 0.80, 0.0164),
    ];

    const output = await rerank('查询', input, 2);

    // 按原始 score 降序：B(0.9) → C(0.8)
    expect(output).toHaveLength(2);
    expect(output[0].chunk.id).toBe('B');
    expect(output[0].score).toBe(0.90);
    expect(output[0].scores.rerank).toBeUndefined();
    expect(output[0].scores.rrf).toBe(0.0328);
    expect(output[1].chunk.id).toBe('C');
  });
});
