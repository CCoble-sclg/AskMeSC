<script lang="ts">
  import type { Message } from '$lib/types';
  import MarkdownRenderer from './MarkdownRenderer.svelte';
  import ChartRenderer from './ChartRenderer.svelte';

  let { message }: { message: Message } = $props();
</script>

<div class="message {message.role}" class:error={message.isError}>
  <div class="avatar">
    {#if message.role === 'user'}
      👤
    {:else}
      🤖
    {/if}
  </div>
  
  <div class="content">
    {#if message.role === 'assistant'}
      <MarkdownRenderer content={message.content} />
    {:else}
      <div class="text">{message.content}</div>
    {/if}
    
    {#if message.chart}
      <ChartRenderer data={message.chart} />
    {/if}
    
    {#if message.sources && message.sources.length > 0}
      <div class="sources">
        <span class="sources-label">Sources:</span>
        <ul>
          {#each message.sources as source}
            <li>
              <span class="source-table">{source.table}</span>
              <span class="source-id">#{source.id}</span>
              {#if source.snippet}
                <span class="source-snippet">"{source.snippet}"</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    
    <div class="timestamp">
      {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </div>
  </div>
</div>

<style>
  .message {
    display: flex;
    gap: 0.75rem;
    max-width: 85%;
  }

  .message.user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .message.assistant {
    align-self: flex-start;
  }

  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .content {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    box-shadow: var(--shadow);
  }

  .message.user .content {
    background: var(--primary);
    color: white;
    border-color: var(--primary);
  }

  .message.error .content {
    background: #fef2f2;
    border-color: var(--error);
    color: var(--error);
  }

  .text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .sources {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
  }

  .sources-label {
    font-weight: 600;
    color: var(--text-secondary);
  }

  .sources ul {
    list-style: none;
    margin-top: 0.25rem;
    padding-left: 0;
  }

  .sources li {
    padding: 0.25rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }

  .source-table {
    background: var(--primary);
    color: white;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    font-size: 0.7rem;
    text-transform: uppercase;
  }

  .source-id {
    font-weight: 500;
    color: var(--text);
  }

  .source-snippet {
    color: var(--text-secondary);
    font-style: italic;
    font-size: 0.75rem;
  }

  .timestamp {
    margin-top: 0.5rem;
    font-size: 0.7rem;
    color: var(--text-secondary);
    text-align: right;
  }

  .message.user .timestamp {
    color: rgba(255, 255, 255, 0.7);
  }
</style>
