// ============================================================
// 文档清洗器（CommonJS）
// 将原始 markdown 规范化为干净文本，不切分，只清理
// 供 clean-and-chunk.cjs / buildIndex.cjs 共用
//
// 清洗步骤：
//   1. 去除 YAML front matter
//   2. 去除 HTML 注释
//   3. 去除不可见字符（BOM、零宽字符、控制字符）
//   4. 空行规范化（连续 3+ 空行 → 2 行，首尾去空）
//   5. 全角/半角标点纠正（英文语境）
//   6. 清洗损失计算
// ============================================================

// 不可见字符正则
const RE_BOM = /^\uFEFF/;
const RE_ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF]/g;
const RE_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// YAML front matter（文件开头的 --- ... --- 块）
const RE_FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

// HTML 注释
const RE_HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * 清洗原始文档内容
 * @param {string} rawContent - 原始 markdown 文本
 * @param {object} [opts]
 * @param {boolean} [opts.stripFrontMatter=true]
 * @param {boolean} [opts.stripHtmlComments=true]
 * @param {boolean} [opts.stripInvisibleChars=true]
 * @param {boolean} [opts.normalizeBlankLines=true]
 * @param {boolean} [opts.normalizePunctuation=true]
 * @returns {{ content: string, originalLength: number, cleanedLength: number, cleaningRatio: number, warnings: string[] }}
 */
function cleanDocument(rawContent, opts = {}) {
  const {
    stripFrontMatter = true,
    stripHtmlComments = true,
    stripInvisibleChars = true,
    normalizeBlankLines = true,
    normalizePunctuation = true,
  } = opts;

  const originalLength = rawContent.length;
  const warnings = [];
  let content = rawContent;

  // 1. 去除 BOM
  content = content.replace(RE_BOM, '');

  // 2. 去除 YAML front matter
  if (stripFrontMatter) {
    const before = content.length;
    content = content.replace(RE_FRONT_MATTER, '');
    if (content.length < before) {
      warnings.push('stripped YAML front matter');
    }
  }

  // 3. 去除 HTML 注释
  if (stripHtmlComments) {
    content = content.replace(RE_HTML_COMMENT, '');
  }

  // 4. 去除不可见字符
  if (stripInvisibleChars) {
    const before = content.length;
    content = content.replace(RE_ZERO_WIDTH, '');
    content = content.replace(RE_CONTROL_CHARS, '');
    if (content.length < before) {
      warnings.push(`removed ${before - content.length} invisible chars`);
    }
  }

  // 5. 全角/半角标点纠正（仅在英文语境，不改中文标点）
  if (normalizePunctuation) {
    content = content.replace(/／/g, '/');
    content = content.replace(/：(?=[A-Za-z0-9])/g, ':');
    content = content.replace(/，(?=\d)/g, ',');
  }

  // 6. 空行规范化
  if (normalizeBlankLines) {
    // Windows 换行符统一
    content = content.replace(/\r\n/g, '\n');
    // 连续 3+ 空行 → 2 行
    content = content.replace(/\n{3,}/g, '\n\n');
    // 首尾空行去除
    content = content.replace(/^\n+/, '').replace(/\n+$/, '');
  }

  const cleanedLength = content.length;
  const cleaningRatio = originalLength > 0
    ? (originalLength - cleanedLength) / originalLength
    : 0;

  // 清洗损失超过 20% 告警
  if (cleaningRatio > 0.2) {
    warnings.push(`high cleaning ratio: ${(cleaningRatio * 100).toFixed(1)}%`);
  }

  return {
    content,
    originalLength,
    cleanedLength,
    cleaningRatio,
    warnings,
  };
}

/**
 * 清洗 Wiki 词条内容
 * 去除"出现频次: N"等元信息行，保留实际内容
 * @param {string} rawContent - Wiki 词条原始内容
 * @returns {string} 清洗后的内容
 */
function cleanWikiContent(rawContent) {
  let content = rawContent.replace(/\r\n/g, '\n');
  // 去除频次行
  content = content.replace(/^出现频次:\s*\d+\s*$/m, '');
  // 去除首尾空白
  content = content.trim();
  // 空行规范化
  content = content.replace(/\n{3,}/g, '\n\n');
  return content;
}

module.exports = {
  cleanDocument,
  cleanWikiContent,
};
