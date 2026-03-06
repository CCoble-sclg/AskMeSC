export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  timestamp: Date;
  isError?: boolean;
}

export interface Source {
  table: string;
  id: string;
  snippet?: string;
  score?: number;
}

export interface ChatResponse {
  response: string;
  sources?: Source[];
  conversationId: string;
}
