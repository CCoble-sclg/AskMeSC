<script lang="ts">
  let { onSend, onClear, disabled = false }: {
    onSend: (message: string) => void;
    onClear: () => void;
    disabled?: boolean;
  } = $props();

  let input = $state('');
  let textarea: HTMLTextAreaElement;

  $effect(() => {
    if (!disabled && textarea) {
      textarea.focus();
    }
  });

  const handleSubmit = () => {
    if (input.trim() && !disabled) {
      onSend(input.trim());
      input = '';
      // Reset textarea height
      if (textarea) {
        textarea.style.height = 'auto';
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    // Auto-resize textarea
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }
  };
</script>

<div class="input-container">
  <div class="input-wrapper">
    <textarea
      bind:this={textarea}
      bind:value={input}
      onkeydown={handleKeyDown}
      oninput={handleInput}
      placeholder="Ask about Stanly County records..."
      rows="1"
      {disabled}
    ></textarea>
    
    <div class="buttons">
      <button 
        type="button" 
        class="clear-btn" 
        onclick={onClear}
        title="Clear conversation"
      >
        🗑️
      </button>
      
      <button 
        type="button" 
        class="send-btn" 
        onclick={handleSubmit}
        disabled={disabled || !input.trim()}
      >
        Send
      </button>
    </div>
  </div>
  
  <p class="disclaimer">
    AI-generated responses. Verify important information with official sources.
  </p>
</div>

<style>
  .input-container {
    padding: 1rem 0;
    border-top: 1px solid var(--border);
    background: var(--background);
  }

  .input-wrapper {
    display: flex;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem;
    box-shadow: var(--shadow);
  }

  textarea {
    flex: 1;
    border: none;
    outline: none;
    resize: none;
    padding: 0.5rem;
    font-size: 1rem;
    line-height: 1.5;
    background: transparent;
    color: var(--text);
    min-height: 24px;
    max-height: 150px;
  }

  textarea::placeholder {
    color: var(--text-secondary);
  }

  textarea:disabled {
    background: var(--background);
    color: var(--text-secondary);
  }

  .buttons {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }

  button {
    border: none;
    border-radius: 8px;
    padding: 0.5rem 1rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .send-btn {
    background: var(--primary);
    color: white;
  }

  .send-btn:hover:not(:disabled) {
    background: var(--primary-dark);
  }

  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .clear-btn {
    background: transparent;
    padding: 0.5rem;
    font-size: 1rem;
    color: var(--text-secondary);
  }

  .clear-btn:hover {
    background: var(--border);
  }

  .disclaimer {
    text-align: center;
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-top: 0.5rem;
  }
</style>
