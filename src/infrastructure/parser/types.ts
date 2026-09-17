// ============================================================
// 解析器内部类型（Infrastructure 层）
// ParsedDoc 是索引构建用的解析中间结果；WikiStats 为应用层统计类型
// ============================================================

import type { DocChunk } from '@/domain/document/types';
import type { WikiEntry } from '@/domain/entity/types';
import type { WikiStats } from '@/application/kb/kbTypes';

export type { DocChunk, WikiEntry, WikiStats };

/** 原始文档解析结果（infrastructure 索引构建用） */
export interface ParsedDoc {
  id: string;
  title: string;
  path: string;
  rawContent: string;
  chunks: DocChunk[];
  metadata: DocChunk['metadata'];
  wikiLinks: string[];
}
