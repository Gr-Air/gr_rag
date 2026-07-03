# Spec 008: RAGAS 离线批量评估体系

> 创建日期：2026-07-01
> 状态：**implemented**
> 关联 Issue：`[DESIGN] RAG 性能与准确率离线评估`
> 实施日期：2026-07-01

---

## 1. 动机

缺乏量化的 RAG 性能评估体系，无法客观衡量检索质量和回答准确性。需要搭建基于 RAGAS 的离线批量评估框架，使用阿里百炼平台的模型进行评估。

---

## 2. 行为契约

### 2.1 正常路径

| 输入 | 预期输出 |
|------|---------|
| 评估数据集（query + ground_truth） | RAGAS 指标报告（faithfulness、context_recall、context_precision、answer_relevancy） |
| 阿里百炼 API Key | 使用 qwen-plus 模型进行评估 |
| 无实体提问 | 走 RRF 混合检索路径 |
| 有实体提问 | 走结构化查询路径 |

### 2.2 边界条件

| 输入 | 预期输出 |
|------|---------|
| 空数据集 | 返回空指标报告 |
| 部分查询失败 | 跳过失败项，继续评估其余查询 |
| API 限流 | 自动重试，指数退避 |

### 2.3 错误处理

| 异常场景 | 预期行为 |
|----------|---------|
| API Key 无效 | 返回错误信息，终止评估 |
| 模型不存在（如 mimo-v2.5） | 使用默认 qwen-plus 模型 |
| Embeddings API 不兼容 | 降级或跳过相关指标 |

---

## 3. 验收标准

- [x] `test/rag-eval/evaluate.py` 使用 RAGAS 进行离线评估
- [x] 支持阿里百炼平台（OpenAI 兼容 API）
- [x] 评估指标：faithfulness、context_recall、context_precision、answer_relevancy
- [x] 支持生成无实体提问测试用例
- [x] 评估结果输出为可读格式

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `test/rag-eval/evaluate.py` | `evaluate_with_ragas()` 函数 | 新增 |
| `test/rag-eval/evaluate.py` | 阿里百炼模型适配 | 修改 |
| `test/rag-eval/evaluate.py` | 无实体提问生成 | 修改 |

---

## 5. 兼容影响

### 5.1 公开 API 变更

无。评估脚本独立于生产环境。

### 5.2 数据格式变更

无。

### 5.3 下游调用方

无。评估脚本为独立工具。

---

## 6. 降级策略

- 可通过修改模型参数使用其他评估模型
- 如需回退，git revert 即可

---

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|--------|---------|
| （评估脚本属于独立工具，按 AGENTS.md 约定不强制测试） | — | 通过手动运行验证 |