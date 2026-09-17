// ============================================================
// Search API（Presentation 层）
// 只负责：请求解析 / 校验 / DTO 映射 / 错误映射
// 检索流程在 application/search/entitySearch（经 composition 注入）
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getContainer } from '@/composition/container';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q');
  const topK = parseInt(searchParams.get('topK') || '10');
  const searchMethod = searchParams.get('method') as 'rrf' | 'entity' | undefined;

  if (!query || query.trim().length === 0) {
    return NextResponse.json({ error: '请提供搜索关键词' }, { status: 400 });
  }

  const { kbStatus, entitySearch } = getContainer();
  if (!kbStatus.isIndexReady()) {
    return NextResponse.json(
      { error: '索引尚未初始化完成，请稍后再试' },
      { status: 503 }
    );
  }

  try {
    const trimmedQuery = query.trim();
    const routedResult = await entitySearch.routedSearch(trimmedQuery, topK, { forceMethod: searchMethod });
    const { results, method, matchedKeywords } = routedResult;

    return NextResponse.json({
      query,
      matchedKeywords,
      method,
      total: results.length,
      results: results.map(r => ({
        id: r.chunk.id,
        docId: r.chunk.docId,
        docTitle: r.chunk.docTitle,
        docPath: r.chunk.docPath,
        content: r.chunk.content.slice(0, 500),
        metadata: r.chunk.metadata,
        score: r.score,
        scores: r.scores ?? {},
        source: r.source,
        highlight: r.highlight,
      })),
    });
  } catch (err) {
    console.error('[API] 搜索失败:', err);
    return NextResponse.json({ error: `搜索失败: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
