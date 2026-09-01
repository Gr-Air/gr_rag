// ============================================================
// 文档 Domain 类型 + 仓储接口
// 依赖方向：domain 不得 import infrastructure / app / fs / DB
// ============================================================

/** 文档块（检索最小单元 - 子文档，用于向量检索） */
export interface DocChunk {
  id: string;
  docId: string;
  docTitle: string;
  docPath: string;
  chunkIndex: number;
  content: string;
  /** 元数据 */
  metadata: {
    client?: string;
    project?: string;
    docType?: string;
    date?: string;
  };
  /** 该块内引用的 wiki 词条 */
  wikiLinks: string[];
  /** 语义分块相关：父文档 ID */
  parentDocId?: string;
  /** 语义分块相关：该块在父文档中的起始字符偏移 */
  parentStart?: number;
  /** 语义分块相关：该块在父文档中的结束字符偏移 */
  parentEnd?: number;
}

/** Chunk 元数据（与 chunks_meta JSON 分片结构对齐） */
export interface ChunkMeta {
  docId: string;
  docTitle: string;
  docPath: string;
  metadata: DocChunk['metadata'];
  content: string;
  wikiLinks: string[];
  parentDocId?: string;
}

/** Chunk 仓储抽象
 * - getByIds：pipeline/assembler 批量附着 chunk 用
 * - getAll：entityRouter 倒排索引 / chat route 上下文用
 * Phase 3 将迁移现有 JsonChunkStore 实现到 infrastructure 并演进为 async 签名
 */
export interface ChunkStore {
  /** 按 id 批量获取 chunks */
  getByIds(ids: string[]): DocChunk[];
  /** 获取全部 chunks（Map<chunkId, ChunkMeta>） */
  getAll(): Map<string, ChunkMeta>;
}

/** 已知文档类型白名单（校验 LLM 输出的 relevantDocTypes） */
export const KNOWN_DOC_TYPES: ReadonlySet<string> = new Set([
  '客户项目验收', '技术方案', '技术架构设计', '来往账目', '系统测试报告',
  '需求规格说明书', '项目人员清单', '项目管理计划', '项目费用结算', '项目进度汇报', '大型台账',
]);
