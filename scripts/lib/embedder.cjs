// ============================================================
// Embedding 调用工具（CommonJS）
// 阿里云 DashScope API 批量调用，供 buildIndex / buildIncremental 共用
// ============================================================

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v4';
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';

/**
 * 批量调用 DashScope Embedding API
 * @param {string[]} texts - 待向量化的文本数组
 * @returns {Promise<number[][]>} 向量数组
 */
async function getEmbeddingsBatch(texts) {
  const BATCH_SIZE = 10; // DashScope text-embedding-v4 限制单次最多 10 条
  const results = [];

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

    const data = await response.json();
    for (const emb of data.output.embeddings) {
      results.push(emb.embedding);
    }

    console.log(`  Embedding: ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
  }

  return results;
}

module.exports = {
  getEmbeddingsBatch,
  DASHSCOPE_API_KEY,
  EMBEDDING_MODEL,
  DASHSCOPE_URL,
};
