import type { Env, EmbeddingChunk } from '../types';

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

const TEXT_FIELD_PATTERNS = [
  'description', 'notes', 'comments', 'remarks', 'details',
  'summary', 'name', 'title', 'address', 'memo', 'text',
  'content', 'body', 'message', 'subject'
];

export class EmbeddingService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Generate embedding vector for a text string using Workers AI
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const result = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [text],
    });

    if ('data' in result && Array.isArray(result.data) && result.data.length > 0) {
      return result.data[0] as number[];
    }

    throw new Error('Failed to generate embedding');
  }

  /**
   * Build text content from a record for embedding
   */
  buildTextContent(record: Record<string, any>): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith('_')) continue;
      if (value === null || value === undefined) continue;
      
      const strValue = String(value).trim();
      if (strValue.length < 10) continue;

      const keyLower = key.toLowerCase();
      const isTextField = TEXT_FIELD_PATTERNS.some(pattern => 
        keyLower.includes(pattern)
      );

      if (isTextField) {
        parts.push(`${key}: ${strValue}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Split text into overlapping chunks for embedding
   */
  chunkText(text: string, recordId: string, table: string): EmbeddingChunk[] {
    const chunks: EmbeddingChunk[] = [];
    
    const cleanText = text.replace(/\s+/g, ' ').trim();

    if (cleanText.length <= CHUNK_SIZE) {
      chunks.push({
        id: `${table}-${recordId}-0`,
        text: cleanText,
        metadata: {
          table,
          recordId,
          chunkIndex: 0,
        },
      });
    } else {
      let start = 0;
      let chunkIndex = 0;

      while (start < cleanText.length) {
        const end = Math.min(start + CHUNK_SIZE, cleanText.length);
        let chunkText = cleanText.slice(start, end);

        if (end < cleanText.length) {
          const lastPeriod = chunkText.lastIndexOf('. ');
          const lastNewline = chunkText.lastIndexOf('\n');
          const breakPoint = Math.max(lastPeriod, lastNewline);
          
          if (breakPoint > CHUNK_SIZE * 0.5) {
            chunkText = chunkText.slice(0, breakPoint + 1);
          }
        }

        chunks.push({
          id: `${table}-${recordId}-${chunkIndex}`,
          text: chunkText.trim(),
          metadata: {
            table,
            recordId,
            chunkIndex,
          },
        });

        start += Math.max(chunkText.length - CHUNK_OVERLAP, 1);
        chunkIndex++;

        if (chunkIndex > 100) break;
      }
    }

    return chunks;
  }

  /**
   * Store a chunk's embedding in Vectorize with R2 reference
   */
  async storeEmbedding(
    chunk: EmbeddingChunk,
    r2Info?: { database: string; r2Key: string }
  ): Promise<void> {
    const embedding = await this.generateEmbedding(chunk.text);

    await this.env.VECTORS.upsert([
      {
        id: chunk.id,
        values: embedding,
        metadata: {
          ...chunk.metadata,
          textPreview: chunk.text.substring(0, 100),
          database: r2Info?.database,
          r2Key: r2Info?.r2Key,
        },
      },
    ]);
  }

  /**
   * Search for similar chunks
   */
  async searchSimilar(
    text: string,
    topK: number = 10,
    filter?: { database?: string; table?: string }
  ): Promise<Array<{
    id: string;
    score: number;
    metadata: Record<string, unknown>;
  }>> {
    const embedding = await this.generateEmbedding(text);

    const results = await this.env.VECTORS.query(embedding, {
      topK,
      returnMetadata: 'all',
      filter: filter as any,
    });

    return results.matches.map(match => ({
      id: match.id,
      score: match.score || 0,
      metadata: (match.metadata || {}) as Record<string, unknown>,
    }));
  }

  /**
   * Delete embeddings by prefix
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    // Vectorize doesn't support prefix deletion directly
    // Would need to track IDs in D1 for cleanup
    console.log(`Would delete embeddings with prefix: ${prefix}`);
  }
}
