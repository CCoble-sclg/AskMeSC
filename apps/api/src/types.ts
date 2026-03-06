export interface Env {
  // D1 Database
  DB: D1Database;
  
  // R2 Storage
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

export interface SyncRecord {
  id: string;
  table: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface EmbeddingChunk {
  id: string;
  text: string;
  metadata: {
    table: string;
    recordId: string;
    chunkIndex: number;
  };
}
