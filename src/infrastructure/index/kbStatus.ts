// ============================================================
// 知识库状态（Infrastructure 层）
// 实现 Application 层的 KbStatusPort：
//   索引就绪 / 结构化库就绪 / manifest 版本信息
// ============================================================

import type { KbStatusPort, IndexInfo } from '@/application/ports';
import { isIndexReady, isStructDbReady, getIndexManifest } from './indexManager';

export const kbStatus: KbStatusPort = {
  isIndexReady,
  isStructDbReady,
  getIndexInfo(): IndexInfo | null {
    const manifest = getIndexManifest();
    if (!manifest) return null;
    return {
      indexVersion: manifest.indexVersion,
      builtAt: manifest.builtAt,
      buildMode: manifest.buildMode,
    };
  },
};
