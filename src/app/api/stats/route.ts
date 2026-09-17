// ============================================================
// Stats API（Presentation 层）
// 只负责：请求处理 / JSON 映射 / 错误映射
// 统计能力在 KbStatsPort / KbStatusPort（经 composition 注入）
// ============================================================

import { NextResponse } from 'next/server';
import { getContainer } from '@/composition/container';

export async function GET() {
  try {
    const { kbStats, kbStatus } = getContainer();
    const stats = kbStats.getWikiStats();
    const indexStatus = kbStatus.isIndexReady();
    const structDbStatus = kbStatus.isStructDbReady();
    const indexInfo = kbStatus.getIndexInfo();

    let structStats = null;
    if (structDbStatus) {
      try {
        structStats = kbStats.getStructStats();
      } catch { /* ignore */ }
    }

    return NextResponse.json({
      ...stats,
      indexReady: indexStatus,
      structDbReady: structDbStatus,
      structStats,
      indexVersion: indexInfo?.indexVersion ?? null,
      indexBuiltAt: indexInfo?.builtAt ?? null,
      indexBuildMode: indexInfo?.buildMode ?? null,
    });
  } catch (err) {
    console.error('[API] 获取统计失败:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
