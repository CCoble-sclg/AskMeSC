import { Hono } from 'hono';
import type { Env, ChatRequest, ChatResponse, Source, QueryType } from '../types';
import { RagService } from '../services/rag';
import { SqlService } from '../services/sql';
import { SchemaService } from '../services/schema';

export const chatRoutes = new Hono<{ Bindings: Env }>();

interface ConversationContext {
  lastQueryType: 'sql' | 'document';
  lastSql?: string;
  lastQuestion?: string;
  lastResultSummary?: string;
  timestamp: number;
}

const CONTEXT_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Store/retrieve context from D1 (persists across worker instances)
async function getConversationContext(db: D1Database, conversationId: string): Promise<ConversationContext | null> {
  try {
    const result = await db.prepare(
      `SELECT context_json, updated_at FROM conversation_context WHERE conversation_id = ?`
    ).bind(conversationId).first();
    
    if (!result) return null;
    
    const context = JSON.parse(result.context_json as string) as ConversationContext;
    const updatedAt = new Date(result.updated_at as string).getTime();
    
    // Check if expired
    if (Date.now() - updatedAt > CONTEXT_EXPIRY_MS) {
      return null;
    }
    
    return context;
  } catch (e) {
    console.error('Error getting context:', e);
    return null;
  }
}

async function saveConversationContext(db: D1Database, conversationId: string, context: ConversationContext): Promise<void> {
  try {
    await db.prepare(
      `INSERT OR REPLACE INTO conversation_context (conversation_id, context_json, updated_at) 
       VALUES (?, ?, datetime('now'))`
    ).bind(conversationId, JSON.stringify(context)).run();
  } catch (e) {
    console.error('Error saving context:', e);
  }
}

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

const FOLLOWUP_INDICATORS = [
  'that', 'this', 'those', 'these', 'it', 'they', 'the count', 'the number',
  'break it down', 'break that down', 'more detail', 'why', 'explain',
  'too high', 'too low', 'wrong', 'incorrect', 'not right',
  'by week', 'by month', 'by day', 'by type', 'by category',
  'filter', 'only', 'exclude', 'just the', 'instead'
];

function isFollowUpQuestion(question: string, context: ConversationContext | undefined): boolean {
  if (!context || Date.now() - context.timestamp > CONTEXT_EXPIRY_MS) {
    return false;
  }
  
  const lowerQuestion = question.toLowerCase();
  
  // Short questions are often follow-ups
  if (question.split(' ').length <= 6) {
    for (const indicator of FOLLOWUP_INDICATORS) {
      if (lowerQuestion.includes(indicator)) {
        return true;
      }
    }
  }
  
  // Starts with follow-up words
  if (/^(but|and|also|what about|can you|could you|why|how about)/i.test(lowerQuestion)) {
    return true;
  }
  
  return false;
}

function determineQueryType(question: string, context?: ConversationContext): { type: QueryType; confidence: number } {
  const lowerQuestion = question.toLowerCase();
  
  // If this is a follow-up to a SQL query, keep it as SQL
  if (context?.lastQueryType === 'sql' && isFollowUpQuestion(question, context)) {
    console.log('Detected follow-up to SQL query, maintaining SQL path');
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
  
  try {
    // Get previous conversation context from D1 (non-critical, failures are ignored)
    let previousContext: ConversationContext | null = null;
    try {
      previousContext = await getConversationContext(c.env.DB, conversationId);
    } catch (e) {
      console.error('Non-critical: failed to get conversation context:', e);
    }

    const { type: queryType, confidence } = determineQueryType(message, previousContext ?? undefined);
    console.log(`Query type: ${queryType} (confidence: ${confidence.toFixed(2)}), hasContext: ${!!previousContext}, conversationId: ${conversationId}`);
    
    if (queryType === 'sql' && c.env.AZURE_FUNCTION_URL) {
      console.log('Attempting Azure SQL query path via Function proxy...');

      const sqlService = new SqlService(c.env);
      console.log('SqlService created, calling queryWithNaturalLanguage...');
      
      // Build context string for follow-up questions
      let contextualMessage = message;
      if (previousContext && isFollowUpQuestion(message, previousContext)) {
        contextualMessage = `Previous question: "${previousContext.lastQuestion}"
Previous SQL: ${previousContext.lastSql}
Previous result summary: ${previousContext.lastResultSummary}

Follow-up question: ${message}`;
        console.log('Using conversation context for follow-up question');
      }
      
      const { result, generatedSql } = await sqlService.queryWithNaturalLanguage(
        contextualMessage,
        body.filters?.database
      );
      console.log(`SQL generated: ${generatedSql}`);
      console.log(`Query returned ${result.rowCount} rows`);
      
      const { text } = await sqlService.generateResponse(message, result, generatedSql);
      
      // Save context for follow-up questions (non-critical)
      try {
        const resultSummary = result.rowCount === 1 
          ? JSON.stringify(result.rows[0])
          : `${result.rowCount} rows returned`;
        
        await saveConversationContext(c.env.DB, conversationId, {
          lastQueryType: 'sql',
          lastSql: generatedSql,
          lastQuestion: message,
          lastResultSummary: resultSummary,
          timestamp: Date.now(),
        });
      } catch (e) {
        console.error('Non-critical: failed to save conversation context:', e);
      }
      
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
    }
    
    // Document search path
    console.log(`Using document search: queryType=${queryType}, hasAzureFunction=${!!c.env.AZURE_FUNCTION_URL}`);

    const rag = new RagService(c.env);
    const { response, sources } = await rag.query(message);

    // Save context (non-critical)
    try {
      await saveConversationContext(c.env.DB, conversationId, {
        lastQueryType: 'document',
        lastQuestion: message,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('Non-critical: failed to save conversation context:', e);
    }

    const result: ChatResponse = {
      response,
      sources,
      conversationId,
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
