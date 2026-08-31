// ============================================================
// 核心类型定义
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

/** 原始文档解析结果 */
export interface ParsedDoc {
  id: string;
  title: string;
  path: string;
  rawContent: string;
  chunks: DocChunk[];
  metadata: DocChunk['metadata'];
  wikiLinks: string[];
}

/** Wiki 词条 */
export interface WikiEntry {
  name: string;
  type: 'concept' | 'entity';
  frequency: number;
  category?: string;
  path: string;
}

/** 检索来源类型 */
export type SearchSource = 'vector' | 'bm25' | 'rrf' | 'entity' | 'hybrid';

/** 检索方法 */
export type SearchMethod = 'rrf' | 'entity';

/**
 * 检索管线中间结果：chunkId + 分数链路（各阶段只追加，不覆盖）
 * 追溯链路：vector/bm25 原始分 → rrf 融合分（含实体加成）→ rerank 相关性分
 */
export interface RetrievalHit {
  chunkId: string;
  /** 组装阶段批量附上（getChunksByIds 一次取回） */
  chunk?: DocChunk;
  scores: {
    /** 向量相似度原始分 */
    vector?: number;
    /** BM25 原始分 */
    bm25?: number;
    /** RRF 融合分（含实体加成后的最终值） */
    rrf?: number;
    /** rerank 模型相关性分 */
    rerank?: number;
    /** 结构化检索命中分（词条频次，仅 StructRetriever 输出，Spec 029） */
    struct?: number;
  };
  ranks: {
    /** 1-based；被实体过滤的向量结果此字段缺省（不贡献 RRF） */
    vector?: number;
    bm25?: number;
  };
  source: SearchSource;
}

/** 搜索结果（最终展示态：score 为归一化最终分，scores 保留完整链路供追溯/评估） */
export interface SearchResult {
  chunk: DocChunk;
  /** 最终分：rerank 路径下为 rerank 相关性分，否则为归一化 RRF 分 */
  score: number;
  /** 完整分数链路（vector/bm25/rrf/rerank），调试与 eval 用 */
  scores: RetrievalHit['scores'];
  source: SearchSource;
  highlight?: string;
}

/** 知识库统计 */
export interface WikiStats {
  totalDocs: number;
  totalChunks: number;
  totalConcepts: number;
  totalEntities: number;
  totalClients: number;
  totalProjects: number;
  totalDocTypes: number;
  topConcepts: WikiEntry[];
  topEntities: WikiEntry[];
  clients: string[];
  projects: string[];
  docTypes: string[];
  indexReady?: boolean;
  structDbReady?: boolean;
  structStats?: {
    totalEntries: number;
    totalConcepts: number;
    totalEntities: number;
    totalDocs: number;
    totalRelations: number;
  } | null;
}

// ============================================================
// 多轮对话相关类型
// ============================================================

/** 对话消息 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/** 对话会话 */
export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  /** 压缩后的对话摘要 */
  summary?: string;
  /** 上一次检索的结果（用于追问上下文） */
  lastSearchResults?: {
    query: string;
    results: SearchResult[];
    method: SearchMethod;
  };
  createdAt: number;
  updatedAt: number;
}
