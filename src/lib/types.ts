// ============================================================
// Application / Infrastructure 类型（非 Domain）
// Domain 类型已迁移到 src/domain/{search,document,entity}/types.ts
// 本文件保留：解析结果（infrastructure）+ 知识库统计（infrastructure）+ 会话（application）
// + 临时 re-export domain 类型供未迁移的调用方使用
// Phase 2-17 逐步迁移 import 到 @/domain/* 后删除 re-export
// ============================================================

import { DocChunk } from '@/domain/document/types';
import { WikiEntry } from '@/domain/entity/types';
import { SearchResult, SearchMethod } from '@/domain/search/types';

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

/** 知识库统计（infrastructure） */
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
// Application 层：多轮对话相关类型
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

// Re-export domain 类型，供未迁移的调用方临时使用
export type { DocChunk, ChunkMeta, ChunkStore } from '@/domain/document/types';
export type { WikiEntry, KnownEntityInfo, EntityMatch, EntityRepository } from '@/domain/entity/types';
export type {
  SearchSource,
  SearchMethod,
  RetrievalHit,
  SearchResult,
  SearchQuery,
  QueryAnalysis,
  RetrievalFilter,
  RetrievalOptions,
  RetrievalRequest,
  Retriever,
  Fusion,
  Reranker,
} from '@/domain/search/types';
