// ============================================================
// Application 层 Port 定义
// Application 只依赖这些抽象；具体实现位于 infrastructure/，
// 由 src/composition/container.ts 注入
// 仅在"需要隔离变化 / 存在多实现 / 属于稳定业务能力"处定义 Port
// ============================================================

import type { SearchResult } from '@/domain/search/types';
import type { WikiStats } from './kb/kbTypes';

// ============================================================
// LLM Client Port（OpenAI 兼容 Chat API 的应用层抽象）
// ============================================================

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompleteRequest {
  apiKey: string;
  baseURL?: string;
  model: string;
  messages: LlmMessage[];
  /** 传 undefined 则不携带该参数（推理模型不兼容 temperature） */
  temperature?: number;
  maxTokens?: number;
}

export interface LlmStreamRequest {
  apiKey: string;
  baseURL?: string;
  model: string;
  messages: LlmMessage[];
  temperature?: number;
}

/**
 * LLM Client Port
 * - complete：一次性补全（query 改写 / 会话压缩），返回 content 或 null
 * - stream：流式补全（RAG 回答），逐段 yield content
 */
export interface LlmClient {
  complete(req: LlmCompleteRequest): Promise<string | null>;
  stream(req: LlmStreamRequest): AsyncGenerator<string>;
}

/** 推理模型（如 deepseek-r1）不兼容 temperature 参数，token 预算策略也不同 */
export function isReasoningModel(model: string): boolean {
  return model.toLowerCase().includes('reasoning') || model.toLowerCase().includes('deepseek-r1');
}

// ============================================================
// Embedding Port（查询向量）
// ============================================================

export interface EmbeddingPort {
  /** 生成查询 embedding（带内部缓存） */
  embed(query: string): Promise<number[]>;
  /** 预热内部缓存，避免向量检索时重复调用 embedding API */
  prewarm(query: string, embedding: number[]): void;
}

// ============================================================
// 检索缓存 Port（Spec 030：只缓存 pre-rerank SearchResult[]）
// ============================================================

export interface CacheContext {
  entities: string[];
  policyVersion: string;
}

export interface SearchCachePort {
  /** 精确 + 语义两级匹配查询缓存 */
  lookup(query: string, embedding: number[], ctx: CacheContext): SearchResult[] | null;
  /** 写入缓存（LRU 淘汰） */
  save(query: string, embedding: number[], results: SearchResult[], ctx: CacheContext): void;
}

// ============================================================
// 文档文件 Port（Raw / Wiki 目录读取）
// ============================================================

export interface DocumentFileStore {
  /** 读取 Raw/<docName>.md，不存在返回 null */
  readRawDoc(docName: string): string | null;
  /** 读取 Wiki/<relPath>，不存在返回 null */
  readWikiDoc(relPath: string): string | null;
}

// ============================================================
// 知识库状态 Port（索引就绪 / 结构化库 / manifest 版本）
// ============================================================

export interface IndexInfo {
  indexVersion: number;
  builtAt: string;
  buildMode?: string;
}

export interface KbStatusPort {
  isIndexReady(): boolean;
  isStructDbReady(): boolean;
  getIndexInfo(): IndexInfo | null;
}

// ============================================================
// 知识库统计 Port（parser 提供的统计/文档列表能力）
// ============================================================

export interface KbStatsPort {
  getWikiStats(): WikiStats;
  listRawDocs(): Array<{ id: string; title: string; path: string; metadata: Record<string, string>; wikiLinks: string[]; chunkCount: number }>;
  /** 结构化库统计（未就绪时返回 null） */
  getStructStats(): {
    totalEntries: number;
    totalConcepts: number;
    totalEntities: number;
    totalDocs?: number;
    totalRelations: number;
  } | null;
}
