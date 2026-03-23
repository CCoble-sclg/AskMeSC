<script lang="ts">
  import ChatMessage from './ChatMessage.svelte';
  import ChatInput from './ChatInput.svelte';
  import type { Message } from '$lib/types';
  import { chatApi, type ProgressEvent } from '$lib/api';

  let messages: Message[] = $state([]);
  let isLoading = $state(false);
  let progressMessage = $state('Searching records...');
  let conversationId = $state<string | undefined>(undefined);
  let lastSql = $state<string | undefined>(undefined);
  let lastQuestion = $state<string | undefined>(undefined);
  let lastResponse = $state<string | undefined>(undefined);
  let lastDatabase = $state<string | undefined>(undefined);
  let chatContainer: HTMLElement;

  const scrollToBottom = () => {
    setTimeout(() => {
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }, 100);
  };

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    // Add user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    messages = [...messages, userMessage];
    scrollToBottom();

    // Show loading state
    isLoading = true;
    progressMessage = 'Understanding your question...';

    try {
      // Use streaming for new queries (no previous SQL context), regular for follow-ups
      const isFollowUp = !!lastSql;
      
      let response;
      if (isFollowUp) {
        // Use regular endpoint for follow-ups (faster)
        response = await chatApi.sendMessage(text, conversationId, lastSql, lastQuestion, lastResponse, lastDatabase);
      } else {
        // Use streaming endpoint for new queries (shows progress)
        response = await chatApi.sendMessageWithProgress(
          text,
          (event: ProgressEvent) => {
            progressMessage = event.message;
          },
          conversationId,
          lastSql,
          lastQuestion,
          lastResponse,
          lastDatabase
        );
      }
      
      conversationId = response.conversationId;
      lastSql = response.lastSql;
      lastQuestion = response.lastQuestion;
      lastResponse = response.response;
      lastDatabase = response.lastDatabase;

      // Add assistant message
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.response,
        sources: response.sources,
        timestamp: new Date(),
      };
      messages = [...messages, assistantMessage];
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'An unexpected error occurred.';
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: errorText,
        timestamp: new Date(),
        isError: true,
      };
      messages = [...messages, errorMessage];
    } finally {
      isLoading = false;
      progressMessage = 'Searching records...';
      scrollToBottom();
    }
  };

  const handleClear = () => {
    messages = [];
    conversationId = undefined;
    lastSql = undefined;
    lastQuestion = undefined;
    lastResponse = undefined;
    lastDatabase = undefined;
  };
</script>

<div class="chat-container">
  <div class="messages" bind:this={chatContainer}>
    {#if messages.length === 0}
      <div class="welcome">
        <h2>Welcome to AskMeSC</h2>
        <p>I can help you find information about Stanly County:</p>
        <ul>
          <li>Animal shelter and kennel records</li>
          <li>Employee and HR information</li>
          <li>Finance and vendor payments</li>
          <li>Utility billing and customer accounts</li>
        </ul>
        <p class="hint">Try asking: "How many animals are currently in the kennel?" or "Show me the top vendors by payment amount"</p>
      </div>
    {:else}
      {#each messages as message (message.id)}
        <ChatMessage {message} />
      {/each}
      
      {#if isLoading}
        <div class="loading">
          <div class="loading-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <span class="loading-text">{progressMessage}</span>
        </div>
      {/if}
    {/if}
  </div>

  <ChatInput onSend={handleSend} onClear={handleClear} disabled={isLoading} />
</div>

<style>
  .chat-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
    padding: 1rem;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .welcome {
    text-align: center;
    padding: 2rem;
    color: var(--text-secondary);
  }

  .welcome h2 {
    color: var(--text);
    margin-bottom: 1rem;
  }

  .welcome ul {
    list-style: none;
    padding: 0;
    margin: 1rem 0;
  }

  .welcome li {
    padding: 0.25rem 0;
  }

  .welcome li::before {
    content: "✓ ";
    color: var(--success);
  }

  .hint {
    margin-top: 1.5rem;
    font-style: italic;
    background: var(--surface);
    padding: 1rem;
    border-radius: var(--radius);
    border: 1px dashed var(--border);
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    color: var(--text-secondary);
  }

  .loading-dots {
    display: flex;
    gap: 4px;
  }

  .loading-dots span {
    width: 8px;
    height: 8px;
    background: var(--primary);
    border-radius: 50%;
    animation: bounce 1.4s infinite ease-in-out both;
  }

  .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
  .loading-dots span:nth-child(2) { animation-delay: -0.16s; }

  @keyframes bounce {
    0%, 80%, 100% { transform: scale(0); }
    40% { transform: scale(1); }
  }
</style>
