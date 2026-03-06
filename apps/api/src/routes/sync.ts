import { Hono } from 'hono';
import type { Env, SyncRecord, EmbeddingChunk } from '../types';
import { EmbeddingService } from '../services/embedding';

export const syncRoutes = new Hono<{ Bindings: Env }>();

// Middleware to check sync API key
const validateApiKey = async (c: any, next: any) => {
  const apiKey = c.req.header('X-Sync-API-Key');
  const expectedKey = c.env.SYNC_API_KEY;
  
  if (!expectedKey) {
    console.warn('SYNC_API_KEY not configured');
    return c.json({ error: 'Sync not configured' }, 503);
  }
  
  if (apiKey !== expectedKey) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  await next();
};

syncRoutes.use('*', validateApiKey);

// Upload records to D1 and generate embeddings
syncRoutes.post('/upload', async (c) => {
  const body = await c.req.json<{
    table: string;
    records: SyncRecord[];
  }>();

  if (!body.table || !body.records || !Array.isArray(body.records)) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { table, records } = body;
  const embedService = new EmbeddingService(c.env);
  
  let inserted = 0;
  let embedded = 0;
  const errors: string[] = [];

  try {
    // Process records in batches
    for (const record of records) {
      try {
        // Store metadata in D1
        await c.env.DB.prepare(`
          INSERT OR REPLACE INTO sync_records (id, table_name, content, metadata, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `).bind(
          record.id,
          table,
          record.content,
          JSON.stringify(record.metadata)
        ).run();
        inserted++;

        // Generate and store embedding
        if (record.content && record.content.length > 0) {
          const chunks = embedService.chunkText(record.content, record.id, table);
          for (const chunk of chunks) {
            await embedService.storeEmbedding(chunk);
            embedded++;
          }
        }
      } catch (err) {
        errors.push(`Record ${record.id}: ${err}`);
      }
    }

    return c.json({
      success: true,
      inserted,
      embedded,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Sync upload error:', error);
    return c.json({ error: 'Upload failed', details: String(error) }, 500);
  }
});

// Upload files to R2
syncRoutes.post('/files', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File;
  const key = formData.get('key') as string;
  const metadata = formData.get('metadata') as string;

  if (!file || !key) {
    return c.json({ error: 'File and key are required' }, 400);
  }

  try {
    await c.env.STORAGE.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type,
      },
      customMetadata: metadata ? JSON.parse(metadata) : {},
    });

    return c.json({ success: true, key });
  } catch (error) {
    console.error('File upload error:', error);
    return c.json({ error: 'File upload failed' }, 500);
  }
});

// Clear all data (use with caution!)
syncRoutes.delete('/clear', async (c) => {
  const confirm = c.req.query('confirm');
  
  if (confirm !== 'yes') {
    return c.json({ error: 'Add ?confirm=yes to confirm deletion' }, 400);
  }

  try {
    // Clear D1 records
    await c.env.DB.prepare('DELETE FROM sync_records').run();
    
    // Note: Vectorize and R2 clearing would need separate handling
    
    return c.json({ success: true, message: 'D1 records cleared' });
  } catch (error) {
    console.error('Clear error:', error);
    return c.json({ error: 'Clear failed' }, 500);
  }
});
