// ============================================================
// Embedding Port 适配器（Infrastructure 层）
// 实现 Application 层的 EmbeddingPort：
//   - embed：查询向量生成（内部缓存）
//   - prewarm：预热缓存，避免向量检索时重复调用 embedding API
// ============================================================

import type { EmbeddingPort } from '@/application/ports';
import { getQueryEmbedding } from './embedding';
import { prewarmQueryEmbedding } from '../vector/vectorEngine';

export const queryEmbeddingPort: EmbeddingPort = {
  embed: getQueryEmbedding,
  prewarm: prewarmQueryEmbedding,
};
