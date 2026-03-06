export interface Env {
  // D1 Database (index only)
  DB: D1Database;
  
  // R2 Storage (full data)
  STORAGE: R2Bucket;
  
  // Vectorize for embeddings
  VECTORS: VectorizeIndex;
  
  // Workers AI
  AI: Ai;
  
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
  filters?: {
    database?: string;
    tables?: string[];
  };
}

export interface ChatResponse {
  response: string;
  sources?: Source[];
  conversationId: string;
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
