// ============================================================
// Wiki 反向链接标注核心库（CommonJS）
//
// 功能：
// - loadWikiEntries(): 从 Wiki/entity + Wiki/concept 加载词条名
// - linkFile(): 占位符法反向标注（将纯文本词条替换为 [[词条]]）
// - checkMissing(): 检查遗漏未包裹的词条
//
// 供 link-entities.cjs 流水线脚本使用
// ============================================================

const fs = require('fs');
const path = require('path');

// scripts/lib/linker.cjs → scripts/lib → scripts → llm-wiki → (root)
const ROOT = path.join(__dirname, '..', '..', '..');
const WIKI_DIR = path.join(ROOT, 'Wiki');
const RAW_DIR = path.join(ROOT, 'Raw');

// ============================================================
// 1. 加载 Wiki 词条
// ============================================================

/**
 * 从 Wiki/entity 和 Wiki/concept 目录加载所有词条名称
 * 按长度降序排列，确保长名称优先匹配（避免子串问题）
 *
 * @returns {Array<{name: string, type: 'entity'|'concept'}>}
 */
function loadWikiEntries() {
  /** @type {Array<{name: string, type: 'entity'|'concept'}>} */
  const entries = [];

  for (const sub of ['entity', 'concept']) {
    const dir = path.join(WIKI_DIR, sub);
    if (!fs.existsSync(dir)) continue;

    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.replace(/\.md$/, '');
      if (name) {
        entries.push({ name, type: /** @type {'entity'|'concept'} */ (sub) });
      }
    }
  }

  // 按长度降序排列，长度相同时按字母序
  entries.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
  return entries;
}

// ============================================================
// 2. 占位符法反向标注
// ============================================================

/**
 * 对单个 Raw 文档执行占位符法反向标注。
 *
 * 算法：
 * 1. 将已有 [[...]] 替换为唯一占位符（避免破坏已有链接）
 * 2. 在剩余纯文本中按词条名匹配并包裹为 [[词条]]
 * 3. 恢复占位符
 *
 * @param {string} filePath - Raw 文档的完整路径
 * @param {Array<{name: string, type: string}>} entries - 词条列表（已按长度降序）
 * @param {{ dryRun?: boolean }} [opts] - 选项
 * @returns {{ changed: boolean, linkedCount: number, linkedNames: string[], newContent?: string }}
 */
function linkFile(filePath, entries, opts = {}) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const original = content;
  let linkedCount = 0;
  /** @type {string[]} */
  const linkedNames = [];

  // Step 1: 将已有 [[...]] 替换为占位符
  const phMap = new Map();
  let counter = 0;

  let text = content.replace(/\[\[[^\]]+\]\]/g, (match) => {
    const ph = `__WLPH_${counter}__`;
    phMap.set(ph, match);
    counter++;
    return ph;
  });

  // Step 2: 逐词条在剩余文本中查找并包裹为 [[词条]]
  // 每轮替换后动态检测当前 text 中的 [[...]] 位置，跳过已包裹的区域
  for (const { name } of entries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 纯 ASCII + 以单词字符首尾 → 用 \b 边界；含特殊字符或中文 → 直接匹配
    const isPureAscii = /^[\x00-\x7F]+$/.test(name);
    const useBoundary = isPureAscii && /^\w/.test(name) && /\w$/.test(name);
    const pattern = useBoundary
      ? new RegExp('\\b' + escaped + '\\b', 'g')
      : new RegExp(escaped, 'g');

    // 先收集当前 text 中所有 [[...]] 的区间
    const wikiSpans = [];
    const linkRegex = /\[\[[^\]]+\]\]/g;
    let lm;
    while ((lm = linkRegex.exec(text)) !== null) {
      wikiSpans.push({ s: lm.index, e: lm.index + lm[0].length });
    }

    // 检查位置是否在某个 [[...]] 内部
    function isInsideWiki(pos) {
      for (const span of wikiSpans) {
        if (span.s <= pos && pos < span.e) return true;
      }
      return false;
    }

    // 收集需要替换的位置（跳过已在 [[...]] 内的匹配）
    /** @type {Array<{start: number, end: number}>} */
    const toReplace = [];
    let pm;
    while ((pm = pattern.exec(text)) !== null) {
      if (!isInsideWiki(pm.index) && !isInsideWiki(pm.index + pm[0].length - 1)) {
        toReplace.push({ start: pm.index, end: pm.index + pm[0].length });
      }
    }

    if (toReplace.length > 0) {
      // 从后往前替换，避免位置偏移
      let newText = '';
      let lastEnd = 0;
      for (const rp of toReplace) {
        newText += text.slice(lastEnd, rp.start) + `[[${name}]]`;
        lastEnd = rp.end;
      }
      newText += text.slice(lastEnd);
      text = newText;

      linkedCount++;
      linkedNames.push(name);
    }
  }

  // Step 3: 恢复占位符
  for (const [ph, orig] of phMap) {
    text = text.replace(ph, orig);
  }

  const changed = text !== original;

  // 写回文件（dry-run 模式不写入）
  if (changed && !opts.dryRun) {
    fs.writeFileSync(filePath, text, 'utf-8');
  }

  return {
    changed,
    linkedCount,
    linkedNames,
    newContent: changed ? text : undefined,
  };
}

// ============================================================
// 3. 遗漏检查
// ============================================================

/**
 * 检查文件中是否有遗漏未包裹的纯文本词条
 * 排除已在 [[...]] 内部的匹配
 *
 * @param {string} filePath - Raw 文档路径
 * @param {Array<{name: string, type: string}>} entries - 词条列表
 * @returns {{ missingCount: number, missingNames: string[] }}
 */
function checkMissing(filePath, entries) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // 收集所有 [[...]] 链接的区间
  /** @type {Array<{start: number, end: number}>} */
  const wikiSpans = [];
  const linkRegex = /\[\[[^\]]+\]\]/g;
  let m;
  while ((m = linkRegex.exec(content)) !== null) {
    wikiSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  /**
   * 检查位置 pos 是否在某个 [[...]] 区间内
   * @param {number} pos
   * @returns {boolean}
   */
  function isInside(pos) {
    for (const span of wikiSpans) {
      if (span.start <= pos && pos < span.end) return true;
    }
    return false;
  }

  /** @type {string[]} */
  const missingNames = [];

  for (const { name } of entries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 纯 ASCII + 以单词字符首尾 → 用 \b 边界；含特殊字符或中文 → 直接匹配
    const isPureAscii = /^[\x00-\x7F]+$/.test(name);
    const useBoundary = isPureAscii && /^\w/.test(name) && /\w$/.test(name);
    const pattern = useBoundary
      ? new RegExp('\\b' + escaped + '\\b', 'g')
      : new RegExp(escaped, 'g');

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // 检查起始和结束位置是否都在 wiki 链接内部
      if (isInside(start) && isInside(end - 1)) {
        continue; // 已在 [[...]] 内部，不是遗漏
      }

      missingNames.push(name);
      break; // 每个词条只报告一次
    }
  }

  return {
    missingCount: missingNames.length,
    missingNames,
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  ROOT,
  WIKI_DIR,
  RAW_DIR,
  loadWikiEntries,
  linkFile,
  checkMissing,
};
