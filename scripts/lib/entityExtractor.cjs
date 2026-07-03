// ============================================================
// LLM 实体提取模块
// 使用阿里百炼平台的 LLM 从文档 chunk 中提取实体和概念
// ============================================================

const fetch = require('node-fetch').default;

let _clientConfig = null;

function getClientConfig() {
  if (_clientConfig) return _clientConfig;
  
  const useDashScope = process.env.DASHSCOPE_API_KEY && !process.env.DASHSCOPE_API_KEY.startsWith('sk-你的');
  _clientConfig = {
    apiKey: useDashScope ? process.env.DASHSCOPE_API_KEY : process.env.OPENAI_API_KEY,
    baseURL: useDashScope ? process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1' : process.env.OPENAI_BASE_URL,
    model: useDashScope ? 'qwen-plus' : (process.env.LLM_MODEL || 'qwen-plus'),
  };
  return _clientConfig;
}

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
              content: '你是一个专业的实体提取专家。请从文本中提取人名、公司名、技术名词、项目名、产品名等实体。',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 2000,
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

const ENTITY_TYPES = ['person', 'company', 'technology', 'concept', 'project', 'product', 'location', 'organization'];

function parseEntities(rawOutput) {
  try {
    const jsonMatch = rawOutput.match(/\[([\s\S]*)\]/);
    if (jsonMatch) {
      const jsonStr = `[${jsonMatch[1]}]`;
      const entities = JSON.parse(jsonStr);
      return entities
        .filter(e => e.name && typeof e.name === 'string')
        .map(e => ({
          name: e.name.trim(),
          type: ENTITY_TYPES.includes(e.type) ? e.type : 'concept',
          definition: e.definition ? e.definition.trim() : '',
          attributes: e.attributes || {},
        }));
    }
  } catch (err) {
    console.warn('解析实体失败:', err.message);
  }
  return [];
}

async function extractEntitiesFromChunk(content, opts = {}) {
  const maxContentLength = opts.maxContentLength || 3000;
  const truncatedContent = content.length > maxContentLength 
    ? content.slice(0, maxContentLength) + '...' 
    : content;

  const prompt = `请从以下文本中提取实体和概念，返回 JSON 数组格式。

文本内容：
${truncatedContent}

提取规则：
1. 提取人名、公司名、技术名词、项目名、产品名、地点、组织
2. 每个实体包含：name（名称）、type（类型）、definition（一句话定义，可选）
3. type 可选值：person, company, technology, concept, project, product, location, organization
4. 只提取文本中明确出现的实体，不要推断
5. 优先提取具有业务价值的实体，忽略通用词汇

输出格式（只输出 JSON，不要其他内容）：
[{"name": "中信证券", "type": "company", "definition": "中国头部证券公司"}]`;

  const raw = await callLLM(prompt, opts);
  return parseEntities(raw);
}

async function generateEntityDefinition(entityName, context, opts = {}) {
  const prompt = `请为以下实体生成简短但准确的定义，用于企业知识库。

实体名称：${entityName}

相关上下文（该实体出现的文档片段）：
${context.slice(0, 1000)}

要求：
1. 用一句话清晰定义该实体
2. 语言专业但不晦涩
3. 长度控制在 50-150 字之间
4. 只输出定义文本，不要其他内容`;

  const raw = await callLLM(prompt, opts);
  return raw.trim();
}

function isEntityExtractorAvailable() {
  const config = getClientConfig();
  return config.apiKey && !config.apiKey.startsWith('sk-你的');
}

module.exports = {
  extractEntitiesFromChunk,
  generateEntityDefinition,
  isEntityExtractorAvailable,
  getClientConfig,
};