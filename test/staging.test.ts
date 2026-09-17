// ============================================================
// staging 测试用例
// 测试 scripts/lib/staging.cjs 的 JSONL 读写逻辑
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  getGitCommit,
  stagingExists,
  CHUNKS_FILE,
  MANIFEST_FILE,
  writeStaging,
  readStaging,
  getChunksByDocId,
  updateStaging,
  writeManifest,
  readManifest,
} from '../scripts/lib/staging.cjs';
import type { StagingChunk } from '../scripts/lib/staging.cjs';

describe('staging JSONL 格式', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('每行一个 JSON 对象', () => {
    const chunks = [
      { id: 'chunk_0', content: '内容一' },
      { id: 'chunk_1', content: '内容二' },
      { id: 'chunk_2', content: '内容三' },
    ];
    const file = path.join(tmpDir, 'test.jsonl');
    const lines = chunks.map((c) => JSON.stringify(c));
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const content = fs.readFileSync(file, 'utf-8');
    const readLines = content.split('\n').filter((l: string) => l.trim().length > 0);
    expect(readLines.length).toBe(3);

    const parsed = readLines.map((l: string) => JSON.parse(l));
    expect(parsed[0].id).toBe('chunk_0');
    expect(parsed[2].content).toBe('内容三');
  });

  it('manifest 包含必要字段', () => {
    const manifest = {
      pipelineVersion: '1.0.0',
      totalChunks: 100,
      totalDocs: 10,
      sourceFiles: ['Raw/a.md'],
      chunkConfig: { minSize: 200, maxSize: 1000, overlap: 0.1 },
      builtAt: new Date().toISOString(),
      gitCommit: 'abc1234',
    };
    const file = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));

    const read = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(read.pipelineVersion).toBe('1.0.0');
    expect(read.totalChunks).toBe(100);
    expect(read.gitCommit).toBe('abc1234');
  });
});

describe('staging 模块函数', () => {
  describe('getGitCommit', () => {
    it('返回短 hash 或 unknown', () => {
      const commit = getGitCommit();
      expect(typeof commit).toBe('string');
      expect(commit.length).toBeGreaterThan(0);
      expect(commit === 'unknown' || commit.match(/^[0-9a-f]+$/)).toBeTruthy();
    });
  });

  describe('stagingExists', () => {
    it('返回布尔值', () => {
      expect(typeof stagingExists()).toBe('boolean');
    });
  });
});

describe('staging 读写往返', () => {
  const chunksFile = CHUNKS_FILE;
  let backup: string | null = null;

  beforeEach(() => {
    backup = fs.existsSync(chunksFile) ? fs.readFileSync(chunksFile, 'utf-8') : null;
  });

  afterEach(() => {
    if (backup !== null) {
      fs.writeFileSync(chunksFile, backup, 'utf-8');
    }
  });

  it('写入后读取应得到相同数据', () => {
    const testChunks = [
      {
        id: 'test_0',
        docId: 'test_doc',
        docTitle: '测试文档',
        docPath: 'Raw/test.md',
        chunkIndex: 0,
        content: '测试内容一',
        metadata: { client: '客户', project: '项目', docType: '类型', date: '20240101' },
        wikiLinks: ['链接1'],
        parentDocId: 'parent_test_doc',
        sectionTitle: '章节一',
      },
      {
        id: 'test_1',
        docId: 'test_doc',
        docTitle: '测试文档',
        docPath: 'Raw/test.md',
        chunkIndex: 1,
        content: '测试内容二',
        metadata: { client: '客户', project: '项目', docType: '类型', date: '20240101' },
        wikiLinks: ['链接2'],
        parentDocId: 'parent_test_doc',
        sectionTitle: '章节二',
      },
    ];

    writeStaging(testChunks);
    const read = readStaging();
    expect(read.length).toBe(2);
    expect(read[0].id).toBe('test_0');
    expect(read[0].sectionTitle).toBe('章节一');
    expect(read[1].content).toBe('测试内容二');
    expect(read[1].wikiLinks).toContain('链接2');
  });

  it('getChunksByDocId 按 docId 过滤', () => {
    writeStaging([
      { id: 'a_0', docId: 'doc_a', content: 'A0', parentDocId: 'parent_doc_a', chunkIndex: 0 },
      { id: 'a_1', docId: 'doc_a', content: 'A1', parentDocId: 'parent_doc_a', chunkIndex: 1 },
      { id: 'b_0', docId: 'doc_b', content: 'B0', parentDocId: 'parent_doc_b', chunkIndex: 0 },
    ]);

    const result = getChunksByDocId('doc_a');
    expect(result.length).toBe(2);
    expect(result.every((c) => c.docId === 'doc_a')).toBe(true);
  });

  it('updateStaging 移除旧 chunk 并追加新 chunk', () => {
    writeStaging([
      { id: 'old_0', docId: 'old_doc', content: '旧内容', parentDocId: 'parent_old_doc', chunkIndex: 0 },
      { id: 'keep_0', docId: 'keep_doc', content: '保留内容', parentDocId: 'parent_keep_doc', chunkIndex: 0 },
    ]);

    const all = updateStaging(['old_doc'], [
      { id: 'new_0', docId: 'new_doc', content: '新内容', parentDocId: 'parent_new_doc', chunkIndex: 0 },
    ]);

    expect(all.length).toBe(2);
    expect(all.find((c) => c.docId === 'old_doc')).toBeUndefined();
    expect(all.find((c) => c.docId === 'keep_doc')).toBeDefined();
    expect(all.find((c) => c.docId === 'new_doc')).toBeDefined();
  });

  it('readStaging callback 模式逐条处理', () => {
    writeStaging([
      { id: 'cb_0', docId: 'doc', content: 'A', parentDocId: 'parent_doc', chunkIndex: 0 },
      { id: 'cb_1', docId: 'doc', content: 'B', parentDocId: 'parent_doc', chunkIndex: 1 },
      { id: 'cb_2', docId: 'doc', content: 'C', parentDocId: 'parent_doc', chunkIndex: 2 },
    ]);

    const collected: StagingChunk[] = [];
    readStaging((chunk: StagingChunk) => {
      collected.push(chunk);
    });
    expect(collected.length).toBe(3);
    expect(collected[1].content).toBe('B');
  });

  it('readStaging callback 返回 false 可提前终止', () => {
    writeStaging([
      { id: 'stop_0', docId: 'doc', content: 'A', parentDocId: 'parent_doc', chunkIndex: 0 },
      { id: 'stop_1', docId: 'doc', content: 'B', parentDocId: 'parent_doc', chunkIndex: 1 },
      { id: 'stop_2', docId: 'doc', content: 'C', parentDocId: 'parent_doc', chunkIndex: 2 },
    ]);

    const collected: StagingChunk[] = [];
    readStaging((chunk: StagingChunk) => {
      collected.push(chunk);
      if (collected.length >= 2) return false;
    });
    expect(collected.length).toBe(2);
  });
});

describe('staging manifest 读写', () => {
  const manifestFile = MANIFEST_FILE;
  let backup: string | null = null;

  beforeEach(() => {
    backup = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf-8') : null;
  });

  afterEach(() => {
    if (backup !== null) {
      fs.writeFileSync(manifestFile, backup, 'utf-8');
    } else if (fs.existsSync(manifestFile)) {
      fs.unlinkSync(manifestFile);
    }
  });

  it('写入后读取 manifest', () => {
    writeManifest({
      totalChunks: 42,
      totalDocs: 5,
      sourceFiles: ['Raw/a.md', 'Raw/b.md'],
      chunkConfig: { minSize: 200, maxSize: 1000, overlap: 0.1 },
    });

    const read = readManifest();
    expect(read).not.toBeNull();
    expect(read!.totalChunks).toBe(42);
    expect(read!.sourceFiles!.length).toBe(2);
    expect(read!.gitCommit).toBeDefined();
    expect(read!.builtAt).toBeDefined();
  });

  it('readManifest 无文件时返回 null', () => {
    if (fs.existsSync(manifestFile)) {
      fs.unlinkSync(manifestFile);
    }
    expect(readManifest()).toBeNull();
  });
});
