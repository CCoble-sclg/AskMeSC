-- AskMeSC Database Schema
-- Run with: npm run db:migrate

-- Main table for synced records
CREATE TABLE IF NOT EXISTS sync_records (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT, -- JSON string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster lookups by table
CREATE INDEX IF NOT EXISTS idx_sync_records_table ON sync_records(table_name);

-- Index for timestamp-based queries
CREATE INDEX IF NOT EXISTS idx_sync_records_updated ON sync_records(updated_at);

-- Conversation history (optional, for context)
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' or 'assistant'
    content TEXT NOT NULL,
    sources TEXT, -- JSON array of source references
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- Sync metadata for tracking
CREATE TABLE IF NOT EXISTS sync_status (
    id INTEGER PRIMARY KEY,
    table_name TEXT UNIQUE NOT NULL,
    last_sync_at DATETIME,
    records_synced INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending'
);
