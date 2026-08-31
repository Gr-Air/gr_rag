// ============================================================
// OpenAI 兼容 LLM Client（Infrastructure 层）
// 实现 Application 层的 LlmClient Port：
//   - complete：一次性补全（query 改写 / 会话压缩）
//   - stream：流式补全（RAG 回答），逐段 yield content
// 推理模型（deepseek-r1 等）不兼容 temperature 参数，此处统一处理
// ============================================================

import OpenAI from 'openai';
import type {
  LlmClient,
  LlmCompleteRequest,
  LlmStreamRequest,
} from '@/application/ports';

export class OpenAiLlmClient implements LlmClient {
  async complete(req: LlmCompleteRequest): Promise<string | null> {
    const client = new OpenAI({
      apiKey: req.apiKey,
      baseURL: req.baseURL || undefined,
    });

    const reasoning = isReasoning(req.model);

    const response = await client.chat.completions.create({
      model: req.model,
      messages: req.messages,
      // 推理模型：不设 temperature/max_tokens 让模型自然结束
      ...(reasoning ? {} : {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      }),
    });

    const content = response.choices[0]?.message?.content || null;

    // 推理模型有时 content 为空（max_tokens 不足时 token 消耗在 reasoning_content 上）
    if (!content) {
      const reasonLen = (response.choices[0]?.message as { reasoning_content?: string } | null | undefined)?.reasoning_content?.length || 0;
      if (reasonLen > 0) {
        console.warn(`[LlmClient] content 为空 (reasoning_content 长度: ${reasonLen})`);
      }
    }

    return content;
  }

  async *stream(req: LlmStreamRequest): AsyncGenerator<string> {
    const client = new OpenAI({
      apiKey: req.apiKey,
      baseURL: req.baseURL || undefined,
    });

    const reasoning = isReasoning(req.model);

    const stream = await client.chat.completions.create({
      model: req.model,
      messages: req.messages,
      stream: true,
      ...(reasoning ? {} : { temperature: req.temperature ?? 0.3 }),
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      const content = delta.content;
      if (content) {
        yield content;
      }
    }
  }
}

/** 推理模型（如 deepseek-r1）不兼容 temperature 参数 */
function isReasoning(model: string): boolean {
  return model.toLowerCase().includes('reasoning') || model.toLowerCase().includes('deepseek-r1');
}
