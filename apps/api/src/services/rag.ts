import type { Env, Source } from '../types';
import { EmbeddingService } from './embedding';

const SYSTEM_PROMPT = `You are a helpful assistant for citizens asking questions about local government services and public records. 

Guidelines:
- Answer questions based ONLY on the provided context
- If the context doesn't contain relevant information, say "I don't have information about that in my records"
- Be concise but thorough
- Cite specific records when possible (e.g., "According to permit #12345...")
- Use plain language that citizens can understand
- If asked about sensitive personal information, explain that you cannot provide it

Context from public records:
`;

export class RagService {
  private env: Env;
  private embedService: EmbeddingService;

  constructor(env: Env) {
    this.env = env;
    this.embedService = new EmbeddingService(env);
  }

  async query(question: string): Promise<{ response: string; sources: Source[] }> {
    // Step 1: Generate embedding for the question
    const questionEmbedding = await this.embedService.generateEmbedding(question);

    // Step 2: Search for relevant chunks in Vectorize
    const searchResults = await this.env.VECTORS.query(questionEmbedding, {
      topK: 10,
      returnMetadata: 'all',
    });

    // Step 3: Build context from search results
    const sources: Source[] = [];
    const contextChunks: string[] = [];

    for (const match of searchResults.matches) {
      if (match.score && match.score > 0.5) { // Relevance threshold
        const metadata = match.metadata as Record<string, unknown>;
        
        // Fetch full content from D1 if needed
        const content = await this.fetchContent(
          metadata.table as string,
          metadata.recordId as string
        );

        if (content) {
          contextChunks.push(content);
          sources.push({
            table: metadata.table as string,
            id: metadata.recordId as string,
            snippet: content.substring(0, 200) + '...',
            score: match.score,
          });
        }
      }
    }

    // Step 4: Generate response using Workers AI
    const context = contextChunks.join('\n\n---\n\n');
    const prompt = SYSTEM_PROMPT + context + '\n\nQuestion: ' + question;

    const aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + context },
        { role: 'user', content: question },
      ],
      max_tokens: 1024,
    });

    const response = 'response' in aiResponse 
      ? aiResponse.response 
      : 'I apologize, but I was unable to generate a response.';

    return {
      response: response || 'No response generated',
      sources: sources.slice(0, 5), // Return top 5 sources
    };
  }

  async queryStream(question: string): Promise<ReadableStream> {
    // Generate embedding and search (same as above)
    const questionEmbedding = await this.embedService.generateEmbedding(question);
    
    const searchResults = await this.env.VECTORS.query(questionEmbedding, {
      topK: 10,
      returnMetadata: 'all',
    });

    const contextChunks: string[] = [];
    for (const match of searchResults.matches) {
      if (match.score && match.score > 0.5) {
        const metadata = match.metadata as Record<string, unknown>;
        const content = await this.fetchContent(
          metadata.table as string,
          metadata.recordId as string
        );
        if (content) {
          contextChunks.push(content);
        }
      }
    }

    const context = contextChunks.join('\n\n---\n\n');

    // Use streaming AI response
    const stream = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + context },
        { role: 'user', content: question },
      ],
      stream: true,
      max_tokens: 1024,
    });

    return stream as unknown as ReadableStream;
  }

  private async fetchContent(table: string, recordId: string): Promise<string | null> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT content FROM sync_records 
        WHERE table_name = ? AND id = ?
      `).bind(table, recordId).first<{ content: string }>();

      return result?.content || null;
    } catch {
      return null;
    }
  }
}
