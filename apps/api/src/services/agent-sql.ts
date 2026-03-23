import type { Env } from '../types';
import { ClaudeService } from './claude';
import { SchemaCache } from './schema-cache';

const MAX_ITERATIONS = 30;
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

  private async callAzureFunction(endpoint: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${this.env.AZURE_FUNCTION_URL}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.env.AZURE_FUNCTION_KEY,
      },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  private async listDatabases(): Promise<string> {
    // Return known databases - these are configured in the Azure Function
    const databases = ['Animal', 'Logos'];
    return `Available databases:\n- Animal: Animal shelter/control records\n- Logos: County ERP system (HR, Finance, Utility Billing)`;
  }

  private async listTables(database: string): Promise<string> {
    // Check cache first
    const cachedTables = await this.cache.getDatabaseTables(database);
    if (cachedTables && cachedTables.length > 0) {
      console.log(`Cache hit: ${database} tables (${cachedTables.length} tables)`);
      return `Tables in ${database} database (from cache):\n${cachedTables.join('\n')}`;
    }

    // Fetch from Azure Function
    try {
      console.log(`Cache miss: Fetching ${database} tables from Azure Function...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      const response = await fetch(
        `${this.env.AZURE_FUNCTION_URL}/api/schema?database=${database}`,
        { 
          headers: { 'x-api-key': this.env.AZURE_FUNCTION_KEY },
          signal: controller.signal
        }
      );
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        return `Error fetching tables: HTTP ${response.status}`;
      }
      
      const data = await response.json();
      
      if (!data.tables || data.tables.length === 0) {
        return `No tables found in ${database} database`;
      }
      
      const tableList = data.tables.map((t: any) => 
        `[${t.schema}].[${t.name}]`
      );
      
      // Save to cache
      await this.cache.setDatabaseTables(database, tableList);
      
      return `Tables in ${database} database:\n${tableList.join('\n')}`;
    } catch (e) {
      console.error('Error listing tables:', e);
      return `Error listing tables: ${e}`;
    }
  }

  private async describeTable(database: string, tableName: string): Promise<string> {
    const cleanTable = tableName.replace(/[\[\]]/g, '');
    const schema = cleanTable.includes('.') ? cleanTable.split('.')[0] : 'dbo';
    const name = cleanTable.includes('.') ? cleanTable.split('.')[1] : cleanTable;
    
    // Check cache first
    const cachedSchema = await this.cache.getTableSchema(database, schema, name);
    if (cachedSchema) {
      console.log(`Cache hit: ${database}.${schema}.${name} schema`);
      const columns = cachedSchema.columns.map(c => `  - [${c.name}] (${c.type})`).join('\n');
      return `Table [${schema}].[${name}] in ${database} (from cache):\n${columns}`;
    }

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
    
    // Check cache first
    const cachedValues = await this.cache.getSampleValues(database, schema, name, columnName);
    if (cachedValues) {
      console.log(`Cache hit: ${database}.${schema}.${name}.${columnName} samples`);
      return `Sample values for [${columnName}] in [${schema}].[${name}] (from cache):\n${cachedValues.join(', ')}`;
    }

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
      if (!sql.trim().toUpperCase().startsWith('SELECT')) {
        return 'Error: Only SELECT queries are allowed';
      }
      
      if (!sql.toUpperCase().includes('TOP ')) {
        sql = sql.replace(/^SELECT\s+/i, `SELECT TOP ${MAX_ROWS} `);
      }
      
      const result = await this.callAzureFunction('query', { database, query: sql });
      
      if (result.error) return `Query error: ${result.error}`;
      
      if (!result.rows?.length) {
        return `Query returned 0 rows.\nSQL: ${sql}`;
      }
      
      const columns = Object.keys(result.rows[0]);
      const rows = result.rows.slice(0, 20).map((r: any) => 
        columns.map(c => `${c}: ${r[c]}`).join(', ')
      ).join('\n');
      
      return `Query returned ${result.rowCount} rows:\n${rows}${result.rowCount > 20 ? `\n... and ${result.rowCount - 20} more` : ''}\n\nSQL: ${sql}`;
    } catch (e) {
      return `Query execution error: ${e}`;
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
    
    return `You are a data analyst with access to SQL databases. Answer questions by exploring the database structure and querying data.

CURRENT DATE: ${today} (Year: ${currentYear})
When users mention "this year", "since January", etc., use ${currentYear}.

AVAILABLE TOOLS:
${toolDescriptions}

HOW TO EXPLORE (like a data analyst would):
1. If you don't know which database to use, call list_databases first
2. Call list_tables to see what tables exist in a database
3. Call describe_table to see columns in a table
4. Call sample_values to understand what values exist in important columns (like status codes, types, categories)
5. Once you understand the data, call run_query with a SQL query
6. When you have the answer, call final_answer

TIPS:
- Explore incrementally - don't guess column names, look them up first
- Sample values help you understand codes and categories (e.g., what does "EUTH" mean in outcome_type?)
- If a query returns unexpected results, investigate further before answering
- For counts, consider if there are status/location columns that might filter active vs inactive records
- The cache will remember what you discover, so future queries will be faster
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
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
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
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found');
        action = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.error('Failed to parse agent response:', response);
        steps.push({ thought: 'Failed to parse action', result: response });
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
      const queryResults = steps
        .filter(s => s.tool === 'run_query' && s.result && !s.result.includes('error'))
        .map(s => s.result)
        .join('\n');
      
      if (queryResults) {
        finalAnswer = 'Based on my database exploration, here is what I found:\n\n' +
          queryResults + '\n\n' +
          'Note: I reached my exploration limit. The data above should help answer your question.';
      } else {
        finalAnswer = 'I explored the database but could not determine a complete answer. Here is what I found:\n\n' +
          steps.map(s => s.result).filter(Boolean).join('\n\n');
      }
    }

    return { answer: finalAnswer, steps, finalSql };
  }
}
