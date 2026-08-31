// ============================================================
// 阿里云 DashScope Embedding API 调用模块
// 支持 TypeScript（运行时）和 CommonJS（构建脚本）
// ============================================================

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v4';
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1024', 10);

// DashScope Text Embedding API endpoint
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';

interface EmbeddingResponse {
  output: {
    embeddings: Array<{ embedding: number[]; text_index: number }>;
  };
}

/**
 * 调用阿里 DashScope API 获取文本向量
 * 支持批量调用（最多 25 条/次）
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY.startsWith('sk-你的')) {
    throw new Error('DASHSCOPE_API_KEY 未配置，请在 .env 中设置有效的 API Key');
  }

  const results: number[][] = [];
  const BATCH_SIZE = 10; // DashScope text-embedding-v4 限制单次最多 10 条

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetch(DASHSCOPE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: { texts: batch },
        parameters: { text_type: 'document' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DashScope API error (${response.status}): ${errText}`);
    }

    const data: EmbeddingResponse = await response.json();
    for (const emb of data.output.embeddings) {
      results.push(emb.embedding);
    }
  }

  return results;
}

/**
 * 获取单条文本的向量（用于 query embedding）
 */
export async function getQueryEmbedding(text: string): Promise<number[]> {
  if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY.startsWith('sk-你的')) {
    throw new Error('DASHSCOPE_API_KEY 未配置，请在 .env 中设置有效的 API Key');
  }

  const response = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: { texts: [text] },
      parameters: { text_type: 'query' },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DashScope API error (${response.status}): ${errText}`);
  }

  const data: EmbeddingResponse = await response.json();
  return data.output.embeddings[0].embedding;
}

/**
 * 获取向量维度
 */
export function getEmbeddingDim(): number {
  return EMBEDDING_DIM;
}
