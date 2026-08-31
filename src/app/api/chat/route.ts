// ============================================================
// Chat API（Presentation 层）
// 只负责：请求解析 / 校验 / SSE 事件映射 / 错误映射
// 业务流程全部在 application/chat/chatService（经 composition 注入）
// ============================================================

import { NextRequest } from 'next/server';
import { getContainer } from '@/composition/container';
import type { SearchResult } from '@/domain/search/types';

export async function POST(req: NextRequest) {
  const {
    query,
    topK = 10,
    apiKey,
    baseURL,
    model,
    sessionId,
  } = await req.json();

  if (!query || query.trim().length === 0) {
    return new Response('请提供问题', { status: 400 });
  }

  const { kbStatus, chatService } = getContainer();
  if (!kbStatus.isIndexReady()) {
    return new Response('索引尚未初始化完成，请稍后再试', { status: 503 });
  }

  // 创建 SSE 流
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of chatService.chat(query.trim(), {
          topK,
          apiKey,
          baseURL,
          model,
          sessionId,
        })) {
          switch (event.type) {
            case 'method':
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'method',
                    method: event.method,
                    matchedKeywords: event.matchedKeywords,
                    entityDocsContent: event.entityDocsContent,
                    sessionId: event.sessionId,
                    rewriteMethod: event.rewriteMethod,
                    rewrittenQuery: event.rewrittenQuery,
                  })}\n\n`
                )
              );
              break;
            case 'context':
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'context',
                    sessionId: event.sessionId,
                    results: event.results.map((r: SearchResult) => ({
                      docTitle: r.chunk.docPath
                        ? r.chunk.docPath.replace(/^Raw\//, '').replace(/\.md$/, '')
                        : r.chunk.docTitle,
                      metadata: r.chunk.metadata,
                      source: r.source,
                      score: r.score,
                      scores: r.scores ?? {},
                      content: r.chunk.content,
                      docPath: r.chunk.docPath,
                    })),
                  })}\n\n`
                )
              );
              break;
            case 'token':
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'token', content: event.content })}\n\n`
                )
              );
              break;
            case 'error':
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'error', content: event.content })}\n\n`
                )
              );
              break;
            case 'done':
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'done', sessionId: event.sessionId })}\n\n`
                )
              );
              break;
          }
        }

        controller.close();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', content: error.message })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
