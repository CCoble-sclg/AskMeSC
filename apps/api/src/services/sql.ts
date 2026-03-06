import { neon } from '@neondatabase/serverless';
import type { Env, QueryResult, TableSchema } from '../types';
import { SchemaService } from './schema';

const MAX_ROWS = 100;
const QUERY_TIMEOUT_MS = 5000;

const DANGEROUS_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER',
  'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL',
  'INTO', 'SET', 'MERGE'
];

export class SqlService {
  private env: Env;
  private schemaService: SchemaService;

  constructor(env: Env) {
    this.env = env;
    this.schemaService = new SchemaService(env);
  }

  async generateSql(question: string, database?: string): Promise<string> {
    const schemaContext = await this.schemaService.getSchemaContext(database);
    
    const prompt = `You are a SQL expert. Generate a PostgreSQL query to answer the user's question.

RULES:
- Generate ONLY a SELECT query - no INSERT, UPDATE, DELETE, or DDL
- Always include LIMIT ${MAX_ROWS} at the end
- Use proper table and column names from the schema
- Use ILIKE for case-insensitive string matching
- Return ONLY the SQL query, no explanation or markdown
- If you cannot answer with a SELECT query, return: SELECT 'Cannot generate query for this request' AS error

${schemaContext}

User question: ${question}

SQL query:`;

    const aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.1,
    });

    const response = 'response' in aiResponse ? aiResponse.response : '';
    
    let sql = response?.trim() || '';
    sql = sql.replace(/```sql\n?/gi, '').replace(/```\n?/g, '').trim();
    
    if (!sql.toUpperCase().includes('LIMIT')) {
      sql = sql.replace(/;?\s*$/, '') + ` LIMIT ${MAX_ROWS}`;
    }

    return sql;
  }

  validateQuery(sql: string): { valid: boolean; error?: string } {
    const upperSql = sql.toUpperCase();

    for (const keyword of DANGEROUS_KEYWORDS) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(upperSql) && keyword !== 'INTO') {
        return { valid: false, error: `Query contains forbidden keyword: ${keyword}` };
      }
      if (keyword === 'INTO' && /\bINTO\b/i.test(upperSql) && !/\bINSERT\s+INTO\b/i.test(upperSql)) {
        if (/SELECT\s+.*\s+INTO\b/i.test(upperSql)) {
          return { valid: false, error: 'SELECT INTO is not allowed' };
        }
      }
    }

    if (!upperSql.trim().startsWith('SELECT')) {
      return { valid: false, error: 'Only SELECT queries are allowed' };
    }

    if (upperSql.includes(';') && upperSql.indexOf(';') < upperSql.length - 1) {
      return { valid: false, error: 'Multiple statements are not allowed' };
    }

    return { valid: true };
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const validation = this.validateQuery(sql);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const connectionString = this.env.NEON_DATABASE_URL;
    if (!connectionString) {
      throw new Error('Database connection not configured');
    }

    const neonSql = neon(connectionString);
    
    const startTime = Date.now();
    
    try {
      const rows = await neonSql.query(sql);
      const executionTimeMs = Date.now() - startTime;

      return {
        sql,
        rows: rows.rows as Record<string, unknown>[],
        rowCount: rows.rows.length,
        executionTimeMs,
      };
    } catch (error) {
      throw new Error(`Query execution failed: ${error}`);
    }
  }

  async queryWithNaturalLanguage(
    question: string, 
    database?: string
  ): Promise<{ result: QueryResult; generatedSql: string }> {
    const sql = await this.generateSql(question, database);
    
    if (sql.includes("Cannot generate query")) {
      throw new Error('Unable to generate a valid query for this question');
    }

    const result = await this.executeQuery(sql);
    
    return { result, generatedSql: sql };
  }

  formatResultsForLLM(result: QueryResult): string {
    if (result.rowCount === 0) {
      return 'No results found.';
    }

    const parts: string[] = [];
    parts.push(`Found ${result.rowCount} result(s):\n`);

    for (const row of result.rows.slice(0, 20)) {
      const rowParts: string[] = [];
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && value !== undefined) {
          rowParts.push(`${key}: ${value}`);
        }
      }
      parts.push(rowParts.join(', '));
    }

    if (result.rowCount > 20) {
      parts.push(`\n... and ${result.rowCount - 20} more results`);
    }

    return parts.join('\n');
  }

  async generateResponse(
    question: string,
    queryResult: QueryResult,
    generatedSql: string
  ): Promise<string> {
    const resultContext = this.formatResultsForLLM(queryResult);

    const prompt = `You are a helpful assistant answering questions about local government data.

The user asked: "${question}"

I ran this SQL query: ${generatedSql}

Query results:
${resultContext}

Please provide a clear, helpful answer based on these results. If there are many results, summarize the key findings. Use plain language that citizens can understand.`;

    const aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: 1024,
    });

    return 'response' in aiResponse 
      ? aiResponse.response || 'Unable to generate response'
      : 'Unable to generate response';
  }
}
