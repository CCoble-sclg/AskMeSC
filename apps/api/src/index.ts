import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatRoutes } from './routes/chat';
import { syncRoutes } from './routes/sync';
import { healthRoutes } from './routes/health';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// CORS for the frontend
app.use('*', cors({
  origin: ['http://localhost:5173', 'https://askmesc.pages.dev'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Sync-API-Key'],
}));

// Routes
app.route('/api/health', healthRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/sync', syncRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
