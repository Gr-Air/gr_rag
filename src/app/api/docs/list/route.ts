// ============================================================
// Docs List API（Presentation 层）
// 只负责：请求处理 / JSON 映射 / 错误映射
// 文档列表能力在 KbStatsPort（经 composition 注入）
// ============================================================

import { NextResponse } from 'next/server';
import { getContainer } from '@/composition/container';

export async function GET() {
  try {
    const { kbStats } = getContainer();
    const list = kbStats.listRawDocs();

    return NextResponse.json({ total: list.length, docs: list });
  } catch (err) {
    console.error('[API] 获取文档列表失败:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
