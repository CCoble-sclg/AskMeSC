-- AskMeSC Database Schema (Index-Only)
-- D1 is used for lightweight indexing; full data is stored in R2
-- Run with: npm run db:migrate

-- Table index - tracks synced tables
CREATE TABLE IF NOT EXISTS table_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    database_name TEXT NOT NULL,
    table_key TEXT NOT NULL,
    schema_name TEXT,
    table_name TEXT,
    row_count INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    embedding_count INTEGER DEFAULT 0,
    last_sync DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(database_name, table_key)
);

CREATE INDEX IF NOT EXISTS idx_table_index_db ON table_index(database_name);

-- Database registry
CREATE TABLE IF NOT EXISTS database_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    server TEXT,
    description TEXT,
    table_count INTEGER DEFAULT 0,
    total_rows INTEGER DEFAULT 0,
    last_sync DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Conversation history (for context in multi-turn chats)
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- Sync log for tracking sync operations
CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    database_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    tables_processed INTEGER DEFAULT 0,
    rows_processed INTEGER DEFAULT 0,
    duration_seconds REAL,
    status TEXT DEFAULT 'running',
    error_message TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_sync_log_db ON sync_log(database_name);
CREATE INDEX IF NOT EXISTS idx_sync_log_started ON sync_log(started_at);

-- Table schemas for Text-to-SQL
CREATE TABLE IF NOT EXISTS table_schemas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_key TEXT UNIQUE NOT NULL,
    database_name TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    primary_key TEXT,
    foreign_keys_json TEXT,
    row_count INTEGER DEFAULT 0,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_table_schemas_db ON table_schemas(database_name);
CREATE INDEX IF NOT EXISTS idx_table_schemas_name ON table_schemas(full_name);

-- Document metadata for R2 documents (contracts, policies, etc.)
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    content_type TEXT,
    category TEXT,
    description TEXT,
    r2_key TEXT NOT NULL,
    file_size INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    indexed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
