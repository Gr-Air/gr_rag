// ============================================================
// Chunk 存储抽象（已迁移到 domain/document/types.ts，Phase 1）
// 此文件为 re-export 兼容层，供 lib/ 内未迁移的调用方使用
// Phase 3 迁移完成后删除此文件
// ============================================================

export type { DocChunk, ChunkMeta, ChunkStore } from '@/domain/document/types';
