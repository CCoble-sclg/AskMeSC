# AskMeSC Data Sync Service

PowerShell-based service that syncs data from SQL Server to Cloudflare for the AI chatbot.

## Prerequisites

- Windows Server with PowerShell 5.1+
- Access to SQL Server database
- Network access to Cloudflare API

## Setup

### 1. Configure the sync

Copy the example configuration and edit:

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

Update these settings:
- `sqlServer.server` - Your SQL Server hostname
- `sqlServer.database` - Database name
- `cloudflare.apiUrl` - Your deployed Worker URL
- `cloudflare.syncApiKey` - Secret key (set in Cloudflare Workers)

### 2. Configure tables to sync

Edit the `tables` array in `config.json`:

```json
{
  "tables": [
    {
      "source": "dbo.YourTable",
      "target": "your_table",
      "columns": [
        { "source": "ID", "target": "id", "primaryKey": true },
        { "source": "Description", "target": "description", "embed": true },
        { "source": "SSN", "skip": true }
      ],
      "modifiedColumn": "LastModified",
      "embedFields": ["description"]
    }
  ]
}
```

Column options:
- `primaryKey` - Use as the unique identifier
- `embed` - Include in text for AI embeddings
- `skip` - Don't sync this column
- `sanitize` - Apply sanitization rule:
  - `mask_name` - "John Smith" → "J*** S****"
  - `mask_ssn` - "123-45-6789" → "***-**-6789"
  - `mask_phone` - "(555) 123-4567" → "(***) ***-4567"
  - `redact` - Replace with "[REDACTED]"

### 3. Test the sync

Run manually first:

```powershell
# Dry run (no actual uploads)
.\SyncService.ps1 -DryRun

# Test with real upload
.\SyncService.ps1

# Full sync (ignore last sync time)
.\SyncService.ps1 -FullSync
```

### 4. Install scheduled task

```powershell
# Run as Administrator
.\Install-ScheduledTask.ps1

# Custom time (default is 2 AM)
.\Install-ScheduledTask.ps1 -Time "03:30"

# Different user account
.\Install-ScheduledTask.ps1 -User "DOMAIN\ServiceAccount"
```

## Monitoring

Logs are stored in the `logs` folder (configurable in `config.json`).

View recent logs:
```powershell
Get-Content .\logs\sync_$(Get-Date -Format 'yyyy-MM-dd').log -Tail 50
```

Check task status:
```powershell
Get-ScheduledTask -TaskName "AskMeSC-DataSync" | Select-Object State, LastRunTime, LastTaskResult
```

## Troubleshooting

### Connection issues

Test SQL Server connectivity:
```powershell
$conn = New-Object System.Data.SqlClient.SqlConnection
$conn.ConnectionString = "Server=YOUR_SERVER;Database=YOUR_DB;Integrated Security=True"
$conn.Open()
$conn.Close()
```

### API issues

Test Cloudflare API:
```powershell
$headers = @{ "X-Sync-API-Key" = "YOUR_KEY" }
Invoke-RestMethod -Uri "https://your-api.workers.dev/api/health" -Headers $headers
```

## Security Notes

- The `config.json` file contains sensitive credentials - do not commit to git
- Use Windows Integrated Security where possible
- Store the Cloudflare sync API key securely
- Review sanitization rules for PII before first sync
