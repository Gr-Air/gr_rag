// ============================================================
// 文件系统文档存储（Infrastructure 层）
// 实现 Application 层的 DocumentFileStore Port：
//   Raw / Wiki 目录的 markdown 文件读取
// ============================================================

import fs from 'fs';
import path from 'path';
import type { DocumentFileStore } from '@/application/ports';

const RAW_DIR = path.join(process.cwd(), '..', 'Raw');
const WIKI_DIR = path.join(process.cwd(), '..', 'Wiki');

export class FsDocumentFileStore implements DocumentFileStore {
  /** 读取 Raw/<docName>.md，不存在返回 null */
  readRawDoc(docName: string): string | null {
    const filePath = path.join(RAW_DIR, `${docName}.md`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn(`[FileStore] 读取 Raw 文档失败: ${filePath}`, err);
      return null;
    }
  }

  /** 读取 Wiki/<relPath>，不存在返回 null */
  readWikiDoc(relPath: string): string | null {
    const filePath = path.join(WIKI_DIR, relPath);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn(`[FileStore] 读取 Wiki 文档失败: ${filePath}`, err);
      return null;
    }
  }
}
