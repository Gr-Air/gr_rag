// ============================================================
// 中间存储读写器（CommonJS）
// 管理 chunks_staging/ 目录下的 JSONL 文件和清单
// 供 clean-and-chunk.cjs / build-from-staging.cjs / inspect-chunks.cjs 共用
//
// 目录结构：
//   src/data/chunks_staging/
//   ├── chunks.jsonl           # 每行一个 chunk
//   ├── manifest.json          # 构建清单
//   └── quality_report.json    # 质量报告
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STAGING_DIR = path.join(__dirname, '..', '..', 'src', 'data', 'chunks_staging');
const CHUNKS_FILE = path.join(STAGING_DIR, 'chunks.jsonl');
const MANIFEST_FILE = path.join(STAGING_DIR, 'manifest.json');
const QUALITY_FILE = path.join(STAGING_DIR, 'quality_report.json');

/**
 * 获取 git commit hash（短）
 * @returns {string}
 */
function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * 确保目录存在
 */
function ensureStagingDir() {
  if (!fs.existsSync(STAGING_DIR)) {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  }
}

/**
 * 判断 staging 是否存在（用于降级策略）
 * @returns {boolean}
 */
function stagingExists() {
  return fs.existsSync(CHUNKS_FILE) && fs.existsSync(MANIFEST_FILE);
}

/**
 * 写入全部 chunks 到 JSONL 文件（全量重写）
 * @param {Array} chunks - chunk 对象数组
 */
function writeStaging(chunks) {
  ensureStagingDir();
  const lines = chunks.map(c => JSON.stringify(c));
  fs.writeFileSync(CHUNKS_FILE, lines.join('\n') + '\n', 'utf-8');
}

/**
 * 流式读取 chunks.jsonl
 * @param {function(chunk: object): boolean} [callback] - 每读到一条 chunk 调用，返回 false 可提前终止
 * @returns {Array} 所有 chunk（如果未传 callback）
 */
function readStaging(callback) {
  if (!fs.existsSync(CHUNKS_FILE)) {
    if (callback) return;
    return [];
  }

  const content = fs.readFileSync(CHUNKS_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  if (callback) {
    for (const line of lines) {
      const chunk = JSON.parse(line);
      if (callback(chunk) === false) break;
    }
    return;
  }

  return lines.map(line => JSON.parse(line));
}

/**
 * 按 docId 过滤 chunks
 * @param {string} docId - 文档 ID（如 raw_xxx 或 wiki_xxx）
 * @returns {Array}
 */
function getChunksByDocId(docId) {
  const results = [];
  readStaging(chunk => {
    if (chunk.docId === docId || chunk.parentDocId === `parent_${docId}`) {
      results.push(chunk);
    }
  });
  return results;
}

/**
 * 按 parentDocId 过滤并移除旧 chunk，追加新 chunk（增量更新）
 * @param {string[]} removeDocIds - 要移除的 parentDocId 列表
 * @param {Array} newChunks - 要追加的新 chunk
 */
function updateStaging(removeDocIds, newChunks) {
  ensureStagingDir();

  // 读取旧 chunks，过滤掉要移除的
  const kept = [];
  if (fs.existsSync(CHUNKS_FILE)) {
    const content = fs.readFileSync(CHUNKS_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      const chunk = JSON.parse(line);
      const docId = chunk.parentDocId
        ? chunk.parentDocId.replace(/^parent_/, '')
        : chunk.docId;
      if (!removeDocIds.includes(docId)) {
        kept.push(chunk);
      }
    }
  }

  // 合并并重写
  const all = [...kept, ...newChunks];
  writeStaging(all);
  return all;
}

/**
 * 写入 manifest.json
 * @param {object} info
 * @param {number} info.totalChunks
 * @param {number} info.totalDocs
 * @param {string[]} info.sourceFiles
 * @param {object} info.chunkConfig
 * @param {string} [info.pipelineVersion='1.0.0']
 */
function writeManifest(info) {
  ensureStagingDir();
  const manifest = {
    pipelineVersion: info.pipelineVersion || '1.0.0',
    totalChunks: info.totalChunks,
    totalDocs: info.totalDocs,
    sourceFiles: info.sourceFiles,
    chunkConfig: info.chunkConfig,
    builtAt: new Date().toISOString(),
    gitCommit: getGitCommit(),
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * 读取 manifest.json
 * @returns {object|null}
 */
function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'));
}

/**
 * 写入质量报告
 * @param {object} report
 */
function writeQualityReport(report) {
  ensureStagingDir();
  fs.writeFileSync(QUALITY_FILE, JSON.stringify(report, null, 2), 'utf-8');
}

/**
 * 读取质量报告
 * @returns {object|null}
 */
function readQualityReport() {
  if (!fs.existsSync(QUALITY_FILE)) return null;
  return JSON.parse(fs.readFileSync(QUALITY_FILE, 'utf-8'));
}

module.exports = {
  STAGING_DIR,
  CHUNKS_FILE,
  MANIFEST_FILE,
  QUALITY_FILE,
  stagingExists,
  writeStaging,
  readStaging,
  getChunksByDocId,
  updateStaging,
  writeManifest,
  readManifest,
  writeQualityReport,
  readQualityReport,
  getGitCommit,
};
