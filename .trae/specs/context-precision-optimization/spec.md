# Context Precision 优化 - Product Requirement Document

## Overview
- **Summary**: 针对 RAG 系统 Context Precision 偏低（0.31）的问题，实施多项优化措施，包括调整 rerank 阈值、减少 topK、优化 Wiki 概念词条等，目标将 Context Precision 提升至 0.45 以上。
- **Purpose**: Context Precision 衡量检索上下文与问题的相关性，当前分数过低表明检索返回了大量不相关上下文，影响 RAG 回答质量。
- **Target Users**: LLM Wiki 项目的 RAG 系统用户和开发者

## Goals
- Context Precision 从 0.31 提升至 0.45 以上
- Context Recall 保持在 0.53 以上
- Answer Relevancy 保持在 0.85 以上
- 表格截断率保持在 5% 以下

## Non-Goals (Out of Scope)
- 不修改现有 API 接口契约
- 不改变数据存储结构（SQLite/LanceDB）
- 不引入新的第三方依赖

## Background & Context
当前评估结果（50条样本）：
- Context Recall: 0.5433 ✅
- Context Precision: 0.3136 ❌（目标 ≥ 0.45）
- Answer Relevancy: 0.8699 ✅
- 表格截断率: 2.28% ✅

根因分析：
1. RRF 混合检索召回了大量相关但非核心的上下文
2. Wiki 概念词条过于宽泛，与具体项目文档混淆
3. rerank 分数阈值（0.3）过低，未过滤低相关度结果
4. topK（5）过高，增加了无关上下文的概率

## Functional Requirements
- **FR-1**: 调整 rerank 分数阈值从 0.3 提升到 0.5
- **FR-2**: 减少 topK 从 5 减少到 3
- **FR-3**: 优化 Wiki 概念词条权重，避免过宽泛概念影响检索精度
- **FR-4**: 增加查询类型识别，对宽泛查询进行更严格的过滤

## Non-Functional Requirements
- **NFR-1**: 优化后评估时间不超过 1 小时（50条样本）
- **NFR-2**: API 响应时间不超过 3 秒（P95）

## Constraints
- **Technical**: TypeScript strict mode, Next.js 16
- **Dependencies**: RAGAS 评估框架、阿里百炼 API

## Assumptions
- 开发服务器已在 localhost:3000 运行
- 评估脚本 `evaluate.py` 可正常调用 API

## Acceptance Criteria

### AC-1: Context Precision 提升至 0.45 以上
- **Given**: 50 条测试样本
- **When**: 运行 RAGAS 评估
- **Then**: Context Precision ≥ 0.45
- **Verification**: `programmatic`

### AC-2: Context Recall 保持在 0.53 以上
- **Given**: 50 条测试样本
- **When**: 运行 RAGAS 评估
- **Then**: Context Recall ≥ 0.53
- **Verification**: `programmatic`

### AC-3: Answer Relevancy 保持在 0.85 以上
- **Given**: 50 条测试样本
- **When**: 运行 RAGAS 评估
- **Then**: Answer Relevancy ≥ 0.85
- **Verification**: `programmatic`

### AC-4: 表格截断率保持在 5% 以下
- **Given**: 50 条测试样本
- **When**: 运行 RAGAS 评估
- **Then**: Chunk 级表格截断率 ≤ 5%
- **Verification**: `programmatic`

## Open Questions
- [ ] 是否需要调整实体匹配度权重（当前 0.2）？
- [ ] 是否需要对不同类型的查询使用不同的 topK？