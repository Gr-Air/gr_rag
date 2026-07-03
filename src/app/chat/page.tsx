"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  context?: Array<{
    docTitle: string;
    metadata: Record<string, string>;
    source: string;
    score: number;
    content?: string;
    docPath?: string;
  }>;
  matchedKeywords?: string[];
  structSummary?: string;
}

const QUICK_PROMPTS = [
  "国家电网的ERP系统架构是怎样的？",
  "物联网管理平台有哪些客户？",
  "最近的项目验收情况如何？",
  "微服务架构改造涉及哪些技术？",
];

export default function ChatPage() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || "";

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(initialQuery);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({
    apiKey: "",
    baseURL: "",
    model: "",
    topK: 10,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (initialQuery) {
      sendMessage(initialQuery);
    }
  }, []);

  const sendMessage = useCallback(
    async (text?: string) => {
      const queryText = text || input.trim();
      if (!queryText || loading) return;

      const userMsg: Message = {
        id: Date.now().toString(),
        role: "user",
        content: queryText,
      };

      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);

      const assistantId = (Date.now() + 1).toString();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
      };
      setMessages((prev) => [...prev, assistantMsg]);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: queryText,
            topK: settings.topK,
            apiKey: settings.apiKey?.trim() || undefined,
            baseURL: settings.baseURL?.trim() || undefined,
            model: settings.model?.trim() || undefined,
          }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("无法读取响应流");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                setMessages((prev) =>
                  prev.map((msg) => {
                    if (msg.id !== assistantId) return msg;

                    if (data.type === "method") {
                      return {
                        ...msg,
                        matchedKeywords: data.matchedKeywords,
                        structSummary: data.structSummary,
                      };
                    } else if (data.type === "context") {
                      return {
                        ...msg,
                        context: data.results,
                      };
                    } else if (data.type === "token") {
                      return { ...msg, content: msg.content + (data.content || "") };
                    } else if (data.type === "error") {
                      return { ...msg, content: data.content || "发生错误" };
                    }
                    return msg;
                  })
                );
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
      } catch (err: any) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? { ...msg, content: `请求失败: ${err.message}` }
              : msg
          )
        );
      } finally {
        setLoading(false);
      }
    },
    [input, loading, settings.topK]
  );

  return (
    <div className="h-full flex flex-col mx-auto max-w-4xl relative">
      {/* 顶部导航栏 */}
      <header className="flex-shrink-0 flex items-center justify-between h-14 px-6 border-b border-slate-200/60 bg-white/70 backdrop-blur-xl sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
          </Link>
          <div className="h-5 w-px bg-slate-200" />
          <h1 className="text-sm font-semibold text-slate-700">AI 智能问答</h1>
        </div>
        <div className="flex items-center gap-1">
          <NavLink href="/">问答</NavLink>
          <NavLink href="/chat" active>AI对话</NavLink>
          <NavLink href="/search">搜索</NavLink>
          <NavLink href="/docs">文档</NavLink>
          <div className="h-5 w-px bg-slate-200 mx-1" />
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-1.5 rounded-lg transition-all duration-200 ${
              showSettings ? "bg-indigo-50 text-indigo-600" : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            }`}
            title="设置"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* 设置面板 */}
      {showSettings && (
        <div className="flex-shrink-0 mx-4 sm:mx-6 mt-3 p-4 glass-card rounded-2xl shadow-sm animate-fade-in-up">
          <h3 className="text-xs font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            LLM 配置
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <InputField label="API Key" type="password" placeholder="sk-...（留空使用环境变量）" value={settings.apiKey} onChange={(v) => setSettings({ ...settings, apiKey: v })} />
            <InputField label="Base URL（可选）" placeholder="https://api.openai.com/v1" value={settings.baseURL} onChange={(v) => setSettings({ ...settings, baseURL: v })} />
            <InputField label="模型" placeholder="gpt-4o-mini" value={settings.model} onChange={(v) => setSettings({ ...settings, model: v })} />
            <div>
              <label className="block text-[11px] text-slate-500 mb-1.5 font-medium">召回文档数</label>
              <select
                value={settings.topK}
                onChange={(e) => setSettings({ ...settings, topK: parseInt(e.target.value) })}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all duration-200"
              >
                {[3, 5, 8, 10].map((k) => (
                  <option key={k} value={k}>{k} 篇文档</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto py-6 px-4 sm:px-6 space-y-5 gradient-bg">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="relative mb-8">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-emerald-400 flex items-center justify-center border-2 border-white">
                <div className="w-2 h-2 rounded-full bg-white" />
              </div>
            </div>

            <h2 className="text-2xl font-bold text-slate-800 mb-2 tracking-tight">星辰Wiki 智能助手</h2>
            <p className="text-sm text-slate-500 max-w-sm mb-8">
              我可以基于知识库文档回答你的问题，支持自定义 LLM 配置
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-lg">
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    setInput(q);
                    inputRef.current?.focus();
                  }}
                  className="text-left px-4 py-3 rounded-xl border border-slate-200/80 bg-white/60 backdrop-blur-sm text-sm text-slate-600 hover:border-indigo-300 hover:text-indigo-700 hover:bg-white/90 transition-all duration-200 hover:shadow-sm"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} message-enter`}
            style={{ animationDelay: `${Math.min(idx * 50, 300)}ms` }}
          >
            <div className="flex items-start gap-2.5 max-w-[80%]">
              {msg.role === "assistant" && (
                <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm mt-0.5">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
              )}
              {msg.role === "system" && (
                <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center mt-0.5">
                  <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              )}

              <div
                className={`rounded-2xl px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-gradient-to-br from-indigo-600 to-indigo-500 text-white shadow-md shadow-indigo-500/20"
                    : msg.role === "system"
                    ? "bg-amber-50/80 border border-amber-200 text-amber-800 backdrop-blur-sm"
                    : "glass-card shadow-sm"
                }`}
              >
                {msg.matchedKeywords && msg.matchedKeywords.length > 0 && (
                  <EntityTags keywords={msg.matchedKeywords} />
                )}

                {msg.structSummary && (
                  <StructResultCard
                    structSummary={msg.structSummary}
                    matchedKeywords={msg.matchedKeywords}
                  />
                )}

                {msg.context && msg.context.length > 0 && (
                  <ReferenceCards contexts={msg.context} />
                )}

                <div className={`text-sm leading-relaxed whitespace-pre-wrap markdown-body ${msg.role === "user" ? "text-white" : ""}`}>
                  {msg.content || (
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-slate-300" style={{ animation: "bounce-dot 1.4s ease-in-out infinite" }} />
                      <span className="inline-block w-2 h-2 rounded-full bg-slate-300" style={{ animation: "bounce-dot 1.4s ease-in-out 0.2s infinite" }} />
                      <span className="inline-block w-2 h-2 rounded-full bg-slate-300" style={{ animation: "bounce-dot 1.4s ease-in-out 0.4s infinite" }} />
                    </span>
                  )}
                </div>
              </div>

              {msg.role === "user" && (
                <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-slate-200 flex items-center justify-center mt-0.5">
                  <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
              )}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入框区域 */}
      <div className="flex-shrink-0 px-4 sm:px-6 pb-5 pt-2 bg-gradient-to-t from-white via-white/90 to-transparent">
        <div className="flex items-end gap-2.5 glass-card rounded-2xl p-2 shadow-sm border-slate-200/60">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder="输入问题，基于知识库文档回答..."
            disabled={loading}
            className="flex-1 px-3 py-2.5 bg-transparent text-sm text-slate-700 placeholder-slate-400 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-500 text-white flex items-center justify-center hover:from-indigo-700 hover:to-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md active:scale-95"
          >
            {loading ? (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </button>
        </div>
        <p className="text-[11px] text-slate-400 text-center mt-3">
          回答基于知识库文档内容生成，请以实际文档为准
        </p>
      </div>
    </div>
  );
}

/* ========== 导航链接 ========== */
function NavLink({ href, active, children }: { href: string; active?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
        active
          ? "bg-indigo-50 text-indigo-600"
          : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
      }`}
    >
      {children}
    </Link>
  );
}

/* ========== 表单组件 ========== */
function InputField({ label, type = "text", placeholder, value, onChange }: {
  label: string;
  type?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-[11px] text-slate-500 mb-1.5 font-medium">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all duration-200"
      />
    </div>
  );
}

/* ========== 子组件 ========== */

function EntityTags({ keywords }: { keywords: string[] }) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] text-slate-400 flex-shrink-0">🔍 识别:</span>
      {keywords.map((kw, i) => (
        <span
          key={i}
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-50 text-indigo-600 border border-indigo-100"
        >
          {kw}
        </span>
      ))}
    </div>
  );
}

function StructResultCard({
  structSummary,
  matchedKeywords,
}: {
  structSummary: string;
  matchedKeywords?: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  const lines = structSummary.split("\n").filter((l) => l.trim());
  const sections: { keyword: string; freq: number; docs: string[] }[] = [];

  let currentSection: { keyword: string; freq: number; docs: string[] } | null = null;
  for (const line of lines) {
    const headingMatch = line.match(/^### (.+?)\(频次:\s*(\d+)\)/);
    if (headingMatch) {
      if (currentSection) sections.push(currentSection);
      currentSection = { keyword: headingMatch[1].trim(), freq: parseInt(headingMatch[2]), docs: [] };
    } else if (line.startsWith("  - ") && currentSection) {
      currentSection.docs.push(line.replace(/^\s*-\s*/, "").trim());
    }
  }
  if (currentSection) sections.push(currentSection);

  const totalDocs = sections.reduce((sum, s) => sum + s.docs.length, 0);

  return (
    <div className="mb-3 pb-3 border-b border-slate-200/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left text-xs text-slate-500 flex items-center gap-1.5 hover:bg-white/60 rounded-lg px-2 py-1.5 transition-all duration-200"
      >
        <span className={`flex-shrink-0 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
        <span className="font-medium text-slate-600">关联查询</span>
        {matchedKeywords && matchedKeywords.length > 0 && (
          <span className="text-[10px] opacity-60">({matchedKeywords.join("、")})</span>
        )}
        <span className="text-[10px] opacity-50 font-mono ml-auto">
          {sections.length}实体 · {totalDocs}文档
        </span>
      </button>

      {expanded && (
        <div className="mt-1 mx-6 mb-1 animate-fade-in-up">
          <div className="text-[11px] leading-relaxed text-slate-600 bg-indigo-50/50 border border-indigo-100 rounded-xl px-3 py-2 max-h-64 overflow-y-auto">
            {sections.map((section, si) => (
              <div key={si} className={si > 0 ? "mt-2 pt-2 border-t border-indigo-100/50" : ""}>
                <div className="font-semibold text-indigo-700 mb-0.5">
                  {section.keyword}
                  <span className="font-normal text-slate-400 ml-1">({section.freq})</span>
                </div>
                <ul className="space-y-0.5">
                  {section.docs.map((doc, di) => (
                    <li key={di} className="text-slate-500 pl-3">· {doc}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReferenceCards({
  contexts,
}: {
  contexts: Array<{
    docTitle: string;
    metadata: Record<string, string>;
    source: string;
    score: number;
    content?: string;
    docPath?: string;
  }>;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="mb-3 pb-3 border-b border-slate-200/50">
      <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        参考文档 ({contexts.length})
      </div>
      <div className="space-y-1">
        {contexts.map((ctx, i) => (
          <div key={i}>
            <button
              onClick={() => toggle(i)}
              className="w-full text-left text-xs flex items-center gap-2 hover:bg-white/60 rounded-lg px-2 py-1.5 transition-all duration-200 group"
            >
              <span className={`flex-shrink-0 transition-transform duration-200 ${expanded.has(i) ? "rotate-90" : ""}`}>
                <svg className="w-3 h-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </span>
              <span className="truncate flex-1 font-medium text-slate-600 group-hover:text-slate-900">
                {ctx.docTitle}
              </span>
              <span className="text-[10px] text-slate-400 font-mono flex-shrink-0">
                {ctx.score.toFixed(2)}
              </span>
              <SourceBadge source={ctx.source} />
            </button>

            {expanded.has(i) && ctx.content && (
              <div className="mt-1 mx-6 mb-1 animate-fade-in-up">
                <div className="text-[11px] leading-relaxed text-slate-600 bg-white/80 border border-slate-100 rounded-xl px-3 py-2 max-h-48 overflow-y-auto whitespace-pre-wrap">
                  {ctx.content.replace(/\[\[([^\]]+)\]\]/g, "$1").slice(0, 1500)}
                  {ctx.content.length > 1500 && (
                    <span className="text-slate-300 ml-1">...（已截断）</span>
                  )}
                </div>
                {ctx.docPath && (
                  <div className="text-[10px] text-slate-300 mt-0.5 ml-0.5 truncate">
                    {ctx.docPath}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const styles: Record<string, string> = {
    vector: "bg-purple-50 text-purple-600 border-purple-100",
    bm25: "bg-amber-50 text-amber-600 border-amber-100",
    hybrid: "bg-emerald-50 text-emerald-600 border-emerald-100",
    entity: "bg-rose-50 text-rose-600 border-rose-100",
    structured: "bg-blue-50 text-blue-600 border-blue-100",
  };

  const labels: Record<string, string> = {
    vector: "向量",
    bm25: "BM25",
    hybrid: "混合",
    entity: "实体",
    structured: "数据库",
  };

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 border ${styles[source] || "bg-slate-50 text-slate-500 border-slate-100"}`}>
      {labels[source] || source}
    </span>
  );
}
