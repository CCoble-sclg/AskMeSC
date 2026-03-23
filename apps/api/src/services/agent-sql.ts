import type { Env, QueryResult } from '../types';
import { ClaudeService } from './claude';

const MAX_ITERATIONS = 20;
const MAX_ROWS = 50;

// Safe, generic progress messages that don't expose database details
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
  private currentDatabase: string = 'Animal';

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
      console.log(`Agent: Fetching tables from schema endpoint for ${this.currentDatabase}...`);
      
      // Use AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
      
      const response = await fetch(
        `${this.env.AZURE_FUNCTION_URL}/api/schema?database=${this.currentDatabase}`,
        { 
          headers: { 'x-api-key': this.env.AZURE_FUNCTION_KEY },
          signal: controller.signal
        }
      );
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.error('Agent: Schema fetch failed:', response.status);
        return this.getStaticTableList();
      }
      
      const data = await response.json();
      console.log('Agent: Schema response has tables:', data.tables?.length);
      
      if (!data.tables || data.tables.length === 0) {
        return this.getStaticTableList();
      }
      
      const tableList = data.tables.map((t: any) => 
        `[${t.schema}].[${t.name}] - ${t.columns?.length || 0} columns`
      ).join('\n');
      
      return `Tables in ${this.currentDatabase} database:\n${tableList}`;
    } catch (e) {
      console.error('Agent: Error in listTables, using static fallback:', e);
      return this.getStaticTableList();
    }
  }

  private getStaticTableList(): string {
    if (this.currentDatabase === 'Logos') {
      return this.getLogosStaticTableList();
    }
    return this.getAnimalStaticTableList();
  }

  private getLogosStaticTableList(): string {
    return `Logos Database - Tyler Munis Government ERP

=== SCHEMA ORGANIZATION ===
| Schema | Purpose |
| dbo | Core financial, AP, AR, purchasing, assets, projects |
| HR | Human resources, payroll, benefits, employees |
| UT | Utility management extensions |
| FM | Financial management extensions |
| MCD | Mobile code enforcement, inspections |

=== GENERAL LEDGER (MOST IMPORTANT) ===

**dbo.GLAccount** - Chart of accounts
- GLAccountID (PK), GLAccountDelimitedFull (e.g., "110.3500 330.50")
- Note: Account format has SPACE: "110.3500 330.50" not "110.3500.330.50"

**dbo.JournalDetail** - ALL financial transactions (THE MAIN TABLE)
- GLAccountID, FiscalEndYear, Amount, Source, Description, GLDate

**CRITICAL: BUDGET vs EXPENSES (Source column)**
BUDGET sources (exclude from expense calcs):
- 'BudgetProcessing' - Original budget
- 'BA YYYY-##' - Budget amendments
- 'Budget' - Budget entries

EXPENSE sources (actual spending):
- 'Accounts Payable', 'Purchase Orders', 'JE-###', 'Payroll Post', etc.

**Budget vs Actual Query Pattern:**
SELECT 
  SUM(CASE WHEN Source = 'BudgetProcessing' THEN Amount ELSE 0 END) as Budget,
  SUM(CASE WHEN Source LIKE 'BA %' THEN Amount ELSE 0 END) as Amendments,
  SUM(CASE WHEN Source NOT IN ('BudgetProcessing') AND Source NOT LIKE 'BA %' AND Source NOT LIKE 'Budget%' THEN Amount ELSE 0 END) as Expenses
FROM dbo.JournalDetail WHERE GLAccountID = [id] AND FiscalEndYear = 2026

Remaining Balance = Budget + Amendments - Expenses

=== ACCOUNTS PAYABLE ===
- dbo.Vendor (VendorID, VendorNumber, CentralNameID, ActiveFlag)
- dbo.AccountsPayableInvoice (InvoiceID, VendorID, InvoiceNumber, InvoiceAmount, InvoiceDate)

=== PURCHASING ===
- dbo.PurchaseOrder (PurchaseOrderID, PONumber, VendorID, FiscalYear, ProcessStatus)
- dbo.PurchaseOrderDetail (line items)

=== HUMAN RESOURCES (HR schema) ===
- HR.Employee (EmployeeId, EmployeeNumber, RecordStatus)
- HR.EmployeeName (EmployeeId, FirstName, LastName, EffectiveEndDate)
- HR.EmployeeJob (EmployeeId, Title, RateAmount, DepartmentId, IsPrimaryJob, EffectiveEndDate)

**Active Employee Query:**
SELECT e.EmployeeNumber, en.FirstName, en.LastName, ej.Title
FROM HR.Employee e
JOIN HR.EmployeeName en ON e.EmployeeId = en.EmployeeId
JOIN HR.EmployeeJob ej ON e.EmployeeId = ej.EmployeeId
WHERE e.RecordStatus = 1 AND en.EffectiveEndDate IS NULL AND ej.EffectiveEndDate IS NULL AND ej.IsPrimaryJob = 1

=== UTILITY BILLING ===
- dbo.UtilityCustomerAccount, dbo.UtilityAccount
- dbo.UtilityTransactionHeader / UtilityTransactionDetail

=== OTHER KEY TABLES ===
- dbo.Permit - Building permits
- MCD.Inspection - Inspections
- dbo.Asset - Fixed assets
- dbo.Grants - Grant tracking
- dbo.Project - Project tracking
- dbo.Receipt - Cash receipts
- dbo.CentralName - Shared name/address table (LastName, FirstName, CentralNameID)

=== CRITICAL NOTES ===
1. ALWAYS filter by FiscalEndYear for balances
2. ALWAYS separate Budget from Expenses using Source
3. Check EffectiveEndDate IS NULL for current HR records
4. Check ActiveFlag for master records
5. Use CentralNameID to link names across modules`;
  }

  private getAnimalStaticTableList(): string {
    return `Tables in Animal database:

[dbo].[kennel] - Kennel records (animals that have been in the shelter)
[dbo].[animal] - Animal master records
[dbo].[person] - People (owners, contacts)
[dbo].[tag] - Pet licenses/tags
[dbo].[bite] - Bite incidents
[dbo].[violation] - Code violations
[dbo].[treatment] - Medical treatments
[dbo].[animal_evaluation] - Behavior evaluations

Other tables: animal_history, kennel_history, person_history, memo, receipt, todo, event, schedule

KNOWN CODES (verified from this database):
- outcome_type: 'EUTH' (euthanasia), 'ADOPTION', 'RTO' (return to owner), 'TRANSFER', 'DIED'
- intake_type: 'STRAY', 'OWNED' (owner surrender), 'RESCUE'
- location: 'SHELTER' (physical animals ~40-50), 'WEB' (web entries - exclude for physical counts)

KEY QUERY PATTERNS:
- Current animals: WHERE outcome_date IS NULL AND location = 'SHELTER'
- Euthanasia counts: WHERE outcome_type = 'EUTH'
- Adoptions: WHERE outcome_type = 'ADOPTION'

Still explore with describe_table and sample_values to discover additional patterns.`;
  }

  private async describeTable(tableName: string): Promise<string> {
    try {
      const cleanTable = tableName.replace(/[\[\]]/g, '');
      const name = cleanTable.includes('.') ? cleanTable.split('.')[1] : cleanTable;
      
      // Use SELECT TOP 0 to get column names without data - fast and reliable
      const sql = `SELECT TOP 0 * FROM [${name}]`;
      
      const result = await this.callAzureFunction('query', { database: this.currentDatabase, query: sql });
      
      if (result.error) {
        // Try fallback: get one row and infer columns
        const fallbackSql = `SELECT TOP 1 * FROM [${name}]`;
        const fallbackResult = await this.callAzureFunction('query', { database: this.currentDatabase, query: fallbackSql });
        
        if (fallbackResult.error || !fallbackResult.rows?.length) {
          return `Table [${name}] not found or query error: ${result.error || fallbackResult.error}`;
        }
        
        const columns = Object.keys(fallbackResult.rows[0]).map(col => `  - [${col}]`).join('\n');
        return `Table [dbo].[${name}]:\n${columns}`;
      }
      
      // For TOP 0, columns are in the metadata - but we need to get them differently
      // Let's just get 1 row and extract column names
      const sampleSql = `SELECT TOP 1 * FROM [${name}]`;
      const sampleResult = await this.callAzureFunction('query', { database: this.currentDatabase, query: sampleSql });
      
      if (!sampleResult.rows?.length) {
        return `Table [dbo].[${name}] exists but appears empty`;
      }
      
      const columns = Object.keys(sampleResult.rows[0]).map(col => `  - [${col}]`).join('\n');
      return `Table [dbo].[${name}]:\n${columns}`;
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
      
      const result = await this.callAzureFunction('query', { database: this.currentDatabase, query: sql });
      
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
      
      const result = await this.callAzureFunction('query', { database: this.currentDatabase, query: sql });
      
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

    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();
    
    // Database-specific context
    const databaseContext = this.currentDatabase === 'Logos' 
      ? `DATABASE: Logos (ERP System - contains HR, Finance, and Utility Billing data)
This is a business/financial database. Explore tables to discover the schema.`
      : `DATABASE: Animal (Animal Shelter/Control data)
Key tables: kennel, animal, person, tag, bite, violation, treatment
Known codes: outcome_type (EUTH, ADOPTION, RTO, TRANSFER, DIED), location (SHELTER, WEB)`;
    
    return `You are a data analyst agent with access to a SQL database. Your job is to answer questions by exploring the database.

CURRENT DATE: ${today} (Year: ${currentYear})
When users ask about "this year", "since January 1st", etc., use ${currentYear} as the year.

${databaseContext}

AVAILABLE TOOLS:
${toolDescriptions}

CRITICAL GUIDELINES - EXPLORE LIKE A DATA ANALYST:

1. UNDERSTAND THE TABLE STRUCTURE:
   - Use list_tables to see what's available
   - Use describe_table to see all columns in a table
   - Look for columns that might filter data: status, type, location, category columns

2. FOR COUNT QUESTIONS - ALWAYS CHECK THESE COLUMN TYPES:
   - 'location' columns - might distinguish physical vs virtual/web records
   - 'status' or 'stat' columns - might indicate active vs inactive
   - 'type' columns - might categorize records
   - Date columns - NULL might mean current/active
   
   RUN GROUP BY queries on these columns to see the distribution BEFORE giving a final count!

3. SANITY CHECK YOUR RESULTS:
   - If a count is unexpectedly large or small, investigate what's included
   - Group by relevant columns to see the breakdown

4. When confident in your understanding, use final_answer with a clear response

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

  async queryWithAgent(
    question: string, 
    database: string = 'Animal',
    onProgress?: ProgressCallback
  ): Promise<{ answer: string; steps: AgentStep[]; finalSql?: string }> {
    this.currentDatabase = database;
    console.log(`Agent starting exploration of ${database} database for question: ${question.substring(0, 50)}...`);
    
    const steps: AgentStep[] = [];
    let finalAnswer = '';
    let finalSql = '';

    // Send initial progress
    await onProgress?.('Understanding your question...', 0, MAX_ITERATIONS);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Add delay between iterations to avoid rate limiting
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Send thinking progress
      await onProgress?.(getProgressMessage('thinking', i), i + 1, MAX_ITERATIONS);
      
      // Only keep last 5 steps to reduce prompt size
      const recentSteps = steps.slice(-5);
      const prompt = this.buildAgentPrompt(question, recentSteps);
      
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
        await onProgress?.('Preparing your answer...', i + 1, MAX_ITERATIONS);
        finalAnswer = action.parameters.answer as string;
        finalSql = action.parameters.sql_used as string || '';
        steps.push(step);
        break;
      }

      // Send progress update for the tool being executed
      await onProgress?.(getProgressMessage(action.tool, i), i + 1, MAX_ITERATIONS);

      // Execute the tool
      const result = await this.executeTool(action.tool, action.parameters || {});
      step.result = result;
      steps.push(step);

      console.log(`Agent step ${i + 1}: ${action.tool} -> ${result.substring(0, 100)}...`);
    }

    // If we hit max iterations without final_answer, try to summarize what we found
    if (!finalAnswer) {
      // Look for query results that might contain the answer
      const queryResults = steps
        .filter(s => s.tool === 'run_query' && s.result && !s.result.includes('error'))
        .map(s => s.result)
        .join('\n');
      
      // If we have useful results, summarize them
      if (queryResults.includes('cnt:') || queryResults.includes('count')) {
        finalAnswer = 'Based on my database exploration, here is what I found:\n\n' +
          queryResults + '\n\n' +
          'Note: I reached my exploration limit before formulating a complete answer, but the data above should help answer your question.';
      } else {
        finalAnswer = 'I explored the database but could not determine a complete answer. Here is what I found:\n\n' +
          steps.map(s => s.result).filter(Boolean).join('\n\n');
      }
    }

    return { answer: finalAnswer, steps, finalSql };
  }
}
