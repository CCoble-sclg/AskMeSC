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

  extractKeywords(question: string): string[] {
    const stopWords = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
      'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
      'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
      'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
      'because', 'until', 'while', 'what', 'which', 'who', 'whom', 'this',
      'that', 'these', 'those', 'am', 'i', 'me', 'my', 'myself', 'we', 'our',
      'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they',
      'them', 'their', 'show', 'get', 'find', 'list', 'give', 'tell', 'many',
      'much', 'any', 'see', 'look', 'also', 'about'
    ]);

    const words = question.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    const uniqueWords = [...new Set(words)];
    
    const entityKeywords = ['invoice', 'vendor', 'employee', 'payment', 'check', 
      'account', 'department', 'batch', 'item', 'transaction', 'payable', 'receivable'];
    
    const prioritized = uniqueWords.sort((a, b) => {
      const aIsEntity = entityKeywords.some(e => a.includes(e) || e.includes(a));
      const bIsEntity = entityKeywords.some(e => b.includes(e) || e.includes(a));
      if (aIsEntity && !bIsEntity) return -1;
      if (!aIsEntity && bIsEntity) return 1;
      return b.length - a.length;
    });

    return prioritized.slice(0, 10);
  }

  async generateSql(question: string, database?: string): Promise<string> {
    const keywords = this.extractKeywords(question);
    const schemaContext = await this.schemaService.getSchemaContext(database, keywords);
    
    const prompt = `You are a SQL expert. Generate a PostgreSQL query to answer the user's question.

RULES:
- Generate ONLY a SELECT query - no INSERT, UPDATE, DELETE, or DDL
- Always include LIMIT ${MAX_ROWS} at the end
- CRITICAL: Always use double quotes around table names exactly as shown (e.g., FROM "dbo_AccountsPayableInvoice")
- CRITICAL: Always use double quotes around column names exactly as shown (e.g., SELECT "InvoiceDate")
- Use ILIKE only for TEXT/VARCHAR columns, never for dates or numbers
- For date filtering, use operators like >=, <=, BETWEEN with proper date literals (e.g., "InvoiceDate" >= '2023-01-01')
- For year filtering, use: EXTRACT(YEAR FROM "DateColumn") = 2023
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
      console.log('Executing SQL:', sql);
      const result = await neonSql.query(sql);
      const executionTimeMs = Date.now() - startTime;
      
      const resultRows = Array.isArray(result) ? result : (result.rows || []);
      console.log(`Query returned ${resultRows.length} rows`);

      return {
        sql,
        rows: resultRows as Record<string, unknown>[],
        rowCount: resultRows.length,
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
