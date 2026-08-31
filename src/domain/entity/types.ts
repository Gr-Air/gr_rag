// ============================================================
// 实体 Domain 类型 + 仓储接口
// 依赖方向：domain 不得 import infrastructure / app / fs / SQLite
// ============================================================

/** Wiki 词条（概念或实体的统一抽象） */
export interface WikiEntry {
  name: string;
  type: 'concept' | 'entity';
  frequency: number;
  category?: string;
  path: string;
}

/** 已知实体信息（用于查询改写时的实体匹配） */
export interface KnownEntityInfo {
  name: string;
  type: 'concept' | 'entity';
  category: string;
  frequency: number;
  definition: string;
  source: string;
}

/** 实体匹配结果（查询与实体的匹配信息） */
export interface EntityMatch {
  /** 匹配的实体名 */
  name: string;
  /** 匹配类型：精确或模糊 */
  matchType: 'exact' | 'fuzzy';
}

/**
 * 实体仓储抽象
 * Phase 6 将迁移现有 SqliteEntityRepository 实现到 infrastructure
 */
export interface EntityRepository {
  /** 获取全部已知实体（用于查询改写匹配） */
  getKnownEntities(): KnownEntityInfo[];
  /** 检查结构化数据库是否就绪 */
  isReady(): boolean;
}
