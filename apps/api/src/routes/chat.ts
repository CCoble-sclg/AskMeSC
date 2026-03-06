import { Hono } from 'hono';
import type { Env, ChatRequest, ChatResponse, Source } from '../types';
import { RagService } from '../services/rag';

export const chatRoutes = new Hono<{ Bindings: Env }>();

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

  const rag = new RagService(c.env);
  
  try {
    // Generate conversation ID if not provided
    const conversationId = body.conversationId || crypto.randomUUID();

    // Run RAG pipeline
    const { response, sources } = await rag.query(message);

    // Optionally store conversation for context (future enhancement)
    // await storeConversation(c.env.DB, conversationId, message, response);

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
