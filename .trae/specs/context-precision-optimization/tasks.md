# Context Precision 优化 - Implementation Plan

## [x] Task 1: 调整 rerank 分数阈值从 0.3 提升到 0.5
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 在 hybridSearch.ts 中调整 rerank 分数阈值
  - 当前阈值 0.3 过低，导致低相关度结果被返回
  - 提升到 0.5 过滤低质量上下文
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-3
- **Test Requirements**:
  - `programmatic` TR-1.1: 运行 50 条样本评估，Context Precision ≥ 0.40
  - `programmatic` TR-1.2: Context Recall ≥ 0.52
- **Notes**: 阈值调整可能影响召回率，需平衡

## [x] Task 2: 减少 topK 从 5 减少到 3
- **Priority**: high
- **Depends On**: Task 1
- **Description**: 
  - 在 hybridSearch.ts 中将默认 topK 从 5 减少到 3
  - 减少返回的上下文数量，降低无关上下文概率
- **Acceptance Criteria Addressed**: AC-1, AC-2
- **Test Requirements**:
  - `programmatic` TR-2.1: 运行 50 条样本评估，Context Precision ≥ 0.43
  - `programmatic` TR-2.2: Context Recall ≥ 0.51
- **Notes**: 减少 topK 可能导致召回率下降，需监控

## [x] Task 3: 优化 Wiki 概念词条权重策略
- **Priority**: medium
- **Depends On**: Task 2
- **Description**: 
  - 当前 WIKI_DOC_BOOST = 1.3，可能导致过宽泛概念排名过高
  - 调整策略：仅对包含查询实体关键词的 Wiki 文档给予权重加成
  - 对纯概念词条（不包含查询实体）降低权重
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-3.1: 运行 50 条样本评估，Context Precision ≥ 0.45
  - `programmatic` TR-3.2: Answer Relevancy ≥ 0.85
- **Notes**: 需要区分概念词条和项目实体文档

## [x] Task 4: 增加查询类型识别和动态 topK
- **Priority**: medium
- **Depends On**: Task 3
- **Description**: 
  - 对宽泛查询（如"相关的项目文档有哪些"）使用更小的 topK 和更高的阈值
  - 对具体查询（如"项目经理是谁"）保持现有策略
- **Acceptance Criteria Addressed**: AC-1, AC-2
- **Test Requirements**:
  - `programmatic` TR-4.1: 运行 50 条样本评估，Context Precision ≥ 0.45
  - `programmatic` TR-4.2: Context Recall ≥ 0.53
- **Notes**: 使用正则匹配识别查询类型

## [x] Task 5: 更新 Spec 文档和验证最终结果
- **Priority**: high
- **Depends On**: Task 4
- **Description**: 
  - 更新 spec/planned/017-context-recall-optimization.md 记录最新优化结果
  - 运行完整 50 条样本评估验证最终效果
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-3, AC-4
- **Test Requirements**:
  - `programmatic` TR-5.1: Context Precision ≥ 0.45
  - `programmatic` TR-5.2: Context Recall ≥ 0.53
  - `programmatic` TR-5.3: Answer Relevancy ≥ 0.85
  - `programmatic` TR-5.4: 表格截断率 ≤ 5%