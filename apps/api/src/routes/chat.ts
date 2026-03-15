import { Hono } from 'hono';
import type { Env, ChatRequest, ChatResponse, Source, QueryType } from '../types';
import { RagService } from '../services/rag';
import { SqlService } from '../services/sql';
import { SchemaService } from '../services/schema';

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
  
  try {
    const { type: queryType, confidence } = determineQueryType(message, !!previousSql);
    console.log(`Query type: ${queryType} (confidence: ${confidence.toFixed(2)}), hasPreviousSql: ${!!previousSql}, previousQuestion: ${previousQuestion?.substring(0, 50) || 'none'}, conversationId: ${conversationId}`);
    
    if (queryType === 'sql' && c.env.AZURE_FUNCTION_URL) {
      console.log('Attempting Azure SQL query path via Function proxy...');

      const sqlService = new SqlService(c.env);
      
      let result: Awaited<ReturnType<typeof sqlService.queryWithNaturalLanguage>>['result'];
      let generatedSql: string;
      let usedContext = false;
      
      if (previousSql) {
        try {
          console.log(`Using previous SQL for follow-up: ${previousSql.substring(0, 80)}...`);
          const queryResult = await sqlService.queryWithNaturalLanguage(
            message,
            body.filters?.database,
            previousSql,
            previousQuestion
          );
          result = queryResult.result;
          generatedSql = queryResult.generatedSql;
          usedContext = true;
        } catch (followUpError) {
          console.warn('Follow-up query with context failed, retrying with question context only:', followUpError);
          try {
            const retryQuestion = previousQuestion
              ? `Based on the previous question "${previousQuestion}": ${message}`
              : message;
            const queryResult = await sqlService.queryWithNaturalLanguage(
              retryQuestion,
              body.filters?.database
            );
            result = queryResult.result;
            generatedSql = queryResult.generatedSql;
          } catch (retryError) {
            console.error('Retry also failed, falling back to standalone query:', retryError);
            const queryResult = await sqlService.queryWithNaturalLanguage(
              message,
              body.filters?.database
            );
            result = queryResult.result;
            generatedSql = queryResult.generatedSql;
          }
        }
      } else {
        const queryResult = await sqlService.queryWithNaturalLanguage(
          message,
          body.filters?.database
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
    console.error('Chat error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ 
      error: `Failed to process your question: ${errorMessage}` 
    }, 500);
  }
});

// Streaming endpoint for real-time responses
chatRoutes.post('/stream', async (c) => {
  const body = await c.req.json<ChatRequest>();
  
  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'Message is required' }, 400);
  }

  const rag = new RagService(c.env);

  try {
    const stream = await rag.queryStream(body.message);
    
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Stream error:', error);
    return c.json({ error: 'Streaming failed' }, 500);
  }
});
