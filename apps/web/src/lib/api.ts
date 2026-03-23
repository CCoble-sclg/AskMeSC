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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          const eventType = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          try {
            const parsed = JSON.parse(data);
            if (parsed.message && parsed.step !== undefined) {
              onProgress(parsed as ProgressEvent);
            } else if (parsed.response) {
              finalResponse = parsed as ChatResponse;
            } else if (parsed.error) {
              throw new Error(parsed.error);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
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
