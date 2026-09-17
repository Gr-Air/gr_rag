import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // 测试文件统一放在 test/ 目录
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['node_modules', '.next'],

    // 测试环境
    environment: 'node',

    // 全局设置
    globals: true,

    // 路径别名（与 tsconfig 保持一致）
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
