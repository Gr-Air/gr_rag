"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { WikiStats } from "@/application/kb/kbTypes";

interface RawDoc {
  id: string;
  title: string;
  path: string;
  metadata: {
    client?: string;
    project?: string;
    docType?: string;
    date?: string;
  };
  wikiLinks: string[];
  chunkCount: number;
}

export default function DocsPage() {
  const [docs, setDocs] = useState<RawDoc[]>([]);
  const [stats, setStats] = useState<WikiStats | null>(null);
  const [loading, setLoading] = useState(true);

  const [filterClient, setFilterClient] = useState("");
  const [filterProject, setFilterProject] = useState("");
  const [filterDocType, setFilterDocType] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/docs/list").then((r) => r.json()),
    ])
      .then(([statsData, docsData]) => {
        setStats(statsData);
        setDocs(docsData.docs || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filteredDocs = docs.filter((doc) => {
    if (filterClient && doc.metadata.client !== filterClient) return false;
    if (filterProject && doc.metadata.project !== filterProject) return false;
    if (filterDocType && doc.metadata.docType !== filterDocType) return false;
    return true;
  });

  const hasFilter = filterClient || filterProject || filterDocType;

  return (
    <div className="h-full flex flex-col mx-auto max-w-6xl relative">
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
          <h1 className="text-sm font-semibold text-slate-700">文档浏览</h1>
        </div>
        <nav className="flex items-center gap-1">
          <NavLink href="/">问答</NavLink>
          <NavLink href="/chat">AI对话</NavLink>
          <NavLink href="/search">搜索</NavLink>
          <NavLink href="/docs" active>文档</NavLink>
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="px-4 sm:px-6 py-6">
          {/* 统计卡片 */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <StatCard icon="📄" label="文档总数" value={docs.length.toString()} />
              <StatCard icon="📂" label="客户企业" value={stats.clients.length.toString()} />
              <StatCard icon="📋" label="项目系统" value={stats.projects.length.toString()} />
              <StatCard icon="🏷️" label="文档类型" value={stats.docTypes.length.toString()} />
            </div>
          )}

          {/* 筛选器 */}
          {stats && (
            <div className="glass-card rounded-2xl p-4 mb-6 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                <span className="text-xs font-semibold text-slate-500">筛选条件</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <FilterSelect
                  label="客户企业"
                  value={filterClient}
                  onChange={setFilterClient}
                  options={stats.clients}
                  placeholder="全部客户"
                />
                <FilterSelect
                  label="项目系统"
                  value={filterProject}
                  onChange={setFilterProject}
                  options={stats.projects}
                  placeholder="全部项目"
                />
                <FilterSelect
                  label="文档类型"
                  value={filterDocType}
                  onChange={setFilterDocType}
                  options={stats.docTypes}
                  placeholder="全部类型"
                />
              </div>
            </div>
          )}

          {/* 文档列表 */}
          {loading ? (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="glass-card rounded-2xl p-4 animate-pulse">
                  <div className="h-4 bg-slate-200 rounded-full w-1/2 mb-3" />
                  <div className="h-3 bg-slate-100 rounded-full w-3/4" />
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  共 {filteredDocs.length} 个文档
                </div>
                {hasFilter && (
                  <button
                    onClick={() => {
                      setFilterClient("");
                      setFilterProject("");
                      setFilterDocType("");
                    }}
                    className="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1 px-3 py-1.5 rounded-lg hover:bg-indigo-50 transition-all duration-200"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    清除筛选
                  </button>
                )}
              </div>

              <div className="space-y-2">
                {filteredDocs.map((doc) => (
                  <div
                    key={doc.id}
                    className="glass-card rounded-2xl p-4 hover:bg-white/95 hover:border-indigo-200/50 hover:shadow-md transition-all duration-200 group"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-slate-800 group-hover:text-indigo-700 transition-colors truncate">
                          {doc.title}
                        </h3>
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {doc.metadata.client && (
                            <span className="text-[11px] px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-lg border border-indigo-100 font-medium">
                              🏢 {doc.metadata.client}
                            </span>
                          )}
                          {doc.metadata.project && (
                            <span className="text-[11px] px-2 py-0.5 bg-emerald-50 text-emerald-600 rounded-lg border border-emerald-100 font-medium">
                              📋 {doc.metadata.project}
                            </span>
                          )}
                          {doc.metadata.docType && (
                            <span className="text-[11px] px-2 py-0.5 bg-amber-50 text-amber-600 rounded-lg border border-amber-100 font-medium">
                              📄 {doc.metadata.docType}
                            </span>
                          )}
                          {doc.metadata.date && (
                            <span className="text-[11px] px-2 py-0.5 bg-slate-50 text-slate-500 rounded-lg border border-slate-100">
                              📅 {doc.metadata.date}
                            </span>
                          )}
                          <span className="text-[11px] px-2 py-0.5 bg-slate-50 text-slate-400 rounded-lg border border-slate-100">
                            共 {doc.chunkCount} 块
                          </span>
                        </div>
                        {doc.wikiLinks.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2.5">
                            {doc.wikiLinks.slice(0, 10).map((link) => (
                              <span
                                key={link}
                                className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded-md border border-purple-100 font-medium hover:bg-purple-100 transition-colors cursor-default"
                              >
                                [[{link}]]
                              </span>
                            ))}
                            {doc.wikiLinks.length > 10 && (
                              <span className="text-[10px] text-slate-400 px-1.5 py-0.5">
                                +{doc.wikiLinks.length - 10}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {filteredDocs.length === 0 && (
                <div className="text-center py-20 animate-fade-in-up">
                  <div className="relative inline-block mb-6">
                    <div className="w-20 h-20 rounded-2xl bg-slate-100 flex items-center justify-center">
                      <svg className="w-10 h-10 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                  </div>
                  <p className="text-slate-500 font-medium">没有匹配的文档</p>
                  <p className="text-sm text-slate-400 mt-1">尝试调整筛选条件</p>
                </div>
              )}
            </>
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

function StatCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="glass-card rounded-2xl p-4 hover:bg-white/95 hover:shadow-md transition-all duration-200">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-50 to-purple-50 flex items-center justify-center text-xl border border-indigo-100">
          {icon}
        </div>
        <div>
          <div className="text-lg font-bold text-slate-800 tracking-tight">{value}</div>
          <div className="text-[11px] text-slate-400 font-medium">{label}</div>
        </div>
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <div>
      <label className="block text-[11px] text-slate-400 mb-1.5 font-medium">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all duration-200"
      >
        <option value="">{placeholder}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}
