<script lang="ts">
  import '../app.css';
</script>

<div class="app">
  <header>
    <div class="header-content">
      <h1>
        <span class="logo">🏛️</span>
        AskMeSC
      </h1>
      <p class="tagline">Your AI Assistant for Public Records</p>
    </div>
  </header>

  <main>
    <slot />
  </main>

  <footer>
    <p>Powered by AI | Data updated nightly | <a href="/about">About</a></p>
  </footer>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 1rem 1.5rem;
    box-shadow: var(--shadow);
  }

  .header-content {
    max-width: 900px;
    margin: 0 auto;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--primary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .logo {
    font-size: 1.75rem;
  }

  .tagline {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin-top: 0.25rem;
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  footer {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 1rem;
    text-align: center;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
</style>
