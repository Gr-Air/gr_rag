// ============================================================
// Composition Root（组装根）
// 唯一允许实例化具体 Infrastructure 的位置：
//   1. 创建全部基础设施实现（引擎 / 适配器 / Port 实现）
//   2. 注入 Application 层 Use Case 工厂，组装业务流程
//   3. Presentation（app routes）通过 getContainer() 获取用例
//
// 依赖方向：composition → application / infrastructure → domain
// ============================================================

import type { Retriever } from '@/domain/search/types';

// Application 层 Use Case
import { createHybridSearch, type HybridSearchFn } from '@/application/search/hybridSearch';
import { createSmartRewriter, type SmartRewriter } from '@/application/search/queryRewriter';
import { createEntitySearch, type EntitySearch } from '@/application/search/entitySearch';
import { createRagChatStream, type RagChatStreamFn } from '@/application/chat/ragEngine';
import { createChatService, type ChatService } from '@/application/chat/chatService';
import { createEvalService, type EvalService } from '@/application/eval/evalService';

// Application 层 Port
import type { LlmClient, EmbeddingPort, SearchCachePort, KbStatusPort, KbStatsPort, DocumentFileStore } from '@/application/ports';

// Infrastructure 实现
import { getChunkStore } from '@/infrastructure/document/jsonChunkStore';
import { VectorRetriever } from '@/infrastructure/search/retrievers/vector';
import { BM25Retriever } from '@/infrastructure/search/retrievers/bm25';
import { RRFFusion } from '@/infrastructure/search/fusion';
import { getReranker } from '@/infrastructure/search/rerankers';
import { OpenAiLlmClient } from '@/infrastructure/llm/openaiClient';
import { LruSearchCache } from '@/infrastructure/cache/searchCache';
import { FsDocumentFileStore } from '@/infrastructure/document/documentFileStore';
import { kbStatus } from '@/infrastructure/index/kbStatus';
import { kbStats } from '@/infrastructure/parser/kbStats';
import { SqliteStructQuery, SqliteEntityRepository } from '@/infrastructure/struct/entityAdapters';
import { queryEmbeddingPort } from '@/infrastructure/embedding/embeddingAdapter';

// ============================================================
// Container
// ============================================================

export interface Container {
  // ---- Ports（Application 定义，Infrastructure 实现）----
  llm: LlmClient;
  embedding: EmbeddingPort;
  cache: SearchCachePort;
  kbStatus: KbStatusPort;
  kbStats: KbStatsPort;
  fileStore: DocumentFileStore;

  // ---- Use Cases ----
  hybridSearch: HybridSearchFn;
  smartRewriter: SmartRewriter;
  entitySearch: EntitySearch;
  ragChatStream: RagChatStreamFn;
  chatService: ChatService;
  evalService: EvalService;
}

function build(): Container {
  // ---- Infrastructure 实例 ----
  const chunkStore = getChunkStore();
  const retrievers: Retriever[] = [
    new VectorRetriever(),
    new BM25Retriever(),
    // StructRetriever 默认不启用（Spec 029：启用与否留给 eval 数据决策）
  ];
  const fusion = new RRFFusion(chunkStore);
  const llm = new OpenAiLlmClient();
  const cache = new LruSearchCache();
  const fileStore = new FsDocumentFileStore();
  const structQuery = new SqliteStructQuery();
  const entityRepo = new SqliteEntityRepository();

  // ---- Use Case 组装 ----
  const hybridSearch = createHybridSearch({
    chunkStore,
    retrievers,
    fusion,
  });

  const smartRewriter = createSmartRewriter({ llm, entityRepo });

  const entitySearch = createEntitySearch({
    chunkStore,
    structQuery,
    entityRepo,
    hybridSearch,
  });

  // reranker 按请求时环境创建（DASHSCOPE_API_KEY 存在与否决定 Qwen/Noop）
  const ragChatStream = createRagChatStream({
    llm,
    rerankerFactory: getReranker,
    hybridSearch,
  });

  const chatService = createChatService({
    llm,
    embedding: queryEmbeddingPort,
    cache,
    chunkStore,
    structQuery,
    fileStore,
    hybridSearch,
    smartRewriter,
    ragChatStream,
  });

  const evalService = createEvalService({
    llm,
    chunkStore,
    structQuery,
    entityRepo,
    fileStore,
    hybridSearch,
    smartRewriter,
    ragChatStream,
  });

  return {
    llm,
    embedding: queryEmbeddingPort,
    cache,
    kbStatus,
    kbStats,
    fileStore,
    hybridSearch,
    smartRewriter,
    entitySearch,
    ragChatStream,
    chatService,
    evalService,
  };
}

// 懒初始化单例（首次请求时组装，避免模块加载副作用）
let _container: Container | null = null;

export function getContainer(): Container {
  if (!_container) {
    _container = build();
  }
  return _container;
}

/** 测试用：重置容器（下次 getContainer 重新组装） */
export function _resetContainerForTest(): void {
  _container = null;
}
