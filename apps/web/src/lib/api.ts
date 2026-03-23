import type { ChatResponse } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export interface ProgressEvent {
  message: string;
  step: number;
  total: number;
}

class ChatApi {
  async sendMessage(
    message: string,
    conversationId?: string,
    previousSql?: string,
    previousQuestion?: string,
    previousResponse?: string,
    previousDatabase?: string
  ): Promise<ChatResponse> {
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        conversationId,
        previousSql,
        previousQuestion,
        previousResponse,
        previousDatabase,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to send message');
    }

    return response.json();
  }

  async sendMessageWithProgress(
    message: string,
    onProgress: (event: ProgressEvent) => void,
    conversationId?: string,
    previousSql?: string,
    previousQuestion?: string,
    previousResponse?: string,
    previousDatabase?: string
  ): Promise<ChatResponse> {
    const response = await fetch(`${API_BASE}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        conversationId,
        previousSql,
        previousQuestion,
        previousResponse,
        previousDatabase,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to send message');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse: ChatResponse | null = null;
    let currentEventType = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        
        if (trimmedLine.startsWith('event:')) {
          currentEventType = trimmedLine.slice(6).trim();
          continue;
        }
        
        if (trimmedLine.startsWith('data:')) {
          const data = trimmedLine.slice(5).trim();
          if (!data) continue;
          
          try {
            const parsed = JSON.parse(data);
            
            if (currentEventType === 'progress' && parsed.message) {
              onProgress(parsed as ProgressEvent);
            } else if (currentEventType === 'complete' && parsed.response) {
              finalResponse = parsed as ChatResponse;
            } else if (currentEventType === 'error' && parsed.error) {
              throw new Error(parsed.error);
            } else if (parsed.response) {
              // Fallback: detect complete response without event type
              finalResponse = parsed as ChatResponse;
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
          
          currentEventType = ''; // Reset after processing data
        }
      }
    }

    if (!finalResponse) {
      throw new Error('No response received');
    }

    return finalResponse;
  }

  async checkHealth(): Promise<{ status: string; checks: Record<string, boolean> }> {
    const response = await fetch(`${API_BASE}/api/health`);
    return response.json();
  }
}

export const chatApi = new ChatApi();
