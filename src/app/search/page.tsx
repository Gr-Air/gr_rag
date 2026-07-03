"use client";

import { useState, useCallback } from "react";
import Link from "next/link";

interface SearchResult {
  id: string;
  docId: string;
  docTitle: string;
  docPath: string;
  content: string;
  metadata: {
    client?: string;
    project?: string;
    docType?: string;
    date?: string;
  };
  score: number;
  source: string;
  highlight?: string;
}

interface SearchResponse {
  query: string;
  matchedKeywords?: string[];
  total: number;
  results: SearchResult[];
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    setError("");

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&topK=10`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setResponse(null);
      } else {
        setResponse(data);
      }
    } catch (err: any) {
      setError("搜索请求失败，请检查服务是否正常运行");
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const results = response?.results || [];

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
          <h1 className="text-sm font-semibold text-slate-700">智能搜索</h1>
        </div>
        <nav className="flex items-center gap-1">
          <NavLink href="/">问答</NavLink>
          <NavLink href="/chat">AI对话</NavLink>
          <NavLink href="/search" active>搜索</NavLink>
          <NavLink href="/docs">文档</NavLink>
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
          {/* 搜索框 */}
          <div className="flex gap-2.5 mb-8">
            <div className="relative flex-1">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="搜索文档内容、技术方案、项目信息..."
                className="w-full px-4 py-3 pr-10 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 shadow-sm transition-all duration-200"
              />
              <svg
                className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <button
              onClick={handleSearch}
              disabled={loading || !query.trim()}
              className="px-5 py-3 bg-gradient-to-br from-indigo-600 to-indigo-500 text-white rounded-xl font-medium text-sm hover:from-indigo-700 hover:to-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md active:scale-[0.98]"
            >
              {loading ? "搜索中..." : "搜索"}
            </button>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl text-sm text-red-700 flex items-start gap-2 animate-fade-in-up">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </div>
          )}

          {/* 加载骨架屏 */}
          {loading && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="glass-card rounded-2xl p-5 animate-pulse">
                  <div className="h-4 bg-slate-200 rounded-full w-3/4 mb-3" />
                  <div className="h-3 bg-slate-100 rounded-full w-full mb-2" />
                  <div className="h-3 bg-slate-100 rounded-full w-2/3" />
                </div>
              ))}
            </div>
          )}

          {/* 空结果 */}
          {searched && results.length === 0 && !loading && !error && (
            <div className="text-center py-20 animate-fade-in-up">
              <div className="relative inline-block mb-6">
                <div className="w-20 h-20 rounded-2xl bg-slate-100 flex items-center justify-center">
                  <svg className="w-10 h-10 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
              </div>
              <p className="text-slate-500 font-medium mb-1">未找到相关文档</p>
              <p className="text-sm text-slate-400">请尝试更换搜索关键词</p>
            </div>
          )}

          {/* 搜索结果 */}
          {results.length > 0 && (
            <div className="animate-fade-in-up">
              {/* 实体标签行 */}
              {response?.matchedKeywords && response.matchedKeywords.length > 0 && (
                <div className="mb-4 flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-slate-400 flex-shrink-0">🔍 识别实体:</span>
                  {response.matchedKeywords.map((kw, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-100"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              )}

              <div className="mb-4 text-sm text-slate-500 flex items-center gap-2">
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                共找到 {results.length} 条结果
              </div>

              <div className="space-y-3">
                {results.map((result) => (
                  <div
                    key={result.id}
                    className="glass-card rounded-2xl p-5 hover:bg-white/95 hover:border-indigo-200/50 hover:shadow-md transition-all duration-200 group"
                  >
                    {/* 标题行 */}
                    <div className="flex items-start justify-between mb-2.5">
                      <h3 className="text-base font-semibold text-slate-800 group-hover:text-indigo-700 transition-colors">
                        {result.docTitle}
                      </h3>
                      <SourceBadge source={result.source} />
                    </div>

                    {/* 元数据 */}
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {result.metadata.client && (
                        <MetaTag icon="🏢" label="客户" value={result.metadata.client} />
                      )}
                      {result.metadata.project && (
                        <MetaTag icon="📋" label="项目" value={result.metadata.project} />
                      )}
                      {result.metadata.docType && (
                        <MetaTag icon="📄" label="类型" value={result.metadata.docType} />
                      )}
                      {result.metadata.date && (
                        <MetaTag icon="📅" label="日期" value={result.metadata.date} />
                      )}
                      <span className="inline-flex items-center gap-1 text-xs text-slate-400 bg-slate-50 rounded-lg px-2 py-0.5 border border-slate-100">
                        相关度 {(result.score * 100).toFixed(1)}%
                      </span>
                    </div>

                    {/* 高亮内容 */}
                    {result.highlight && (
                      <div
                        className="text-sm text-slate-600 leading-relaxed line-clamp-4 bg-slate-50/50 rounded-xl px-3 py-2.5 border border-slate-100"
                        dangerouslySetInnerHTML={{
                          __html: result.highlight.replace(
                            /\*\*(.+?)\*\*/g,
                            '<mark class="bg-amber-100 text-amber-800 rounded px-0.5 font-medium">$1</mark>'
                          ),
                        }}
                      />
                    )}

                    {/* 文档路径 */}
                    <div className="mt-2.5 text-xs text-slate-400 font-mono flex items-center gap-1">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      {result.docPath}
                    </div>
                  </div>
                ))}
              </div>

              {/* 底部引导 */}
              <div className="mt-8 p-4 bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-100 rounded-2xl text-sm text-indigo-700 flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center">
                  <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <div>
                  <p className="font-medium mb-0.5">需要更智能的回答？</p>
                  <p className="text-indigo-600/70">
                    试试{" "}
                    <Link href={`/chat?q=${encodeURIComponent(query)}`} className="font-semibold underline hover:text-indigo-800 transition-colors">
                      AI 智能问答
                    </Link>
                    ，基于检索结果生成综合分析
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
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

/* ========== 子组件 ========== */

function SourceBadge({ source }: { source: string }) {
  const styles: Record<string, string> = {
    vector: "bg-purple-50 text-purple-600 border border-purple-100",
    bm25: "bg-amber-50 text-amber-600 border border-amber-100",
    hybrid: "bg-emerald-50 text-emerald-600 border border-emerald-100",
    entity: "bg-rose-50 text-rose-600 border border-rose-100",
  };

  const labels: Record<string, string> = {
    vector: "向量",
    bm25: "BM25",
    hybrid: "混合",
    entity: "实体",
  };

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${styles[source] || styles.hybrid}`}>
      {labels[source] || source}
    </span>
  );
}

function MetaTag({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500 bg-slate-50 rounded-lg px-2 py-0.5 border border-slate-100">
      <span className="text-[10px]">{icon}</span>
      <span className="text-slate-400">{label}:</span>
      {value}
    </span>
  );
}
