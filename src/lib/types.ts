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
export type SearchSource = 'vector' | 'bm25' | 'hybrid' | 'entity' | 'structured';

/** 检索方法 */
export type SearchMethod = 'rrf' | 'entity';

/** 搜索结果 */
export interface SearchResult {
  chunk: DocChunk;
  score: number;
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
    structSummary?: string;
  };
  createdAt: number;
  updatedAt: number;
}
