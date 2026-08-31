// ============================================================
// 搜索结果高亮片段生成（纯函数）
// ============================================================

/**
 * 生成搜索结果高亮片段：定位首个查询字符命中位置，截取窗口并对查询词加粗
 */
export function generateHighlight(content: string, query: string): string {
  const MAX_HIGHLIGHT_LEN = 300;
  const queryChars = query.replace(/\s+/g, '');

  if (!queryChars) {
    return content.slice(0, MAX_HIGHLIGHT_LEN) + (content.length > MAX_HIGHLIGHT_LEN ? '...' : '');
  }

  // 查找第一个匹配位置
  let bestIdx = 0;
  for (const char of queryChars) {
    const idx = content.indexOf(char);
    if (idx !== -1) {
      bestIdx = idx;
      break;
    }
  }

  const start = Math.max(0, bestIdx - 50);
  const end = Math.min(content.length, start + MAX_HIGHLIGHT_LEN);
  let snippet = content.slice(start, end);

  // 高亮查询词
  const queryWords = query.split(/\s+/).filter(w => w.length > 0);
  for (const word of queryWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    snippet = snippet.replace(new RegExp(`(${escaped})`, 'gi'), '**$1**');
  }

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}
