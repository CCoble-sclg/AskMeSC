import { Hono } from 'hono';
import type { Env } from '../types';
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

// Upload JSON content to R2
syncRoutes.post('/r2/upload', async (c) => {
  let body: { key?: string; content?: unknown; contentType?: string };
  
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON body', details: String(e) }, 400);
  }

  if (!body.key) {
    return c.json({ error: 'Key is required' }, 400);
  }
  
  if (body.content === undefined || body.content === null) {
    return c.json({ error: 'Content is required' }, 400);
  }

  // Ensure content is a string
  const contentStr = typeof body.content === 'string' 
    ? body.content 
    : JSON.stringify(body.content);

  try {
    await c.env.STORAGE.put(body.key, contentStr, {
      httpMetadata: {
        contentType: body.contentType || 'application/json',
      },
    });

    return c.json({ success: true, key: body.key, size: contentStr.length });
  } catch (error) {
    console.error('R2 upload error:', error);
    return c.json({ error: 'Upload failed', details: String(error) }, 500);
  }
});

// List objects in R2 with prefix
syncRoutes.get('/r2/list', async (c) => {
  const prefix = c.req.query('prefix') || '';
  
  try {
    const listed = await c.env.STORAGE.list({ prefix, limit: 1000 });
    
    const objects = listed.objects.map(obj => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded,
    }));

    return c.json({ objects, truncated: listed.truncated });
  } catch (error) {
    console.error('R2 list error:', error);
    return c.json({ error: 'List failed' }, 500);
  }
});

// Get object from R2
syncRoutes.get('/r2/get/:key{.+}', async (c) => {
  const key = c.req.param('key');
  
  try {
    const object = await c.env.STORAGE.get(key);
    
    if (!object) {
      return c.json({ error: 'Not found' }, 404);
    }

    const content = await object.text();
    return c.json({ key, content });
  } catch (error) {
    console.error('R2 get error:', error);
    return c.json({ error: 'Get failed' }, 500);
  }
});

// Delete object from R2
syncRoutes.delete('/r2/delete/:key{.+}', async (c) => {
  const key = c.req.param('key');
  
  try {
    await c.env.STORAGE.delete(key);
    return c.json({ success: true, key });
  } catch (error) {
    console.error('R2 delete error:', error);
    return c.json({ error: 'Delete failed' }, 500);
  }
});

// Generate embeddings for a table's data in R2
syncRoutes.post('/embeddings/generate', async (c) => {
  const body = await c.req.json<{
    database: string;
    tableKey: string;
  }>();

  if (!body.database || !body.tableKey) {
    return c.json({ error: 'Database and tableKey are required' }, 400);
  }

  const embedService = new EmbeddingService(c.env);

  try {
    // Get table metadata
    const metaKey = `databases/${body.database}/tables/${body.tableKey}/_meta.json`;
    const metaObj = await c.env.STORAGE.get(metaKey);
    
    if (!metaObj) {
      return c.json({ error: 'Table metadata not found' }, 404);
    }

    const meta = await metaObj.json<{
      chunkCount: number;
      totalRows: number;
      primaryKey: string;
      columns: Array<{ name: string; type: string }>;
    }>();

    let totalEmbeddings = 0;
    const errors: string[] = [];
    const chunkCount = meta.chunkCount ?? 0;

    if (chunkCount === 0) {
      return c.json({ error: 'No chunks to process', meta }, 400);
    }

    // Process each data chunk
    for (let i = 1; i <= chunkCount; i++) {
      const chunkKey = `databases/${body.database}/tables/${body.tableKey}/data_${String(i).padStart(4, '0')}.json`;
      
      try {
        const chunkObj = await c.env.STORAGE.get(chunkKey);
        if (!chunkObj) continue;

        const chunkData = await chunkObj.json<{
          rows: Array<Record<string, any>>;
        }>();

        // Generate embeddings for each row
        for (const row of chunkData.rows) {
          try {
            const textContent = embedService.buildTextContent(row);
            
            if (textContent.length >= 20) {
              const chunks = embedService.chunkText(
                textContent,
                row._id || 'unknown',
                body.tableKey
              );

              for (const chunk of chunks) {
                await embedService.storeEmbedding(chunk, {
                  database: body.database,
                  r2Key: chunkKey,
                });
                totalEmbeddings++;
              }
            }
          } catch (err) {
            errors.push(`Row ${row._id}: ${err}`);
          }
        }
      } catch (err) {
        errors.push(`Chunk ${i}: ${err}`);
      }
    }

    // Update index in D1 (handle undefined values)
    const rowCount = meta.totalRows ?? 0;
    await c.env.DB.prepare(`
      INSERT OR REPLACE INTO table_index (database_name, table_key, row_count, embedding_count, last_sync)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).bind(body.database, body.tableKey, rowCount, totalEmbeddings).run();

    return c.json({
      success: true,
      database: body.database,
      tableKey: body.tableKey,
      totalEmbeddings,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    });
  } catch (error) {
    console.error('Embedding generation error:', error);
    return c.json({ error: 'Embedding generation failed', details: String(error) }, 500);
  }
});

// Get sync status for all databases/tables
syncRoutes.get('/status', async (c) => {
  try {
    // List databases from R2
    const dbList = await c.env.STORAGE.list({ prefix: 'databases/', delimiter: '/' });
    
    const databases: Array<{
      name: string;
      tables: number;
      lastSync?: string;
    }> = [];

    for (const prefix of dbList.delimitedPrefixes || []) {
      const dbName = prefix.replace('databases/', '').replace('/', '');
      
      // Get database metadata
      const metaObj = await c.env.STORAGE.get(`databases/${dbName}/_meta.json`);
      let meta = null;
      if (metaObj) {
        meta = await metaObj.json<{ tableCount: number; syncedAt: string }>();
      }

      databases.push({
        name: dbName,
        tables: meta?.tableCount || 0,
        lastSync: meta?.syncedAt,
      });
    }

    // Get index stats from D1
    const indexStats = await c.env.DB.prepare(`
      SELECT database_name, COUNT(*) as table_count, SUM(embedding_count) as total_embeddings
      FROM table_index
      GROUP BY database_name
    `).all();

    return c.json({
      databases,
      indexStats: indexStats.results,
    });
  } catch (error) {
    console.error('Status error:', error);
    return c.json({ error: 'Failed to get status' }, 500);
  }
});

// Clear all data for a database
syncRoutes.delete('/database/:name', async (c) => {
  const dbName = c.req.param('name');
  const confirm = c.req.query('confirm');
  
  if (confirm !== 'yes') {
    return c.json({ error: 'Add ?confirm=yes to confirm deletion' }, 400);
  }

  try {
    // List and delete all objects with database prefix
    const prefix = `databases/${dbName}/`;
    let deleted = 0;
    let cursor: string | undefined;

    do {
      const listed = await c.env.STORAGE.list({ prefix, cursor, limit: 100 });
      
      for (const obj of listed.objects) {
        await c.env.STORAGE.delete(obj.key);
        deleted++;
      }
      
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    // Clear from D1 index
    await c.env.DB.prepare('DELETE FROM table_index WHERE database_name = ?').bind(dbName).run();

    // Clear embeddings from Vectorize (would need to track IDs)
    // For now, embeddings will be orphaned but overwritten on next sync

    return c.json({ success: true, deleted });
  } catch (error) {
    console.error('Delete database error:', error);
    return c.json({ error: 'Delete failed' }, 500);
  }
});
