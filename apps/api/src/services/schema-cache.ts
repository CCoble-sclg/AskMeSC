import type { Env } from '../types';

export interface CachedTableSchema {
  database: string;
  schema: string;
  tableName: string;
  columns: Array<{
    name: string;
    type: string;
  }>;
  sampleValues?: Record<string, string[]>;
  rowCountEstimate?: number;
  discoveredAt: string;
  lastAccessed: string;
}

export interface CachedDatabaseInfo {
  name: string;
  tables: string[];
  discoveredAt: string;
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class SchemaCache {
  private kv: KVNamespace;

  constructor(env: Env) {
    this.kv = env.SCHEMA_CACHE;
  }

  private tableKey(database: string, schema: string, tableName: string): string {
    return `table:${database}:${schema}:${tableName}`;
  }

  private databaseKey(database: string): string {
    return `database:${database}`;
  }

  private sampleKey(database: string, schema: string, tableName: string, column: string): string {
    return `sample:${database}:${schema}:${tableName}:${column}`;
  }

  async getDatabaseTables(database: string): Promise<string[] | null> {
    try {
      const cached = await this.kv.get<CachedDatabaseInfo>(this.databaseKey(database), 'json');
      return cached?.tables || null;
    } catch (e) {
      console.error('Cache read error:', e);
      return null;
    }
  }

  async setDatabaseTables(database: string, tables: string[]): Promise<void> {
    try {
      const data: CachedDatabaseInfo = {
        name: database,
        tables,
        discoveredAt: new Date().toISOString(),
      };
      await this.kv.put(this.databaseKey(database), JSON.stringify(data), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (e) {
      console.error('Cache write error:', e);
    }
  }

  async getTableSchema(database: string, schema: string, tableName: string): Promise<CachedTableSchema | null> {
    try {
      const key = this.tableKey(database, schema, tableName);
      const cached = await this.kv.get<CachedTableSchema>(key, 'json');
      
      if (cached) {
        // Update last accessed time (fire and forget)
        this.kv.put(key, JSON.stringify({
          ...cached,
          lastAccessed: new Date().toISOString(),
        }), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
      }
      
      return cached;
    } catch (e) {
      console.error('Cache read error:', e);
      return null;
    }
  }

  async setTableSchema(
    database: string,
    schema: string,
    tableName: string,
    columns: Array<{ name: string; type: string }>,
    rowCountEstimate?: number
  ): Promise<void> {
    try {
      const data: CachedTableSchema = {
        database,
        schema,
        tableName,
        columns,
        rowCountEstimate,
        discoveredAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
      };
      await this.kv.put(this.tableKey(database, schema, tableName), JSON.stringify(data), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (e) {
      console.error('Cache write error:', e);
    }
  }

  async getSampleValues(database: string, schema: string, tableName: string, column: string): Promise<string[] | null> {
    try {
      const key = this.sampleKey(database, schema, tableName, column);
      const cached = await this.kv.get<string[]>(key, 'json');
      return cached;
    } catch (e) {
      console.error('Cache read error:', e);
      return null;
    }
  }

  async setSampleValues(
    database: string,
    schema: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void> {
    try {
      const key = this.sampleKey(database, schema, tableName, column);
      await this.kv.put(key, JSON.stringify(values), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (e) {
      console.error('Cache write error:', e);
    }
  }

  async getKnownDatabases(): Promise<string[]> {
    try {
      const list = await this.kv.list({ prefix: 'database:' });
      return list.keys.map(k => k.name.replace('database:', ''));
    } catch (e) {
      console.error('Cache list error:', e);
      return [];
    }
  }

  async clearDatabase(database: string): Promise<void> {
    try {
      const list = await this.kv.list({ prefix: `table:${database}:` });
      const sampleList = await this.kv.list({ prefix: `sample:${database}:` });
      
      const allKeys = [
        this.databaseKey(database),
        ...list.keys.map(k => k.name),
        ...sampleList.keys.map(k => k.name),
      ];
      
      await Promise.all(allKeys.map(key => this.kv.delete(key)));
    } catch (e) {
      console.error('Cache clear error:', e);
    }
  }

  async clearAll(): Promise<void> {
    try {
      const list = await this.kv.list();
      await Promise.all(list.keys.map(k => this.kv.delete(k.name)));
    } catch (e) {
      console.error('Cache clear error:', e);
    }
  }
}
