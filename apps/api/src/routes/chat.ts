import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Env, ChatRequest, ChatResponse, Source } from '../types';
import { AgentSqlService, type ProgressCallback } from '../services/agent-sql';
import { RateLimitError } from '../services/claude';
import { SchemaCache } from '../services/schema-cache';

export const chatRoutes = new Hono<{ Bindings: Env }>();

// Admin endpoint to clear schema cache
chatRoutes.post('/clear-cache', async (c) => {
  try {
    const cache = new SchemaCache(c.env);
    const body = await c.req.json<{ database?: string }>().catch(() => ({}));
    
    if (body.database) {
      await cache.clearDatabase(body.database);
      return c.json({ success: true, message: `Cleared cache for ${body.database} database` });
    } else {
      await cache.clearAll();
      return c.json({ success: true, message: 'Cleared all schema cache' });
    }
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// Main chat endpoint
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
    console.log('Using direct query mode...');
    const agentService = new AgentSqlService(c.env);
    
    const { answer, sql } = await agentService.queryDirect(
      message,
      undefined,
      body.previousQuestion ? {
        previousQuestion: body.previousQuestion,
        previousSql: body.previousSql,
        previousResponse: body.previousResponse,
      } : undefined
    );
    
    console.log('Direct query completed');
    
    const response: ChatResponse = {
      response: answer,
      sources: [{
        table: 'Direct Query',
        id: 'direct',
        snippet: sql,
        score: 0.9,
      }],
      conversationId,
      lastSql: sql,
      lastQuestion: message,
      lastResponse: answer,
    };
    
    return c.json(response);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return c.json({ 
        error: 'I\'m processing too many requests. Please wait about 30 seconds and try again.' 
      }, 429);
    }
    console.error('Chat error:', error);
    return c.json({ 
      error: `Failed to process your question: ${error instanceof Error ? error.message : String(error)}` 
    }, 500);
  }
});

// Streaming endpoint - always uses agent with progress updates
chatRoutes.post('/stream', async (c) => {
  const body = await c.req.json<ChatRequest>();
  
  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'Message is required' }, 400);
  }

  const message = body.message.trim();
  const conversationId = body.conversationId || crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    try {
      const agentService = new AgentSqlService(c.env);
      
      const onProgress: ProgressCallback = async (progressMessage, step, total) => {
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ message: progressMessage, step, total }),
        });
      };

      const { answer, sql } = await agentService.queryDirect(
        message,
        onProgress,
        body.previousQuestion ? {
          previousQuestion: body.previousQuestion,
          previousSql: body.previousSql,
          previousResponse: body.previousResponse,
        } : undefined
      );

      const response: ChatResponse = {
        response: answer,
        sources: [{
          table: 'Direct Query',
          id: 'direct',
          snippet: sql,
          score: 0.9,
        }],
        conversationId,
        lastSql: sql,
        lastQuestion: message,
        lastResponse: answer,
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
