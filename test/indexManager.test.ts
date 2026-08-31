// ============================================================
// indexManager / index manifest 测试
// 覆盖 spec 026 验收标准：
//   - manifest 正常写入与 schema 完整性
//   - store 缺失（构建中断）时拒绝写入新版本
//   - indexVersion 递增
//   - JSON 损坏降级
//   - 无 manifest 旧索引兼容（降级文件存在性检查）
//   - structDb 最小 manifest 创建与读改写
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import manifestLibDefault from '../scripts/lib/manifest.cjs';
import { evaluateIndexReadiness, checkStoresReady, readManifest } from '@/lib/indexManager';

/** manifest.cjs（CJS 构建脚本模块）的最小类型声明 */
interface ManifestLib {
  writeManifestAfterBuild(
    dataDir: string,
    opts?: { buildMode?: string }
  ): {
    indexVersion: number;
    buildMode: string;
    builtAt: string;
    stores: Record<string, { ready: boolean }>;
    stats: { totalChunks?: number | null };
  } | null;
  readManifest(dataDir: string): { indexVersion: number; stores: Record<string, { ready: boolean }> } | null;
  getManifestPath(dataDir: string): string;
  updateStructDbEntry(dataDir: string): { indexVersion: number; stores: Record<string, { ready: boolean }> } | null;
  cleanupManifestTmp(dataDir: string): void;
}
const manifestLib = manifestLibDefault as unknown as ManifestLib;

// ============================================================
// 测试辅助：在 tmpDir 中创建全部必需 store 的文件结构
// ============================================================

function createReadyStores(dataDir: string) {
  fs.mkdirSync(path.join(dataDir, 'lancedb', 'chunks.lance'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'vectors'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'vectors', 'config.json'),
    JSON.stringify({ totalChunks: 100, dim: 1024 })
  );

  fs.mkdirSync(path.join(dataDir, 'bm25'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'bm25', 'meta.json'), JSON.stringify({ docCount: 100, totalShards: 1 }));
  fs.writeFileSync(path.join(dataDir, 'bm25', 'doc_lengths.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(dataDir, 'bm25', 'shard_0.json'), JSON.stringify({}));

  fs.mkdirSync(path.join(dataDir, 'chunks_meta'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'chunks_meta', 'config.json'),
    JSON.stringify({ totalChunks: 100, totalShards: 1 })
  );
  fs.writeFileSync(path.join(dataDir, 'chunks_meta', 'shard_0.json'), JSON.stringify({}));

  fs.mkdirSync(path.join(dataDir, 'parents'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'parents', 'parents.json'), JSON.stringify({}));
}

describe('scripts/lib/manifest.cjs 构建侧', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('store 齐全时写入 manifest 且 schema 完整', () => {
    createReadyStores(tmpDir);

    const manifest = manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });
    expect(manifest).not.toBeNull();
    const m = manifest!;

    expect(m.indexVersion).toBe(1);
    expect(m.buildMode).toBe('full');
    expect(typeof m.builtAt).toBe('string');
    for (const store of ['lancedb', 'bm25', 'chunksMeta', 'parents']) {
      expect(m.stores[store].ready).toBe(true);
    }
    expect(m.stats.totalChunks).toBe(100);

    // 落盘文件可读回
    const readBack = manifestLib.readManifest(tmpDir)!;
    expect(readBack.indexVersion).toBe(1);
  });

  it('必需 store 缺失（模拟构建中断）时拒绝写入，保留旧版本', () => {
    // 第一次构建成功 → v1
    createReadyStores(tmpDir);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });

    // 模拟中断：删除 chunks_meta 目录后再构建 → 返回 null 且 manifest 保持 v1
    fs.rmSync(path.join(tmpDir, 'chunks_meta'), { recursive: true, force: true });
    const result = manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });

    expect(result).toBeNull();
    const preserved = manifestLib.readManifest(tmpDir)!;
    expect(preserved.indexVersion).toBe(1);
  });

  it('indexVersion 随构建成功递增', () => {
    createReadyStores(tmpDir);

    const m1 = manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' })!;
    const m2 = manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'incremental' })!;

    expect(m1.indexVersion).toBe(1);
    expect(m2.indexVersion).toBe(2);
    expect(m2.buildMode).toBe('incremental');
  });

  it('损坏的 manifest JSON 读取返回 null（不抛错）', () => {
    createReadyStores(tmpDir);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });

    fs.writeFileSync(manifestLib.getManifestPath(tmpDir), '{ broken json!!');

    expect(manifestLib.readManifest(tmpDir)).toBeNull();
  });

  it('原子写入后无 .tmp 残留；cleanupManifestTmp 清理孤儿 tmp', () => {
    createReadyStores(tmpDir);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });

    expect(fs.existsSync(manifestLib.getManifestPath(tmpDir) + '.tmp')).toBe(false);

    // 模拟中断残留的孤儿 tmp
    fs.writeFileSync(manifestLib.getManifestPath(tmpDir) + '.tmp', 'partial');
    manifestLib.cleanupManifestTmp(tmpDir);
    expect(fs.existsSync(manifestLib.getManifestPath(tmpDir) + '.tmp')).toBe(false);
  });

  it('updateStructDbEntry：manifest 不存在时创建最小 manifest', () => {
    fs.writeFileSync(path.join(tmpDir, 'struct_kb.db'), 'fake');

    const manifest = manifestLib.updateStructDbEntry(tmpDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.indexVersion).toBe(1);
    expect(manifest!.stores.structDb.ready).toBe(true);

    const readBack = manifestLib.readManifest(tmpDir)!;
    expect(readBack.stores.structDb.ready).toBe(true);
  });

  it('updateStructDbEntry：已有 manifest 时读改写且 indexVersion +1', () => {
    createReadyStores(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'struct_kb.db'), 'fake');
    const before = manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' })!;
    expect(before.stores.structDb?.ready).toBe(true); // collectStoresStatus 已包含 structDb

    // 重新构建 structDb → 版本 +1
    const after = manifestLib.updateStructDbEntry(tmpDir)!;
    expect(after.indexVersion).toBe(before.indexVersion + 1);
  });

  it('updateStructDbEntry：struct_kb.db 不存在时返回 null 且不写 manifest', () => {
    const result = manifestLib.updateStructDbEntry(tmpDir);
    expect(result).toBeNull();
    expect(fs.existsSync(manifestLib.getManifestPath(tmpDir))).toBe(false);
  });
});

describe('indexManager 运行侧就绪判定', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexmanager-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('manifest 完整 + 各 store 文件存在 → ready', () => {
    createReadyStores(tmpDir);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });

    expect(evaluateIndexReadiness(tmpDir)).toBe(true);
  });

  it('manifest 完整但删除任一必需 store 目录 → not ready', () => {
    createReadyStores(tmpDir);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });

    // 删除 parents → 文件系统复核不通过 → not ready
    fs.rmSync(path.join(tmpDir, 'parents'), { recursive: true, force: true });
    expect(evaluateIndexReadiness(tmpDir)).toBe(false);

    // 恢复后删除 lancedb → 同样 not ready
    createReadyStores(tmpDir);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });
    fs.rmSync(path.join(tmpDir, 'lancedb'), { recursive: true, force: true });
    expect(evaluateIndexReadiness(tmpDir)).toBe(false);
  });

  it('无 manifest 的旧索引 → 降级为旧检查，lancedb + bm25/meta.json 存在即 ready', () => {
    // 旧索引只有 lancedb 目录和 bm25/meta.json（无 chunks_meta/parents）
    fs.mkdirSync(path.join(tmpDir, 'lancedb'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'bm25'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'bm25', 'meta.json'), '{}');

    expect(evaluateIndexReadiness(tmpDir)).toBe(true);
    expect(readManifest(tmpDir)).toBeNull();
  });

  it('manifest 损坏 JSON → 视为 null，降级行为生效', () => {
    createReadyStores(tmpDir);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });
    fs.writeFileSync(manifestLib.getManifestPath(tmpDir), 'not-json{{{');

    // manifest 损坏 → readManifest 返回 null → 降级旧检查（lancedb + bm25/meta.json 存在）→ ready
    expect(evaluateIndexReadiness(tmpDir)).toBe(true);

    // 对照：旧检查不满足时（lancedb 缺失）→ not ready
    fs.rmSync(path.join(tmpDir, 'lancedb'), { recursive: true, force: true });
    expect(evaluateIndexReadiness(tmpDir)).toBe(false);
  });

  it('checkStoresReady 与 evaluateIndexReadiness 在完整 store 上一致', () => {
    createReadyStores(tmpDir);
    expect(checkStoresReady(tmpDir)).toBe(true);
    manifestLib.writeManifestAfterBuild(tmpDir, { buildMode: 'full' });
    expect(evaluateIndexReadiness(tmpDir)).toBe(true);
  });

  it('checkStoresReady：structDb 缺失不影响必需 store 判定', () => {
    createReadyStores(tmpDir);
    expect(checkStoresReady(tmpDir)).toBe(true);
  });
});
