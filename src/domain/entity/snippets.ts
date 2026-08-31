// ============================================================
// 文档片段提取（领域规则，纯函数，零基础设施依赖）
// 从 chat/eval route 的重复实现中抽出（DRY）：
//   - estimateTokens：中英文混合 token 估算
//   - mergeRanges：重叠区间合并
//   - extractEntitySnippets：长文档实体上下文片段提取（密度排序 top-N）
// ============================================================

/**
 * 估算文本的 token 数量（混合中英文场景）
 * 中文约 1.5 字符/token，英文/数字约 4 字符/token
 */
export function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    // Unicode 范围：CJK 统一表意文字 + 中文标点
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/.test(ch)) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 合并重叠或相邻的字符区间
 */
export function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      // 有重叠，合并
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/**
 * 从长文档中提取实体关键字上下文的片段
 *
 * 算法：
 * 1. 用所有 matchedKeywords 构建正则，匹配文档中所有提及位置
 * 2. 对每处提及，向前后扩展指定 token 数对应的字符
 * 3. 合并重叠的区间
 * 4. 按提及密度排序，取 top-N 个片段
 */
export function extractEntitySnippets(
  content: string,
  docName: string,
  keywords: string[],
  contextTokens: number,
  maxSnippets: number,
  cnCharsPerToken: number,
  enCharsPerToken: number,
): string | null {
  // 构建正则：匹配所有关键字（按长度降序，避免短关键字被长关键字遮蔽）
  const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
  const escaped = sortedKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'gi');

  // 找到所有匹配位置（字符索引）
  const matches: Array<{ start: number; end: number; keyword: string }> = [];
  let match: RegExpExecArray | null;
  // 重置 lastIndex
  pattern.lastIndex = 0;
  while ((match = pattern.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, keyword: match[0] });
  }

  if (matches.length === 0) return null;

  // 估算上下文窗口对应的字符数
  // 取中文和英文 token→字符 的平均值做近似估算
  const avgCharsPerToken = (cnCharsPerToken + enCharsPerToken) / 2;
  const contextChars = Math.ceil(contextTokens * avgCharsPerToken);

  // 对每个匹配位置扩展上下文窗口
  const rawRanges: Array<{ start: number; end: number }> = matches.map((m) => ({
    start: Math.max(0, m.start - contextChars),
    end: Math.min(content.length, m.end + contextChars),
  }));

  // 合并重叠区间
  const mergedRanges = mergeRanges(rawRanges);

  // 计算每个区间的"提及密度"（提及次数 / 区间字符数），密度高的优先
  const scoredRanges = mergedRanges.map((range) => {
    const mentionCount = matches.filter(
      (m) => m.start >= range.start && m.end <= range.end,
    ).length;
    const rangeLength = range.end - range.start;
    const density = mentionCount / (rangeLength || 1);
    return { ...range, mentionCount, density };
  });

  // 按密度降序排序，取 top-N
  scoredRanges.sort((a, b) => b.density - a.density);
  const topRanges = scoredRanges.slice(0, maxSnippets);

  // 按文档中的原始位置排序输出
  topRanges.sort((a, b) => a.start - b.start);

  // 构建输出片段
  const snippetParts = topRanges.map((range, idx) => {
    const snippet = content.slice(range.start, range.end).trim();
    const startToken = estimateTokens(content.slice(0, range.start));
    const endToken = startToken + estimateTokens(snippet);
    const header =
      topRanges.length > 1
        ? `#### 片段 ${idx + 1}（约第 ${startToken}-${endToken} token，提及 ${range.mentionCount} 次）`
        : `#### 实体上下文片段（约第 ${startToken}-${endToken} token，提及 ${range.mentionCount} 次）`;
    return `${header}\n\n${snippet}`;
  });

  return `### ${docName}（长文档片段提取，原文档约 ${estimateTokens(content)} token）\n\n${snippetParts.join('\n\n')}`;
}
