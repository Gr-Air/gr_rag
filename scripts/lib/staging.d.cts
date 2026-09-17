// staging.cjs 的类型声明（.d.cts 与 .cjs 配对）
export interface StagingChunk {
  id: string;
  content: string;
  docId?: string;
  docTitle?: string;
  docPath?: string;
  parentDocId?: string;
  chunkIndex?: number;
  metadata?: Record<string, string>;
  wikiLinks?: string[];
  sectionTitle?: string;
}

export interface StagingManifest {
  pipelineVersion?: string;
  totalChunks?: number;
  totalDocs?: number;
  sourceFiles?: string[];
  chunkConfig?: { minSize: number; maxSize: number; overlap: number };
  builtAt?: string;
  gitCommit?: string;
}

export declare const CHUNKS_FILE: string;
export declare const MANIFEST_FILE: string;
export declare const QUALITY_FILE: string;

export declare function getGitCommit(): string;
export declare function stagingExists(): boolean;
export declare function writeStaging(chunks: StagingChunk[]): void;
export declare function readStaging(callback: (chunk: StagingChunk) => boolean | void): void;
export declare function readStaging(): StagingChunk[];
export declare function getChunksByDocId(docId: string): StagingChunk[];
export declare function updateStaging(removeDocIds: string[], newChunks: StagingChunk[]): StagingChunk[];
export declare function writeManifest(info: StagingManifest): void;
export declare function readManifest(): StagingManifest | null;
