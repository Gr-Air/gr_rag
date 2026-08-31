// ============================================================
// 检索 Domain 类型 + 接口
// 依赖方向：domain 不得 import infrastructure / app / fs / DB
// 接口只为可替换性和测试 mock 服务，管线组装固定于 application 层
// Phase 2：拆分 RetrievalContext → SearchQuery / QueryAnalysis / RetrievalFilter / RetrievalOptions
// ============================================================

import { DocChunk } from '../document/types';

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
  /** 组装阶段批量附上（ChunkStore 一次取回） */
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

// ============================================================
// Phase 2：RetrievalContext 拆分
// ============================================================

/** 纯查询意图：Retriever 只需知道查什么 */
export interface SearchQuery {
  query: string;
}

/** 查询分析结果：实体匹配信息，Fusion 用于实体过滤/加成，Retriever 不依赖此类型 */
export interface QueryAnalysis {
  matchedKeywords?: string[];
}

/** 检索过滤条件：docType 白名单过滤（来自 LLM 改写） */
export interface RetrievalFilter {
  filteredChunkIds?: string[];
}

/** Retriever 选项：topN + 过滤 + 结构化检索关键词（非 Entity 概念，是检索参数） */
export interface RetrievalOptions {
  topN: number;
  filter?: RetrievalFilter;
  /** 结构化检索用：匹配关键词（StructRetriever 的查询输入，非实体域知识） */
  keywords?: string[];
}

/** 完整检索请求：pipeline 内部聚合，按组件分发不同子结构 */
export interface RetrievalRequest {
  query: SearchQuery;
  analysis?: QueryAnalysis;
  filter?: RetrievalFilter;
}

/** 检索器：一路召回（向量 / BM25 / 结构化），输出统一 RetrievalHit */
export interface Retriever {
  readonly name: 'vector' | 'bm25' | 'struct';
  search(query: SearchQuery, options: RetrievalOptions): Promise<RetrievalHit[]>;
}

/** 融合器：合并多路召回结果，基于 QueryAnalysis 做实体过滤/加成 */
export interface Fusion {
  readonly name: string;
  fuse(hitLists: RetrievalHit[][], analysis: QueryAnalysis, topK: number): RetrievalHit[];
}

/**
 * 重排器：对最终检索结果做语义精排
 * 注：operates on SearchResult（rerank 由 ragEngine 调用侧持有，
 * 输入为含 chunk 的最终结果，而非管线中间态 RetrievalHit）
 */
export interface Reranker {
  readonly name: string;
  rerank(query: SearchQuery, results: SearchResult[], topN: number): Promise<SearchResult[]>;
}
