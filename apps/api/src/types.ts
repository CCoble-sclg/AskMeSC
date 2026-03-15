export interface Env {
  // D1 Database (index only)
  DB: D1Database;
  
  // R2 Storage (documents and files)
  STORAGE: R2Bucket;
  
  // Vectorize for document embeddings
  VECTORS: VectorizeIndex;
  
  // Workers AI (used for embeddings only)
  AI: Ai;
  
  // Anthropic Claude API key (used for LLM generation)
  ANTHROPIC_API_KEY: string;
  
  // Azure Function SQL Proxy
  AZURE_FUNCTION_URL: string;
  AZURE_FUNCTION_KEY: string;
  
  // Legacy: Neon PostgreSQL connection string (deprecated)
  NEON_DATABASE_URL?: string;
  
  // Environment variables
  ENVIRONMENT: string;
  SYNC_API_KEY?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
  previousSql?: string;
  previousQuestion?: string;
  filters?: {
    database?: string;
    tables?: string[];
  };
}

export interface ChatResponse {
  response: string;
  sources?: Source[];
  conversationId: string;
  lastSql?: string;
  lastQuestion?: string;
}

export interface ChartData {
  type: 'bar' | 'line' | 'pie' | 'doughnut';
  title?: string;
  labels: string[];
  datasets: ChartDataset[];
}

export interface ChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string | string[];
  borderColor?: string | string[];
}

export interface Source {
  table: string;
  id: string;
  snippet: string;
  score: number;
}

export interface EmbeddingChunk {
  id: string;
  text: string;
  metadata: {
    table: string;
    recordId: string;
    chunkIndex: number;
    database?: string;
    r2Key?: string;
  };
}

export interface TableIndex {
  databaseName: string;
  tableKey: string;
  schemaName?: string;
  tableName?: string;
  rowCount: number;
  chunkCount: number;
  embeddingCount: number;
  lastSync?: string;
}

export interface DatabaseInfo {
  name: string;
  server?: string;
  tableCount: number;
  totalRows: number;
  lastSync?: string;
}

export interface R2ChunkData {
  database: string;
  table: string;
  tableKey: string;
  chunkIndex: number;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

export interface R2TableMeta {
  database: string;
  schema: string;
  table: string;
  fullName: string;
  tableKey: string;
  totalRows: number;
  chunkCount: number;
  primaryKey?: string;
  columns: Array<{ name: string; type: string }>;
  exportedAt: string;
}

// Schema types for Text-to-SQL
export interface TableSchema {
  database: string;
  schema: string;
  tableName: string;
  fullName: string;
  columns: ColumnSchema[];
  primaryKey?: string;
  foreignKeys?: ForeignKey[];
  rowCount?: number;
  description?: string;
}

export interface ColumnSchema {
  name: string;
  type: string;
  postgresType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  referencedTable?: string;
  description?: string;
}

export interface ForeignKey {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface SchemaUploadRequest {
  database: string;
  tables: TableSchema[];
}

// Query types
export interface QueryRequest {
  question: string;
  database?: string;
}

export interface QueryResult {
  sql: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
}

export type QueryType = 'sql' | 'document' | 'hybrid';

export interface QueryRouterResult {
  type: QueryType;
  confidence: number;
  reasoning: string;
}
