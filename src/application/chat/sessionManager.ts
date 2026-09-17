// ============================================================
// 会话管理器：支持多轮对话 + 上下文压缩（Application 层）
//
// 功能：
//   1. 创建/管理对话会话（基于 sessionId）
//   2. 保留最近 N 轮对话历史
//   3. 对话压缩：历史过长时自动压缩为摘要（LLM 走 LlmClient Port）
//   4. 追问检测：自动关联上一轮的检索结果
//   5. 会话自动过期清理
// 存储为进程内 Map（单用户场景，无外部存储依赖）
// ============================================================

import type { SearchMethod, SearchResult } from '@/domain/search/types';
import type { LlmClient } from '../ports';
import type { ChatSession } from './types';

// ============================================================
// 配置
// ============================================================

const MAX_MESSAGES = 10;           // 最大保留消息数
const COMPRESS_THRESHOLD = 6;      // 超过此数触发压缩
const SESSION_TTL = 30 * 60 * 1000; // 会话过期时间（30分钟）

// ============================================================
// 会话存储（内存 Map）
// ============================================================

const sessions = new Map<string, ChatSession>();

/** 生成唯一 session ID */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `sess_${timestamp}_${random}`;
}

/** 清理过期会话 */
function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL) {
      sessions.delete(id);
    }
  }
}

// 每 5 分钟清理一次
setInterval(cleanExpiredSessions, 5 * 60 * 1000);

// ============================================================
// 公开 API
// ============================================================

/**
 * 创建新会话
 */
export function createSession(): ChatSession {
  cleanExpiredSessions();
  const session: ChatSession = {
    id: generateSessionId(),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.set(session.id, session);
  console.log(`[Session] 创建会话: ${session.id}`);
  return session;
}

/**
 * 获取或创建会话
 */
export function getOrCreateSession(sessionId?: string): ChatSession {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.updatedAt = Date.now();
    return session;
  }
  return createSession();
}

/**
 * 获取会话（不创建）
 */
export function getSession(sessionId: string): ChatSession | undefined {
  const session = sessions.get(sessionId);
  if (session) {
    session.updatedAt = Date.now();
  }
  return session;
}

/**
 * 添加消息到会话
 */
export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.messages.push({
    role,
    content,
    timestamp: Date.now(),
  });
  session.updatedAt = Date.now();
}

/**
 * 保存上一次检索结果（用于追问上下文）
 */
export function saveLastSearchResults(
  sessionId: string,
  query: string,
  results: SearchResult[],
  method: SearchMethod,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.lastSearchResults = {
    query,
    results,
    method,
  };
  session.updatedAt = Date.now();
}

/**
 * 获取上一轮检索结果
 */
export function getLastSearchResults(sessionId: string): ChatSession['lastSearchResults'] | undefined {
  const session = sessions.get(sessionId);
  return session?.lastSearchResults;
}

/**
 * 检测是否为追问（指代上一轮内容）
 * 如："那第二个呢？"、"它和XX比呢？"、"详细说说"
 */
export function isFollowUpQuery(query: string): boolean {
  const followUpPatterns = [
    /^那(?:么|这个|第二个|第三个|第一个|它|他|她|这些)/,
    /^(?:详细|具体|展开)(?:说说|讲讲|解释)/,
    /^(?:能|可以|能否)(?:详细|具体|展开)/,
    /^(?:还有|另外)(?:呢|吗)/,
    /^(?:然后|接下来)(?:呢|怎么样)/,
    /^(?:这|那)(?:是|个)(?:什么|为什么|怎么)/,
    /^(?:上面|前面|刚才|之前)(?:的|提到)/,
    /^(?:它|他|她)(?:们|的)?(?:和|跟|与|比)/,
    /^(?:再|继续|接着)(?:说|讲|解释)/,
    /^(?:什么意思|为什么)/,
  ];

  return followUpPatterns.some(p => p.test(query.trim()));
}

/**
 * 获取对话历史摘要（用于 prompt 拼接）
 */
export function getConversationContext(sessionId: string): {
  historyText: string;
  summary?: string;
  hasFollowUp: boolean;
} {
  const session = sessions.get(sessionId);
  if (!session) return { historyText: '', hasFollowUp: false };

  const recentMessages = session.messages.slice(-MAX_MESSAGES);
  const hasFollowUp = recentMessages.length >= 2 &&
    recentMessages[recentMessages.length - 2]?.role === 'assistant';

  let historyText = '';

  // 如果有压缩摘要，前置显示
  if (session.summary) {
    historyText = `## 对话历史摘要\n${session.summary}\n\n`;
  }

  // 添加最近几轮对话
  if (recentMessages.length > 0) {
    const conversationPairs: string[] = [];
    for (let i = 0; i < recentMessages.length; i++) {
      const msg = recentMessages[i];
      if (msg.role === 'user') {
        const assistantMsg = recentMessages[i + 1];
        if (assistantMsg && assistantMsg.role === 'assistant') {
          conversationPairs.push(
            `用户: ${msg.content}\n助手: ${assistantMsg.content.slice(0, 300)}${assistantMsg.content.length > 300 ? '...' : ''}`
          );
          i++; // skip assistant
        } else {
          conversationPairs.push(`用户: ${msg.content}`);
        }
      }
    }
    if (conversationPairs.length > 0) {
      historyText += `## 最近对话\n${conversationPairs.join('\n\n')}`;
    }
  }

  return {
    historyText,
    summary: session.summary,
    hasFollowUp,
  };
}

/**
 * 压缩对话历史为摘要（用 LLM 生成）
 * 当消息数超过 COMPRESS_THRESHOLD 时触发
 * LLM 通过 LlmClient Port 注入，本模块不依赖任何具体 SDK
 */
export async function compressConversation(
  sessionId: string,
  llm: LlmClient,
): Promise<string | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const messageCount = session.messages.length;
  if (messageCount < COMPRESS_THRESHOLD) return null;

  if (!llm.available) {
    console.warn('[Session] 无 LLM，跳过对话压缩');
    return null;
  }

  // 构建压缩 prompt
  const oldMessages = session.messages.slice(0, -2); // 保留最后 2 条不压缩
  const conversationText = oldMessages
    .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `你是一个对话摘要助手。请将以下对话历史压缩为一段简洁的摘要（不超过 200 字），提取关键信息和上下文要点。只输出摘要文本，不要加任何前缀。`;

  try {
    const content = await llm.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `对话历史:\n${conversationText.slice(0, 4000)}` },
      ],
      temperature: 0.3,
      maxTokens: 300,
    });

    const summary = content?.trim() || '';
    if (summary) {
      // 保留最后 2 条消息，用摘要替换之前的
      session.summary = summary;
      session.messages = session.messages.slice(-2);
      session.updatedAt = Date.now();
      console.log(`[Session] 对话已压缩: ${sessionId}, 摘要长度: ${summary.length}`);
      return summary;
    }
  } catch (err) {
    console.error('[Session] 对话压缩失败:', err instanceof Error ? err.message : err);
  }

  return null;
}

/**
 * 删除会话
 */
export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
  console.log(`[Session] 删除会话: ${sessionId}`);
}

/**
 * 获取活跃会话数
 */
export function getActiveSessionCount(): number {
  cleanExpiredSessions();
  return sessions.size;
}

/**
 * 清空所有会话（仅测试使用）
 * @internal for testing only
 */
export function clearAllSessions(): void {
  sessions.clear();
  console.log('[Session] 清空所有会话（测试用）');
}
