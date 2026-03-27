import type { Env } from '../types';
import { ClaudeService } from './claude';
import { SchemaCache } from './schema-cache';
import { ANIMAL_DB_KNOWLEDGE, LOGOS_DB_KNOWLEDGE } from './domain-knowledge-static';

const MAX_ITERATIONS = 10;
const MAX_ROWS = 50;

const PROGRESS_MESSAGES: Record<string, string[]> = {
  list_tables: ['Exploring database structure...', 'Discovering available data...'],
  describe_table: ['Examining data fields...', 'Understanding data structure...'],
  sample_values: ['Analyzing data patterns...', 'Learning data characteristics...'],
  run_query: ['Querying the database...', 'Retrieving information...', 'Processing your request...'],
  thinking: ['Analyzing your question...', 'Determining best approach...', 'Planning next step...'],
};

function getProgressMessage(tool: string, iteration: number): string {
  const messages = PROGRESS_MESSAGES[tool] || PROGRESS_MESSAGES['thinking'];
  return messages[iteration % messages.length];
}

export type ProgressCallback = (message: string, step: number, total: number) => void | Promise<void>;

interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

interface AgentStep {
  thought: string;
  tool?: string;
  parameters?: Record<string, unknown>;
  result?: string;
}

const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'list_databases',
    description: 'List all available databases you can query',
    parameters: {}
  },
  {
    name: 'list_tables',
    description: 'Get a list of tables in a database',
    parameters: {
      database: { type: 'string', description: 'The database name (e.g., "Animal" or "Logos")', required: true }
    }
  },
  {
    name: 'describe_table',
    description: 'Get column information for a specific table',
    parameters: {
      database: { type: 'string', description: 'The database name', required: true },
      table_name: { type: 'string', description: 'The table name (e.g., "kennel" or "dbo.GLAccount")', required: true }
    }
  },
  {
    name: 'sample_values',
    description: 'Get sample values from a column to understand what data exists',
    parameters: {
      database: { type: 'string', description: 'The database name', required: true },
      table_name: { type: 'string', description: 'The table name', required: true },
      column_name: { type: 'string', description: 'The column to sample', required: true },
      limit: { type: 'number', description: 'Max values to return (default 20)' }
    }
  },
  {
    name: 'run_query',
    description: 'Execute a SELECT query against a database',
    parameters: {
      database: { type: 'string', description: 'The database name', required: true },
      sql: { type: 'string', description: 'The SQL SELECT query to run', required: true }
    }
  },
  {
    name: 'final_answer',
    description: 'Provide the final answer to the user',
    parameters: {
      answer: { type: 'string', description: 'The complete answer with insights and context', required: true },
      sql_used: { type: 'string', description: 'The main SQL query that produced the answer' }
    }
  }
];

export class AgentSqlService {
  private env: Env;
  private claude: ClaudeService;
  private cache: SchemaCache;
  private conversationContext?: {
    previousQuestion?: string;
    previousSql?: string;
    previousResponse?: string;
  };

  constructor(env: Env) {
    this.env = env;
    this.claude = new ClaudeService(env.ANTHROPIC_API_KEY);
    this.cache = new SchemaCache(env);
  }

  /**
   * Direct query mode - 2 LLM calls total:
   * 1. Generate SQL from question + domain knowledge
   * 2. Format answer from results
   */
  async queryDirect(
    question: string,
    onProgress?: ProgressCallback,
    context?: { previousQuestion?: string; previousSql?: string; previousResponse?: string }
  ): Promise<{ answer: string; sql: string }> {
    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();

    let contextBlock = '';
    if (context?.previousQuestion) {
      contextBlock = `
PREVIOUS CONTEXT:
- Previous question: "${context.previousQuestion}"
- Previous SQL: ${context.previousSql || 'N/A'}
- Previous answer: ${context.previousResponse?.substring(0, 500) || 'N/A'}

This is a FOLLOW-UP question. Use the same database and base filters from the previous SQL.
If the user asks "what were they", "list them", "show details", etc., query for INDIVIDUAL ROWS with detail columns (Date, Description, Amount, etc.) instead of aggregates.
`;
    }

    // Step 1: Generate SQL (ONE LLM call)
    await onProgress?.('Generating query...', 1, 3);
    
    const sqlPrompt = `Generate a T-SQL query to answer this question.

CURRENT DATE: ${today} (Year: ${currentYear})

DOMAIN KNOWLEDGE:

=== ANIMAL DATABASE (use for shelter/animal questions) ===
${ANIMAL_DB_KNOWLEDGE}

=== LOGOS DATABASE (use for finance/HR/employee questions) ===
${LOGOS_DB_KNOWLEDGE}
${contextBlock}
USER QUESTION: ${question}

Respond with ONLY this JSON format, nothing else:
{"database": "Animal", "sql": "SELECT ..."}
or
{"database": "Logos", "sql": "SELECT ..."}`;

    const sqlResponse = await this.claude.chat(
      'You are a T-SQL expert for Microsoft SQL Server. You respond with ONLY a JSON object containing "database" and "sql" keys. No markdown, no explanation, no code fences.',
      sqlPrompt,
      { maxTokens: 1000, temperature: 0 }
    );

    let database: string;
    let sql: string;
    
    try {
      const cleaned = sqlResponse.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      const parsed = JSON.parse(jsonMatch[0]);
      database = parsed.database;
      sql = parsed.sql;
      if (!database || !sql) throw new Error('Missing database or sql in response');
    } catch (e) {
      console.error('Failed to parse SQL response:', sqlResponse);
      throw new Error(`Failed to generate SQL query: ${e instanceof Error ? e.message : e}`);
    }

    console.log(`Direct query - DB: ${database}, SQL: ${sql}`);

    // Step 2: Run the query
    await onProgress?.('Running query...', 2, 3);
    
    const result = await this.callAzureFunction('query', { database, query: sql });
    
    console.log('Query result:', JSON.stringify(result).substring(0, 500));
    
    if (result.error) {
      const details = result.details ? ` - ${result.details}` : '';
      throw new Error(`Query failed (${database}): ${result.error}${details} | SQL: ${sql}`);
    }

    const rows = result.rows || [];
    const resultText = rows.length === 0 
      ? 'No results found.'
      : rows.slice(0, MAX_ROWS).map((r: Record<string, unknown>) => 
          Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(', ')
        ).join('\n');

    // Step 3: Format answer (ONE LLM call)
    await onProgress?.('Formatting answer...', 3, 3);

    const answerPrompt = `Based on the query results, provide a complete answer to the user's question.

USER QUESTION: ${question}

SQL USED: ${sql}

QUERY RESULTS (${rows.length} rows):
${resultText}

FORMATTING RULES:
- If there are multiple rows, display them in a markdown table
- Include ALL rows in your response - do not truncate or summarize
- Format currency values with $ and commas (e.g., $1,234.56)
- Format dates as readable (e.g., Jan 15, 2026)
- Start with a brief summary sentence, then show the data
- Be specific with numbers and names`;

    const answer = await this.claude.chat(
      'You are a helpful assistant. Provide complete, well-formatted answers based on data.',
      answerPrompt,
      { maxTokens: 2000, temperature: 0 }
    );

    return { answer, sql };
  }

  private async callAzureFunction(endpoint: string, body: Record<string, unknown>, retries = 2): Promise<any> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${this.env.AZURE_FUNCTION_URL}/api/${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.env.AZURE_FUNCTION_KEY,
          },
          body: JSON.stringify(body),
        });
        const result = await response.json();

        const isRetryable = result.error && (
          result.details?.includes('Failed to connect') ||
          result.details?.includes('timeout') ||
          result.details?.includes('ETIMEOUT') ||
          response.status >= 500
        );

        if (isRetryable && attempt < retries) {
          console.log(`Azure Function call failed (attempt ${attempt + 1}), retrying: ${result.details || result.error}`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        return result;
      } catch (e) {
        if (attempt < retries) {
          console.log(`Azure Function fetch failed (attempt ${attempt + 1}), retrying: ${e}`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw e;
      }
    }
  }

  private async listDatabases(): Promise<string> {
    return `Available databases:

1. Animal - Animal shelter operations and adoptions tracking
   - Tables are in dbo schema (standard): [dbo].[kennel], [dbo].[animal], etc.
   - PRIMARY USE: Tracking shelter animals, intakes, outcomes (adoptions, transfers, euthanasia)
   - KEY TABLE: [dbo].[kennel] - All shelter transactions (intakes, outcomes, current animals)
   - Supporting tables: [dbo].[animal] (animal details), [dbo].[person] (owners/adopters)
   
   CRITICAL FOR CURRENT SHELTER COUNTS:
   - DO NOT just use 'outcome_date IS NULL' - that includes ~13,000 LOST/FOUND reports!
   - CORRECT: WHERE outcome_date IS NULL AND kennel_no NOT IN ('LOST', 'FOUND')
   - kennel_no values 'LOST' and 'FOUND' are tracking records, not physical animals in shelter
   
   KEY CODE VALUES:
   - outcome_type: ADOPTION, EUTH (euthanasia), DIED, RTO (return to owner), TRANSFER, FOSTER
   - animal_type: DOG, CAT, BIRD, LIVESTOCK, OTHER
   - kennel_stat: AVAILABLE, STRAY WAIT, EVALUATION, UNAVAIL

2. Logos - County ERP system (Tyler Technologies Munis)
   - Tables are in dbo schema (main) and HR schema (employees)
   - SCHEMAS NOT USED: CD (Community Development) - ignore these tables
   
   KEY FINANCIAL TABLES:
   - [dbo].[JournalDetail] - ALL financial transactions (budget, expenses, revenue)
   - [dbo].[GLAccount] - GL account master (join on GLAccountID)
   - [dbo].[Account] - Account code definitions (AccountType: 1=Asset, 2=Liability, 3=Fund Balance, 4=Revenue, 5=Expense)
   - [dbo].[Organization1] - Funds (OrganizationCode = fund number like '110' for General Fund)
   - [dbo].[Vendor] - Vendor master
   - [dbo].[PurchaseOrder] - Purchase orders
   
   HR TABLES (for employee counts):
   - [HR].[EmployeeEmployment] - BEST TABLE for current employee status
   - Active employees: WHERE vsEmploymentStatusId = 518 AND EffectiveEndDate = '9999-12-31'
   - Status codes: 518=Active, 519=Terminated, 517=Leave, 520=Retired
   - [HR].[Employee] - Employee master (links via EmployeeId)
   - [HR].[EmployeeName] - Names (use EffectiveEndDate = '9999-12-31' for current)
   - [HR].[EmployeeJob] - Job/position info
   
   UTILITY BILLING:
   - [dbo].[UtilityAccount] - Customer accounts (AccountStatus: 1=Active, 2=Inactive)
   - [dbo].[UtilityBill], [dbo].[UtilityCustomerAccount]
   
   CRITICAL - BUDGET VS EXPENSES (Source column in JournalDetail):
   - Source = 'BudgetProcessing' → BUDGET entries
   - Source = 'BA YYYY-##' → Budget amendments
   - All other Source values → ACTUAL expenses/revenue (Accounts Payable, Payroll Post, Purchase Orders, etc.)
   
   BALANCE FORMULA:
   Budget = SUM(CASE WHEN Source = 'BudgetProcessing' OR Source LIKE 'BA %' THEN Amount ELSE 0 END)
   Expenses = SUM(CASE WHEN Source NOT IN ('BudgetProcessing') AND Source NOT LIKE 'BA %' THEN Amount ELSE 0 END)
   Remaining = Budget - Expenses
   
   ALWAYS filter by FiscalEndYear (e.g., 2026) for current year data!`;
  }

  private async listTables(database: string): Promise<string> {
    // Fetch from Azure Function
    try {
      const url = `${this.env.AZURE_FUNCTION_URL}/api/schema?database=${database}`;
      console.log(`Fetching tables from: ${url}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      const response = await fetch(url, { 
        headers: { 'x-api-key': this.env.AZURE_FUNCTION_KEY },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      console.log(`Schema response status: ${response.status} for database: ${database}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Schema error response: ${errorText}`);
        return `Error fetching tables from ${database}: HTTP ${response.status} - ${errorText}`;
      }
      
      const data = await response.json();
      console.log(`Schema returned ${data.tables?.length || 0} tables for ${database}`);
      
      if (!data.tables || data.tables.length === 0) {
        return `No tables found in ${database} database. The database may be empty or not configured.`;
      }
      
      // Show first few table names in log
      const firstTables = data.tables.slice(0, 5).map((t: any) => t.name).join(', ');
      console.log(`First tables in ${database}: ${firstTables}...`);
      
      const tableList = data.tables.map((t: any) => 
        `[${t.schema}].[${t.name}]`
      );
      
      return `Tables in ${database} database (${tableList.length} total):\n${tableList.join('\n')}`;
    } catch (e) {
      console.error(`Error listing tables for ${database}:`, e);
      return `Error listing tables from ${database}: ${e}`;
    }
  }

  private async describeTable(database: string, tableName: string): Promise<string> {
    const cleanTable = tableName.replace(/[\[\]]/g, '');
    const schema = cleanTable.includes('.') ? cleanTable.split('.')[0] : 'dbo';
    const name = cleanTable.includes('.') ? cleanTable.split('.')[1] : cleanTable;
    
    // TEMPORARILY DISABLED CACHE
    // const cachedSchema = await this.cache.getTableSchema(database, schema, name);
    // if (cachedSchema) {
    //   console.log(`Cache hit: ${database}.${schema}.${name} schema`);
    //   const columns = cachedSchema.columns.map(c => `  - [${c.name}] (${c.type})`).join('\n');
    //   return `Table [${schema}].[${name}] in ${database} (from cache):\n${columns}`;
    // }

    // Fetch by querying
    try {
      console.log(`Cache miss: Describing ${database}.${schema}.${name}...`);
      const sampleSql = `SELECT TOP 1 * FROM [${schema}].[${name}]`;
      const result = await this.callAzureFunction('query', { database, query: sampleSql });
      
      if (result.error) {
        return `Error describing table: ${result.error}`;
      }
      
      if (!result.rows?.length) {
        return `Table [${schema}].[${name}] exists but appears empty`;
      }
      
      // Extract column info (we don't have types from this method, but names are useful)
      const columns = Object.keys(result.rows[0]).map(col => ({ name: col, type: 'unknown' }));
      
      // Save to cache
      await this.cache.setTableSchema(database, schema, name, columns);
      
      const columnList = columns.map(c => `  - [${c.name}]`).join('\n');
      return `Table [${schema}].[${name}] in ${database}:\n${columnList}`;
    } catch (e) {
      return `Error describing table: ${e}`;
    }
  }

  private async sampleValues(database: string, tableName: string, columnName: string, limit: number = 20): Promise<string> {
    const cleanTable = tableName.replace(/[\[\]]/g, '');
    const schema = cleanTable.includes('.') ? cleanTable.split('.')[0] : 'dbo';
    const name = cleanTable.includes('.') ? cleanTable.split('.')[1] : cleanTable;
    
    // TEMPORARILY DISABLED CACHE
    // const cachedValues = await this.cache.getSampleValues(database, schema, name, columnName);
    // if (cachedValues) {
    //   console.log(`Cache hit: ${database}.${schema}.${name}.${columnName} samples`);
    //   return `Sample values for [${columnName}] in [${schema}].[${name}] (from cache):\n${cachedValues.join(', ')}`;
    // }

    try {
      console.log(`Cache miss: Sampling ${database}.${schema}.${name}.${columnName}...`);
      const sql = `SELECT TOP ${limit} DISTINCT [${columnName}] as val FROM [${schema}].[${name}] WHERE [${columnName}] IS NOT NULL ORDER BY [${columnName}]`;
      
      const result = await this.callAzureFunction('query', { database, query: sql });
      
      if (result.error) return `Error: ${result.error}`;
      if (!result.rows?.length) return `No values found in ${tableName}.${columnName}`;
      
      const values = result.rows.map((r: any) => String(r.val));
      
      // Save to cache
      await this.cache.setSampleValues(database, schema, name, columnName, values);
      
      return `Sample values for [${columnName}] in [${schema}].[${name}]:\n${values.join(', ')}`;
    } catch (e) {
      return `Error sampling values: ${e}`;
    }
  }

  private async runQuery(database: string, sql: string): Promise<string> {
    try {
      console.log(`Running query on DATABASE: ${database}`);
      console.log(`SQL: ${sql.substring(0, 200)}...`);
      
      if (!sql.trim().toUpperCase().startsWith('SELECT')) {
        return 'Error: Only SELECT queries are allowed';
      }
      
      if (!sql.toUpperCase().includes('TOP ')) {
        sql = sql.replace(/^SELECT\s+/i, `SELECT TOP ${MAX_ROWS} `);
      }
      
      const result = await this.callAzureFunction('query', { database, query: sql });
      
      if (result.error) {
        console.error(`Query error on ${database}: ${result.error}`);
        return `Query error on ${database}: ${result.error}`;
      }
      
      console.log(`Query on ${database} returned ${result.rowCount} rows`);
      
      if (!result.rows?.length) {
        return `Query on ${database} returned 0 rows.\nSQL: ${sql}`;
      }
      
      const columns = Object.keys(result.rows[0]);
      const rows = result.rows.slice(0, 20).map((r: any) => 
        columns.map(c => `${c}: ${r[c]}`).join(', ')
      ).join('\n');
      
      return `Query on ${database} returned ${result.rowCount} rows:\n${rows}${result.rowCount > 20 ? `\n... and ${result.rowCount - 20} more` : ''}\n\nSQL: ${sql}`;
    } catch (e) {
      console.error(`Query execution error on ${database}:`, e);
      return `Query execution error on ${database}: ${e}`;
    }
  }

  private async executeTool(tool: string, params: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case 'list_databases':
        return this.listDatabases();
      case 'list_tables':
        return this.listTables(params.database as string);
      case 'describe_table':
        return this.describeTable(params.database as string, params.table_name as string);
      case 'sample_values':
        return this.sampleValues(
          params.database as string,
          params.table_name as string, 
          params.column_name as string,
          (params.limit as number) || 20
        );
      case 'run_query':
        return this.runQuery(params.database as string, params.sql as string);
      default:
        return `Unknown tool: ${tool}`;
    }
  }

  private buildAgentPrompt(question: string, steps: AgentStep[]): string {
    const toolDescriptions = AGENT_TOOLS.map(t => {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `    ${k}: ${v.type} - ${v.description}${v.required ? ' (required)' : ''}`)
        .join('\n');
      return `${t.name}: ${t.description}${params ? '\n  Parameters:\n' + params : ''}`;
    }).join('\n\n');

    const stepHistory = steps.map((s, i) => {
      let text = `Step ${i + 1}:\n  Thought: ${s.thought}`;
      if (s.tool) text += `\n  Tool: ${s.tool}`;
      if (s.parameters) text += `\n  Parameters: ${JSON.stringify(s.parameters)}`;
      if (s.result) text += `\n  Result: ${s.result}`;
      return text;
    }).join('\n\n');

    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();
    
    // Build conversation context if we have it
    let contextBlock = '';
    if (this.conversationContext?.previousQuestion) {
      contextBlock = `
CONVERSATION CONTEXT:
Previous question: "${this.conversationContext.previousQuestion}"
${this.conversationContext.previousSql ? `Previous SQL used: ${this.conversationContext.previousSql}` : ''}
${this.conversationContext.previousResponse ? `Previous answer summary: ${this.conversationContext.previousResponse.substring(0, 800)}...` : ''}

This is a FOLLOW-UP question. The user is likely asking about the same subject (same table, same entity, same account).
Look at the previous SQL to understand what entity/filter was used, and APPLY THE SAME FILTER to your new query.
`;
    }
    
    return `You are a data analyst with access to SQL databases. Answer questions by querying data.

CURRENT DATE: ${today} (Year: ${currentYear})
When users mention "this year", "since January", etc., use ${currentYear}.

AVAILABLE TOOLS:
${toolDescriptions}

INSTRUCTIONS:
You have COMPLETE domain knowledge below. DO NOT explore - go DIRECTLY to run_query!

FAST PATH (ALWAYS use this):
1. Read domain knowledge → 2. run_query with SQL → 3. final_answer

DO NOT call list_databases, list_tables, describe_table, or sample_values - you already have all the information you need!

=== ANIMAL DATABASE DOMAIN KNOWLEDGE ===
${ANIMAL_DB_KNOWLEDGE}

=== LOGOS DATABASE DOMAIN KNOWLEDGE ===
${LOGOS_DB_KNOWLEDGE}
${contextBlock}
USER QUESTION: ${question}

${stepHistory ? 'PREVIOUS STEPS:\n' + stepHistory + '\n\n' : ''}
Respond with valid JSON:
{
  "thought": "Your reasoning about what to do next",
  "tool": "tool_name",
  "parameters": { ... }
}

When ready to answer, use final_answer tool.`;
  }

  async queryWithAgent(
    question: string, 
    onProgress?: ProgressCallback,
    context?: {
      previousQuestion?: string;
      previousSql?: string;
      previousResponse?: string;
    }
  ): Promise<{ answer: string; steps: AgentStep[]; finalSql?: string }> {
    this.conversationContext = context;
    console.log(`Agent starting exploration for: ${question.substring(0, 50)}...`);
    
    const steps: AgentStep[] = [];
    let finalAnswer = '';
    let finalSql = '';

    await onProgress?.('Understanding your question...', 0, MAX_ITERATIONS);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      await onProgress?.(getProgressMessage('thinking', i), i + 1, MAX_ITERATIONS);
      
      const recentSteps = steps.slice(-6);
      const prompt = this.buildAgentPrompt(question, recentSteps);
      
      const response = await this.claude.chat(
        'You are a database exploration agent. Always respond with valid JSON.',
        prompt,
        { maxTokens: 1024, temperature: 0 }
      );

      let action: { thought: string; tool: string; parameters: Record<string, unknown> };
      try {
        // Find all JSON objects in the response and take the first valid one
        const jsonMatches = response.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
        if (!jsonMatches || jsonMatches.length === 0) {
          throw new Error('No JSON found in response');
        }
        
        // Try to parse the first JSON object that has the required fields
        let parsed = null;
        for (const match of jsonMatches) {
          try {
            const candidate = JSON.parse(match);
            if (candidate.thought && candidate.tool) {
              parsed = candidate;
              break;
            }
          } catch {
            continue;
          }
        }
        
        if (!parsed) {
          throw new Error('No valid action JSON found');
        }
        action = parsed;
      } catch (e) {
        console.error('Failed to parse agent response:', e, 'Response:', response.substring(0, 500));
        // Don't break - try to continue with a generic exploration step
        if (i < 3) {
          // Early in exploration, try listing tables
          steps.push({ thought: 'Parse error, retrying exploration', result: `Parse error: ${e}` });
          continue;
        }
        steps.push({ thought: 'Failed to parse action after multiple attempts', result: String(e) });
        break;
      }

      const step: AgentStep = {
        thought: action.thought,
        tool: action.tool,
        parameters: action.parameters,
      };

      if (action.tool === 'final_answer') {
        await onProgress?.('Preparing your answer...', i + 1, MAX_ITERATIONS);
        finalAnswer = action.parameters.answer as string;
        finalSql = action.parameters.sql_used as string || '';
        steps.push(step);
        break;
      }

      await onProgress?.(getProgressMessage(action.tool, i), i + 1, MAX_ITERATIONS);

      const result = await this.executeTool(action.tool, action.parameters || {});
      step.result = result;
      steps.push(step);

      console.log(`Agent step ${i + 1}: ${action.tool} -> ${result.substring(0, 100)}...`);
    }

    if (!finalAnswer) {
      // Get any query results we found
      const queryResults = steps
        .filter(s => s.tool === 'run_query' && s.result && !s.result.includes('error'))
        .map(s => s.result)
        .join('\n\n');
      
      if (queryResults) {
        finalAnswer = 'Based on my database exploration, here is what I found:\n\n' +
          queryResults + '\n\n' +
          'Note: I reached my exploration limit. The data above should help answer your question.';
      } else {
        // Summarize what we learned without dumping everything
        const tablesExplored = steps
          .filter(s => s.tool === 'describe_table')
          .map(s => s.parameters?.table_name)
          .filter(Boolean);
        
        const lastThought = steps
          .filter(s => s.thought && s.thought !== 'Failed to parse action')
          .slice(-1)[0]?.thought || '';
        
        if (tablesExplored.length > 0) {
          finalAnswer = `I was exploring the database to answer your question. I examined the following tables: ${tablesExplored.join(', ')}.\n\n` +
            `However, I wasn't able to complete my analysis. ${lastThought ? `My last observation: ${lastThought}` : ''}\n\n` +
            'Please try asking your question again, or try being more specific about what you\'re looking for.';
        } else {
          finalAnswer = 'I started exploring the database but encountered an issue before I could complete my analysis.\n\n' +
            'Please try asking your question again. If the problem persists, try being more specific about which data you need.';
        }
      }
    }

    return { answer: finalAnswer, steps, finalSql };
  }
}
