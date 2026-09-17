// ============================================================
// 实体关键词匹配（领域规则，纯函数，零基础设施依赖）
// 从 entityRouter / queryRewriter 拆出的匹配算法：
//   - extractMatchingKeywords：贪心最大匹配 + 全局包含匹配
//   - decomposeEntity：未知实体分解为已知实体组合
// 字典（关键字列表）由调用方注入（来自 EntityRepository）
// ============================================================

/**
 * 从用户问题中提取匹配的实体关键字
 * 使用贪婪最大匹配（优先长词，大小写不敏感），再全局包含匹配（处理非连续出现）
 *
 * @param query - 用户查询
 * @param keywords - 已知实体关键字字典（任意顺序，内部按长度降序处理）
 */
export function extractMatchingKeywords(query: string, keywords: string[]): string[] {
  const matched: Set<string> = new Set();
  const queryLower = query.toLowerCase();
  const sorted = [...keywords].sort((a, b) => b.length - a.length);

  // 贪心最大匹配（从当前位置开始，按关键字长度降序尝试）
  let i = 0;
  while (i < query.length) {
    let found = false;

    for (const kw of sorted) {
      const kwLen = kw.length;
      if (i + kwLen > query.length) continue;
      // 大小写不敏感比较
      if (queryLower.slice(i, i + kwLen) === kw.toLowerCase()) {
        matched.add(kw);
        i += kwLen;
        found = true;
        break;
      }
    }

    if (!found) i++;
  }

  // 也尝试在整个 query 中搜索（处理非连续匹配的情况）
  for (const kw of sorted) {
    if (queryLower.includes(kw.toLowerCase())) {
      matched.add(kw);
    }
  }

  return [...matched].sort((a, b) => b.length - a.length);
}

/**
 * 实体分解：将未知实体分解为已知实体的组合
 * 策略：从已知实体列表中查找所有是未知实体子串的实体
 * 例如："南方电网供应链管理平台项目" → ["南方电网", "供应链管理平台"]
 */
export function decomposeEntity(unknown: string, knownNames: Iterable<string>): string[] {
  const results: string[] = [];
  const unknownLower = unknown.toLowerCase();

  for (const known of knownNames) {
    if (known.length >= 2 && unknownLower.includes(known.toLowerCase())) {
      if (!results.some(r => r.includes(known))) {
        results.push(known);
      }
    }
  }

  return results.sort((a, b) => b.length - a.length);
}
