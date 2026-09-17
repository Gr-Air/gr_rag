# AGENTS.md — llm-wiki 开发治理规范

> 面向 AI Agent 和人类开发者，定义本项目的开发约定、分支命名、测试要求、spec 对账规则与完成定义。

---

## 1. Issue 分类

每个 issue 必须在标题前标注分类标签：

| 标签 | 含义 | 示例 |
|------|------|------|
| `[BUG]` | 局部缺陷，不影响公共接口 | `[BUG] tokenizer 空字符串未过滤` |
| `[DESIGN]` | 设计变更，调整模块内部实现 | `[DESIGN] 提取共享 chunker 模块` |
| `[API]` | 公共接口或兼容性变更 | `[API] smartRewrite 返回值新增 routeDecision 字段` |
| `[MULTI]` | 多 issue 同根因，需统一修复 | `[MULTI] 分块逻辑 x3 统一` |

**分类判断流程**：

1. 是否涉及 `src/lib/` 中导出的函数签名变更？→ `[API]`
2. 是否涉及多个独立模块的同一个问题根因？→ `[MULTI]`
3. 是否是纯内部实现改动（不改变公开契约）？→ `[DESIGN]`
4. 是否是单点缺陷修复？→ `[BUG]`

---

## 2. 分支命名

```
<type>/<short-desc>
```

| Type | 用途 | 对应 Issue 标签 |
|------|------|----------------|
| `fix/` | 缺陷修复 | `[BUG]` |
| `refactor/` | 设计变更 / 重构 | `[DESIGN]` |
| `feat/` | 公共接口变更 / 新功能 | `[API]` |
| `unify/` | 多模块统一修复 | `[MULTI]` |

示例：
- `fix/tokenizer-empty-filter`
- `refactor/shared-chunker`
- `feat/route-decision-field`
- `unify/chunk-logic-3x`

---

## 3. 测试要求

### 3.1 必须测试

- `src/lib/` 下所有导出的纯函数、算法逻辑
- 任何 `[API]` 或 `[MULTI]` 变更必须有对应测试

### 3.2 可以不测试

- Next.js 页面组件 (`src/app/*/page.tsx`)
- API Route Handler 的集成行为（mock 困难的第三方服务）
- 构建脚本 (`scripts/`)

### 3.3 测试文件规范

- 统一放在 `test/` 目录下
- 命名：`test/<moduleName>.test.ts`
- 源文件导入使用 `@/lib/xxx` 路径别名
- 运行：`npm test`（CI）/ `npm run test:watch`（开发）

### 3.4 Mock 策略

- 外部 native 模块 (`@node-rs/jieba`)：mock
- 文件系统 (`fs`)：mock
- 外部 API (`openai`)：mock
- 纯算法函数：直接测试，不 mock

---

## 4. Spec 对账规则

### 4.1 Spec 文件位置

```
spec/
├── README.md              # 状态分类说明
├── governance/            # 治理模板
│   └── spec-template.md   # spec 编写模板
├── planned/               # 计划中（已讨论未实施）
├── implemented/           # 已实施（已合并到主分支）
└── archived/              # 归档（已废弃/不再适用）
```

### 4.2 对账流程

1. **新需求/问题**：先在 `spec/planned/` 创建 spec 文档（按模板），状态标记为 `planned`
2. **开发中**：创建对应分支，spec 状态改为 `in-progress`
3. **PR 合并前**：必须完成 spec 对账清单（见第 5 节），spec 状态改为 `implemented`
4. **已废弃**：移动到 `spec/archived/`，标注废弃原因和日期

### 4.3 Spec 必须包含

- 状态标记（planned / in-progress / implemented / archived）
- 行为契约（输入→输出、边界条件、错误处理）
- 验收标准（可测试的断言列表）
- 实现锚点（涉及的文件和函数）
- 兼容影响（对公开 API、数据格式、下游调用方的影响）

---

## 5. PR 合并前的 Spec 对账清单

每个 PR 合并前，必须在 PR 描述中逐项确认：

```
[ ] Spec 文档已更新（新建/移动/修改状态）
[ ] 行为契约与实现一致
[ ] 验收标准已通过（测试全部 green）
[ ] 公开 API 兼容性已评估（无破坏性变更 或 已记录迁移指南）
[ ] 数据格式兼容性已评估（索引/LanceDB/SQLite schema）
[ ] 下游调用方已检查（所有 import 本模块的文件）
[ ] 硬编码规则变更已同步到 spec 文档
[ ] 新增导出函数的测试覆盖率 ≥ 80%
```

---

## 6. 完成定义 (Definition of Done)

- [ ] 代码通过 ESLint（`npm run lint`）
- [ ] 所有测试通过（`npm test`）
- [ ] 相关 spec 文档状态更新为 `implemented`
- [ ] PR 描述完成 spec 对账清单
- [ ] 无遗留的 TODO/FIXME 注释（或已转为 issue）
- [ ] `[API]` 变更需在 PR 描述中提供迁移指南

---

## 7. 技术约定

| 项目 | 约定 |
|------|------|
| 运行时 | Node.js 20+ |
| 框架 | Next.js 16 (App Router) |
| 语言 | TypeScript 5 (strict) |
| 测试 | Vitest 4 + @vitest/coverage-v8 |
| 包管理 | npm |
| 代码风格 | ESLint (eslint-config-next) |
| 路径别名 | `@/` → `src/` |
| 测试目录 | `test/` |

---

## 8. 项目架构速览

```
src/lib/     # 16 个核心模块（检索/路由/改写/会话/索引管理）
src/app/     # Next.js App Router 页面 + API Route
scripts/     # 索引构建脚本（全量/增量/结构化）
test/        # Vitest 测试文件
spec/        # Spec 治理文档
src/data/    # 预构建索引（LanceDB/BM25/SQLite/chunks_meta）
```

核心检索链路：`chat/route.ts` → `smartRewrite` → `routedSearch/hybridSearch` → `ragEngine` → LLM 流式响应
