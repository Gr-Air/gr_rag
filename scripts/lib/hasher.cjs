// ============================================================
// 文件 Hash 工具（CommonJS）
// 供 buildIndex / buildIncremental 共用
// ============================================================

const crypto = require('crypto');
const fs = require('fs');

/**
 * 计算内容的 MD5 hash
 * @param {string} content
 * @returns {string}
 */
function fileHash(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * 批量计算文件 hash，返回 key → hash 的映射
 * @param {Array<{ key: string, content: string }>} files
 * @returns {Record<string, string>}
 */
function buildStateSnapshot(files) {
  const state = {};
  for (const f of files) {
    state[f.key] = fileHash(f.content);
  }
  return state;
}

module.exports = {
  fileHash,
  buildStateSnapshot,
};
