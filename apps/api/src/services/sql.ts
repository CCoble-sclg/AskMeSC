import type { Env, QueryResult, ChartData } from '../types';
import { SchemaService } from './schema';
import { ClaudeService } from './claude';

const MAX_ROWS = 100;

const DANGEROUS_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER',
  'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL',
  'INTO', 'SET', 'MERGE'
];

interface AzureFunctionResponse {
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  error?: string;
  details?: string;
}

export class SqlService {
  private env: Env;
  private schemaService: SchemaService;
  private claude: ClaudeService;

  constructor(env: Env) {
    this.env = env;
    this.schemaService = new SchemaService(env);
    this.claude = new ClaudeService(env.ANTHROPIC_API_KEY);
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
      'account', 'department', 'batch', 'item', 'transaction', 'payable', 'receivable',
      'animal', 'license', 'permit', 'owner', 'dog', 'cat', 'pet'];
    
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
    
    // Check if this is a follow-up question with context
    const isFollowUp = question.includes('Previous question:');
    
    const prompt = `You are a SQL analytics expert. Generate a Microsoft SQL Server (T-SQL) query to provide INSIGHTFUL analysis for the user's question.

${isFollowUp ? `FOLLOW-UP QUESTION HANDLING:
- This is a follow-up to a previous query. Use the previous SQL as a starting point.
- If the user says something is "too high/low" or "wrong", consider:
  - Using a different table (e.g., animal table instead of kennel for unique animals)
  - Adding filters or different groupings
  - Checking for duplicates or historical records
- If asked to "break down" or add detail, add GROUP BY clauses
- Maintain relevance to the original question while addressing the follow-up

` : ''}ANALYTICAL MINDSET (IMPORTANT):
- Think like a data analyst - what insights would be most valuable?
- For time-based questions (last month, this year, etc.), consider:
  - Group by week or day to show trends
  - Include comparisons to previous periods when relevant
  - Show breakdowns by category/type when the data supports it
- For count questions, consider including:
  - Groupings that reveal patterns (by type, by week, by status)
  - Percentage breakdowns when useful
- Always aim to provide context, not just raw numbers

RULES:
- Generate ONLY a SELECT query - no INSERT, UPDATE, DELETE, or DDL
- Use TOP ${MAX_ROWS} after SELECT (e.g., SELECT TOP ${MAX_ROWS} ...)
- CRITICAL: Use square brackets for table names exactly as shown (e.g., FROM [dbo].[TableName])
- CRITICAL: Use square brackets for column names exactly as shown (e.g., SELECT [ColumnName])
- For case-insensitive text search, use LIKE (SQL Server is case-insensitive by default)

TIME-BASED ANALYSIS:
- For "last month" or "this month": GROUP BY week using DATEPART(WEEK, [date]) or by day
- For "last year" or trends: GROUP BY month using FORMAT([DateColumn], 'yyyy-MM')
- Include ORDER BY to show chronological trends
- Consider showing multiple metrics (COUNT, SUM, AVG) in one query

AGGREGATION PATTERNS:
- "How many X": Consider grouping by type/category to show breakdown
- "Show me X by month/week": Use GROUP BY with appropriate date functions
- Questions about trends: Include time-based grouping and ORDER BY date

DATE FUNCTIONS (T-SQL):
- Current date: GETDATE()
- Last month: WHERE [DateColumn] >= DATEADD(MONTH, -1, DATEADD(DAY, 1-DAY(GETDATE()), GETDATE())) AND [DateColumn] < DATEADD(DAY, 1-DAY(GETDATE()), GETDATE())
- This week: WHERE [DateColumn] >= DATEADD(WEEK, DATEDIFF(WEEK, 0, GETDATE()), 0)
- Group by week: DATEPART(WEEK, [DateColumn]) AS week_number
- Group by day: CAST([DateColumn] AS DATE) AS date

- Return ONLY the SQL query, no explanation or markdown
- If you cannot answer with a SELECT query, return: SELECT 'Cannot generate query for this request' AS error

ANIMAL DATABASE DOMAIN KNOWLEDGE:
This database tracks animal shelter operations. Key concepts:

1. INTAKE = animals "taken in" or "received":
   - Query: [SYSADM].[activity] table WHERE [activity_type] IN ('STRAY', 'OWNED', 'RESCUE', 'PROT CUST')
   - STRAY = stray animals found/brought in
   - OWNED = owner surrenders  
   - RESCUE = rescue transfers
   - PROT CUST = protective custody
   
2. Activity types that are NOT intakes (exclude from intake counts):
   - INV = investigations
   - OTHER = miscellaneous
   - WILD = wildlife encounters
   - TRANSPORT = animal transport
   
3. Key columns in [SYSADM].[activity]:
   - [activity_date] = date of activity (use for date filtering)
   - [activity_type] = type of activity
   - [animal_id] = links to animal record

4. For unique animal counts, consider using DISTINCT on [animal_id] to avoid duplicates

${schemaContext}

User question: ${question}

SQL query:`;

    const response = await this.claude.chat(
      'You are a SQL expert. Return ONLY the SQL query with no explanation, markdown, or commentary.',
      prompt,
      { maxTokens: 500, temperature: 0 }
    );
    
    let sqlQuery = response?.trim() || '';
    sqlQuery = sqlQuery.replace(/```sql\n?/gi, '').replace(/```\n?/g, '').trim();
    
    // Ensure TOP clause exists
    if (!sqlQuery.toUpperCase().includes('TOP ')) {
      sqlQuery = sqlQuery.replace(/^SELECT\s+/i, `SELECT TOP ${MAX_ROWS} `);
    }

    return sqlQuery;
  }

  validateQuery(sqlQuery: string): { valid: boolean; error?: string } {
    const upperSql = sqlQuery.toUpperCase();

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

  async executeQuery(sqlQuery: string, database: string = 'Animal'): Promise<QueryResult> {
    const validation = this.validateQuery(sqlQuery);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const functionUrl = this.env.AZURE_FUNCTION_URL;
    const apiKey = this.env.AZURE_FUNCTION_KEY;
    
    if (!functionUrl || !apiKey) {
      throw new Error('Azure Function not configured');
    }

    const startTime = Date.now();
    
    try {
      console.log('Executing SQL via Azure Function:', sqlQuery);
      
      const response = await fetch(`${functionUrl}/api/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          database,
          query: sqlQuery,
        }),
      });

      const result: AzureFunctionResponse = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      console.log(`Query returned ${result.rowCount} rows in ${result.executionTimeMs}ms`);

      return {
        sql: sqlQuery,
        rows: result.rows,
        rowCount: result.rowCount,
        executionTimeMs: result.executionTimeMs,
      };
    } catch (error) {
      console.error('Query execution error:', error);
      throw new Error(`Query execution failed: ${error}`);
    }
  }

  async queryWithNaturalLanguage(
    question: string, 
    database?: string
  ): Promise<{ result: QueryResult; generatedSql: string }> {
    const sqlQuery = await this.generateSql(question, database);
    
    if (sqlQuery.includes("Cannot generate query")) {
      throw new Error('Unable to generate a valid query for this question');
    }

    const result = await this.executeQuery(sqlQuery, database || 'Animal');
    
    return { result, generatedSql: sqlQuery };
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

  formatResultsAsMarkdownTable(result: QueryResult, maxRows: number = 15): string {
    if (result.rowCount === 0 || result.rows.length === 0) {
      return '';
    }

    const columns = Object.keys(result.rows[0]);
    if (columns.length === 0) return '';

    const formatValue = (val: unknown): string => {
      if (val === null || val === undefined) return '-';
      if (typeof val === 'number') {
        if (Number.isInteger(val)) return val.toLocaleString();
        return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      if (val instanceof Date) return val.toLocaleDateString();
      const str = String(val);
      return str.length > 50 ? str.substring(0, 47) + '...' : str;
    };

    const formatHeader = (col: string): string => {
      return col.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
    };

    const header = '| ' + columns.map(formatHeader).join(' | ') + ' |';
    const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
    
    const rows = result.rows.slice(0, maxRows).map(row => {
      return '| ' + columns.map(col => formatValue(row[col])).join(' | ') + ' |';
    });

    let table = [header, separator, ...rows].join('\n');
    
    if (result.rowCount > maxRows) {
      table += `\n\n*Showing ${maxRows} of ${result.rowCount} results*`;
    }

    return table;
  }

  detectChartType(question: string, result: QueryResult): { shouldChart: boolean; type?: ChartData['type']; title?: string } {
    const lowerQ = question.toLowerCase();
    
    if (result.rowCount < 2 || result.rowCount > 20) {
      return { shouldChart: false };
    }

    const columns = Object.keys(result.rows[0]);
    const hasNumericColumn = result.rows.some(row => 
      columns.some(col => typeof row[col] === 'number' || !isNaN(Number(row[col])))
    );

    if (!hasNumericColumn) {
      return { shouldChart: false };
    }

    if (lowerQ.includes('by month') || lowerQ.includes('over time') || lowerQ.includes('trend') || lowerQ.includes('per month')) {
      return { shouldChart: true, type: 'line', title: 'Trend Over Time' };
    }

    if (lowerQ.includes('breakdown') || lowerQ.includes('distribution') || lowerQ.includes('percentage') || lowerQ.includes('share')) {
      return { shouldChart: true, type: 'pie', title: 'Distribution' };
    }

    if (lowerQ.includes('top') || lowerQ.includes('most') || lowerQ.includes('compare') || lowerQ.includes('by vendor') || lowerQ.includes('by department')) {
      return { shouldChart: true, type: 'bar', title: 'Comparison' };
    }

    if (lowerQ.includes('count') || lowerQ.includes('how many') || lowerQ.includes('total')) {
      if (result.rowCount > 1) {
        return { shouldChart: true, type: 'bar', title: 'Summary' };
      }
    }

    return { shouldChart: false };
  }

  generateChartData(result: QueryResult, chartType: ChartData['type'], title?: string): ChartData | undefined {
    if (result.rowCount === 0 || result.rows.length === 0) return undefined;

    const columns = Object.keys(result.rows[0]);
    
    let labelColumn = columns.find(c => 
      typeof result.rows[0][c] === 'string' || 
      c.toLowerCase().includes('name') || 
      c.toLowerCase().includes('vendor') ||
      c.toLowerCase().includes('month') ||
      c.toLowerCase().includes('department')
    ) || columns[0];

    let valueColumn = columns.find(c => {
      const val = result.rows[0][c];
      return (typeof val === 'number' || !isNaN(Number(val))) && c !== labelColumn;
    });

    if (!valueColumn) {
      const countCol = columns.find(c => c.toLowerCase().includes('count') || c.toLowerCase().includes('total') || c.toLowerCase().includes('sum'));
      if (countCol) valueColumn = countCol;
    }

    if (!valueColumn) return undefined;

    const labels = result.rows.map(row => String(row[labelColumn] || 'Unknown'));
    const data = result.rows.map(row => {
      const val = row[valueColumn!];
      return typeof val === 'number' ? val : Number(val) || 0;
    });

    return {
      type: chartType,
      title,
      labels,
      datasets: [{
        label: valueColumn.replace(/([A-Z])/g, ' $1').trim(),
        data,
      }],
    };
  }

  async generateResponse(
    question: string,
    queryResult: QueryResult,
    generatedSql: string
  ): Promise<{ text: string }> {
    const resultContext = this.formatResultsForLLM(queryResult);
    const markdownTable = this.formatResultsAsMarkdownTable(queryResult);

    const prompt = `You are a data analyst assistant for local government. Provide INSIGHTFUL analysis, not just raw answers.

The user asked: "${question}"

SQL query executed: ${generatedSql}

Query results:
${resultContext}

ANALYSIS INSTRUCTIONS:
- Answer the question with **key insights and context**
- Identify **trends, patterns, or notable findings** in the data
- If showing time-based data, comment on trends (increasing, decreasing, peaks)
- Compare values when relevant (e.g., "X is 50% higher than Y")
- Highlight **outliers or significant values**
- Provide **statistical context** when useful (averages, ranges, percentages)
- Use **bold** for important numbers and findings
- Be conversational but data-driven
- Do NOT include a table - one will be appended automatically
- Keep response focused and under 200 words`;

    let text = await this.claude.chat(
      'You are a helpful assistant answering questions about local government data.',
      prompt,
      { maxTokens: 1024 }
    ) || 'Unable to generate response';

    const lines = text.split('\n');
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) return false;
      return true;
    });
    text = filteredLines.join('\n').trim();

    if (markdownTable && queryResult.rowCount > 1) {
      text += '\n\n' + markdownTable;
    }

    return { text };
  }
}
