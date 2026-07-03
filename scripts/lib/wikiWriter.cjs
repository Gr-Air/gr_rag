// ============================================================
// Wiki 词条写入器（CommonJS）
// 将 LLM 提取的实体/概念写入 Wiki/entity 和 Wiki/concept 目录
// 格式与现有词条保持一致，并增加定义字段
//
// 供 extract-entities.cjs 使用
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const WIKI_CONCEPT_DIR = path.join(ROOT, 'Wiki', 'concept');
const WIKI_ENTITY_DIR = path.join(ROOT, 'Wiki', 'entity');

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function readExistingFrequency(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/出现频次:\s*(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

/**
 * 写入或更新 Wiki 词条
 */
function writeWikiEntry(name, type, definition, frequency) {
  const dir = type === 'entity' ? WIKI_ENTITY_DIR : WIKI_CONCEPT_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const safeName = sanitizeName(name);
  const filePath = path.join(dir, `${safeName}.md`);
  const isExisting = fs.existsSync(filePath);
  const typeLabel = type === 'entity' ? '实体' : '概念';

  const oldFreq = readExistingFrequency(filePath);
  const newFreq = Math.max(oldFreq, frequency);

  let content = `# ${name}\n\n> ${typeLabel} | 出现频次: ${newFreq}\n`;
  if (definition && definition.length > 0) {
    content += `> 定义: ${definition}\n`;
  }
  content += `> 来源: LLM提取\n\n`;

  fs.writeFileSync(filePath, content, 'utf-8');

  return {
    path: `Wiki/${type}/${safeName}.md`,
    action: isExisting ? 'updated' : 'created',
  };
}

/**
 * 批量写入 Wiki 词条
 */
function writeAllWikiEntries(entityMap, conceptMap, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  let created = 0;
  let updated = 0;
  let total = 0;

  for (const [name, info] of entityMap) {
    const frequency = info.sources.length;
    const result = writeWikiEntry(name, 'entity', info.definition, frequency);
    if (result.action === 'created') created++;
    else updated++;
    total++;
    onProgress(total, entityMap.size + conceptMap.size);
  }

  for (const [name, info] of conceptMap) {
    const frequency = info.sources.length;
    const result = writeWikiEntry(name, 'concept', info.definition, frequency);
    if (result.action === 'created') created++;
    else updated++;
    total++;
    onProgress(total, entityMap.size + conceptMap.size);
  }

  return { created, updated, total };
}

/**
 * 获取已有的 Wiki 词条名称集合
 */
function getExistingWikiNames() {
  const concepts = new Set();
  const entities = new Set();

  if (fs.existsSync(WIKI_CONCEPT_DIR)) {
    for (const f of fs.readdirSync(WIKI_CONCEPT_DIR)) {
      if (f.endsWith('.md')) concepts.add(f.replace(/\.md$/, ''));
    }
  }

  if (fs.existsSync(WIKI_ENTITY_DIR)) {
    for (const f of fs.readdirSync(WIKI_ENTITY_DIR)) {
      if (f.endsWith('.md')) entities.add(f.replace(/\.md$/, ''));
    }
  }

  return { concepts, entities };
}

module.exports = {
  writeWikiEntry,
  writeAllWikiEntries,
  getExistingWikiNames,
  WIKI_CONCEPT_DIR,
  WIKI_ENTITY_DIR,
};
