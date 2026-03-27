import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatRoutes } from './routes/chat';
import { syncRoutes } from './routes/sync';
import { healthRoutes } from './routes/health';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// CORS for the frontend
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return 'https://askmesc.stanlycountync.gov';
    const allowed = [
      'https://askmesc.stanlycountync.gov',
      'https://askmesc.pages.dev',
      'http://localhost:5173',
    ];
    if (allowed.includes(origin)) return origin;
    if (origin.endsWith('.askmesc.pages.dev')) return origin;
    return 'https://askmesc.stanlycountync.gov';
  },
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
