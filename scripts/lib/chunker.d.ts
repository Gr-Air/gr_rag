declare module '*/chunker.cjs' {
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

  export function extractWikiLinks(content: string): string[];
  export function parseFilename(filename: string): ChunkMeta;
  export function extractTitle(content: string, filename: string): string;
  export function isTableLine(line: string): boolean;
  export function isTableBlock(text: string): boolean;
  export function splitParagraphsTableAware(sectionText: string): string[];
  export function chunkDocument(
    content: string,
    docId: string,
    docTitle: string,
    docPath: string,
    metadata: ChunkMeta,
    options?: ChunkOptions
  ): Chunk[];
}
