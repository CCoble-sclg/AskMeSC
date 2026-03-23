import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import * as sql from "mssql";

// Azure Function SQL Proxy - v1.1

interface QueryRequest {
  database: string;
  query: string;
}

interface DatabaseConfig {
  server: string;
  database: string;
  user: string;
  password: string;
}

function getDatabaseConfig(dbName: string): DatabaseConfig | null {
  const prefix = `DB_${dbName.toUpperCase()}_`;
  
  const server = process.env[`${prefix}SERVER`];
  const database = process.env[`${prefix}DATABASE`];
  const user = process.env[`${prefix}USER`];
  const password = process.env[`${prefix}PASSWORD`];
  
  console.log(`Getting config for ${dbName}: server=${server}, database=${database}`);
  
  if (!server || !database || !user || !password) {
    return null;
  }
  
  return { server, database, user, password };
}

async function getConnection(dbName: string): Promise<sql.ConnectionPool> {
  const config = getDatabaseConfig(dbName);
  if (!config) {
    throw new Error(`Database '${dbName}' is not configured. Check environment variables DB_${dbName.toUpperCase()}_*`);
  }
  
  console.log(`Creating fresh connection to ${config.database} on ${config.server}`);
  
  // NO CACHING - create fresh connection every time
  const pool = await sql.connect({
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  });
  
  // Verify we connected to the right database
  const verifyResult = await pool.request().query('SELECT DB_NAME() as db_name');
  const actualDb = verifyResult.recordset[0]?.db_name;
  console.log(`Connected to database: ${actualDb} (requested: ${config.database})`);
  
  if (actualDb !== config.database) {
    await pool.close();
    throw new Error(`Database mismatch! Requested ${config.database} but connected to ${actualDb}`);
  }
  
  return pool;
}

function validateQuery(query: string): { valid: boolean; error?: string } {
  const upperQuery = query.toUpperCase().trim();
  
  const dangerousKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER',
    'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'MERGE'
  ];
  
  for (const keyword of dangerousKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(upperQuery)) {
      return { valid: false, error: `Query contains forbidden keyword: ${keyword}` };
    }
  }
  
  if (!upperQuery.startsWith('SELECT')) {
    return { valid: false, error: 'Only SELECT queries are allowed' };
  }
  
  if (query.includes(';') && query.indexOf(';') < query.length - 1) {
    return { valid: false, error: 'Multiple statements are not allowed' };
  }
  
  return { valid: true };
}

export async function queryHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('SQL Proxy query request received');
  
  // Verify API key
  const apiKey = request.headers.get('x-api-key');
  const expectedKey = process.env.API_KEY;
  
  if (!apiKey || apiKey !== expectedKey) {
    return {
      status: 401,
      jsonBody: { error: 'Unauthorized' }
    };
  }
  
  try {
    const body = await request.json() as QueryRequest;
    
    if (!body.database || !body.query) {
      return {
        status: 400,
        jsonBody: { error: 'database and query are required' }
      };
    }
    
    // Validate the query
    const validation = validateQuery(body.query);
    if (!validation.valid) {
      return {
        status: 400,
        jsonBody: { error: validation.error }
      };
    }
    
    context.log(`Executing query on database: ${body.database}`);
    
    const startTime = Date.now();
    const pool = await getConnection(body.database);
    
    try {
      const result = await pool.request().query(body.query);
      const executionTimeMs = Date.now() - startTime;
      
      context.log(`Query returned ${result.recordset?.length || 0} rows in ${executionTimeMs}ms`);
      
      return {
        status: 200,
        jsonBody: {
          rows: result.recordset || [],
          rowCount: result.recordset?.length || 0,
          executionTimeMs
        }
      };
    } finally {
      // Always close connection - no caching
      try { await pool.close(); } catch (e) { /* ignore */ }
    }
  } catch (error: any) {
    context.error('Query execution error:', error);
    return {
      status: 500,
      jsonBody: { 
        error: 'Query execution failed',
        details: error.message 
      }
    };
  }
}

// Schema endpoint to get table information
export async function schemaHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('SQL Proxy schema request received');
  
  const apiKey = request.headers.get('x-api-key');
  const expectedKey = process.env.API_KEY;
  
  if (!apiKey || apiKey !== expectedKey) {
    return {
      status: 401,
      jsonBody: { error: 'Unauthorized' }
    };
  }
  
  try {
    const dbName = request.query.get('database');
    
    if (!dbName) {
      return {
        status: 400,
        jsonBody: { error: 'database query parameter is required' }
      };
    }
    
    const pool = await getConnection(dbName);
    
    try {
      // Get all tables and their columns
      const tablesResult = await pool.request().query(`
        SELECT 
          s.name AS schema_name,
          t.name AS table_name,
          c.name AS column_name,
          ty.name AS data_type,
          c.is_nullable,
          CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
        FROM sys.tables t
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        INNER JOIN sys.columns c ON t.object_id = c.object_id
        INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM sys.index_columns ic
          INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
          WHERE i.is_primary_key = 1
        ) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
        ORDER BY s.name, t.name, c.column_id
      `);
      
      // Group by table
      const tables: Record<string, any> = {};
      for (const row of tablesResult.recordset) {
        const fullName = `${row.schema_name}.${row.table_name}`;
        if (!tables[fullName]) {
          tables[fullName] = {
            schema: row.schema_name,
            name: row.table_name,
            fullName,
            columns: []
          };
        }
        tables[fullName].columns.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable,
          isPrimaryKey: row.is_primary_key === 1
        });
      }
      
      context.log(`Schema for ${dbName}: found ${Object.keys(tables).length} tables`);
      
      return {
        status: 200,
        jsonBody: {
          database: dbName,
          tables: Object.values(tables)
        }
      };
    } finally {
      // Always close connection - no caching
      try { await pool.close(); } catch (e) { /* ignore */ }
    }
  } catch (error: any) {
    context.error('Schema fetch error:', error);
    return {
      status: 500,
      jsonBody: { 
        error: 'Failed to fetch schema',
        details: error.message 
      }
    };
  }
}

// Health check endpoint
export async function healthHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: { 
      status: 'healthy',
      timestamp: new Date().toISOString()
    }
  };
}

// Register the functions
app.http('query', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: queryHandler
});

app.http('schema', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: schemaHandler
});

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: healthHandler
});
