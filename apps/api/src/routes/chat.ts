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
  'amount', 'date', 'between', 'greater than', 'less than', 'over', 'under'
];

function determineQueryType(question: string): { type: QueryType; confidence: number } {
  const lowerQuestion = question.toLowerCase();
  
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
  
  try {
    const { type: queryType, confidence } = determineQueryType(message);
    console.log(`Query type: ${queryType} (confidence: ${confidence.toFixed(2)})`);
    
    if (queryType === 'sql' && c.env.AZURE_FUNCTION_URL) {
      console.log('Attempting Azure SQL query path via Function proxy...');
      try {
        const sqlService = new SqlService(c.env);
        console.log('SqlService created, calling queryWithNaturalLanguage...');
        const { result, generatedSql } = await sqlService.queryWithNaturalLanguage(
          message,
          body.filters?.database
        );
        console.log(`SQL generated: ${generatedSql}`);
        console.log(`Query returned ${result.rowCount} rows`);
        
        const { text } = await sqlService.generateResponse(message, result, generatedSql);
        
        const chatResponse: ChatResponse = {
          response: text,
          sources: [{
            table: 'SQL Query',
            id: 'generated',
            snippet: generatedSql,
            score: confidence,
          }],
          conversationId,
        };
        
        return c.json(chatResponse);
      } catch (sqlError) {
        console.error('SQL query failed, falling back to document search:', sqlError);
        console.error('Error details:', String(sqlError));
      }
    } else {
      console.log(`Skipping SQL: queryType=${queryType}, hasAzureFunction=${!!c.env.AZURE_FUNCTION_URL}`);
    }
    
    const rag = new RagService(c.env);
    const { response, sources } = await rag.query(message);

    const result: ChatResponse = {
      response,
      sources,
      conversationId,
    };

    return c.json(result);
  } catch (error) {
    console.error('Chat error:', error);
    return c.json({ 
      error: 'Failed to process your question. Please try again.' 
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
