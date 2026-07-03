import type { NextConfig } from "next";

const nextConfig = {
  serverExternalPackages: ['better-sqlite3', '@node-rs/jieba', '@lancedb/lancedb'],
} as NextConfig;

export default nextConfig;
