<#
.SYNOPSIS
    AskMeSC Data Sync Service - Syncs SQL Server data to Cloudflare D1/Vectorize

.DESCRIPTION
    This script connects to your SQL Server database, extracts and sanitizes data,
    and uploads it to Cloudflare for the AI chatbot to query.

.EXAMPLE
    .\SyncService.ps1 -ConfigPath .\config.json

.EXAMPLE
    .\SyncService.ps1 -ConfigPath .\config.json -FullSync
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath = ".\config.json",
    
    [Parameter(Mandatory = $false)]
    [switch]$FullSync,
    
    [Parameter(Mandatory = $false)]
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$script:StartTime = Get-Date

#region Logging

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("Info", "Warning", "Error", "Debug")]
        [string]$Level = "Info"
    )
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] [$Level] $Message"
    
    switch ($Level) {
        "Error"   { Write-Host $logMessage -ForegroundColor Red }
        "Warning" { Write-Host $logMessage -ForegroundColor Yellow }
        "Debug"   { Write-Host $logMessage -ForegroundColor Gray }
        default   { Write-Host $logMessage }
    }
    
    if ($script:Config.logging.logPath) {
        $logFile = Join-Path $script:Config.logging.logPath "sync_$(Get-Date -Format 'yyyy-MM-dd').log"
        Add-Content -Path $logFile -Value $logMessage
    }
}

#endregion

#region Configuration

function Load-Configuration {
    param([string]$Path)
    
    if (-not (Test-Path $Path)) {
        throw "Configuration file not found: $Path"
    }
    
    $config = Get-Content $Path -Raw | ConvertFrom-Json
    
    # Ensure log directory exists
    if ($config.logging.logPath -and -not (Test-Path $config.logging.logPath)) {
        New-Item -ItemType Directory -Path $config.logging.logPath -Force | Out-Null
    }
    
    return $config
}

#endregion

#region SQL Server

function Connect-SqlServer {
    param($Config)
    
    $connectionString = "Server=$($Config.server);Database=$($Config.database);"
    
    if ($Config.integratedSecurity) {
        $connectionString += "Integrated Security=True;"
    } else {
        $connectionString += "User Id=$($Config.username);Password=$($Config.password);"
    }
    
    $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
    $connection.Open()
    
    return $connection
}

function Get-TableData {
    param(
        $Connection,
        $TableConfig,
        [datetime]$LastSync
    )
    
    $columns = ($TableConfig.columns | Where-Object { -not $_.skip } | ForEach-Object { $_.source }) -join ", "
    $query = "SELECT $columns FROM $($TableConfig.source)"
    
    if (-not $script:FullSync -and $TableConfig.modifiedColumn -and $LastSync) {
        $query += " WHERE $($TableConfig.modifiedColumn) > @LastSync"
    }
    
    Write-Log "Executing query: $query" -Level Debug
    
    $command = New-Object System.Data.SqlClient.SqlCommand($query, $Connection)
    
    if (-not $script:FullSync -and $LastSync) {
        $command.Parameters.AddWithValue("@LastSync", $LastSync) | Out-Null
    }
    
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
    $dataTable = New-Object System.Data.DataTable
    $adapter.Fill($dataTable) | Out-Null
    
    return $dataTable
}

#endregion

#region Data Transformation

function Sanitize-Value {
    param(
        [string]$Value,
        [string]$SanitizeRule
    )
    
    if ([string]::IsNullOrEmpty($Value)) { return $Value }
    
    switch ($SanitizeRule) {
        "mask_name" {
            # Keep first letter, mask rest: "John Smith" -> "J*** S****"
            $parts = $Value -split " "
            $masked = $parts | ForEach-Object {
                if ($_.Length -gt 1) {
                    $_.Substring(0, 1) + ("*" * ($_.Length - 1))
                } else {
                    $_
                }
            }
            return $masked -join " "
        }
        "mask_ssn" {
            # Show last 4: "123-45-6789" -> "***-**-6789"
            if ($Value -match "\d{3}-\d{2}-\d{4}") {
                return "***-**-" + $Value.Substring($Value.Length - 4)
            }
            return "***-**-****"
        }
        "mask_phone" {
            # Show last 4: "(555) 123-4567" -> "(***) ***-4567"
            $digits = $Value -replace "[^\d]", ""
            if ($digits.Length -ge 4) {
                return "(***) ***-" + $digits.Substring($digits.Length - 4)
            }
            return $Value
        }
        "redact" {
            return "[REDACTED]"
        }
        default {
            return $Value
        }
    }
}

function Transform-Record {
    param(
        $Row,
        $TableConfig
    )
    
    $record = @{
        id = $null
        table = $TableConfig.target
        content = ""
        metadata = @{}
    }
    
    $contentParts = @()
    
    foreach ($colConfig in $TableConfig.columns) {
        if ($colConfig.skip) { continue }
        
        $sourceValue = $Row.($colConfig.source)
        
        # Handle null values
        if ($null -eq $sourceValue -or $sourceValue -is [DBNull]) {
            $sourceValue = ""
        } else {
            $sourceValue = $sourceValue.ToString()
        }
        
        # Apply sanitization
        if ($colConfig.sanitize) {
            $sourceValue = Sanitize-Value -Value $sourceValue -SanitizeRule $colConfig.sanitize
        }
        
        # Set primary key
        if ($colConfig.primaryKey) {
            $record.id = $sourceValue
        }
        
        # Build content for embedding
        if ($colConfig.embed -or ($TableConfig.embedFields -contains $colConfig.target)) {
            if (-not [string]::IsNullOrWhiteSpace($sourceValue)) {
                $contentParts += "$($colConfig.target): $sourceValue"
            }
        }
        
        # Add to metadata
        $record.metadata[$colConfig.target] = $sourceValue
    }
    
    $record.content = $contentParts -join "`n"
    
    return $record
}

#endregion

#region Cloudflare API

function Send-ToCloudflare {
    param(
        $Records,
        $TableName,
        $Config
    )
    
    $uri = "$($Config.cloudflare.apiUrl)/api/sync/upload"
    
    $body = @{
        table = $TableName
        records = $Records
    } | ConvertTo-Json -Depth 10
    
    $headers = @{
        "Content-Type" = "application/json"
        "X-Sync-API-Key" = $Config.cloudflare.syncApiKey
    }
    
    if ($script:DryRun) {
        Write-Log "DRY RUN: Would upload $($Records.Count) records to $TableName" -Level Info
        return @{ success = $true; inserted = $Records.Count; embedded = 0 }
    }
    
    $attempt = 1
    $maxAttempts = $Config.sync.retryAttempts
    
    while ($attempt -le $maxAttempts) {
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body
            return $response
        }
        catch {
            Write-Log "Upload attempt $attempt failed: $_" -Level Warning
            
            if ($attempt -lt $maxAttempts) {
                Start-Sleep -Milliseconds $Config.sync.retryDelayMs
                $attempt++
            } else {
                throw "Failed to upload after $maxAttempts attempts: $_"
            }
        }
    }
}

#endregion

#region State Management

function Get-LastSyncTime {
    param([string]$TableName)
    
    $stateFile = ".\sync_state.json"
    
    if (Test-Path $stateFile) {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($state.$TableName) {
            return [datetime]$state.$TableName
        }
    }
    
    return [datetime]::MinValue
}

function Set-LastSyncTime {
    param(
        [string]$TableName,
        [datetime]$SyncTime
    )
    
    $stateFile = ".\sync_state.json"
    
    $state = @{}
    if (Test-Path $stateFile) {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable
    }
    
    $state[$TableName] = $SyncTime.ToString("o")
    $state | ConvertTo-Json | Set-Content $stateFile
}

#endregion

#region Main

function Start-Sync {
    Write-Log "========================================" -Level Info
    Write-Log "AskMeSC Data Sync Starting" -Level Info
    Write-Log "Config: $ConfigPath" -Level Info
    Write-Log "Full Sync: $FullSync" -Level Info
    Write-Log "Dry Run: $DryRun" -Level Info
    Write-Log "========================================" -Level Info
    
    # Load configuration
    $script:Config = Load-Configuration -Path $ConfigPath
    
    # Connect to SQL Server
    Write-Log "Connecting to SQL Server: $($script:Config.sqlServer.server)" -Level Info
    $connection = Connect-SqlServer -Config $script:Config.sqlServer
    Write-Log "Connected successfully" -Level Info
    
    $totalRecords = 0
    $totalEmbedded = 0
    
    try {
        foreach ($tableConfig in $script:Config.tables) {
            Write-Log "Processing table: $($tableConfig.source) -> $($tableConfig.target)" -Level Info
            
            $lastSync = Get-LastSyncTime -TableName $tableConfig.target
            Write-Log "Last sync: $lastSync" -Level Debug
            
            # Get data from SQL Server
            $data = Get-TableData -Connection $connection -TableConfig $tableConfig -LastSync $lastSync
            Write-Log "Retrieved $($data.Rows.Count) rows" -Level Info
            
            if ($data.Rows.Count -eq 0) {
                Write-Log "No new records to sync" -Level Info
                continue
            }
            
            # Transform records
            $records = @()
            foreach ($row in $data.Rows) {
                $record = Transform-Record -Row $row -TableConfig $tableConfig
                $records += $record
            }
            
            # Upload in batches
            $batchSize = $script:Config.sync.batchSize
            $batches = [math]::Ceiling($records.Count / $batchSize)
            
            for ($i = 0; $i -lt $batches; $i++) {
                $start = $i * $batchSize
                $batch = $records[$start..([math]::Min($start + $batchSize - 1, $records.Count - 1))]
                
                Write-Log "Uploading batch $($i + 1)/$batches ($($batch.Count) records)" -Level Info
                
                $result = Send-ToCloudflare -Records $batch -TableName $tableConfig.target -Config $script:Config
                
                $totalRecords += $result.inserted
                $totalEmbedded += $result.embedded
                
                if ($result.errors) {
                    foreach ($error in $result.errors) {
                        Write-Log "Batch error: $error" -Level Warning
                    }
                }
            }
            
            # Update sync state
            if (-not $DryRun) {
                Set-LastSyncTime -TableName $tableConfig.target -SyncTime (Get-Date)
            }
        }
    }
    finally {
        $connection.Close()
        $connection.Dispose()
    }
    
    $duration = (Get-Date) - $script:StartTime
    
    Write-Log "========================================" -Level Info
    Write-Log "Sync Complete" -Level Info
    Write-Log "Total records: $totalRecords" -Level Info
    Write-Log "Total embeddings: $totalEmbedded" -Level Info
    Write-Log "Duration: $($duration.TotalSeconds.ToString('F2')) seconds" -Level Info
    Write-Log "========================================" -Level Info
}

# Run the sync
Start-Sync
