# AskMeSC Data Sync Service

PowerShell-based service that syncs data from SQL Server to Cloudflare R2/Vectorize for the AI chatbot.

## Architecture

```
SQL Server → JSON Chunks → R2 Storage → Vectorize (Embeddings)
                              ↓
                         D1 (Index Only)
```

- **R2**: Stores full table data as JSON chunks (unlimited storage)
- **Vectorize**: Stores text embeddings for semantic search
- **D1**: Lightweight index for metadata only

## Prerequisites

- Windows Server with PowerShell 5.1+
- Network access to SQL Server
- Network access to Cloudflare API

## Quick Start

### 1. Configure

Copy and edit the configuration:

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

### 2. Discover Tables

See what tables will be synced:

```powershell
.\SyncService.ps1 -DiscoverOnly
```

### 3. Run Sync

```powershell
# Dry run (no uploads)
.\SyncService.ps1 -DryRun

# Full sync
.\SyncService.ps1

# Specific database only
.\SyncService.ps1 -DatabaseName Logos

# Skip embedding generation (faster initial load)
.\SyncService.ps1 -SkipEmbeddings
```

### 4. Schedule Nightly Sync

```powershell
.\Install-ScheduledTask.ps1
```

## Configuration

### Multiple Databases

The config supports multiple databases:

```json
{
  "databases": [
    {
      "name": "Logos",
      "enabled": true,
      "sqlServer": { ... }
    },
    {
      "name": "AnotherDB",
      "enabled": false,
      "sqlServer": { ... }
    }
  ]
}
```

### Schema Filtering

Exclude schemas or specific tables:

```json
"discovery": {
  "excludeSchemas": ["sys", "INFORMATION_SCHEMA", "audit"],
  "excludeTables": ["LargeLogTable", "TempData"],
  "fullSyncTables": ["Employees", "Vendors"]
}
```

### Sanitization

Automatically skip or mask sensitive data:

```json
"sanitization": {
  "rules": [
    { "columnPattern": "SSN", "action": "skip" },
    { "columnPattern": "Password", "action": "skip" }
  ],
  "maskPatterns": [
    { "columnPattern": "Email", "action": "mask_email" },
    { "columnPattern": "Phone", "action": "mask_phone" }
  ]
}
```

## R2 Storage Structure

```
askmesc-storage/
└── databases/
    └── Logos/
        ├── _meta.json
        └── tables/
            ├── dbo_Employees/
            │   ├── _meta.json
            │   ├── data_0001.json (10,000 rows)
            │   ├── data_0002.json
            │   └── ...
            └── dbo_Permits/
                └── ...
```

## Sync Strategies

| Table Type | Strategy | Example |
|------------|----------|---------|
| Reference tables | Full sync (all rows) | Employees, Vendors |
| Tables with dates | Last N years | Transactions, Orders |
| Other tables | All rows | Everything else |

## Monitoring

View logs:

```powershell
Get-Content .\logs\sync_$(Get-Date -Format 'yyyy-MM-dd').log -Tail 100
```

Check sync status via API:

```powershell
Invoke-RestMethod "https://askmesc-api.sclg.workers.dev/api/sync/status" -Headers @{"X-Sync-API-Key"="YOUR_KEY"}
```

## Troubleshooting

### Test SQL Connection

```powershell
$conn = New-Object System.Data.SqlClient.SqlConnection
$conn.ConnectionString = "Server=DS6;Database=Logos;User Id=AskMeSC;Password=xxx"
$conn.Open()
$conn.Close()
Write-Host "Connection successful"
```

### Test Cloudflare API

```powershell
$headers = @{ "X-Sync-API-Key" = "YOUR_KEY" }
Invoke-RestMethod "https://askmesc-api.sclg.workers.dev/api/health" -Headers $headers
```

## Performance Tips

1. **Initial load**: Run with `-SkipEmbeddings` first, then run again to generate embeddings
2. **Large databases**: Run during off-hours
3. **Parallel uploads**: Adjust `r2.parallelUploads` in config (default: 4)
4. **Chunk size**: Adjust `r2.chunkSize` (default: 10,000 rows per file)
