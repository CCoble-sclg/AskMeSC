import type { Env, Source } from '../types';
import { EmbeddingService } from './embedding';
import { ClaudeService } from './claude';

const SYSTEM_PROMPT = `You are a helpful assistant for citizens asking questions about local government services and public records.

Guidelines:
- Answer questions based ONLY on the provided context from public records
- If the context doesn't contain relevant information, say "I don't have information about that in my records"
- Be concise but thorough
- Cite specific records when possible (mention the table/database source)
- Use plain language that citizens can understand
- If asked about sensitive personal information, explain that you cannot provide it
- Format your response with clear structure when appropriate

Context from public records:
`;

interface R2ChunkData {
  database: string;
  table: string;
  tableKey: string;
  chunkIndex: number;
  rowCount: number;
  rows: Array<Record<string, any>>;
}

export class RagService {
  private env: Env;
  private embedService: EmbeddingService;
  private claude: ClaudeService;

  constructor(env: Env) {
    this.env = env;
    this.embedService = new EmbeddingService(env);
    this.claude = new ClaudeService(env.ANTHROPIC_API_KEY);
  }

  async query(question: string): Promise<{ response: string; sources: Source[] }> {
    // Step 1: Search for relevant chunks in Vectorize
    const searchResults = await this.embedService.searchSimilar(question, 15);

    // Step 2: Fetch relevant records from R2
    const sources: Source[] = [];
    const contextParts: string[] = [];
    const fetchedRecords = new Map<string, Record<string, any>>();

    for (const match of searchResults) {
      if (match.score < 0.5) continue;

      const metadata = match.metadata;
      const r2Key = metadata.r2Key as string;
      const recordId = metadata.recordId as string;
      const table = metadata.table as string;
      const database = metadata.database as string;

      if (!r2Key || fetchedRecords.has(`${table}-${recordId}`)) continue;

      try {
        // Fetch the chunk file from R2
        const record = await this.fetchRecordFromR2(r2Key, recordId);
        
        if (record) {
          fetchedRecords.set(`${table}-${recordId}`, record);
          
          // Build context string from record
          const contextStr = this.buildContextFromRecord(record, table, database);
          if (contextStr) {
            contextParts.push(contextStr);
            
            sources.push({
              table: `${database}.${table}`,
              id: recordId,
              snippet: contextStr.substring(0, 200) + (contextStr.length > 200 ? '...' : ''),
              score: match.score,
            });
          }
        }
      } catch (err) {
        console.error(`Failed to fetch record from R2: ${err}`);
      }

      // Limit context size
      if (contextParts.length >= 10) break;
    }

    // Step 3: Generate response using Workers AI
    const context = contextParts.join('\n\n---\n\n');
    
    if (!context) {
      return {
        response: "I don't have any relevant information in my records to answer that question. Please try rephrasing your question or ask about a different topic.",
        sources: [],
      };
    }

    const response = await this.claude.chat(
      SYSTEM_PROMPT + context,
      question,
      { maxTokens: 1024 }
    );

    return {
      response: response || 'No response generated',
      sources: sources.slice(0, 5),
    };
  }

  async queryStream(question: string): Promise<ReadableStream> {
    // Search for relevant content
    const searchResults = await this.embedService.searchSimilar(question, 10);
    
    const contextParts: string[] = [];
    const fetchedRecords = new Set<string>();

    for (const match of searchResults) {
      if (match.score < 0.5) continue;

      const metadata = match.metadata;
      const r2Key = metadata.r2Key as string;
      const recordId = metadata.recordId as string;
      const table = metadata.table as string;
      const database = metadata.database as string;

      if (!r2Key || fetchedRecords.has(`${table}-${recordId}`)) continue;

      try {
        const record = await this.fetchRecordFromR2(r2Key, recordId);
        if (record) {
          fetchedRecords.add(`${table}-${recordId}`);
          const contextStr = this.buildContextFromRecord(record, table, database);
          if (contextStr) {
            contextParts.push(contextStr);
          }
        }
      } catch {
        // Skip failed fetches
      }

      if (contextParts.length >= 8) break;
    }

    const context = contextParts.join('\n\n---\n\n');

    return this.claude.chatStream(
      SYSTEM_PROMPT + context,
      question,
      { maxTokens: 1024 }
    );
  }

  private async fetchRecordFromR2(
    r2Key: string,
    recordId: string
  ): Promise<Record<string, any> | null> {
    try {
      const object = await this.env.STORAGE.get(r2Key);
      if (!object) return null;

      const chunkData = await object.json<R2ChunkData>();
      
      // Find the specific record in the chunk
      const record = chunkData.rows.find(row => row._id === recordId);
      return record || null;
    } catch {
      return null;
    }
  }

  private buildContextFromRecord(
    record: Record<string, any>,
    table: string,
    database: string
  ): string {
    const parts: string[] = [];
    parts.push(`[Source: ${database}.${table}, ID: ${record._id || 'N/A'}]`);

    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith('_')) continue;
      if (value === null || value === undefined || value === '') continue;
      
      const strValue = String(value).trim();
      if (strValue.length === 0) continue;

      // Include meaningful fields
      const keyLower = key.toLowerCase();
      const isImportant = [
        'name', 'title', 'description', 'address', 'status',
        'type', 'date', 'amount', 'number', 'code', 'notes',
        'summary', 'details', 'comments', 'location'
      ].some(k => keyLower.includes(k));

      if (isImportant || strValue.length > 20) {
        parts.push(`${key}: ${strValue}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Get available databases and tables for search filtering
   */
  async getAvailableSources(): Promise<Array<{ database: string; tables: string[] }>> {
    const sources: Array<{ database: string; tables: string[] }> = [];

    try {
      const results = await this.env.DB.prepare(`
        SELECT database_name, GROUP_CONCAT(table_key) as tables
        FROM table_index
        GROUP BY database_name
      `).all();

      for (const row of results.results as any[]) {
        sources.push({
          database: row.database_name,
          tables: row.tables ? row.tables.split(',') : [],
        });
      }
    } catch {
      // Return empty if D1 not available
    }

    return sources;
  }
}
