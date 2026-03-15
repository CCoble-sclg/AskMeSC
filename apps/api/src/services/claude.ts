interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export class ClaudeService {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
  }

  async chat(
    system: string,
    userMessage: string,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    return this.chatMultiTurn(
      system,
      [{ role: 'user', content: userMessage }],
      options
    );
  }

  async chatMultiTurn(
    system: string,
    messages: ClaudeMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const maxTokens = options?.maxTokens ?? 1024;
    const temperature = options?.temperature ?? 1;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Claude API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as ClaudeResponse;
    return data.content?.[0]?.text || '';
  }

  async chatStream(
    system: string,
    userMessage: string,
    options?: { maxTokens?: number }
  ): Promise<ReadableStream> {
    const maxTokens = options?.maxTokens ?? 1024;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        stream: true,
        system,
        messages: [{ role: 'user', content: userMessage }] as ClaudeMessage[],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Claude API stream error (${response.status}): ${errorBody}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    return new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: event.delta.text })}\n\n`));
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      },
    });
  }
}
