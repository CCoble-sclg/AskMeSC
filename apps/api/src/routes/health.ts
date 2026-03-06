import { Hono } from 'hono';
import type { Env } from '../types';

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get('/', async (c) => {
  const checks: Record<string, boolean> = {
    api: true,
    d1: false,
    vectorize: false,
  };

  // Check D1
  try {
    await c.env.DB.prepare('SELECT 1').first();
    checks.d1 = true;
  } catch {
    checks.d1 = false;
  }

  // Check Vectorize
  try {
    // Simple check - just verify the binding exists
    checks.vectorize = !!c.env.VECTORS;
  } catch {
    checks.vectorize = false;
  }

  const healthy = Object.values(checks).every(Boolean);

  return c.json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  }, healthy ? 200 : 503);
});
