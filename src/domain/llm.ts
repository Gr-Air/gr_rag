// ============================================================
// LLM 领域规则（纯函数，零基础设施依赖）
// ============================================================

/** 推理模型（如 deepseek-r1）不兼容 temperature 参数，token 预算策略也不同 */
export function isReasoningModel(model: string): boolean {
  return model.toLowerCase().includes('reasoning') || model.toLowerCase().includes('deepseek-r1');
}
