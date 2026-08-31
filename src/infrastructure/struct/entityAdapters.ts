// ============================================================
// SQLite 结构化数据适配器（Infrastructure 层）
// 实现 Domain 层定义的 Port：
//   - StructQueryPort：按词条名查询关联文档块
//   - EntityRepository：已知实体列表 / 就绪状态
// 底层为 structSearchEngine（better-sqlite3，readonly）
// ============================================================

import type {
  StructQueryPort,
  StructQueryResult,
  EntityRepository,
} from '@/domain/entity/types';
import {
  isStructDbReady,
  executeStructuredQuery,
  getKnownEntityNames,
} from './structSearchEngine';

/** StructQueryPort 的 SQLite 实现 */
export class SqliteStructQuery implements StructQueryPort {
  isReady(): boolean {
    return isStructDbReady();
  }

  async query(names: string[], mode: 'and' | 'or' = 'or'): Promise<StructQueryResult[]> {
    // executeStructuredQuery 已内置：未就绪返回 []、单词条精确查询、type=entity 过滤
    const results = await executeStructuredQuery(names, mode);
    // Infrastructure StructSearchResult → Domain StructQueryResult（裁剪 entry 字段，隐藏 matchType）
    return results.map(r => ({
      entry: {
        id: r.entry.id,
        name: r.entry.name,
        type: r.entry.type,
        category: r.entry.category,
        frequency: r.entry.frequency,
        path: r.entry.path,
      },
      chunks: r.chunks,
    }));
  }
}

/** EntityRepository 的 SQLite 实现 */
export class SqliteEntityRepository implements EntityRepository {
  getKnownEntities() {
    return getKnownEntityNames();
  }

  isReady(): boolean {
    return isStructDbReady();
  }
}
