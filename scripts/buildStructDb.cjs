// ============================================================
// 结构化数据库构建脚本（两表结构 + LLM 实体提取）
// 从 Wiki/concept 和 Wiki/entity 中解析词条，扫描 chunks_meta 中的 wikiLinks
// 构建 entity-chunk 关联关系并存入 SQLite 数据库
//
// 两表结构：
//   entries（词条表）- 实体/概念元信息
//   entry_chunks（关联表）- 实体 ↔ chunk 直接关联
//
// LLM 实体提取：
//   - 对未标注 wikiLinks 的 chunk 调用 LLM 提取实体
//   - 为重要实体生成定义和属性
//
// 用法:
//   node scripts/buildStructDb.cjs
//   node scripts/buildStructDb.cjs --no-llm      # 跳过 LLM 提取
//   node scripts/buildStructDb.cjs --llm-only    # 只做 LLM 提取（增量更新）
//   node scripts/buildStructDb.cjs --concurrency 5    # LLM 并发数
// ============================================================

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const WIKI_DIR = path.join(ROOT, 'Wiki');
const DB_PATH = path.join(__dirname, '..', 'src', 'data', 'struct_kb.db');
const CHUNKS_META_DIR = path.join(__dirname, '..', 'src', 'data', 'chunks_meta');

require('./lib/envLoader.cjs').loadEnv();

const { extractEntitiesFromChunk, generateEntityDefinition, isEntityExtractorAvailable } = require('./lib/entityExtractor.cjs');

// ============================================================
// 1. 解析 Wiki 词条（概念 + 实体）
// ============================================================

function loadWikiEntries() {
  const entries = [];

  for (const sub of ['concept', 'entity']) {
    const dir = path.join(WIKI_DIR, sub);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;

      const name = file.replace(/\.md$/, '');
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');

      let category = '';
      const catMatch = content.match(/^>\s*(.+?)\s*\|/m);
      if (catMatch) category = catMatch[1].trim();

      let frequency = 0;
      const freqMatch = content.match(/出现频次:\s*(\d+)/);
      if (freqMatch) frequency = parseInt(freqMatch[1]);

      let definition = '';
      const defMatch = content.match(/> 定义:\s*(.+)/);
      if (defMatch) definition = defMatch[1].trim();

      entries.push({
        name,
        type: sub,
        category: category || sub,
        frequency,
        path: `Wiki/${sub}/${file}`,
        definition,
        attributes: '{}',
        source: 'wiki',
      });
    }
  }

  return entries;
}

// ============================================================
// 2. 加载 chunks_meta，提取 wikiLinks
// ============================================================

function loadChunksMeta() {
  const configPath = path.join(CHUNKS_META_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.warn('  chunks_meta/config.json 不存在，跳过 chunk 级关联');
    return {};
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const allChunks = {};

  for (let s = 0; s < config.totalShards; s++) {
    const shardPath = path.join(CHUNKS_META_DIR, `shard_${s}.json`);
    if (!fs.existsSync(shardPath)) continue;
    const shard = JSON.parse(fs.readFileSync(shardPath, 'utf-8'));
    Object.assign(allChunks, shard);
  }

  return allChunks;
}

// ============================================================
// 3. 建立关联关系矩阵（wikiLinks 正则提取）
// ============================================================

function buildRelations(entries, allChunks) {
  const entryNameSet = new Set(entries.map(e => e.name));

  /** @type {Map<string, Array<{chunkId: string, context: string}>>} */
  const entryToChunks = new Map();
  for (const entry of entries) {
    entryToChunks.set(entry.name, []);
  }

  for (const [chunkId, chunk] of Object.entries(allChunks)) {
    if (!chunk.wikiLinks || chunk.wikiLinks.length === 0) continue;

    for (const link of chunk.wikiLinks) {
      if (entryNameSet.has(link)) {
        const context = (chunk.content || '').slice(0, 200).replace(/\n/g, ' ').trim();
        entryToChunks.get(link).push({ chunkId, context });
      }
    }
  }

  return { entryToChunks, entryNameSet };
}

// ============================================================
// 4. LLM 实体提取（发现新实体 + 生成定义）
// ============================================================

async function extractEntitiesWithLLM(allChunks, existingEntries, opts = {}) {
  if (!isEntityExtractorAvailable()) {
    console.log('  LLM 实体提取已跳过（未配置 API Key）');
    return { newEntries: [], newRelations: new Map(), updatedDefinitions: {} };
  }

  const concurrency = opts.concurrency || 3;
  const minFrequencyForDefinition = opts.minFrequencyForDefinition || 5;
  const existingNames = new Set(existingEntries.map(e => e.name));
  const existingLowerNames = new Set(existingEntries.map(e => e.name.toLowerCase()));

  /** @type {Map<string, Array<{chunkId: string, context: string}>>} */
  const llmEntityToChunks = new Map();
  /** @type {Map<string, {type: string, definition: string, count: number}>} */
  const llmEntityInfo = new Map();

  const rawChunkEntries = Object.entries(allChunks).filter(
    ([chunkId]) => chunkId.startsWith('raw_')
  );

  console.log(`  待 LLM 提取的 chunk 数: ${rawChunkEntries.length} (Raw 文档)`);

  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < rawChunkEntries.length; i += concurrency) {
    const batch = rawChunkEntries.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async ([chunkId, chunk]) => {
        const entities = await extractEntitiesFromChunk(chunk.content || '');
        const context = (chunk.content || '').slice(0, 200).replace(/\n/g, ' ').trim();
        return { chunkId, entities, context };
      })
    );

    for (const r of batchResults) {
      completed++;
      if (r.status === 'fulfilled') {
        succeeded++;
        for (const entity of r.value.entities) {
          const name = entity.name;
          const lowerName = name.toLowerCase();

          if (existingLowerNames.has(lowerName)) continue;

          if (!llmEntityInfo.has(name)) {
            llmEntityInfo.set(name, {
              type: entity.type === 'concept' ? 'concept' : 'entity',
              definition: entity.definition,
              count: 0,
            });
          }

          const info = llmEntityInfo.get(name);
          info.count++;
          if (!entity.definition && info.definition) {
            info.definition = entity.definition;
          }

          if (!llmEntityToChunks.has(name)) {
            llmEntityToChunks.set(name, []);
          }
          llmEntityToChunks.get(name).push({ chunkId: r.value.chunkId, context: r.value.context });
        }
      } else {
        failed++;
      }
      process.stdout.write(`\r  LLM 提取进度: ${completed}/${Object.keys(allChunks).length} (成功: ${succeeded}, 失败: ${failed})`);
    }
  }
  console.log('');

  const newEntries = Array.from(llmEntityInfo.entries())
    .map(([name, info]) => ({
      name,
      type: info.type,
      category: info.type,
      frequency: info.count,
      path: '',
      definition: info.definition,
      attributes: '{}',
      source: 'llm_extracted',
    }));

  console.log(`  LLM 发现新实体: ${newEntries.length} 个`);

  const updatedDefinitions = {};
  const frequentEntities = newEntries.filter(e => e.frequency >= minFrequencyForDefinition && !e.definition);
  if (frequentEntities.length > 0) {
    console.log(`  为 ${frequentEntities.length} 个高频实体生成定义...`);

    for (let i = 0; i < frequentEntities.length; i += concurrency) {
      const batch = frequentEntities.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async (entry) => {
          const chunks = llmEntityToChunks.get(entry.name) || [];
          const context = chunks.map(c => c.context).join('\n') || entry.name;
          const definition = await generateEntityDefinition(entry.name, context);
          return { name: entry.name, definition };
        })
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          updatedDefinitions[r.value.name] = r.value.definition;
          const entry = newEntries.find(e => e.name === r.value.name);
          if (entry) entry.definition = r.value.definition;
        }
      }
    }
    console.log(`  成功生成定义: ${Object.keys(updatedDefinitions).length} 个`);
  }

  return { newEntries, newRelations: llmEntityToChunks, updatedDefinitions };
}

// ============================================================
// 4. 写入 SQLite（两表结构）
// ============================================================

function buildDatabase(entries, entryToChunks, llmResults = { newEntries: [], newRelations: new Map() }) {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('  已删除旧数据库');
  }

  const db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('concept', 'entity')),
      category TEXT NOT NULL DEFAULT '',
      frequency INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL DEFAULT '',
      definition TEXT DEFAULT '',
      attributes TEXT DEFAULT '{}',
      source TEXT DEFAULT 'wiki'
    );

    CREATE TABLE IF NOT EXISTS entry_chunks (
      entry_id INTEGER NOT NULL,
      chunk_id TEXT NOT NULL,
      context TEXT DEFAULT '',
      PRIMARY KEY (entry_id, chunk_id),
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_name ON entries(name);
    CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
    CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
    CREATE INDEX IF NOT EXISTS idx_entry_chunks_chunk ON entry_chunks(chunk_id);
  `);

  const insertEntry = db.prepare(`
    INSERT OR REPLACE INTO entries (name, type, category, frequency, path, definition, attributes, source)
    VALUES (@name, @type, @category, @frequency, @path, @definition, @attributes, @source)
  `);

  const insertRelation = db.prepare(`
    INSERT OR IGNORE INTO entry_chunks (entry_id, chunk_id, context)
    VALUES (@entry_id, @chunk_id, @context)
  `);

  const allEntries = [...entries, ...llmResults.newEntries];
  const allRelations = new Map([...entryToChunks, ...llmResults.newRelations]);

  const insertAll = db.transaction(() => {
    for (const entry of allEntries) {
      insertEntry.run(entry);
    }

    for (const [entryName, chunks] of allRelations) {
      const entryRow = db.prepare('SELECT id FROM entries WHERE name = ?').get(entryName);
      if (!entryRow) continue;

      for (const { chunkId, context } of chunks) {
        insertRelation.run({ entry_id: entryRow.id, chunk_id: chunkId, context });
      }
    }
  });

  insertAll();

  const stats = {
    totalEntries: db.prepare('SELECT COUNT(*) as c FROM entries').get().c,
    totalConcepts: db.prepare("SELECT COUNT(*) as c FROM entries WHERE type='concept'").get().c,
    totalEntities: db.prepare("SELECT COUNT(*) as c FROM entries WHERE type='entity'").get().c,
    totalRelations: db.prepare('SELECT COUNT(*) as c FROM entry_chunks').get().c,
    wikiEntries: db.prepare("SELECT COUNT(*) as c FROM entries WHERE source='wiki'").get().c,
    llmEntries: db.prepare("SELECT COUNT(*) as c FROM entries WHERE source='llm_extracted'").get().c,
  };

  db.close();
  return stats;
}

// ============================================================
// 主流程
// ============================================================

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    
    const key = arg.slice(2);
    const nextArg = argv[i + 1];
    
    if (nextArg && !nextArg.startsWith('--')) {
      args[key] = isNaN(nextArg) ? nextArg : parseInt(nextArg, 10);
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const enableLLM = !args['no-llm'];
  const llmOnly = args['llm-only'];
  const concurrency = args['concurrency'] || 3;

  console.log('========================================');
  console.log('  星辰Wiki 结构化数据库构建（两表结构）');
  console.log('========================================');
  console.log(`  参数: LLM=${enableLLM}, LLM-only=${llmOnly}, 并发=${concurrency}`);
  console.log('========================================\n');

  if (!llmOnly) {
    console.log('[1/5] 加载 Wiki 词条...');
    const entries = loadWikiEntries();
    console.log(`  ✅ 概念词条: ${entries.filter(e => e.type === 'concept').length} 个`);
    console.log(`  ✅ 实体词条: ${entries.filter(e => e.type === 'entity').length} 个`);
    console.log(`  ✅ 总计: ${entries.length} 个\n`);

    console.log('[2/5] 加载 chunks_meta...');
    const allChunks = loadChunksMeta();
    console.log(`  ✅ 总 chunk 数: ${Object.keys(allChunks).length}\n`);

    console.log('[3/5] 建立词条-chunk 关联关系（wikiLinks）...');
    const { entryToChunks, entryNameSet } = buildRelations(entries, allChunks);

    let linkedEntries = 0;
    let totalLinks = 0;
    for (const [name, chunks] of entryToChunks) {
      if (chunks.length > 0) {
        linkedEntries++;
        totalLinks += chunks.length;
      }
    }
    console.log(`  ✅ 有 chunk 关联的词条: ${linkedEntries}/${entries.length}`);
    console.log(`  ✅ 总关联边数: ${totalLinks}`);
    console.log(`  ✅ 平均每词条关联: ${(totalLinks / entries.length).toFixed(1)} 个 chunk\n`);

    if (enableLLM) {
      console.log('[4/5] LLM 实体提取（发现新实体）...');
      const llmResults = await extractEntitiesWithLLM(allChunks, entries, { concurrency });
      console.log(`  ✅ LLM 发现新实体: ${llmResults.newEntries.length} 个\n`);

      console.log('[5/5] 写入 SQLite 数据库...');
      const stats = buildDatabase(entries, entryToChunks, llmResults);
      console.log(`  ✅ 数据库路径: ${DB_PATH}`);
      console.log(`  ✅ 词条: ${stats.totalEntries} (概念${stats.totalConcepts}/实体${stats.totalEntities})`);
      console.log(`  ✅ 来源分布: Wiki ${stats.wikiEntries} / LLM ${stats.llmEntries}`);
      console.log(`  ✅ 关联边: ${stats.totalRelations}\n`);
    } else {
      console.log('[4/4] 写入 SQLite 数据库...');
      const stats = buildDatabase(entries, entryToChunks);
      console.log(`  ✅ 数据库路径: ${DB_PATH}`);
      console.log(`  ✅ 词条: ${stats.totalEntries} (概念${stats.totalConcepts}/实体${stats.totalEntities})`);
      console.log(`  ✅ 关联边: ${stats.totalRelations}\n`);
    }
  } else {
    console.log('[1/3] 加载 chunks_meta...');
    const allChunks = loadChunksMeta();
    console.log(`  ✅ 总 chunk 数: ${Object.keys(allChunks).length}\n`);

    console.log('[2/3] LLM 实体提取（增量更新）...');
    const entries = [];
    const llmResults = await extractEntitiesWithLLM(allChunks, entries, { concurrency });
    console.log(`  ✅ LLM 发现新实体: ${llmResults.newEntries.length} 个\n`);

    console.log('[3/3] 写入 SQLite 数据库...');
    const stats = buildDatabase(entries, new Map(), llmResults);
    console.log(`  ✅ 数据库路径: ${DB_PATH}`);
    console.log(`  ✅ 词条: ${stats.totalEntries} (概念${stats.totalConcepts}/实体${stats.totalEntities})`);
    console.log(`  ✅ 来源分布: Wiki ${stats.wikiEntries} / LLM ${stats.llmEntries}`);
    console.log(`  ✅ 关联边: ${stats.totalRelations}\n`);
  }

  console.log('========================================');
  console.log('  ✅ 结构化数据库构建完成!');
  console.log('========================================');
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('构建失败:', err);
    process.exit(1);
  });
}