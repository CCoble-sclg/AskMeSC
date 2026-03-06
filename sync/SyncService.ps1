<#
.SYNOPSIS
    AskMeSC Data Sync Service - Syncs SQL Server data to Cloudflare D1/Vectorize

.DESCRIPTION
    This script connects to your SQL Server database, automatically discovers tables,
    extracts and sanitizes data, and uploads it to Cloudflare for the AI chatbot to query.

.EXAMPLE
    .\SyncService.ps1 -ConfigPath .\config.json

.EXAMPLE
    .\SyncService.ps1 -ConfigPath .\config.json -FullSync

.EXAMPLE
    .\SyncService.ps1 -DiscoverOnly  # Just list tables that would be synced
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath = ".\config.json",
    
    [Parameter(Mandatory = $false)]
    [switch]$FullSync,
    
    [Parameter(Mandatory = $false)]
    [switch]$DryRun,
    
    [Parameter(Mandatory = $false)]
    [switch]$DiscoverOnly
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
        "Debug"   { if ($script:Config.logging.logLevel -eq "Debug") { Write-Host $logMessage -ForegroundColor Gray } }
        default   { Write-Host $logMessage }
    }
    
    if ($script:Config.logging.logPath) {
        $logFile = Join-Path $script:Config.logging.logPath "sync_$(Get-Date -Format 'yyyy-MM-dd').log"
        Add-Content -Path $logFile -Value $logMessage -ErrorAction SilentlyContinue
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

function Discover-Tables {
    param($Connection, $DiscoveryConfig)
    
    Write-Log "Discovering tables..." -Level Info
    
    $query = @"
SELECT 
    s.name AS SchemaName,
    t.name AS TableName,
    SUM(p.rows) AS TableRowCount
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
INNER JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
WHERE t.type = 'U'
GROUP BY s.name, t.name
ORDER BY s.name, t.name
"@
    
    $command = New-Object System.Data.SqlClient.SqlCommand($query, $Connection)
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
    $tables = New-Object System.Data.DataTable
    $adapter.Fill($tables) | Out-Null
    
    $filteredTables = @()
    
    foreach ($table in $tables.Rows) {
        $schemaName = $table.SchemaName
        $tableName = $table.TableName
        $fullName = "$schemaName.$tableName"
        
        # Check exclusions
        if ($DiscoveryConfig.excludeSchemas -contains $schemaName) {
            Write-Log "  Excluding $fullName (schema excluded)" -Level Debug
            continue
        }
        
        if ($DiscoveryConfig.excludeTables -contains $fullName -or $DiscoveryConfig.excludeTables -contains $tableName) {
            Write-Log "  Excluding $fullName (table excluded)" -Level Debug
            continue
        }
        
        # Check inclusions (if specified, only include these)
        if ($DiscoveryConfig.includeSchemas -and $DiscoveryConfig.includeSchemas.Count -gt 0) {
            if ($DiscoveryConfig.includeSchemas -notcontains $schemaName) {
                continue
            }
        }
        
        if ($DiscoveryConfig.includeTables -and $DiscoveryConfig.includeTables.Count -gt 0) {
            if ($DiscoveryConfig.includeTables -notcontains $fullName -and $DiscoveryConfig.includeTables -notcontains $tableName) {
                continue
            }
        }
        
        $filteredTables += @{
            Schema = $schemaName
            Table = $tableName
            FullName = $fullName
            RowCount = $table.TableRowCount
        }
    }
    
    Write-Log "Found $($filteredTables.Count) tables to sync" -Level Info
    return $filteredTables
}

function Get-TableColumns {
    param($Connection, $SchemaName, $TableName)
    
    $query = @"
SELECT 
    c.name AS ColumnName,
    t.name AS DataType,
    c.max_length AS MaxLength,
    c.is_nullable AS IsNullable,
    CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS IsPrimaryKey
FROM sys.columns c
INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
LEFT JOIN (
    SELECT ic.object_id, ic.column_id
    FROM sys.index_columns ic
    INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    WHERE i.is_primary_key = 1
) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
WHERE c.object_id = OBJECT_ID('$SchemaName.$TableName')
ORDER BY c.column_id
"@
    
    $command = New-Object System.Data.SqlClient.SqlCommand($query, $Connection)
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
    $columns = New-Object System.Data.DataTable
    $adapter.Fill($columns) | Out-Null
    
    return $columns
}

function Get-TableData {
    param(
        $Connection,
        $SchemaName,
        $TableName,
        $Columns,
        [int]$MaxRecords,
        $DiscoveryConfig
    )
    
    # Build column list, excluding binary types
    $selectColumns = @()
    $dateColumn = $null
    
    foreach ($col in $Columns.Rows) {
        $dataType = $col.DataType.ToLower()
        if ($dataType -in @('image', 'varbinary', 'binary', 'timestamp', 'rowversion')) {
            continue
        }
        $selectColumns += "[$($col.ColumnName)]"
        
        # Check if this is a date column we can filter on
        if ($null -eq $dateColumn -and $DiscoveryConfig.dateColumnNames) {
            foreach ($dateName in $DiscoveryConfig.dateColumnNames) {
                if ($col.ColumnName -eq $dateName -or $col.ColumnName -like "*$dateName*") {
                    if ($dataType -in @('datetime', 'datetime2', 'date', 'smalldatetime')) {
                        $dateColumn = $col.ColumnName
                        break
                    }
                }
            }
        }
    }
    
    if ($selectColumns.Count -eq 0) {
        return $null
    }
    
    $columnList = $selectColumns -join ", "
    
    # Determine sync strategy
    $isFullSyncTable = $false
    if ($DiscoveryConfig.fullSyncTables) {
        foreach ($fst in $DiscoveryConfig.fullSyncTables) {
            if ($TableName -eq $fst -or $TableName -like "*$fst*") {
                $isFullSyncTable = $true
                break
            }
        }
    }
    
    # Build query based on strategy
    if ($isFullSyncTable) {
        # Full sync - no limit
        $query = "SELECT $columnList FROM [$SchemaName].[$TableName]"
        Write-Log "  Strategy: Full sync (reference table)" -Level Info
    }
    elseif ($dateColumn -and $DiscoveryConfig.dateFilterYears) {
        # Date filter
        $yearsBack = $DiscoveryConfig.dateFilterYears
        $query = "SELECT $columnList FROM [$SchemaName].[$TableName] WHERE [$dateColumn] >= DATEADD(year, -$yearsBack, GETDATE()) ORDER BY [$dateColumn] DESC"
        Write-Log "  Strategy: Date filter on [$dateColumn] (last $yearsBack years)" -Level Info
    }
    else {
        # Default - use TOP limit
        $query = "SELECT TOP $MaxRecords $columnList FROM [$SchemaName].[$TableName]"
        Write-Log "  Strategy: TOP $MaxRecords rows" -Level Info
    }
    
    Write-Log "  Query: $query" -Level Debug
    
    $command = New-Object System.Data.SqlClient.SqlCommand($query, $Connection)
    $command.CommandTimeout = 300  # 5 minute timeout
    
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
    $dataTable = New-Object System.Data.DataTable
    $adapter.Fill($dataTable) | Out-Null
    
    return $dataTable
}

#endregion

#region Data Transformation

function Should-SkipColumn {
    param($ColumnName, $SanitizationRules)
    
    foreach ($rule in $SanitizationRules) {
        if ($ColumnName -like "*$($rule.columnPattern)*" -and $rule.action -eq "skip") {
            return $true
        }
    }
    return $false
}

function Sanitize-Value {
    param(
        [string]$Value,
        [string]$ColumnName,
        $MaskPatterns
    )
    
    if ([string]::IsNullOrEmpty($Value)) { return $Value }
    
    foreach ($pattern in $MaskPatterns) {
        if ($ColumnName -like "*$($pattern.columnPattern)*") {
            switch ($pattern.action) {
                "mask_email" {
                    if ($Value -match "^(.)[^@]*(@.*)$") {
                        return $Matches[1] + "****" + $Matches[2]
                    }
                }
                "mask_phone" {
                    $digits = $Value -replace "[^\d]", ""
                    if ($digits.Length -ge 4) {
                        return "(***) ***-" + $digits.Substring($digits.Length - 4)
                    }
                }
                "mask_name" {
                    $parts = $Value -split " "
                    $masked = $parts | ForEach-Object {
                        if ($_.Length -gt 1) { $_.Substring(0, 1) + ("*" * ($_.Length - 1)) } else { $_ }
                    }
                    return $masked -join " "
                }
                "redact" {
                    return "[REDACTED]"
                }
            }
        }
    }
    
    return $Value
}

function Get-PrimaryKeyColumn {
    param($Columns)
    
    foreach ($col in $Columns.Rows) {
        if ($col.IsPrimaryKey) {
            return $col.ColumnName
        }
    }
    
    # Fallback: look for common ID column names
    foreach ($col in $Columns.Rows) {
        if ($col.ColumnName -in @('Id', 'ID', 'id', 'Key', 'PK')) {
            return $col.ColumnName
        }
        if ($col.ColumnName -like "*ID" -or $col.ColumnName -like "*Id") {
            return $col.ColumnName
        }
    }
    
    # Last resort: use first column
    if ($Columns.Rows.Count -gt 0) {
        return $Columns.Rows[0].ColumnName
    }
    
    return $null
}

function Should-EmbedColumn {
    param($ColumnName, $DataType, $EmbeddingConfig)
    
    # Only embed text-like columns
    $textTypes = @('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext')
    if ($DataType.ToLower() -notin $textTypes) {
        return $false
    }
    
    foreach ($pattern in $EmbeddingConfig.textColumnPatterns) {
        if ($ColumnName -like "*$pattern*") {
            return $true
        }
    }
    
    return $false
}

function Transform-Record {
    param(
        $Row,
        $Columns,
        $TableFullName,
        $PrimaryKeyColumn,
        $Config
    )
    
    $record = @{
        id = $null
        table = $TableFullName -replace '\.', '_'
        content = ""
        metadata = @{}
    }
    
    $contentParts = @()
    
    foreach ($col in $Columns.Rows) {
        $colName = $col.ColumnName
        $dataType = $col.DataType
        
        # Skip binary types
        if ($dataType.ToLower() -in @('image', 'varbinary', 'binary', 'timestamp', 'rowversion')) {
            continue
        }
        
        # Skip sensitive columns
        if (Should-SkipColumn -ColumnName $colName -SanitizationRules $Config.sanitization.rules) {
            continue
        }
        
        $value = $Row.$colName
        
        # Handle null/DBNull
        if ($null -eq $value -or $value -is [DBNull]) {
            $value = ""
        } else {
            $value = $value.ToString()
        }
        
        # Apply masking
        $value = Sanitize-Value -Value $value -ColumnName $colName -MaskPatterns $Config.sanitization.maskPatterns
        
        # Set primary key
        if ($colName -eq $PrimaryKeyColumn) {
            $record.id = $value
        }
        
        # Build content for embedding
        if (Should-EmbedColumn -ColumnName $colName -DataType $dataType -EmbeddingConfig $Config.embedding) {
            if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Length -ge $Config.embedding.minTextLength) {
                $contentParts += "$colName`: $value"
            }
        }
        
        # Add to metadata (truncate very long values)
        if ($value.Length -gt 1000) {
            $record.metadata[$colName] = $value.Substring(0, 1000) + "..."
        } else {
            $record.metadata[$colName] = $value
        }
    }
    
    $record.content = $contentParts -join "`n"
    
    # Generate ID if none found
    if (-not $record.id) {
        $record.id = [guid]::NewGuid().ToString()
    }
    
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
    } | ConvertTo-Json -Depth 10 -Compress
    
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
            $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 120
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
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
        if ($state -and $state[$TableName]) {
            return [datetime]$state[$TableName]
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
        $existing = Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
        if ($existing) { $state = $existing }
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
    Write-Log "Discover Only: $DiscoverOnly" -Level Info
    Write-Log "========================================" -Level Info
    
    # Load configuration
    $script:Config = Load-Configuration -Path $ConfigPath
    
    # Connect to SQL Server
    Write-Log "Connecting to SQL Server: $($script:Config.sqlServer.server)/$($script:Config.sqlServer.database)" -Level Info
    $connection = Connect-SqlServer -Config $script:Config.sqlServer
    Write-Log "Connected successfully" -Level Info
    
    $totalRecords = 0
    $totalEmbedded = 0
    $tablesProcessed = 0
    
    try {
        # Discover tables
        $tables = Discover-Tables -Connection $connection -DiscoveryConfig $script:Config.discovery
        
        if ($DiscoverOnly) {
            Write-Log "" -Level Info
            Write-Log "Tables that would be synced:" -Level Info
            Write-Log "-" * 60 -Level Info
            foreach ($t in $tables) {
                Write-Log ("  {0,-40} {1,10:N0} rows" -f $t.FullName, $t.RowCount) -Level Info
            }
            Write-Log "-" * 60 -Level Info
            Write-Log "Total: $($tables.Count) tables" -Level Info
            return
        }
        
        foreach ($tableInfo in $tables) {
            $schemaName = $tableInfo.Schema
            $tableName = $tableInfo.Table
            $fullName = $tableInfo.FullName
            
            Write-Log "" -Level Info
            Write-Log "Processing: $fullName ($($tableInfo.RowCount) rows)" -Level Info
            
            try {
                # Get column information
                $columns = Get-TableColumns -Connection $connection -SchemaName $schemaName -TableName $tableName
                
                if ($columns.Rows.Count -eq 0) {
                    Write-Log "  No columns found, skipping" -Level Warning
                    continue
                }
                
                # Find primary key
                $pkColumn = Get-PrimaryKeyColumn -Columns $columns
                Write-Log "  Primary key: $pkColumn" -Level Debug
                
                # Get data
                $maxRecords = $script:Config.sync.maxRecordsPerTable
                $data = Get-TableData -Connection $connection -SchemaName $schemaName -TableName $tableName -Columns $columns -MaxRecords $maxRecords -DiscoveryConfig $script:Config.discovery
                
                if ($null -eq $data -or $data.Rows.Count -eq 0) {
                    Write-Log "  No data to sync" -Level Info
                    continue
                }
                
                Write-Log "  Retrieved $($data.Rows.Count) rows" -Level Info
                
                # Transform records
                $records = @()
                foreach ($row in $data.Rows) {
                    $record = Transform-Record -Row $row -Columns $columns -TableFullName $fullName -PrimaryKeyColumn $pkColumn -Config $script:Config
                    if ($record.id) {
                        $records += $record
                    }
                }
                
                Write-Log "  Transformed $($records.Count) records" -Level Info
                
                if ($records.Count -eq 0) {
                    continue
                }
                
                # Upload in batches
                $batchSize = $script:Config.sync.batchSize
                $batches = [math]::Ceiling($records.Count / $batchSize)
                $tableTarget = $fullName -replace '\.', '_'
                
                for ($i = 0; $i -lt $batches; $i++) {
                    $start = $i * $batchSize
                    $end = [math]::Min($start + $batchSize - 1, $records.Count - 1)
                    $batch = $records[$start..$end]
                    
                    Write-Log "  Uploading batch $($i + 1)/$batches ($($batch.Count) records)" -Level Info
                    
                    $result = Send-ToCloudflare -Records $batch -TableName $tableTarget -Config $script:Config
                    
                    if ($result.success) {
                        $totalRecords += $result.inserted
                        $totalEmbedded += $result.embedded
                    }
                    
                    if ($result.errors) {
                        foreach ($error in $result.errors) {
                            Write-Log "  Batch error: $error" -Level Warning
                        }
                    }
                }
                
                $tablesProcessed++
                
                # Update sync state
                if (-not $DryRun) {
                    Set-LastSyncTime -TableName $fullName -SyncTime (Get-Date)
                }
            }
            catch {
                Write-Log "  Error processing table: $_" -Level Error
            }
        }
    }
    finally {
        $connection.Close()
        $connection.Dispose()
    }
    
    $duration = (Get-Date) - $script:StartTime
    
    Write-Log "" -Level Info
    Write-Log "========================================" -Level Info
    Write-Log "Sync Complete" -Level Info
    Write-Log "Tables processed: $tablesProcessed" -Level Info
    Write-Log "Total records: $totalRecords" -Level Info
    Write-Log "Total embeddings: $totalEmbedded" -Level Info
    Write-Log "Duration: $($duration.TotalMinutes.ToString('F2')) minutes" -Level Info
    Write-Log "========================================" -Level Info
}

# Run the sync
Start-Sync
