<script lang="ts">
  import '../app.css';
</script>

<div class="app">
  <header>
    <div class="header-content">
      <div class="brand">
        <img src="/stanly-county-logo.png" alt="Stanly County" class="county-logo" />
        <div class="title-group">
          <h1>AskMeSC</h1>
          <p class="tagline">Your AI Assistant for Stanly County Public Records</p>
        </div>
      </div>
    </div>
  </header>

  <main>
    <slot />
  </main>

  <footer>
    <div class="footer-content">
      <p class="footer-tagline">Water. Air. Land. Success.</p>
      <p class="footer-info">Powered by AI | Data updated nightly | <a href="https://www.stanlycountync.gov" target="_blank">stanlycountync.gov</a></p>
    </div>
  </footer>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  header {
    background: var(--primary-dark);
    padding: 1rem 1.5rem;
    box-shadow: var(--shadow);
  }

  .header-content {
    max-width: 900px;
    margin: 0 auto;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .county-logo {
    height: 60px;
    width: auto;
  }

  .title-group {
    display: flex;
    flex-direction: column;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
    color: #ffffff;
    margin: 0;
  }

  .tagline {
    font-size: 0.875rem;
    color: var(--primary-bright);
    margin-top: 0.25rem;
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  footer {
    background: var(--primary-dark);
    padding: 1rem;
    text-align: center;
  }

  .footer-content {
    max-width: 900px;
    margin: 0 auto;
  }

  .footer-tagline {
    font-style: italic;
    color: var(--accent);
    font-size: 1rem;
    margin-bottom: 0.5rem;
  }

  .footer-info {
    font-size: 0.875rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .footer-info a {
    color: var(--primary-bright);
  }

  .footer-info a:hover {
    color: #ffffff;
  }

  @media (max-width: 600px) {
    .brand {
      flex-direction: column;
      text-align: center;
    }
    
    .county-logo {
      height: 50px;
    }
    
    h1 {
      font-size: 1.5rem;
    }
  }
</style>
