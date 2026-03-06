# AskMeSC - AI Citizen Chatbot

An AI-powered chatbot for citizens to query public records and government data, hosted on Cloudflare.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Infrastructure                     │
├───────────────────┬───────────────────┬─────────────────────────┤
│   Pages (Web UI)  │  Workers (API)    │     Storage             │
│                   │                   │                         │
│   SvelteKit Chat  │  Hono REST API    │  D1 - Metadata          │
│   Interface       │  RAG Pipeline     │  R2 - Files             │
│                   │  Workers AI       │  Vectorize - Embeddings │
└───────────────────┴───────────────────┴─────────────────────────┘
                              ▲
                              │ Nightly Sync
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                    On-Premises Windows Server                    │
│                                                                  │
│   SQL Server  ──►  PowerShell Sync  ──►  Cloudflare API         │
│   Database         Service                                       │
└──────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
AskMeSC/
├── apps/
│   ├── api/              # Cloudflare Worker (backend)
│   │   ├── src/
│   │   │   ├── routes/   # API endpoints
│   │   │   └── services/ # RAG, embedding services
│   │   └── wrangler.toml # Cloudflare config
│   │
│   └── web/              # Cloudflare Pages (frontend)
│       └── src/
│           ├── components/
│           └── routes/
│
└── sync/                 # Windows data sync service
    ├── SyncService.ps1
    └── config.example.json
```

## Quick Start

### Prerequisites

- Node.js 20+
- Cloudflare account
- SQL Server (for data sync)

### 1. Install dependencies

```bash
npm install
```

### 2. Set up Cloudflare resources

```bash
# Login to Cloudflare
npx wrangler login

# Create D1 database
cd apps/api
npx wrangler d1 create askmesc-db

# Update wrangler.toml with the database_id from output

# Create R2 bucket
npx wrangler r2 bucket create askmesc-storage

# Create Vectorize index
npx wrangler vectorize create askmesc-index --dimensions 768 --metric cosine
```

### 3. Deploy

```bash
# Deploy API
npm run deploy:api

# Deploy Web
npm run deploy:web
```

### 4. Set up data sync

See [sync/README.md](sync/README.md) for Windows sync service setup.

## Development

```bash
# Start API locally
npm run dev:api

# Start Web locally (in another terminal)
npm run dev:web
```

The web app runs on http://localhost:5173
The API runs on http://localhost:8787

## Configuration

### Environment Variables

Set these as Cloudflare Workers secrets:

```bash
npx wrangler secret put SYNC_API_KEY
```

### Web App

Create `apps/web/.env.local`:
```
VITE_API_URL=http://localhost:8787
```

For production, update to your deployed Worker URL.

## RAG Pipeline

1. **User asks question** → Generate embedding
2. **Vector search** → Find relevant data chunks in Vectorize
3. **Fetch content** → Get full records from D1
4. **LLM generation** → Workers AI generates response with context
5. **Return response** → With source citations

## Security

- Public access with rate limiting
- Sync API protected by API key
- Data sanitization before upload (PII masking)
- No sensitive data stored in client

## License

Private - Internal use only
