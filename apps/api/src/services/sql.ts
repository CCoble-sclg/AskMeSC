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

  async generateSql(
    question: string,
    database?: string,
    previousSql?: string,
    previousQuestion?: string,
    previousResponse?: string
  ): Promise<string> {
    const allKeywords = previousQuestion
      ? [...this.extractKeywords(question), ...this.extractKeywords(previousQuestion)]
      : this.extractKeywords(question);
    const keywords = [...new Set(allKeywords)];
    const schemaContext = await this.schemaService.getSchemaContext(database, keywords);
    
    let followUpBlock = '';
    if (previousSql) {
      // Include the chatbot's previous response so LLM knows what options were offered
      const responseContext = previousResponse 
        ? `\nCHATBOT'S PREVIOUS RESPONSE (what the user is responding to):\n${previousResponse.substring(0, 1500)}\n`
        : '';
      
      followUpBlock = `
PREVIOUS USER QUESTION: ${previousQuestion || '(unknown)'}
PREVIOUS SQL QUERY:
${previousSql}
${responseContext}
=== FOLLOW-UP INSTRUCTIONS (CRITICAL) ===

The user's current message is: "${question}"

STEP 1: DETERMINE WHAT THE USER WANTS
- If user says "yes", "sure", "ok", "please", "do it", etc. → Look at CHATBOT'S PREVIOUS RESPONSE above
- Find the FIRST option/suggestion the chatbot offered (usually after "Would you like me to...")
- Generate a query for THAT option

STEP 2: MAINTAIN ENTITY CONTEXT (CRITICAL!)
Look at the previous query. If it filters by a specific entity (GLAccountID, VendorID, EmployeeId, animal_id, etc.),
KEEP THAT FILTER in the new query unless the user explicitly asks about something else!

Example: If previous query had "WHERE GLAccountID = 1506", and user asks "what about January expenses",
the new query MUST STILL include "WHERE GLAccountID = 1506" plus the January date filter.

STEP 3: MODIFY THE QUERY APPROPRIATELY
Based on what the user wants, you MUST change the query. DO NOT return the same query!

COMMON MODIFICATIONS (ANIMAL DATABASE):
- "dogs in hold/pending status" → CHANGE kennel_stat filter
- "all animal types" or "cats too" → REMOVE the animal_type filter
- "break down by type" → Add GROUP BY a.[animal_type]
- "euthanasia numbers" → Change to WHERE k.[outcome_type] = 'EUTH' and COUNT(*)

COMMON MODIFICATIONS (LOGOS/FINANCE DATABASE):
- "for January" or "for [month]" → Add date filter but KEEP the GLAccountID filter!
- "last 5 years" → Change FiscalEndYear to BETWEEN (currentYear-4) AND currentYear, GROUP BY FiscalEndYear
- "break down by month" → Add GROUP BY FORMAT(GLDate, 'yyyy-MM')
- "show details" → Change from SUM() to SELECT individual transaction rows

IMPORTANT: The query MUST be DIFFERENT from the previous query!
Keep entity filters (GLAccountID, VendorID, etc.) unless user asks about a different entity.

ALWAYS output a valid SELECT query starting with "SELECT".

`;
    }

    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();
    
    const prompt = `You are a SQL expert. Generate a Microsoft SQL Server (T-SQL) query.
${followUpBlock}
CURRENT DATE: ${today} (Year: ${currentYear})
When users ask about "this year", "since January 1st", "YTD", etc., use year ${currentYear}.

RULES:
- Generate ONLY a SELECT query
- Use TOP ${MAX_ROWS} after SELECT
- Use square brackets for table and column names exactly as shown in the schema
- Use ONLY table and column names from the schema below — do not invent names
- Return ONLY the SQL query, no explanation or markdown

DATE FUNCTIONS (T-SQL):
- Current date: GETDATE()
- Last month: WHERE [Col] >= DATEADD(MONTH, -1, DATEADD(DAY, 1-DAY(GETDATE()), GETDATE())) AND [Col] < DATEADD(DAY, 1-DAY(GETDATE()), GETDATE())
- Group by day: CAST([Col] AS DATE)
- Group by month: FORMAT([Col], 'yyyy-MM')

ANIMAL SHELTER DATABASE:
Tables use [dbo] schema. Key tables: kennel, animal, person, tag, bite, violation, treatment.

KNOWN CODES (use these exact values in queries):
- outcome_type: 'EUTH' (euthanasia), 'ADOPTION', 'RTO' (return to owner), 'TRANSFER', 'DIED'
- intake_type: 'STRAY', 'OWNED' (owner surrender), 'RESCUE'
- location: 'SHELTER' (physical animals), 'WEB' (web entries - exclude for physical counts)
- kennel_stat: 'STRAY WAIT', 'AVAILABLE', 'EVALUATION', 'UNAVAIL'

KEY FILTERS:
- Current animals in shelter: WHERE outcome_date IS NULL AND location = 'SHELTER'
- Euthanasia: WHERE outcome_type = 'EUTH'
- Adoptions: WHERE outcome_type = 'ADOPTION'

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
    database?: string,
    previousSql?: string,
    previousQuestion?: string,
    previousResponse?: string
  ): Promise<{ result: QueryResult; generatedSql: string }> {
    const sqlQuery = await this.generateSql(question, database, previousSql, previousQuestion, previousResponse);
    
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

    let columns = Object.keys(result.rows[0]);
    if (columns.length === 0) return '';

    // Filter out redundant columns (if year_month exists, remove year and month)
    const hasYearMonth = columns.some(c => c.toLowerCase().includes('year_month'));
    if (hasYearMonth) {
      columns = columns.filter(c => {
        const lower = c.toLowerCase();
        // Keep year_month, remove separate year/month columns
        if ((lower === 'year' || lower === 'intake_year' || lower === 'outcome_year') && 
            !lower.includes('year_month')) return false;
        if ((lower === 'month' || lower === 'intake_month' || lower === 'outcome_month') && 
            !lower.includes('year_month')) return false;
        return true;
      });
    }

    const formatValue = (val: unknown, colName: string): string => {
      if (val === null || val === undefined) return '-';
      if (typeof val === 'number') {
        // Don't add commas to year values (4-digit numbers in year columns or 1900-2100 range)
        const isYearColumn = colName.toLowerCase().includes('year');
        const looksLikeYear = Number.isInteger(val) && val >= 1900 && val <= 2100;
        if (isYearColumn || looksLikeYear) {
          return String(val);
        }
        if (Number.isInteger(val)) return val.toLocaleString();
        return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      if (val instanceof Date) return val.toLocaleDateString();
      const str = String(val);
      return str.length > 50 ? str.substring(0, 47) + '...' : str;
    };

    const formatHeader = (col: string): string => {
      // Better header formatting
      return col
        .replace(/_/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, s => s.toUpperCase())
        .trim();
    };

    const header = '| ' + columns.map(formatHeader).join(' | ') + ' |';
    const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';

    const rows = result.rows.slice(0, maxRows).map(row => {
      return '| ' + columns.map(col => formatValue(row[col], col)).join(' | ') + ' |';
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
    generatedSql: string,
    previousQuestion?: string
  ): Promise<{ text: string }> {
    const resultContext = this.formatResultsForLLM(queryResult);
    const markdownTable = this.formatResultsAsMarkdownTable(queryResult);

    let conversationBlock = '';
    if (previousQuestion) {
      conversationBlock = `\nConversation context: The user previously asked "${previousQuestion}" and is now following up.\n`;
    }

    const prompt = `You are a data analyst assistant for local government. Provide INSIGHTFUL analysis, not just raw answers.
${conversationBlock}
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
- Do NOT guess specific dates or years — only reference dates if they appear in the query results
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
