import type { ChatResponse } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787';

class ChatApi {
  async sendMessage(message: string, conversationId?: string, previousSql?: string, previousQuestion?: string): Promise<ChatResponse> {
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
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to send message');
    }

    return response.json();
  }

  async checkHealth(): Promise<{ status: string; checks: Record<string, boolean> }> {
    const response = await fetch(`${API_BASE}/api/health`);
    return response.json();
  }
}

export const chatApi = new ChatApi();
