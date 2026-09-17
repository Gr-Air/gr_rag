// ============================================================
// 文件扫描器（CommonJS）
// 统一扫描 Raw/ 和 Wiki/ 目录，供 buildIndex/buildIncremental 共用
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const RAW_DIR = path.join(ROOT, 'Raw');
const WIKI_DIR = path.join(ROOT, 'Wiki');

/**
 * 扫描 Raw 目录下的所有 .md 文档
 * @returns {Array<{ file: string, content: string, key: string }>}
 */
function scanRawDocuments() {
  const results = [];
  if (!fs.existsSync(RAW_DIR)) return results;

  for (const f of fs.readdirSync(RAW_DIR)) {
    if (!f.endsWith('.md')) continue;
    const filePath = path.join(RAW_DIR, f);
    const content = fs.readFileSync(filePath, 'utf-8');
    results.push({
      file: `Raw/${f}`,
      content,
      key: `raw_${f.replace(/\.md$/, '')}`,
    });
  }
  return results;
}

/**
 * 扫描 Wiki 目录下的所有词条
 * @returns {Array<{ file: string, content: string, key: string, name: string, type: 'concept'|'entity' }>}
 */
function scanWikiEntries() {
  const results = [];
  for (const sub of ['concept', 'entity']) {
    const dir = path.join(WIKI_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const filePath = path.join(dir, f);
      const content = fs.readFileSync(filePath, 'utf-8');
      const name = f.replace(/\.md$/, '');
      results.push({
        file: `Wiki/${sub}/${f}`,
        content,
        key: `wiki_${name}`,
        name,
        type: sub,
      });
    }
  }
  return results;
}

/**
 * 扫描所有文件（Raw + Wiki）
 * @returns {{ rawDocs: Array, wikiEntries: Array }}
 */
function scanAll() {
  return {
    rawDocs: scanRawDocuments(),
    wikiEntries: scanWikiEntries(),
  };
}

module.exports = {
  ROOT,
  RAW_DIR,
  WIKI_DIR,
  scanRawDocuments,
  scanWikiEntries,
  scanAll,
};
