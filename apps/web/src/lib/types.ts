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

export interface ChatResponse {
  response: string;
  sources?: Source[];
  conversationId: string;
  lastSql?: string;
  lastQuestion?: string;
}
