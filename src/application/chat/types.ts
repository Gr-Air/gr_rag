// ============================================================
// 多轮对话类型（Application 层）
// 会话/消息是业务流程概念，非检索领域模型
// ============================================================

import type { SearchMethod, SearchResult } from '@/domain/search/types';

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
