// ============================================================
// 查询策略：查询类型识别 + 动态 topK 调整
//
// 宽泛查询（如"相关的项目文档有哪些？"）使用更小的 topK，避免召回过多不相关上下文；
// 具体查询（如"项目经理是谁？"）保持原有 topK。
// 硬编码中文正则集中于此（规则表形式），调整需同步 spec 028。
// ============================================================

/**
 * 查询策略版本（Spec 030）：broadQueryPatterns 规则变更时 bump。
 * 用于检索缓存失效——策略变了，旧缓存的结果排序不再适用。
 */
export const POLICY_VERSION = 'v1';

/** 宽泛查询识别规则表 */
export const broadQueryPatterns: RegExp[] = [
  /相关的.*文档有哪些/,
  /有哪些.*项目/,
  /包含.*的文档/,
  /涉及.*的项目/,
  /哪些.*文档/,
  /哪些.*项目/,
  /有.*多少.*文档/,
  /有.*多少.*项目/,
];

/** 宽泛查询下 topK 收敛到此值 */
export const BROAD_QUERY_TOPK = 3;

/**
 * 判断是否为宽泛查询
 */
export function isBroadQuery(query: string): boolean {
  return broadQueryPatterns.some(p => p.test(query));
}

/**
 * 宽泛查询的 topK 调整：超过 BROAD_QUERY_TOPK 时收敛
 * @returns 调整后的 topK
 */
export function adjustTopKForBroadQuery(query: string, topK: number): number {
  if (isBroadQuery(query) && topK > BROAD_QUERY_TOPK) {
    console.log(`[Hybrid] 检测到宽泛查询，topK 从 ${topK} 调整为 ${BROAD_QUERY_TOPK}`);
    return BROAD_QUERY_TOPK;
  }
  return topK;
}
