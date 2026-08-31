// ============================================================
// 索引管理器：基于 index_manifest.json 的索引就绪判定与版本追踪
//
// manifest schema 与 scripts/lib/manifest.cjs（构建侧写入方）保持一致：
//   { indexVersion, pipelineVersion, gitCommit, builtAt, buildMode,
//     stores: { lancedb, bm25, chunksMeta, parents, structDb },
//     stats: { totalDocs, totalChunks } }
//
// 降级语义（spec 026）：
//   - manifest 缺失/损坏 → 降级为旧的文件存在性检查，仅警告一次
//   - structDb 为可选 store，缺失不影响 isIndexReady()（独立由 isStructDbReady 判定）
// ============================================================

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'index_manifest.json');

/** 必需 store：缺失任一则 isIndexReady 为 false */
const REQUIRED_STORES = ['lancedb', 'bm25', 'chunksMeta', 'parents'] as const;

export interface IndexManifestStoreStatus {
  ready: boolean;
  detail: Record<string, unknown> | null;
}

export interface IndexManifest {
  indexVersion: number;
  pipelineVersion: string | null;
  gitCommit: string | null;
  builtAt: string;
  buildMode: string;
  stores: Record<string, IndexManifestStoreStatus>;
  stats: { totalDocs?: number | null; totalChunks?: number | null };
}

/** manifest 缺失/损坏只警告一次（进程生命周期内） */
let manifestIssueWarned = false;

/**
 * 读取 index_manifest.json。
 * 缺失或 JSON 损坏 → null（不抛错）。
 */
export function readManifest(dataDir: string = DATA_DIR): IndexManifest | null {
  const manifestPath = path.join(dataDir, 'index_manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (typeof manifest !== 'object' || manifest === null || typeof manifest.indexVersion !== 'number') {
      return null;
    }
    return manifest as IndexManifest;
  } catch {
    return null;
  }
}

/** 对外暴露：运行时 manifest 读取（含一次性警告日志） */
export function getIndexManifest(): IndexManifest | null {
  const manifest = readManifest();
  if (!manifest && !manifestIssueWarned && fs.existsSync(MANIFEST_PATH)) {
    console.warn('[IndexManager] ⚠️ index_manifest.json 损坏，将降级为文件存在性检查');
    manifestIssueWarned = true;
  }
  return manifest;
}

// ============================================================
// store 就绪复核（运行时以文件系统为准，不盲信 manifest 记录）
// ============================================================

function hasMatchingFile(dirPath: string, prefix: string, ext: string): boolean {
  if (!fs.existsSync(dirPath)) return false;
  return fs.readdirSync(dirPath).some(f => f.startsWith(prefix) && f.endsWith(ext));
}

/** 必需 store 是否全部就绪（基于文件系统实际状态） */
export function checkStoresReady(dataDir: string = DATA_DIR): boolean {
  return REQUIRED_STORES.every(name => {
    switch (name) {
      case 'lancedb':
        return fs.existsSync(path.join(dataDir, 'lancedb', 'chunks.lance'));
      case 'bm25':
        return fs.existsSync(path.join(dataDir, 'bm25', 'meta.json'))
          && fs.existsSync(path.join(dataDir, 'bm25', 'doc_lengths.json'))
          && hasMatchingFile(path.join(dataDir, 'bm25'), 'shard_', '.json');
      case 'chunksMeta':
        return fs.existsSync(path.join(dataDir, 'chunks_meta', 'config.json'))
          && hasMatchingFile(path.join(dataDir, 'chunks_meta'), 'shard_', '.json');
      case 'parents':
        return fs.existsSync(path.join(dataDir, 'parents', 'parents.json'));
      default:
        return false;
    }
  });
}

/**
 * 索引就绪判定核心逻辑（可注入 dataDir，供测试使用 tmpdir）。
 *
 * 规则：
 *   1. manifest 存在且有效 → 必需 store 文件复核通过 → ready
 *   2. manifest 缺失/损坏 → 降级为旧检查（lancedb 目录 + bm25/meta.json）→ ready
 */
export function evaluateIndexReadiness(dataDir: string): boolean {
  const manifest = readManifest(dataDir);
  if (manifest === null) {
    // 降级：旧版文件存在性检查（与重构前 isIndexReady 一致）
    return fs.existsSync(path.join(dataDir, 'lancedb'))
      && fs.existsSync(path.join(dataDir, 'bm25', 'meta.json'));
  }
  return checkStoresReady(dataDir);
}

export function isIndexReady(): boolean {
  return evaluateIndexReadiness(DATA_DIR);
}

/** 检查结构化数据库是否就绪 */
export function isStructDbReady(): boolean {
  return fs.existsSync(path.join(DATA_DIR, 'struct_kb.db'));
}

/**
 * 获取索引状态信息（增量构建时生成）
 * 返回：上次构建时间、追踪的文件数量等
 */
export function getIndexState(): {
  lastBuildAt: string | null;
  trackedFiles: number;
  stateExists: boolean;
} | null {
  const statePath = path.join(DATA_DIR, 'index_state.json');
  if (!fs.existsSync(statePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const stat = fs.statSync(statePath);
    return {
      lastBuildAt: stat.mtime.toISOString(),
      trackedFiles: Object.keys(state).length,
      stateExists: true,
    };
  } catch {
    return null;
  }
}

export async function initIndexes(): Promise<void> {
  const manifest = readManifest();

  if (isIndexReady()) {
    if (manifest) {
      const missing = REQUIRED_STORES.filter(name => !manifest.stores?.[name]?.ready);
      console.log(
        `[IndexManager] ✅ 检索索引已就绪 (v${manifest.indexVersion}, ` +
        `${manifest.buildMode ?? 'unknown'}, 构建于 ${manifest.builtAt})`
      );
      if (missing.length > 0) {
        // manifest 声称缺失但文件复核通过：以文件系统为准，仅提示
        console.warn(`[IndexManager] ⚠️ manifest 中以下 store 标记异常（文件复核已通过）: ${missing.join(', ')}`);
      }
    } else if (fs.existsSync(MANIFEST_PATH)) {
      console.warn('[IndexManager] ⚠️ index_manifest.json 损坏，降级为文件存在性检查（建议重新构建索引）');
    } else {
      console.warn('[IndexManager] ⚠️ 索引就绪但无 manifest（旧版索引），建议重新构建以生成版本信息');
    }

    const state = getIndexState();
    if (state) {
      console.log(`[IndexManager] 📄 增量状态: ${state.trackedFiles} 个文件，上次构建: ${state.lastBuildAt}`);
    }
  } else {
    if (manifest) {
      const missing = REQUIRED_STORES.filter(name => !manifest.stores?.[name]?.ready);
      console.warn(`[IndexManager] ❌ 索引不完整（manifest v${manifest.indexVersion}），缺失 store: ${missing.join(', ') || '文件复核未通过'}`);
    }
    console.warn('[IndexManager] ⚠️ 索引未构建，请运行: node scripts/buildIndex.cjs');
  }

  if (isStructDbReady()) {
    console.log('[IndexManager] ✅ 结构化数据库已就绪');
  } else {
    console.warn('[IndexManager] ⚠️ 结构化数据库未构建，请运行: node scripts/buildStructDb.cjs');
  }
}
