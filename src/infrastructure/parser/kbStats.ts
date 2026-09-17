// ============================================================
// 知识库统计（Infrastructure 层）
// 实现 Application 层的 KbStatsPort：
//   parser 统计 / 文档列表 / 结构化库统计
// ============================================================

import type { KbStatsPort } from '@/application/ports';
import { getWikiStats, loadAllRawDocs } from '../parser/parser';
import { getStructStats, isStructDbReady } from '../struct/structSearchEngine';

export const kbStats: KbStatsPort = {
  getWikiStats: () => getWikiStats(),

  listRawDocs() {
    return loadAllRawDocs().map(doc => ({
      id: doc.id,
      title: doc.title,
      path: doc.path,
      metadata: doc.metadata,
      wikiLinks: doc.wikiLinks,
      chunkCount: doc.chunks.length,
    }));
  },

  getStructStats() {
    if (!isStructDbReady()) return null;
    try {
      return getStructStats();
    } catch {
      return null;
    }
  },
};
