// ============================================================
// LLM 摘要模块（CommonJS）
// 使用 DashScope（qwen-plus）为 chunk 生成摘要、关键词和实体
// 供 summarize-chunks.cjs 使用
//
// 一次 LLM 调用同时返回：
//   - summary: 100-200 字自然语言摘要（用于 embedding）
//   - keywords: 3-5 个核心关键词（用于 BM25 增强）
//   - entities: [{name, type}] 实体列表（用于检索匹配）
// ============================================================

const fetch = require('node-fetch').default;

let _clientConfig = null;

/**
 * 获取 DashScope API 配置（复用 entityExtractor 模式）
 */
function getClientConfig() {
  if (_clientConfig) return _clientConfig;

  const useDashScope = process.env.DASHSCOPE_API_KEY && !process.env.DASHSCOPE_API_KEY.startsWith('sk-你的');
  _clientConfig = {
    apiKey: useDashScope ? process.env.DASHSCOPE_API_KEY : process.env.OPENAI_API_KEY,
    baseURL: useDashScope
      ? process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      : process.env.OPENAI_BASE_URL,
    model: useDashScope ? 'qwen-plus' : (process.env.LLM_MODEL || 'qwen-plus'),
  };
  return _clientConfig;
}

/**
 * 调用 LLM（带重试）
 */
async function callLLM(prompt, opts = {}) {
  const config = getClientConfig();
  const apiKey = opts.apiKey || config.apiKey;
  const baseURL = opts.baseURL || config.baseURL;
  const model = opts.model || config.model;
  const retries = opts.retries || 3;

  if (!apiKey) {
    throw new Error('LLM API Key 未配置');
  }

  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: '你是一个技术文档分析专家，擅长从企业技术文档中提取关键信息。输出格式为标准 JSON。',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 1500,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`LLM API error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      return data.choices[0]?.message?.content || '';
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  throw lastError;
}

/**
 * 实体类型（与 entityExtractor.cjs 保持一致）
 */
const ENTITY_TYPES = ['person', 'company', 'technology', 'concept', 'project', 'product', 'location', 'organization'];

/**
 * 解析 LLM 返回的 JSON
 */
function parseSummaryOutput(rawOutput) {
  try {
    // 提取 JSON 对象
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter(k => typeof k === 'string').map(k => k.trim())
        : [],
      entities: Array.isArray(parsed.entities)
        ? parsed.entities
            .filter(e => e.name && typeof e.name === 'string')
            .map(e => ({
              name: e.name.trim(),
              type: ENTITY_TYPES.includes(e.type) ? e.type : 'concept',
            }))
        : [],
    };
  } catch (err) {
    console.warn('  解析摘要输出失败:', err.message);
    return null;
  }
}

/**
 * 对单个 chunk 生成摘要、关键词和实体
 * @param {string} content - chunk 文本内容
 * @param {object} [opts]
 * @param {number} [opts.maxContentLength=3000] - 最大输入长度
 * @returns {Promise<{summary: string, keywords: string[], entities: Array<{name: string, type: string}>}>}
 */
async function summarizeChunk(content, opts = {}) {
  const maxContentLength = opts.maxContentLength || 3000;
  const truncatedContent = content.length > maxContentLength
    ? content.slice(0, maxContentLength) + '...'
    : content;

  const prompt = `请从以下技术文档文本中提取摘要、关键词和实体。

文本内容：
${truncatedContent}

输出要求（只输出 JSON，不要其他内容）：
{
  "summary": "100-200字的自然语言摘要，忠实概括核心内容，使用中文",
  "keywords": ["关键词1", "关键词2", "关键词3", "关键词4", "关键词5"],
  "entities": [
    {"name": "实体名", "type": "类型"}
  ]
}

规则：
1. summary 必须是连贯的自然语言段落，不要列点
2. keywords 提取 3-5 个核心术语（名词优先），不要包含停用词
3. entities 只提取文本中明确出现的实体，不要推断
4. type 可选值：person, company, technology, concept, project, product, location, organization
5. 如果文本太短或无意义，返回 {"summary": "", "keywords": [], "entities": []}`;

  const raw = await callLLM(prompt, opts);
  const result = parseSummaryOutput(raw);

  // 降级处理：如果解析失败，返回空结果
  return result || { summary: '', keywords: [], entities: [] };
}

/**
 * 批量生成摘要（带并发控制）
 * @param {Array<{id: string, content: string}>} chunks - 待摘要的 chunk 列表
 * @param {object} [opts]
 * @param {number} [opts.concurrency=5] - 并发数
 * @param {number} [opts.minContentLength=200] - 最小内容长度（低于此值跳过）
 * @param {function} [opts.onProgress] - 进度回调
 * @returns {Promise<Map<string, {summary: string, keywords: string[], entities: Array}>>}
 */
async function summarizeChunksBatch(chunks, opts = {}) {
  const concurrency = opts.concurrency || 5;
  const minContentLength = opts.minContentLength || 200;
  const onProgress = opts.onProgress || (() => {});

  // 过滤短 chunk
  const chunksToProcess = chunks.filter(c => c.content && c.content.length >= minContentLength);
  const skippedCount = chunks.length - chunksToProcess.length;
  if (skippedCount > 0) {
    console.log(`  跳过 ${skippedCount} 个短 chunk（< ${minContentLength} 字符）`);
  }

  const results = new Map();
  let done = 0;
  let errors = 0;

  // 并发执行
  const queue = [...chunksToProcess];
  const workers = [];

  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const chunk = queue.shift();
        if (!chunk) break;

        try {
          const result = await summarizeChunk(chunk.content, opts);
          results.set(chunk.id, result);
        } catch (err) {
          console.warn(`\n  ⚠️ chunk ${chunk.id} 摘要失败: ${err.message}`);
          errors++;
          results.set(chunk.id, { summary: '', keywords: [], entities: [] });
        }

        done++;
        onProgress(done, chunksToProcess.length);
      }
    })());
  }

  await Promise.all(workers);

  return { results, errors };
}

/**
 * 检查摘要模块是否可用
 */
function isSummarizerAvailable() {
  const config = getClientConfig();
  return config.apiKey && !config.apiKey.startsWith('sk-你的');
}

module.exports = {
  summarizeChunk,
  summarizeChunksBatch,
  isSummarizerAvailable,
  getClientConfig,
  parseSummaryOutput,
};
