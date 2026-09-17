# Issue 分类账本

> 从 `spec_20260608.md` 和 `spec_discussion_20260608.md` 中提取的所有已知问题，按 AGENTS.md 定义的分类标准归类。

---

## [BUG] 局部缺陷

这些是单点缺陷，修复不影响公共接口。

| # | 标题 | 来源 | 严重度 | 状态 |
|---|------|------|:---:|:---:|
| B-1 | `parser.ts` chunkIndex 跨 section 重复 | spec_discussion §1 | 🔴 高 | ✅ 已修复 (Phase 1) |
| B-2 | `indexLookup.ts` 子章节边界提取 bug（`###` 级别停不下来） | spec_discussion 专项分析 B2 | 🟡 中 | 📋 待修复 |
| B-3 | `adaptiveWindow` "多少个" 被误判为数据查询 → 过度扩展窗口 (±3) | spec_discussion 专项分析 C3 | 🟡 中 | 📋 待修复 |
| B-4 | `isFollowUpQuery` 纠错场景遗漏（"不对/不是这个"、"就这些？"） | spec_discussion 专项分析 D | 🔴 高 | 📋 待修复 |
| B-5 | `smartRouter` "谁负责/有没有" 类查询未覆盖 | spec_discussion 专项分析 A1 | 🔴 高 | 📋 待修复 |
| B-6 | `indexLookup` "甲方/中间件/事业部" 等别名未覆盖 | spec_discussion 专项分析 B1 | 🟢 低 | 📋 待修复 |
| B-7 | `adaptiveWindow` "流程/步骤"类、"性能指标"类未覆盖 | spec_discussion 专项分析 C1/C2 | 🟢 低 | 📋 待修复 |
| B-8 | 会话管理"上一轮 query"在连续追问时不更新 | spec_20260608 §5.7 | 🟡 中 | 📋 待修复 |
| B-9 | 对话压缩异步不 await，失败静默吞掉 | spec_20260608 §5.8 | 🟡 中 | 📋 待修复 |
| B-10 | `entityRouter.routedSearch` 降级路径可能重复调用 hybridSearch | spec_20260608 §5.9 | 🟡 中 | 📋 待修复 |
| B-11 | 实体关键词过滤只在向量侧生效，BM25 侧不过滤 | spec_20260608 §5.14 | 🟢 低 | 📋 待修复 |

---

## [DESIGN] 设计变更

这些是模块内部实现调整，不改变公开 API 契约。

| # | 标题 | 来源 | 优先级 | 状态 |
|---|------|------|:---:|:---:|
| D-1 | 上下文窗口硬编码常量参数化（`SHORT_DOC_TOKEN_LIMIT`, `CONTEXT_WINDOW`, `MAX_SNIPPETS_PER_DOC`） | spec_discussion §5 | 🟡 中低 | 📋 planned |
| D-2 | `hybridSearchExpanded` 公开但无调用方 — 评估是否删除或整合 | spec_20260608 §5.4 | 🟢 低 | 📋 待评估 |
| D-3 | `ragChat` 公开但无调用方 — 评估是否删除 | spec_20260608 §5.5 | 🟢 低 | 📋 待评估 |
| D-4 | `isVectorReady` 公开但无调用方 — 评估是否删除 | spec_20260608 §5.6 | 🟢 低 | 📋 待评估 |
| D-5 | `smartRewrite` 返回的 `intent` 字段未用于路由决策 — 评估是否打通 | spec_discussion §4 | 🟢 低 | 📋 待评估 |
| D-6 | LLM 实体提取结果缓存（同 query 不重复调用） | spec_discussion §2 | 🟢 低 | 📋 planned |
| D-7 | jieba 路径加入模糊匹配（编辑距离 ≤2） | spec_discussion §2 | 🟢 低 | 📋 planned |
| D-8 | 父文档缓存永不过期 — 加 TTL 或增量更新机制 | spec_20260608 §5.11 | 🟡 中 | 📋 待修复 |

---

## [API] 公共接口或兼容性变更

这些涉及 `src/lib/` 中导出函数的签名变更或行为变更，影响下游调用方。

| # | 标题 | 来源 | 优先级 | 状态 |
|---|------|------|:---:|:---:|
| A-1 | `smartRewrite()` 返回值新增 `routeDecision` 字段 | spec_discussion 实施记录 | 🔴 高 | ✅ implemented (Spec 002) |
| A-2 | `ragEngine` options 新增 `contextWindowOverride` | spec_discussion 实施记录 | 🔴 高 | ✅ implemented (Spec 002) |
| A-3 | 统一路由入口到 `entityRouter.routedSearch()` | spec_discussion §3 | 🟡 中 | 📋 planned |

---

## [MULTI] 多 Issue 同根因

这些问题的根因相同，需要统一修复而非逐个修补。

| # | 标题 | 来源 | 优先级 | 状态 |
|---|------|------|:---:|:---:|
| M-1 | 分块逻辑 ×3 统一（提取共享 `chunker.ts` 模块） | spec_discussion §1 | 🔴 高 | ✅ implemented (Spec 001) |
| M-2 | 索引构建 ×2 统一（抽取 `scripts/lib/` 公共模块） | spec_discussion §6 | 🔴 高 | ✅ implemented (Spec 001) |
| M-3 | chunks_meta 分片数量硬编码（构建脚本与运行时独立维护） | spec_20260608 §5.12 | 🟡 中 | 📋 待修复 |
| M-4 | `index_state.json` 首次增量构建可能产生重复数据 | spec_20260608 §5.1 | 🟡 中 | 📋 待修复 |

---

## 分类统计

| 分类 | 总数 | 已修复 | 待处理 |
|------|:---:|:---:|:---:|
| `[BUG]` 局部缺陷 | 11 | 1 | 10 |
| `[DESIGN]` 设计变更 | 8 | 0 | 8 |
| `[API]` 公共接口 | 3 | 2 | 1 |
| `[MULTI]` 同根因 | 4 | 2 | 2 |
| **合计** | **26** | **5** | **21** |

---

## 优先级速览

### 🔴 高优先级（建议近期修复）

| # | 分类 | 标题 |
|---|------|------|
| B-4 | BUG | isFollowUpQuery 纠错场景遗漏 |
| B-5 | BUG | smartRouter "谁负责/有没有" 未覆盖 |
| B-1 | BUG | chunkIndex 跨 section 重复 ✅ 已修复 |
| A-1 | API | smartRewrite 路由决策 ✅ 已实施 |
| A-2 | API | ragEngine contextWindowOverride ✅ 已实施 |
| M-1 | MULTI | 分块逻辑 ×3 统一 ✅ 已实施 |
| M-2 | MULTI | 索引构建 ×2 统一 ✅ 已实施 |

### 🟡 中优先级

| # | 分类 | 标题 |
|---|------|------|
| B-2 | BUG | indexLookup 子章节边界 |
| B-3 | BUG | adaptiveWindow 误判 |
| B-8 | BUG | 连续追问 query 不更新 |
| B-9 | BUG | 对话压缩不 await |
| B-10 | BUG | routedSearch 重复调用 |
| D-1 | DESIGN | 上下文窗口常量参数化 |
| D-8 | DESIGN | 父文档缓存过期 |
| A-3 | API | 统一路由入口 routedSearch |
| M-3 | MULTI | chunks_meta 分片数硬编码 |
| M-4 | MULTI | index_state.json 重复数据 |

### 🟢 低优先级

| # | 分类 | 标题 |
|---|------|------|
| B-6 | BUG | indexLookup 别名覆盖 |
| B-7 | BUG | adaptiveWindow 规则补充 |
| B-11 | BUG | 实体过滤仅向量侧 |
| D-2~D-7 | DESIGN | 死代码清理 + 缓存/模糊匹配优化 |
