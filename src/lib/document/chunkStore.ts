// ============================================================
// JsonChunkStore：基于 chunks_meta JSON 分片的 ChunkStore 实现（Spec 031）
// 合并原 bm25Engine.getChunksByIds（逐个查分片）和
//      entityRouter.loadAllChunks（一次全加载），统一加载入口
// ============================================================

import fs from 'fs';
import path from 'path';
import { DocChunk } from '../types';
import { ChunkStore, ChunkMeta } from './types';

const CHUNKS_META_DIR = path.join(process.cwd(), 'src', 'data', 'chunks_meta');

export class JsonChunkStore implements ChunkStore {
  private allChunksCache: Map<string, ChunkMeta> | null = null;

  /** 懒加载全部 chunks 到内存（首次调用后缓存） */
  private loadAll(): Map<string, ChunkMeta> {
    if (this.allChunksCache) return this.allChunksCache;

    const map = new Map<string, ChunkMeta>();
    const configPath = path.join(CHUNKS_META_DIR, 'config.json');
    if (!fs.existsSync(configPath)) {
      this.allChunksCache = map;
      return map;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (let s = 0; s < config.totalShards; s++) {
      const shardPath = path.join(CHUNKS_META_DIR, `shard_${s}.json`);
      if (!fs.existsSync(shardPath)) continue;
      const shard = JSON.parse(fs.readFileSync(shardPath, 'utf-8'));
      for (const [id, meta] of Object.entries(shard)) {
        map.set(id, meta as ChunkMeta);
      }
    }

    console.log(`[ChunkStore] 加载完成: ${map.size} 个 chunks`);
    this.allChunksCache = map;
    return map;
  }

  getByIds(ids: string[]): DocChunk[] {
    const all = this.loadAll();
    return ids
      .map(id => {
        const meta = all.get(id);
        if (!meta) return undefined;
        return {
          id,
          docId: meta.docId,
          docTitle: meta.docTitle,
          docPath: meta.docPath,
          chunkIndex: 0,
          content: meta.content,
          metadata: meta.metadata,
          wikiLinks: meta.wikiLinks || [],
          parentDocId: meta.parentDocId,
        } as DocChunk;
      })
      .filter((c): c is DocChunk => c !== undefined);
  }

  getAll(): Map<string, ChunkMeta> {
    return this.loadAll();
  }
}

// 模块级单例（项目内共享；Spec 033 Composition Root 落地后改为注入）
let _instance: JsonChunkStore | null = null;

export function getChunkStore(): ChunkStore {
  if (!_instance) _instance = new JsonChunkStore();
  return _instance;
}

/** 测试用：重置单例（避免跨用例缓存污染） */
export function _resetChunkStoreForTest(): void {
  _instance = null;
}
