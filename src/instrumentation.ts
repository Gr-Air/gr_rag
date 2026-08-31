// ============================================================
// Next.js Instrumentation Hook
// 应用启动时自动初始化检索索引
// ============================================================

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initIndexes } = await import('@/infrastructure/index/indexManager');
    await initIndexes().catch(err => {
      console.error('[Instrumentation] 索引初始化失败:', err);
    });
  }
}
