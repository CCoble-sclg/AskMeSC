import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Env, ChatRequest, ChatResponse, Source, QueryType } from '../types';
import { RagService } from '../services/rag';
import { SqlService } from '../services/sql';
import { AgentSqlService, type ProgressCallback } from '../services/agent-sql';
import { SchemaService } from '../services/schema';
import { RateLimitError } from '../services/claude';

export const chatRoutes = new Hono<{ Bindings: Env }>();

const DOCUMENT_KEYWORDS = [
  'policy', 'policies', 'contract', 'contracts', 'document', 'documents',
  'agreement', 'handbook', 'manual', 'guideline', 'procedure', 'rule',
  'regulation', 'bylaw', 'ordinance', 'resolution', 'file', 'pdf'
];

const SQL_KEYWORDS = [
  'how many', 'count', 'total', 'sum', 'average', 'list', 'show me',
  'find', 'search for', 'what are', 'who', 'which', 'when', 'where',
  'invoices', 'payments', 'vendors', 'employees', 'records', 'transactions',
  'amount', 'date', 'between', 'greater than', 'less than', 'over', 'under',
  'animal', 'animals', 'dog', 'dogs', 'cat', 'cats', 'pet', 'pets',
  'license', 'licenses', 'owner', 'owners', 'breed', 'breeds',
  'bite', 'bites', 'violation', 'violations', 'kennel', 'shelter',
  'database', 'db', 'table', 'tables', 'data'
];

// Keywords that indicate Logos ERP database (HR, Finance, Utility Billing)
const LOGOS_KEYWORDS = [
  // HR
  'employee', 'employees', 'staff', 'payroll', 'salary', 'salaries', 'wage', 'wages',
  'hire', 'hired', 'hiring', 'termination', 'terminated', 'department', 'departments',
  'position', 'positions', 'job', 'jobs', 'benefits', 'leave', 'vacation', 'sick',
  'overtime', 'hours worked', 'timesheet', 'hr', 'human resources',
  // Finance
  'invoice', 'invoices', 'payment', 'payments', 'vendor', 'vendors', 'purchase',
  'purchases', 'purchase order', 'po', 'budget', 'budgets', 'expense', 'expenses',
  'revenue', 'fund', 'funds', 'account', 'accounts', 'gl', 'general ledger',
  'accounts payable', 'accounts receivable', 'ap', 'ar', 'check', 'checks',
  'fiscal', 'appropriation', 'encumbrance', 'expenditure', 'expenditures',
  // Utility Billing
  'utility', 'utilities', 'water', 'sewer', 'garbage', 'trash', 'bill', 'bills',
  'billing', 'meter', 'meters', 'reading', 'readings', 'usage', 'consumption',
  'customer', 'customers', 'service address', 'account balance', 'delinquent',
  'disconnect', 'reconnect', 'deposit', 'rate', 'rates'
];

// Keywords that indicate Animal database
const ANIMAL_KEYWORDS = [
  'animal', 'animals', 'dog', 'dogs', 'cat', 'cats', 'pet', 'pets',
  'kennel', 'shelter', 'adoption', 'adoptions', 'adopted', 'stray', 'strays',
  'euthanasia', 'euthanized', 'intake', 'intakes', 'outcome', 'outcomes',
  'breed', 'breeds', 'spay', 'neuter', 'vaccination', 'rabies',
  'bite', 'bites', 'violation', 'violations', 'animal control',
  'license', 'licenses', 'tag', 'tags', 'microchip'
];

// Determine which database to query based on the question
function determineDatabase(question: string, previousDatabase?: string): string {
  const lowerQuestion = question.toLowerCase();
  
  // If we have context from a previous query, stay on that database for follow-ups
  if (previousDatabase && (
    lowerQuestion.startsWith('yes') ||
    lowerQuestion.startsWith('show') ||
    lowerQuestion.startsWith('break') ||
    lowerQuestion.length < 20
  )) {
    return previousDatabase;
  }
  
  let logosScore = 0;
  let animalScore = 0;
  
  for (const keyword of LOGOS_KEYWORDS) {
    if (lowerQuestion.includes(keyword)) {
      logosScore += keyword.includes(' ') ? 3 : 1; // Multi-word matches score higher
    }
  }
  
  for (const keyword of ANIMAL_KEYWORDS) {
    if (lowerQuestion.includes(keyword)) {
      animalScore += keyword.includes(' ') ? 3 : 1;
    }
  }
  
  console.log(`Database routing: Logos=${logosScore}, Animal=${animalScore}`);
  
  // Default to Animal if no clear winner (existing behavior)
  return logosScore > animalScore ? 'Logos' : 'Animal';
}

function determineQueryType(question: string, hasPreviousSql: boolean): { type: QueryType; confidence: number } {
  const lowerQuestion = question.toLowerCase();
  
  // If we have previous SQL context, stay on the SQL path
  if (hasPreviousSql) {
    return { type: 'sql', confidence: 0.9 };
  }
  
  let documentScore = 0;
  let sqlScore = 0;
  
  for (const keyword of DOCUMENT_KEYWORDS) {
    if (lowerQuestion.includes(keyword)) {
      documentScore += 2;
    }
  }
  
  for (const keyword of SQL_KEYWORDS) {
    if (lowerQuestion.includes(keyword)) {
      sqlScore += 1;
    }
  }
  
  if (lowerQuestion.includes('?') && (
    lowerQuestion.startsWith('what does') ||
    lowerQuestion.startsWith('what is our') ||
    lowerQuestion.startsWith('explain')
  )) {
    documentScore += 3;
  }
  
  if (/\d+/.test(question) || 
      lowerQuestion.includes('$') ||
      lowerQuestion.includes('between') ||
      lowerQuestion.includes('from') && lowerQuestion.includes('to')) {
    sqlScore += 2;
  }
  
  const total = documentScore + sqlScore;
  if (total === 0) {
    return { type: 'sql', confidence: 0.5 };
  }
  
  if (documentScore > sqlScore) {
    return { type: 'document', confidence: documentScore / total };
  }
  
  return { type: 'sql', confidence: sqlScore / total };
}

chatRoutes.post('/', async (c) => {
  const body = await c.req.json<ChatRequest>();
  
  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'Message is required' }, 400);
  }

  const message = body.message.trim();
  if (message.length === 0) {
    return c.json({ error: 'Message cannot be empty' }, 400);
  }

  if (message.length > 2000) {
    return c.json({ error: 'Message too long (max 2000 characters)' }, 400);
  }

  const conversationId = body.conversationId || crypto.randomUUID();
  const previousSql = body.previousSql;
  const previousQuestion = body.previousQuestion;
  const previousResponse = body.previousResponse;
  const previousDatabase = body.previousDatabase;
  
  try {
    const { type: queryType, confidence } = determineQueryType(message, !!previousSql);
    
    // Determine which database to query
    const targetDatabase = body.filters?.database || determineDatabase(message, previousDatabase);
    
    console.log(`Query type: ${queryType} (confidence: ${confidence.toFixed(2)}), database: ${targetDatabase}, hasPreviousSql: ${!!previousSql}, previousQuestion: ${previousQuestion?.substring(0, 50) || 'none'}, conversationId: ${conversationId}`);
    
    if (queryType === 'sql' && c.env.AZURE_FUNCTION_URL) {
      console.log(`Attempting Azure SQL query path via Function proxy to ${targetDatabase} database...`);

      // Use agent mode for new queries (no previous context) or when explicitly requested
      const useAgentMode = body.useAgent !== false && !previousSql;
      
      if (useAgentMode) {
        console.log(`Using AGENT mode for multi-step query exploration on ${targetDatabase}...`);
        const agentService = new AgentSqlService(c.env);
        
        try {
          const { answer, steps, finalSql } = await agentService.queryWithAgent(message, targetDatabase);
          
          console.log(`Agent completed with ${steps.length} steps`);
          
          // Build source info from agent steps
          const sources: Source[] = [{
            table: 'Agent Analysis',
            id: 'agent',
            snippet: finalSql || `Explored ${targetDatabase} database in ${steps.length} steps`,
            score: confidence,
          }];
          
          const chatResponse: ChatResponse = {
            response: answer,
            sources,
            conversationId,
            lastSql: finalSql,
            lastQuestion: message,
            lastDatabase: targetDatabase,
          };
          
          return c.json(chatResponse);
        } catch (agentError) {
          if (agentError instanceof RateLimitError) throw agentError;
          console.warn('Agent mode failed, falling back to simple query:', agentError);
          // Fall through to simple query mode
        }
      }
      
      // Simple query mode (follow-ups or fallback)
      console.log(`Using SIMPLE mode for direct query on ${targetDatabase}...`);
      const sqlService = new SqlService(c.env);
      
      let result: Awaited<ReturnType<typeof sqlService.queryWithNaturalLanguage>>['result'];
      let generatedSql: string;
      let usedContext = false;
      
      if (previousSql) {
        try {
          console.log(`Using previous SQL for follow-up: ${previousSql.substring(0, 80)}...`);
          const queryResult = await sqlService.queryWithNaturalLanguage(
            message,
            targetDatabase,
            previousSql,
            previousQuestion,
            previousResponse
          );
          result = queryResult.result;
          generatedSql = queryResult.generatedSql;
          usedContext = true;
        } catch (followUpError) {
          if (followUpError instanceof RateLimitError) throw followUpError;
          console.warn('Follow-up query with context failed, retrying with question context only:', followUpError);
          try {
            const retryQuestion = previousQuestion
              ? `Based on the previous question "${previousQuestion}": ${message}`
              : message;
            const queryResult = await sqlService.queryWithNaturalLanguage(
              retryQuestion,
              targetDatabase
            );
            result = queryResult.result;
            generatedSql = queryResult.generatedSql;
          } catch (retryError) {
            if (retryError instanceof RateLimitError) throw retryError;
            console.error('Retry also failed, falling back to standalone query:', retryError);
            const queryResult = await sqlService.queryWithNaturalLanguage(
              message,
              targetDatabase
            );
            result = queryResult.result;
            generatedSql = queryResult.generatedSql;
          }
        }
      } else {
        const queryResult = await sqlService.queryWithNaturalLanguage(
          message,
          targetDatabase
        );
        result = queryResult.result;
        generatedSql = queryResult.generatedSql;
      }
      console.log(`SQL generated (usedContext=${usedContext}): ${generatedSql}`);
      console.log(`Query returned ${result.rowCount} rows`);
      
      const { text } = await sqlService.generateResponse(message, result, generatedSql, previousQuestion);
      
      const chatResponse: ChatResponse = {
        response: text,
        sources: [{
          table: 'SQL Query',
          id: 'generated',
          snippet: generatedSql,
          score: confidence,
        }],
        conversationId,
        lastSql: generatedSql,
        lastQuestion: message,
        lastDatabase: targetDatabase,
      };
      
      return c.json(chatResponse);
    }
    
    // Document search path
    console.log(`Using document search: queryType=${queryType}, hasAzureFunction=${!!c.env.AZURE_FUNCTION_URL}`);

    const rag = new RagService(c.env);
    const { response, sources } = await rag.query(message);

    const result: ChatResponse = {
      response,
      sources,
      conversationId,
      lastQuestion: message,
    };

    return c.json(result);
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.warn('Rate limit hit, trying Workers AI fallback...');
      
      // Try Workers AI as fallback for SQL generation and execution
      try {
        const lowerMessage = message.toLowerCase();
        let sql = '';
        let queryResult: { rows: any[]; rowCount: number } | null = null;
        
        // Try to detect common kennel queries and run them directly
        if ((lowerMessage.includes('animal') || lowerMessage.includes('kennel')) && 
            (lowerMessage.includes('how many') || lowerMessage.includes('count'))) {
          
          if (lowerMessage.includes('current') || !lowerMessage.includes('total')) {
            // Animals currently in kennel = no outcome + physically at shelter
            sql = "SELECT COUNT(*) as count FROM kennel WHERE outcome_date IS NULL AND location = 'SHELTER'";
          } else {
            sql = 'SELECT COUNT(*) as count FROM kennel';
          }
          
          // Execute the query
          const response = await fetch(`${c.env.AZURE_FUNCTION_URL}/api/query`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': c.env.AZURE_FUNCTION_KEY,
            },
            body: JSON.stringify({ database: 'Animal', query: sql }),
          });
          
          if (response.ok) {
            queryResult = await response.json();
          }
        }
        
        // Use Workers AI to format the response
        const contextInfo = queryResult 
          ? `Query executed: ${sql}\nResult: ${JSON.stringify(queryResult.rows)}`
          : 'No query was executed.';
        
        const aiResponse = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            {
              role: 'system',
              content: `You are a helpful assistant for an animal shelter. Answer the user's question based on the data provided. Be concise.
              
${contextInfo}`
            },
            { role: 'user', content: message }
          ],
          max_tokens: 256,
        });
        
        const fallbackResponse = typeof aiResponse === 'object' && 'response' in aiResponse 
          ? String(aiResponse.response) 
          : queryResult 
            ? `Based on the database query, the count is: ${queryResult.rows[0]?.count || 0}`
            : 'I apologize, but I could not process your request at this time.';
        
        return c.json({
          response: fallbackResponse + '\n\n*(Using simplified AI due to high demand)*',
          sources: sql ? [{ table: 'kennel', id: 'fallback', snippet: sql, score: 0.8 }] : [],
          conversationId,
        });
      } catch (fallbackError) {
        console.error('Workers AI fallback also failed:', fallbackError);
        return c.json({ 
          error: 'I\'m processing too many requests right now. Please wait about 30 seconds and try again.' 
        }, 429);
      }
    }
    console.error('Chat error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ 
      error: `Failed to process your question: ${errorMessage}` 
    }, 500);
  }
});

// Streaming endpoint for real-time responses with progress updates
chatRoutes.post('/stream', async (c) => {
  const body = await c.req.json<ChatRequest>();
  
  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'Message is required' }, 400);
  }

  const message = body.message.trim();
  const conversationId = body.conversationId || crypto.randomUUID();
  const previousDatabase = body.previousDatabase;

  // Determine database for routing
  const targetDatabase = body.filters?.database || determineDatabase(message, previousDatabase);

  return streamSSE(c, async (stream) => {
    try {
      const agentService = new AgentSqlService(c.env);
      
      // Progress callback that sends SSE events
      const onProgress: ProgressCallback = async (progressMessage, step, total) => {
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ message: progressMessage, step, total }),
        });
      };

      const { answer, steps, finalSql } = await agentService.queryWithAgent(
        message,
        targetDatabase,
        onProgress
      );

      // Send the final response
      const response: ChatResponse = {
        response: answer,
        sources: [{
          table: 'Agent Analysis',
          id: 'agent',
          snippet: finalSql || `Explored ${targetDatabase} database in ${steps.length} steps`,
          score: 0.9,
        }],
        conversationId,
        lastSql: finalSql,
        lastQuestion: message,
        lastDatabase: targetDatabase,
      };

      await stream.writeSSE({
        event: 'complete',
        data: JSON.stringify(response),
      });
    } catch (error) {
      console.error('Stream error:', error);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: error instanceof Error ? error.message : 'Streaming failed' }),
      });
    }
  });
});
