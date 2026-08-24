// ============================================================
// 结构化检索引擎（两表结构版本）
// 基于 SQLite 数据库，支持精确查询概念/实体关联的所有 chunk
// 
// 核心能力：
//   1. 根据词条名精确查询关联的 chunk 列表
//   2. 多词条联合查询（AND/OR 语义）
//   3. 与向量库协同工作：提供 chunk 列表给向量库做二次检索
// ============================================================

import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'src', 'data', 'struct_kb.db');

export function isStructDbReady(): boolean {
  return fs.existsSync(DB_PATH);
}

let _db: any = null;

function getDb(): any {
  if (_db) return _db;
  if (!isStructDbReady()) {
    throw new Error('结构化数据库未构建，请运行: node scripts/buildStructDb.cjs');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3');
  _db = new BetterSqlite3(DB_PATH, { readonly: true });
  _db.pragma('journal_mode = WAL');
  return _db;
}

// ============================================================
// 类型定义
// ============================================================

export interface StructEntry {
  id: number;
  name: string;
  type: 'concept' | 'entity';
  category: string;
  frequency: number;
  path: string;
  definition: string;
  attributes: string;
  source: string;
}

export interface StructChunk {
  entry_id: number;
  chunk_id: string;
  context: string;
}

export interface StructSearchResult {
  entry: StructEntry;
  chunks: StructChunk[];
  matchType: 'exact' | 'fuzzy';
}

// ============================================================
// 核心查询方法
// ============================================================

export function queryChunksByEntry(entryName: string): StructSearchResult | null {
  const db = getDb();

  const entry = db.prepare('SELECT * FROM entries WHERE name = ?').get(entryName) as StructEntry | undefined;
  if (!entry) return null;

  const chunks = db.prepare(`
    SELECT * FROM entry_chunks WHERE entry_id = ?
  `).all(entry.id) as StructChunk[];

  return { entry, chunks, matchType: 'exact' };
}

export function queryChunksByEntries(entryNames: string[], mode: 'and' | 'or' = 'or'): StructSearchResult[] {
  const db = getDb();

  const entries = db.prepare(
    `SELECT * FROM entries WHERE name IN (${entryNames.map(() => '?').join(',')})`
  ).all(...entryNames) as StructEntry[];

  if (entries.length === 0) return [];

  if (mode === 'and') {
    return queryChunksByEntriesAnd(entries);
  }

  return queryChunksByEntriesOr(entries);
}

function queryChunksByEntriesAnd(entries: StructEntry[]): StructSearchResult[] {
  const db = getDb();

  let commonChunkIds: Set<string> | null = null;

  for (const entry of entries) {
    const chunkIds = new Set<string>(
      (db.prepare('SELECT chunk_id FROM entry_chunks WHERE entry_id = ?').all(entry.id) as { chunk_id: string }[])
        .map(r => r.chunk_id)
    );

    if (commonChunkIds === null) {
      commonChunkIds = chunkIds;
    } else {
      const intersection = new Set<string>();
      for (const id of commonChunkIds) {
        if (chunkIds.has(id)) intersection.add(id);
      }
      commonChunkIds = intersection;
    }
  }

  if (!commonChunkIds || commonChunkIds.size === 0) {
    return entries.map(e => ({ entry: e, chunks: [], matchType: 'exact' as const }));
  }

  const chunkMap = new Map<string, StructChunk>();
  for (const entry of entries) {
    const chunks = (db.prepare('SELECT * FROM entry_chunks WHERE entry_id = ?').all(entry.id) as StructChunk[])
      .filter(c => commonChunkIds!.has(c.chunk_id));
    for (const chunk of chunks) {
      if (!chunkMap.has(chunk.chunk_id)) {
        chunkMap.set(chunk.chunk_id, chunk);
      }
    }
  }

  const results: StructSearchResult[] = [];
  for (const entry of entries) {
    const entryChunks = (db.prepare('SELECT * FROM entry_chunks WHERE entry_id = ?').all(entry.id) as StructChunk[])
      .filter(c => commonChunkIds!.has(c.chunk_id));
    results.push({ entry, chunks: entryChunks, matchType: 'exact' as const });
  }

  return results;
}

function queryChunksByEntriesOr(entries: StructEntry[]): StructSearchResult[] {
  const db = getDb();

  const results: StructSearchResult[] = [];
  for (const entry of entries) {
    const chunks = db.prepare('SELECT * FROM entry_chunks WHERE entry_id = ?').all(entry.id) as StructChunk[];
    results.push({ entry, chunks, matchType: 'exact' as const });
  }

  return results;
}

export function fuzzySearchEntries(keyword: string, limit = 20): StructEntry[] {
  const db = getDb();

  return db.prepare(`
    SELECT * FROM entries
    WHERE name LIKE ? OR name LIKE ?
    ORDER BY frequency DESC
    LIMIT ?
  `).all(`%${keyword}%`, `${keyword}%`, limit) as StructEntry[];
}

export function getStructStats(): {
  totalEntries: number;
  totalConcepts: number;
  totalEntities: number;
  totalRelations: number;
} {
  const db = getDb();

  return {
    totalEntries: (db.prepare('SELECT COUNT(*) as c FROM entries').get() as any).c,
    totalConcepts: (db.prepare("SELECT COUNT(*) as c FROM entries WHERE type='concept'").get() as any).c,
    totalEntities: (db.prepare("SELECT COUNT(*) as c FROM entries WHERE type='entity'").get() as any).c,
    totalRelations: (db.prepare('SELECT COUNT(*) as c FROM entry_chunks').get() as any).c,
  };
}

export function getAllEntryNames(): string[] {
  const db = getDb();
  return (db.prepare('SELECT name FROM entries ORDER BY frequency DESC').all() as { name: string }[])
    .map(r => r.name);
}

export interface KnownEntityInfo {
  name: string;
  type: 'concept' | 'entity';
  category: string;
  frequency: number;
  definition: string;
  source: string;
}

export function getKnownEntityNames(): KnownEntityInfo[] {
  const db = getDb();
  return db.prepare(
    'SELECT name, type, category, frequency, definition, source FROM entries ORDER BY frequency DESC'
  ).all() as KnownEntityInfo[];
}

export function queryEntriesByChunk(chunkId: string): StructEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT e.* FROM entries e
    INNER JOIN entry_chunks ec ON e.id = ec.entry_id
    WHERE ec.chunk_id = ?
    ORDER BY e.frequency DESC
  `).all(chunkId) as StructEntry[];
}

export function queryEntriesByDocPrefix(docId: string): StructEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT e.* FROM entries e
    INNER JOIN entry_chunks ec ON e.id = ec.entry_id
    WHERE ec.chunk_id LIKE ?
    ORDER BY e.frequency DESC
  `).all(`${docId}%`) as StructEntry[];
}

export function closeStructDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================
// 结构化查询执行 + 结果格式化
// ============================================================

export async function executeStructuredQuery(
  matchedEntries: string[],
  mode: 'and' | 'or' = 'or'
): Promise<StructSearchResult[]> {
  if (!isStructDbReady()) {
    console.warn('[StructSearch] 结构化数据库未就绪');
    return [];
  }

  if (matchedEntries.length === 1) {
    const result = queryChunksByEntry(matchedEntries[0]);
    if (result && result.entry.type === 'entity') {
      return [result];
    }
    return [];
  }

  const results = queryChunksByEntries(matchedEntries, mode);
  return results.filter(r => r.entry.type === 'entity');
}

