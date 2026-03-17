import type { Env, QueryResult } from '../types';
import { ClaudeService } from './claude';

const MAX_ITERATIONS = 10;
const MAX_ROWS = 50;

interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

interface ToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}

interface AgentStep {
  thought: string;
  tool?: string;
  parameters?: Record<string, unknown>;
  result?: string;
}

const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'list_tables',
    description: 'Get a list of all tables in the database with their schemas',
    parameters: {}
  },
  {
    name: 'describe_table',
    description: 'Get detailed column information for a specific table',
    parameters: {
      table_name: { type: 'string', description: 'The table name (e.g., "kennel" or "dbo.kennel")', required: true }
    }
  },
  {
    name: 'sample_values',
    description: 'Get distinct sample values from a column to understand what data exists',
    parameters: {
      table_name: { type: 'string', description: 'The table name', required: true },
      column_name: { type: 'string', description: 'The column to sample', required: true },
      limit: { type: 'number', description: 'Max values to return (default 20)' }
    }
  },
  {
    name: 'run_query',
    description: 'Execute a SELECT query against the database',
    parameters: {
      sql: { type: 'string', description: 'The SQL SELECT query to run', required: true }
    }
  },
  {
    name: 'final_answer',
    description: 'Provide the final answer to the user after gathering enough information',
    parameters: {
      answer: { type: 'string', description: 'The complete answer with insights and context', required: true },
      sql_used: { type: 'string', description: 'The main SQL query that produced the answer' }
    }
  }
];

export class AgentSqlService {
  private env: Env;
  private claude: ClaudeService;

  constructor(env: Env) {
    this.env = env;
    this.claude = new ClaudeService(env.ANTHROPIC_API_KEY);
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

  private async listTables(): Promise<string> {
    try {
      console.log('Agent: Fetching tables from:', `${this.env.AZURE_FUNCTION_URL}/api/schema?database=Animal`);
      
      const response = await fetch(
        `${this.env.AZURE_FUNCTION_URL}/api/schema?database=Animal`,
        { headers: { 'x-api-key': this.env.AZURE_FUNCTION_KEY } }
      );
      
      if (!response.ok) {
        console.error('Agent: Schema fetch failed:', response.status, response.statusText);
        return `Error fetching schema: HTTP ${response.status}`;
      }
      
      const data = await response.json();
      console.log('Agent: Schema response has tables:', !!data.tables, 'count:', data.tables?.length);
      
      if (!data.tables || data.tables.length === 0) {
        return 'No tables found in database. The database may be empty or there was a connection issue.';
      }
      
      const tableList = data.tables.map((t: any) => 
        `[${t.schema}].[${t.name}] - ${t.columns?.length || 0} columns`
      ).join('\n');
      
      return `Tables in database:\n${tableList}`;
    } catch (e) {
      console.error('Agent: Error in listTables:', e);
      return `Error listing tables: ${e}`;
    }
  }

  private async describeTable(tableName: string): Promise<string> {
    try {
      const response = await fetch(
        `${this.env.AZURE_FUNCTION_URL}/api/schema?database=Animal`,
        { headers: { 'x-api-key': this.env.AZURE_FUNCTION_KEY } }
      );
      const data = await response.json();
      
      const searchName = tableName.toLowerCase().replace(/[\[\]]/g, '').replace('dbo.', '');
      const table = data.tables?.find((t: any) => 
        t.name.toLowerCase() === searchName || 
        `${t.schema}.${t.name}`.toLowerCase() === searchName
      );
      
      if (!table) return `Table "${tableName}" not found`;
      
      const columns = table.columns.map((c: any) => 
        `  - [${c.name}] (${c.type})${c.isPrimaryKey ? ' PRIMARY KEY' : ''}${!c.nullable ? ' NOT NULL' : ''}`
      ).join('\n');
      
      return `Table [${table.schema}].[${table.name}]:\n${columns}`;
    } catch (e) {
      return `Error describing table: ${e}`;
    }
  }

  private async sampleValues(tableName: string, columnName: string, limit: number = 20): Promise<string> {
    try {
      const cleanTable = tableName.replace(/[\[\]]/g, '');
      const schema = cleanTable.includes('.') ? cleanTable.split('.')[0] : 'dbo';
      const name = cleanTable.includes('.') ? cleanTable.split('.')[1] : cleanTable;
      
      const sql = `SELECT TOP ${limit} DISTINCT [${columnName}] as val FROM [${schema}].[${name}] WHERE [${columnName}] IS NOT NULL ORDER BY [${columnName}]`;
      
      const result = await this.callAzureFunction('query', { database: 'Animal', query: sql });
      
      if (result.error) return `Error: ${result.error}`;
      if (!result.rows?.length) return `No values found in ${tableName}.${columnName}`;
      
      const values = result.rows.map((r: any) => r.val).join(', ');
      return `Distinct values in [${columnName}]: ${values}`;
    } catch (e) {
      return `Error sampling values: ${e}`;
    }
  }

  private async runQuery(sql: string): Promise<string> {
    try {
      // Ensure SELECT only
      if (!sql.trim().toUpperCase().startsWith('SELECT')) {
        return 'Error: Only SELECT queries are allowed';
      }
      
      // Add TOP if missing
      if (!sql.toUpperCase().includes('TOP ')) {
        sql = sql.replace(/^SELECT\s+/i, `SELECT TOP ${MAX_ROWS} `);
      }
      
      const result = await this.callAzureFunction('query', { database: 'Animal', query: sql });
      
      if (result.error) return `Query error: ${result.error}`;
      
      if (!result.rows?.length) {
        return `Query returned 0 rows.\nSQL: ${sql}`;
      }
      
      // Format results
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
      case 'list_tables':
        return this.listTables();
      case 'describe_table':
        return this.describeTable(params.table_name as string);
      case 'sample_values':
        return this.sampleValues(
          params.table_name as string, 
          params.column_name as string,
          (params.limit as number) || 20
        );
      case 'run_query':
        return this.runQuery(params.sql as string);
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

    return `You are a data analyst agent with access to a SQL database. Your job is to answer questions by exploring the database.

AVAILABLE TOOLS:
${toolDescriptions}

IMPORTANT GUIDELINES:
- Start by exploring: list_tables, then describe_table for relevant tables
- Use sample_values to understand what data exists in key columns (especially status/type columns)
- Only run_query when you understand the schema and data values
- Think step by step - each exploration helps you understand the data better
- When you have enough information, use final_answer to respond

USER QUESTION: ${question}

${stepHistory ? 'PREVIOUS STEPS:\n' + stepHistory + '\n\n' : ''}
Now decide your next action. Respond in this exact JSON format:
{
  "thought": "Your reasoning about what to do next",
  "tool": "tool_name",
  "parameters": { ... }
}

If you have enough information, use the final_answer tool.`;
  }

  async queryWithAgent(question: string): Promise<{ answer: string; steps: AgentStep[]; finalSql?: string }> {
    const steps: AgentStep[] = [];
    let finalAnswer = '';
    let finalSql = '';

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const prompt = this.buildAgentPrompt(question, steps);
      
      const response = await this.claude.chat(
        'You are a database exploration agent. Always respond with valid JSON.',
        prompt,
        { maxTokens: 1024, temperature: 0 }
      );

      // Parse the JSON response
      let action: { thought: string; tool: string; parameters: Record<string, unknown> };
      try {
        // Extract JSON from response (handle markdown code blocks)
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

      // Check if this is the final answer
      if (action.tool === 'final_answer') {
        finalAnswer = action.parameters.answer as string;
        finalSql = action.parameters.sql_used as string || '';
        steps.push(step);
        break;
      }

      // Execute the tool
      const result = await this.executeTool(action.tool, action.parameters || {});
      step.result = result;
      steps.push(step);

      console.log(`Agent step ${i + 1}: ${action.tool} -> ${result.substring(0, 100)}...`);
    }

    // If we hit max iterations without final_answer, generate one
    if (!finalAnswer) {
      finalAnswer = 'I explored the database but could not determine a complete answer. Here is what I found:\n\n' +
        steps.map(s => s.result).filter(Boolean).join('\n\n');
    }

    return { answer: finalAnswer, steps, finalSql };
  }
}
