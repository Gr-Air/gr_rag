import { NextResponse } from 'next/server';
import { getWikiStats } from '@/lib/parser';
import { isIndexReady, isStructDbReady, getIndexManifest } from '@/lib/indexManager';

export async function GET() {
  try {
    const stats = getWikiStats();
    const indexStatus = isIndexReady();
    const structDbStatus = isStructDbReady();
    const manifest = getIndexManifest();

    let structStats = null;
    if (structDbStatus) {
      try {
        const { getStructStats } = await import('@/lib/structSearchEngine');
        structStats = getStructStats();
      } catch { /* ignore */ }
    }

    return NextResponse.json({
      ...stats,
      indexReady: indexStatus,
      structDbReady: structDbStatus,
      structStats,
      indexVersion: manifest?.indexVersion ?? null,
      indexBuiltAt: manifest?.builtAt ?? null,
      indexBuildMode: manifest?.buildMode ?? null,
    });
  } catch (err: any) {
    console.error('[API] 获取统计失败:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
