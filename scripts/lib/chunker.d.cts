// chunker.cjs 的类型声明（.d.cts 与 .cjs 配对）
export interface ChunkMeta {
  client: string;
  project: string;
  docType: string;
  date: string;
}

export interface ChunkOptions {
  minChunkSize?: number;
  maxChunkSize?: number;
}

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  docPath: string;
  parentDocId: string;
  chunkIndex: number;
  content: string;
  metadata: ChunkMeta;
  wikiLinks: string[];
  sectionTitle?: string;
}

export declare function extractWikiLinks(content: string): string[];
export declare function parseFilename(filename: string): ChunkMeta;
export declare function extractTitle(content: string, filename: string): string;
export declare function isTableLine(line: string): boolean;
export declare function isTableBlock(text: string): boolean;
export declare function splitParagraphsTableAware(sectionText: string): string[];
export declare function chunkDocument(
  content: string,
  docId: string,
  docTitle: string,
  docPath: string,
  metadata: ChunkMeta,
  options?: ChunkOptions
): Chunk[];
