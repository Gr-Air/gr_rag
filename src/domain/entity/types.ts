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

// ============================================================
// 结构化查询 Port（SQLite 实体-文档块关联数据的领域抽象）
// 实现见 infrastructure/struct/entityAdapters.ts
// ============================================================

/** 结构化词条记录（实体/概念的关联文档查询结果） */
export interface StructEntryRecord {
  id: number;
  name: string;
  type: 'concept' | 'entity';
  category: string;
  frequency: number;
  path: string;
}

/** 结构化关联块记录 */
export interface StructChunkRecord {
  entry_id: number;
  chunk_id: string;
  context: string;
}

/** 单个词条的结构化查询结果 */
export interface StructQueryResult {
  entry: StructEntryRecord;
  chunks: StructChunkRecord[];
}

/**
 * 结构化查询 Port：按词条名（AND/OR 语义）查询关联文档块
 * 由 infrastructure SQLite 适配器实现
 */
export interface StructQueryPort {
  /** 检查结构化数据库是否就绪 */
  isReady(): boolean;
  /** 多词条联合查询（返回结果只含 type=entity 的词条，与既有语义一致） */
  query(names: string[], mode?: 'and' | 'or'): Promise<StructQueryResult[]>;
}
