// ============================================================
// Eval API（Presentation 层）
// 只负责：请求解析 / 校验 / JSON 映射 / 错误映射
// 评估流程在 application/eval/evalService（经 composition 注入）
// ============================================================

import { NextRequest } from 'next/server';
import { getContainer } from '@/composition/container';

export async function POST(req: NextRequest) {
  const {
    query,
    topK = 10,
    apiKey,
    baseURL,
    model,
  } = await req.json();

  if (!query || query.trim().length === 0) {
    return new Response(JSON.stringify({ error: '请提供问题' }), { status: 400 });
  }

  const { kbStatus, evalService, createLlmClient } = getContainer();
  if (!kbStatus.isIndexReady()) {
    return new Response(JSON.stringify({ error: '索引尚未初始化完成' }), { status: 503 });
  }

  const llm = createLlmClient({
    apiKey: apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
    baseURL: baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL,
    model: model || process.env.LLM_MODEL || 'gpt-3.5-turbo',
  });

  try {
    const result = await evalService.evaluate({
      query,
      topK,
      llm,
    });

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[Eval API Error]', error);
    return new Response(JSON.stringify({
      query: (query || '').trim(),
      answer: '',
      contexts: [],
      sources: [],
      searchMethod: 'error',
      numResults: 0,
      matchedEntities: [],
      error: (error as Error).message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
