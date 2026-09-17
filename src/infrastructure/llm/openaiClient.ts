// ============================================================
// OpenAI 兼容 LLM Client（Infrastructure 层）
// 实现 Application 层的 LlmClient Port：
//   - complete：一次性补全（query 改写 / 会话压缩）
//   - stream：流式补全（RAG 回答），逐段 yield content
// 推理模型（deepseek-r1 等）不兼容 temperature 参数，此处统一处理
//
// Spec 035-B1：配置在构造时绑定（createLlmClient 工厂），
// Application 层不再碰 apiKey/baseURL/model
// ============================================================

import OpenAI from 'openai';
import type {
  LlmClient,
  LlmClientConfig,
  LlmCompleteRequest,
  LlmStreamRequest,
} from '@/application/ports';
import { isReasoningModel } from '@/domain/llm';

export class OpenAiLlmClient implements LlmClient {
  readonly available: boolean;

  constructor(private config: LlmClientConfig) {
    this.available = !!config.apiKey;
  }

  async complete(req: LlmCompleteRequest): Promise<string | null> {
    if (!this.available) return null;

    const client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || undefined,
    });

    const reasoning = isReasoningModel(this.config.model);

    const response = await client.chat.completions.create({
      model: this.config.model,
      messages: req.messages,
      ...(reasoning ? {} : {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      }),
    });

    const content = response.choices[0]?.message?.content || null;

    if (!content) {
      const reasonLen = (response.choices[0]?.message as { reasoning_content?: string } | null | undefined)?.reasoning_content?.length || 0;
      if (reasonLen > 0) {
        console.warn(`[LlmClient] content 为空 (reasoning_content 长度: ${reasonLen})`);
      }
    }

    return content;
  }

  async *stream(req: LlmStreamRequest): AsyncGenerator<string> {
    if (!this.available) return;

    const client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || undefined,
    });

    const reasoning = isReasoningModel(this.config.model);

    const stream = await client.chat.completions.create({
      model: this.config.model,
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

/** 无 API Key 时的降级实现（complete 返回 null，stream 不 yield） */
export class NoopLlmClient implements LlmClient {
  readonly available = false;
  async complete(): Promise<string | null> {
    return null;
  }
  async *stream(): AsyncGenerator<string> {
    // 不 yield 任何内容，调用方据此降级
  }
}

/**
 * LLM 客户端工厂（Composition/Presentation 层调用）
 * 无 apiKey 时返回 NoopLlmClient
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  if (!config.apiKey) return new NoopLlmClient();
  return new OpenAiLlmClient(config);
}
