import type { Env, EmbeddingChunk } from '../types';

const CHUNK_SIZE = 500; // Characters per chunk
const CHUNK_OVERLAP = 50; // Overlap between chunks

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
   * Split text into overlapping chunks for embedding
   */
  chunkText(text: string, recordId: string, table: string): EmbeddingChunk[] {
    const chunks: EmbeddingChunk[] = [];
    
    // Clean and normalize text
    const cleanText = text
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length <= CHUNK_SIZE) {
      // Small text, single chunk
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
      // Split into overlapping chunks
      let start = 0;
      let chunkIndex = 0;

      while (start < cleanText.length) {
        const end = Math.min(start + CHUNK_SIZE, cleanText.length);
        let chunkText = cleanText.slice(start, end);

        // Try to break at sentence boundary
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

        // Move start position with overlap
        start += chunkText.length - CHUNK_OVERLAP;
        if (start <= chunks[chunks.length - 1].text.length - CHUNK_OVERLAP) {
          start = chunks[chunks.length - 1].text.length + start;
        }
        chunkIndex++;

        // Safety check to prevent infinite loops
        if (chunkIndex > 1000) break;
      }
    }

    return chunks;
  }

  /**
   * Store a chunk's embedding in Vectorize
   */
  async storeEmbedding(chunk: EmbeddingChunk): Promise<void> {
    const embedding = await this.generateEmbedding(chunk.text);

    await this.env.VECTORS.upsert([
      {
        id: chunk.id,
        values: embedding,
        metadata: {
          ...chunk.metadata,
          textPreview: chunk.text.substring(0, 100),
        },
      },
    ]);
  }

  /**
   * Delete embeddings for a record
   */
  async deleteEmbeddings(table: string, recordId: string): Promise<void> {
    // Vectorize doesn't support querying by metadata for deletion,
    // so we'd need to track chunk IDs in D1 for cleanup
    // For now, old embeddings will be overwritten on re-sync
    console.log(`Would delete embeddings for ${table}/${recordId}`);
  }
}
