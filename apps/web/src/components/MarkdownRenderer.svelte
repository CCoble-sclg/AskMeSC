<script lang="ts">
  import { marked } from 'marked';
  import { onMount } from 'svelte';

  let { content }: { content: string } = $props();
  let html = $state('');

  $effect(() => {
    const renderer = new marked.Renderer();
    
    renderer.table = (header: string, body: string) => {
      return `<div class="table-wrapper"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
    };

    marked.setOptions({
      renderer,
      gfm: true,
      breaks: true,
    });

    html = marked.parse(content) as string;
  });
</script>

<div class="markdown-content">
  {@html html}
</div>

<style>
  .markdown-content {
    line-height: 1.6;
  }

  .markdown-content :global(p) {
    margin: 0.5em 0;
  }

  .markdown-content :global(p:first-child) {
    margin-top: 0;
  }

  .markdown-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-content :global(strong) {
    font-weight: 600;
  }

  .markdown-content :global(ul), 
  .markdown-content :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }

  .markdown-content :global(li) {
    margin: 0.25em 0;
  }

  .markdown-content :global(.table-wrapper) {
    overflow-x: auto;
    margin: 1em 0;
    border-radius: 8px;
    border: 1px solid var(--border);
  }

  .markdown-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9em;
  }

  .markdown-content :global(thead) {
    background: var(--primary);
    color: white;
  }

  .markdown-content :global(th) {
    padding: 0.75rem 1rem;
    text-align: left;
    font-weight: 600;
    white-space: nowrap;
  }

  .markdown-content :global(td) {
    padding: 0.625rem 1rem;
    border-top: 1px solid var(--border);
  }

  .markdown-content :global(tbody tr:hover) {
    background: rgba(79, 70, 229, 0.05);
  }

  .markdown-content :global(tbody tr:nth-child(even)) {
    background: rgba(0, 0, 0, 0.02);
  }

  .markdown-content :global(code) {
    background: rgba(0, 0, 0, 0.05);
    padding: 0.125em 0.375em;
    border-radius: 4px;
    font-size: 0.9em;
  }

  .markdown-content :global(pre) {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 1em;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1em 0;
  }

  .markdown-content :global(pre code) {
    background: none;
    padding: 0;
  }
</style>
