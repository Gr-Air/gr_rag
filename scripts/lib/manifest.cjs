// ============================================================
// 索引 Manifest 公共模块（跨索引一致性保证）
//
// 职责：
//   1. manifest 的原子读写（tmp + rename，中断不损坏）
//   2. 各 store 就绪状态收集
//   3. 构建成功后生成完整 manifest（store 缺失则拒绝写入，保留旧版本）
//   4. structDb 单独更新时的读改写
//
// 所有函数支持注入 dataDir（默认 src/data），便于测试使用 tmpdir。
// 读取语义：manifest 缺失或 JSON 损坏 → 返回 null（调用方降级，不抛错）
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MANIFEST_FILENAME = 'index_manifest.json';

/** 必需 store：缺失任一则 isIndexReady 为 false、manifest 拒绝写入 */
const REQUIRED_STORES = ['lancedb', 'bm25', 'chunksMeta', 'parents'];

/** 可选 store：独立就绪状态，不影响 index ready 判定 */
const OPTIONAL_STORES = ['structDb'];

// ============================================================
// store 就绪检查
// ============================================================

/** 检查目录下是否存在至少一个匹配文件 */
function hasMatchingFile(dirPath, prefix, ext) {
  if (!fs.existsSync(dirPath)) return false;
  return fs.readdirSync(dirPath).some(f => f.startsWith(prefix) && f.endsWith(ext));
}

/** 收集单个 store 的就绪状态与详情 */
function collectStoreStatus(dataDir, storeName) {
  switch (storeName) {
    case 'lancedb': {
      const dir = path.join(dataDir, 'lancedb');
      const tableDir = path.join(dir, 'chunks.lance');
      const ready = fs.existsSync(dir) && fs.existsSync(tableDir);
      let detail = null;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'vectors', 'config.json'), 'utf-8'));
        detail = { totalChunks: cfg.totalChunks ?? null, dim: cfg.dim ?? null };
      } catch { /* config 缺失不影响 ready 判定 */ }
      return { ready, detail };
    }
    case 'bm25': {
      const dir = path.join(dataDir, 'bm25');
      const metaPath = path.join(dir, 'meta.json');
      const ready = fs.existsSync(metaPath)
        && fs.existsSync(path.join(dir, 'doc_lengths.json'))
        && hasMatchingFile(dir, 'shard_', '.json');
      let detail = null;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        detail = { docCount: meta.docCount ?? null, totalShards: meta.totalShards ?? null };
      } catch { /* ignore */ }
      return { ready, detail };
    }
    case 'chunksMeta': {
      const dir = path.join(dataDir, 'chunks_meta');
      const configPath = path.join(dir, 'config.json');
      const ready = fs.existsSync(configPath) && hasMatchingFile(dir, 'shard_', '.json');
      let detail = null;
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        detail = { totalChunks: cfg.totalChunks ?? null, totalShards: cfg.totalShards ?? null };
      } catch { /* ignore */ }
      return { ready, detail };
    }
    case 'parents': {
      const ready = fs.existsSync(path.join(dataDir, 'parents', 'parents.json'));
      return { ready, detail: null };
    }
    case 'structDb': {
      const dbPath = path.join(dataDir, 'struct_kb.db');
      const ready = fs.existsSync(dbPath);
      return { ready, detail: null };
    }
    default:
      return { ready: false, detail: null };
  }
}

/** 收集全部 store 状态 */
function collectStoresStatus(dataDir) {
  const stores = {};
  for (const name of [...REQUIRED_STORES, ...OPTIONAL_STORES]) {
    stores[name] = collectStoreStatus(dataDir, name);
  }
  return stores;
}

/** 必需 store 是否全部就绪 */
function checkStoresReady(dataDir) {
  return REQUIRED_STORES.every(name => collectStoreStatus(dataDir, name).ready);
}

// ============================================================
// manifest 读写
// ============================================================

function getManifestPath(dataDir) {
  return path.join(dataDir, MANIFEST_FILENAME);
}

/**
 * 读取 manifest。缺失或 JSON 损坏 → null（不抛错）
 */
function readManifest(dataDir) {
  const manifestPath = getManifestPath(dataDir);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (typeof manifest !== 'object' || manifest === null || typeof manifest.indexVersion !== 'number') {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

/**
 * 原子写入 manifest：先写 tmp 再 rename，中断只产生孤儿 tmp 文件
 */
function writeManifest(dataDir, manifest) {
  const manifestPath = getManifestPath(dataDir);
  const tmpPath = manifestPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmpPath, manifestPath);
}

// ============================================================
// manifest 构建 / 更新
// ============================================================

/** 获取 git commit（失败返回 null，不抛错） */
function getGitCommit(rootDir) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: rootDir || process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** 从 staging manifest 读取 pipelineVersion / totalDocs（缺失返回 null） */
function readStagingInfo(dataDir) {
  try {
    const staging = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'chunks_staging', 'manifest.json'), 'utf-8')
    );
    return {
      pipelineVersion: staging.pipelineVersion ?? null,
      totalDocs: staging.totalDocs ?? null,
      gitCommit: staging.gitCommit ?? null,
    };
  } catch {
    return { pipelineVersion: null, totalDocs: null, gitCommit: null };
  }
}

/**
 * 构建完整 manifest（不写入）。
 * 必需 store 缺失时返回 null —— 调用方（构建脚本）应保留旧 manifest，视为本次构建未完成。
 */
function buildManifest(dataDir, { buildMode } = {}) {
  if (!checkStoresReady(dataDir)) return null;

  const stores = collectStoresStatus(dataDir);
  const staging = readStagingInfo(dataDir);
  const prev = readManifest(dataDir);

  return {
    indexVersion: (prev?.indexVersion ?? 0) + 1,
    pipelineVersion: staging.pipelineVersion,
    gitCommit: getGitCommit() ?? staging.gitCommit,
    builtAt: new Date().toISOString(),
    buildMode: buildMode || 'full',
    stores,
    stats: {
      totalDocs: staging.totalDocs,
      totalChunks: stores.chunksMeta.detail?.totalChunks ?? null,
    },
  };
}

/**
 * 构建并原子写入 manifest。
 * @returns 写入的 manifest；必需 store 缺失（构建中断）时返回 null 且不写入
 */
function writeManifestAfterBuild(dataDir, { buildMode } = {}) {
  const manifest = buildManifest(dataDir, { buildMode });
  if (!manifest) return null;
  writeManifest(dataDir, manifest);
  return manifest;
}

/**
 * structDb 构建成功后的读改写：更新 stores.structDb，indexVersion +1。
 * manifest 不存在时创建仅含 structDb 的最小 manifest（indexVersion 从 1 起）。
 */
function updateStructDbEntry(dataDir) {
  const status = collectStoreStatus(dataDir, 'structDb');
  if (!status.ready) return null;

  const manifest = readManifest(dataDir) || {
    indexVersion: 0,
    pipelineVersion: null,
    gitCommit: null,
    builtAt: new Date().toISOString(),
    buildMode: 'structdb-only',
    stores: {},
    stats: {},
  };

  manifest.stores = { ...manifest.stores, structDb: status };
  manifest.indexVersion += 1;
  manifest.builtAt = new Date().toISOString();

  writeManifest(dataDir, manifest);
  return manifest;
}

/** 清理原子写残留的孤儿 tmp 文件（正常启动时调用） */
function cleanupManifestTmp(dataDir) {
  const tmpPath = getManifestPath(dataDir) + '.tmp';
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch { /* 忽略清理失败 */ }
}

module.exports = {
  MANIFEST_FILENAME,
  REQUIRED_STORES,
  OPTIONAL_STORES,
  collectStoreStatus,
  collectStoresStatus,
  checkStoresReady,
  getManifestPath,
  readManifest,
  writeManifest,
  buildManifest,
  writeManifestAfterBuild,
  updateStructDbEntry,
  cleanupManifestTmp,
  getGitCommit,
};
