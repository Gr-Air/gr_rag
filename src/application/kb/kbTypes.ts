// ============================================================
// 知识库统计类型（Application 层）
// 由 KbStatsPort（application/ports.ts）输出，
// 具体统计实现在 infrastructure/parser
// ============================================================

import type { WikiEntry } from '@/domain/entity/types';

/** 知识库统计 */
export interface WikiStats {
  totalDocs: number;
  totalChunks: number;
  totalConcepts: number;
  totalEntities: number;
  totalClients: number;
  totalProjects: number;
  totalDocTypes: number;
  topConcepts: WikiEntry[];
  topEntities: WikiEntry[];
  clients: string[];
  projects: string[];
  docTypes: string[];
  indexReady?: boolean;
  structDbReady?: boolean;
  structStats?: {
    totalEntries: number;
    totalConcepts: number;
    totalEntities: number;
    totalDocs?: number;
    totalRelations: number;
  } | null;
}
