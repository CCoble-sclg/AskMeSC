<#
.SYNOPSIS
    AskMeSC Data Sync Service - Syncs SQL Server data to Cloudflare R2/Vectorize

.DESCRIPTION
    This script connects to SQL Server databases, exports data to JSON chunks,
    uploads to R2 storage, and generates embeddings for AI search.

.EXAMPLE
    .\SyncService.ps1 -ConfigPath .\config.json

.EXAMPLE
    .\SyncService.ps1 -DiscoverOnly  # List tables without syncing

.EXAMPLE
    .\SyncService.ps1 -DatabaseName Logos  # Sync only specific database
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigPath = ".\config.json",
    
    [Parameter(Mandatory = $false)]
    [string]$DatabaseName = "",
    
    [Parameter(Mandatory = $false)]
    [switch]$FullSync,
    
    [Parameter(Mandatory = $false)]
    [switch]$DryRun,
    
    [Parameter(Mandatory = $false)]
    [switch]$DiscoverOnly,
    
    [Parameter(Mandatory = $false)]
    [switch]$SkipEmbeddings
)

$ErrorActionPreference = "Stop"
$script:StartTime = Get-Date
$script:Stats = @{
    TablesProcessed = 0
    RowsExported = 0
    ChunksUploaded = 0
    EmbeddingsGenerated = 0
    Errors = @()
}

#region Logging

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("Info", "Warning", "Error", "Debug", "Success")]
        [string]$Level = "Info"
    )
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] [$Level] $Message"
    
    switch ($Level) {
        "Error"   { Write-Host $logMessage -ForegroundColor Red }
        "Warning" { Write-Host $logMessage -ForegroundColor Yellow }
        "Debug"   { Write-Host $logMessage -ForegroundColor Gray }
        "Success" { Write-Host $logMessage -ForegroundColor Green }
        default   { Write-Host $logMessage }
    }
    
    if ($script:Config -and $script:Config.logging.logPath) {
        $logDir = $script:Config.logging.logPath
        if (-not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        $logFile = Join-Path $logDir "sync_$(Get-Date -Format 'yyyy-MM-dd').log"
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
    
    # Convert relative export path to absolute (relative to AskMeSC root folder)
    # $PSScriptRoot is the sync folder, parent is the AskMeSC folder
    $scriptFolder = $PSScriptRoot
    if (-not $scriptFolder) {
        $scriptFolder = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    $baseDir = Split-Path -Parent $scriptFolder
    
    if ($config.sync.exportPath -match '^\./|^\.\\') {
        $relativePath = $config.sync.exportPath -replace '^\./|^\.\\', ''
        $config.sync.exportPath = Join-Path $baseDir $relativePath
    }
    
    Write-Log "  Export path: $($config.sync.exportPath)" -Level Debug
    
    # Ensure export directory exists
    if ($config.sync.exportPath) {
        if (-not (Test-Path $config.sync.exportPath)) {
            Write-Log "  Creating export directory..." -Level Debug
            try {
                New-Item -ItemType Directory -Path $config.sync.exportPath -Force | Out-Null
                Write-Log "  Export directory created: $($config.sync.exportPath)" -Level Debug
            } catch {
                Write-Log "  ERROR creating export directory: $_" -Level Error
            }
        } else {
            Write-Log "  Export directory exists" -Level Debug
        }
    }
    
    return $config
}

#endregion

#region SQL Server

function Connect-SqlServer {
    param($SqlConfig)
    
    $connectionString = "Server=$($SqlConfig.server);Database=$($SqlConfig.database);"
    
    if ($SqlConfig.integratedSecurity) {
        $connectionString += "Integrated Security=True;"
    } else {
        $connectionString += "User Id=$($SqlConfig.username);Password=$($SqlConfig.password);"
    }
    
    $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
    $connection.Open()
    
    return $connection
}

function Discover-Tables {
    param($Connection, $DiscoveryConfig)
    
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
            continue
        }
        
        if ($DiscoveryConfig.excludeTables -contains $fullName -or $DiscoveryConfig.excludeTables -contains $tableName) {
            continue
        }
        
        # Check inclusions
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
            RowCount = [int64]$table.TableRowCount
        }
    }
    
    return $filteredTables
}

function Get-TableColumns {
    param($Connection, $SchemaName, $TableName)
    
    $query = "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '$SchemaName' AND TABLE_NAME = '$TableName' ORDER BY ORDINAL_POSITION"
    
    $command = New-Object System.Data.SqlClient.SqlCommand($query, $Connection)
    $reader = $command.ExecuteReader()
    
    $columns = @()
    while ($reader.Read()) {
        $columns += [PSCustomObject]@{
            ColumnName = $reader.GetString(0)
            DataType = $reader.GetString(1)
        }
    }
    $reader.Close()
    
    return $columns
}

function Get-PrimaryKeyColumn {
    param($Columns)
    
    foreach ($col in $Columns.Rows) {
        if ($col.IsPrimaryKey) {
            return $col.ColumnName
        }
    }
    
    foreach ($col in $Columns.Rows) {
        if ($col.ColumnName -in @('Id', 'ID', 'id', 'Key', 'PK')) {
            return $col.ColumnName
        }
        if ($col.ColumnName -like "*ID" -or $col.ColumnName -like "*Id") {
            return $col.ColumnName
        }
    }
    
    if ($Columns.Rows.Count -gt 0) {
        return $Columns.Rows[0].ColumnName
    }
    
    return $null
}

function Export-TableToChunks {
    param(
        $Connection,
        $SchemaName,
        $TableName,
        $Columns,
        $DbConfig,
        $ChunkSize,
        $ExportPath
    )
    
    Write-Log "    Starting export for $SchemaName.$TableName" -Level Debug
    
    # Check if columns exist
    if ($null -eq $Columns -or $Columns.Count -eq 0) {
        Write-Log "    No columns found for table" -Level Warning
        return @()
    }
    
    Write-Log "    Found $($Columns.Count) columns" -Level Debug
    
    # Debug: show first column
    if ($Columns.Count -gt 0) {
        Write-Log "    First col: $($Columns[0].ColumnName) ($($Columns[0].DataType))" -Level Debug
    }
    
    # Build column list
    $selectColumns = @()
    $binaryColumns = @('image', 'varbinary', 'binary', 'timestamp', 'rowversion')
    
    foreach ($col in $Columns) {
        $colName = $col.ColumnName
        $dataType = $col.DataType
        
        if ([string]::IsNullOrWhiteSpace($dataType)) { 
            Write-Log "      Skipping column $colName - no data type" -Level Debug
            continue 
        }
        $dataTypeLower = $dataType.ToLower()
        if ($dataTypeLower -in $binaryColumns) {
            Write-Log "      Skipping binary column: $colName ($dataTypeLower)" -Level Debug
            continue
        }
        $selectColumns += "[$colName]"
    }
    
    Write-Log "    Selected $($selectColumns.Count) columns for export" -Level Debug
    
    if ($selectColumns.Count -eq 0) {
        Write-Log "    No exportable columns (all binary?)" -Level Warning
        return @()
    }
    
    $columnList = $selectColumns -join ", "
    $fullName = "$SchemaName.$TableName"
    $tableKey = $fullName -replace '\.', '_'
    
    # Create export directory for this table
    $tableExportPath = Join-Path $ExportPath $tableKey
    if (-not (Test-Path $tableExportPath)) {
        New-Item -ItemType Directory -Path $tableExportPath -Force | Out-Null
    }
    
    # Determine query strategy
    $dateColumn = $null
    foreach ($col in $Columns.Rows) {
        if ($null -eq $col.DataType -or $null -eq $col.ColumnName) { continue }
        if ($DbConfig.discovery.dateColumnNames) {
            foreach ($dateName in $DbConfig.discovery.dateColumnNames) {
                if ($col.ColumnName -eq $dateName -or $col.ColumnName -like "*$dateName*") {
                    $dataType = $col.DataType.ToString().ToLower()
                    if ($dataType -in @('datetime', 'datetime2', 'date', 'smalldatetime')) {
                        $dateColumn = $col.ColumnName
                        break
                    }
                }
            }
        }
        if ($dateColumn) { break }
    }
    
    # Check if full sync table
    $isFullSyncTable = $false
    if ($DbConfig.discovery.fullSyncTables) {
        foreach ($fst in $DbConfig.discovery.fullSyncTables) {
            if ($TableName -eq $fst -or $TableName -like "*$fst*") {
                $isFullSyncTable = $true
                break
            }
        }
    }
    
    # Build query
    if ($isFullSyncTable -or -not $dateColumn) {
        $query = "SELECT $columnList FROM [$SchemaName].[$TableName]"
        $strategy = if ($isFullSyncTable) { "Full sync (reference table)" } else { "Full table scan" }
    } else {
        $yearsBack = $DbConfig.discovery.dateFilterYears
        $query = "SELECT $columnList FROM [$SchemaName].[$TableName] WHERE [$dateColumn] >= DATEADD(year, -$yearsBack, GETDATE())"
        $strategy = "Date filter (last $yearsBack years)"
    }
    
    Write-Log "    Strategy: $strategy" -Level Debug
    
    # Execute query
    $command = New-Object System.Data.SqlClient.SqlCommand($query, $Connection)
    $command.CommandTimeout = 600  # 10 minute timeout
    
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
    $dataTable = New-Object System.Data.DataTable
    
    try {
        $adapter.Fill($dataTable) | Out-Null
    }
    catch {
        Write-Log "    Error querying table: $_" -Level Error
        return @()
    }
    
    if ($dataTable.Rows.Count -eq 0) {
        Write-Log "    No rows to export" -Level Info
        return @()
    }
    
    Write-Log "    Retrieved $($dataTable.Rows.Count) rows" -Level Info
    
    # Get primary key column
    $pkColumn = Get-PrimaryKeyColumn -Columns $Columns
    
    # Export in chunks
    $chunks = @()
    $totalRows = $dataTable.Rows.Count
    $chunkIndex = 1
    $rowIndex = 0
    
    while ($rowIndex -lt $totalRows) {
        $chunkRows = @()
        $endIndex = [Math]::Min($rowIndex + $ChunkSize - 1, $totalRows - 1)
        
        for ($i = $rowIndex; $i -le $endIndex; $i++) {
            $row = $dataTable.Rows[$i]
            $record = @{}
            
            foreach ($col in $Columns) {
                $colName = $col.ColumnName
                if ([string]::IsNullOrEmpty($colName) -or [string]::IsNullOrEmpty($col.DataType)) { continue }
                $dataType = $col.DataType.ToLower()
                
                if ($dataType -in $binaryColumns) {
                    continue
                }
                
                # Check if should skip (sanitization)
                $shouldSkip = $false
                if ($DbConfig.sanitization -and $DbConfig.sanitization.rules) {
                    foreach ($rule in $DbConfig.sanitization.rules) {
                        if ($colName -like "*$($rule.columnPattern)*" -and $rule.action -eq "skip") {
                            $shouldSkip = $true
                            break
                        }
                    }
                }
                if ($shouldSkip) { continue }
                
                try {
                    $value = $row.$colName
                } catch {
                    $value = $null
                }
                
                if ($null -eq $value -or $value -is [DBNull]) {
                    $record[$colName] = $null
                } else {
                    $strValue = $value.ToString()
                    
                    # Apply masking
                    if ($DbConfig.sanitization -and $DbConfig.sanitization.maskPatterns) {
                        foreach ($pattern in $DbConfig.sanitization.maskPatterns) {
                            if ($colName -like "*$($pattern.columnPattern)*") {
                                switch ($pattern.action) {
                                    "mask_email" {
                                        if ($strValue -match "^(.)[^@]*(@.*)$") {
                                            $strValue = $Matches[1] + "****" + $Matches[2]
                                        }
                                    }
                                    "mask_phone" {
                                        $digits = $strValue -replace "[^\d]", ""
                                        if ($digits.Length -ge 4) {
                                            $strValue = "(***) ***-" + $digits.Substring($digits.Length - 4)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    $record[$colName] = $strValue
                }
            }
            
            # Add primary key as _id
            if ($pkColumn -and $record.ContainsKey($pkColumn) -and $null -ne $record[$pkColumn]) {
                $record["_id"] = $record[$pkColumn].ToString()
            } else {
                $record["_id"] = [guid]::NewGuid().ToString()
            }
            
            $chunkRows += $record
        }
        
        # Write chunk to file
        $chunkFileName = "data_{0:D4}.json" -f $chunkIndex
        $chunkFilePath = Join-Path $tableExportPath $chunkFileName
        
        $chunkData = @{
            database = $DbConfig.name
            table = $fullName
            tableKey = $tableKey
            chunkIndex = $chunkIndex
            rowCount = $chunkRows.Count
            rows = $chunkRows
        }
        
        if ($script:Config.r2.compressJson) {
            $chunkData | ConvertTo-Json -Depth 10 -Compress | Set-Content -Path $chunkFilePath -Encoding UTF8
        } else {
            $chunkData | ConvertTo-Json -Depth 10 | Set-Content -Path $chunkFilePath -Encoding UTF8
        }
        
        $chunks += @{
            FilePath = $chunkFilePath
            FileName = $chunkFileName
            ChunkIndex = $chunkIndex
            RowCount = $chunkRows.Count
            R2Key = "databases/$($DbConfig.name)/tables/$tableKey/$chunkFileName"
        }
        
        $script:Stats.RowsExported += $chunkRows.Count
        $rowIndex = $endIndex + 1
        $chunkIndex++
    }
    
    Write-Log "    Exported to $($chunks.Count) chunk(s)" -Level Info
    
    # Write table metadata
    $metaFilePath = Join-Path $tableExportPath "_meta.json"
    $metaData = @{
        database = $DbConfig.name
        schema = $SchemaName
        table = $TableName
        fullName = $fullName
        tableKey = $tableKey
        totalRows = $totalRows
        chunkCount = $chunks.Count
        primaryKey = $pkColumn
        columns = @($Columns | ForEach-Object { @{ name = $_.ColumnName; type = $_.DataType } })
        exportedAt = (Get-Date).ToString("o")
    }
    $metaData | ConvertTo-Json -Depth 5 | Set-Content -Path $metaFilePath -Encoding UTF8
    
    return $chunks
}

#endregion

#region Cloudflare R2 Upload

function Upload-ChunkToR2 {
    param(
        $ChunkInfo,
        $CloudflareConfig
    )
    
    $uri = "$($CloudflareConfig.apiUrl)/api/sync/r2/upload"
    
    $fileContent = [System.IO.File]::ReadAllText($ChunkInfo.FilePath, [System.Text.Encoding]::UTF8)
    
    $body = @{
        key = $ChunkInfo.R2Key
        content = $fileContent
        contentType = "application/json"
    } | ConvertTo-Json -Depth 10 -Compress
    
    $headers = @{
        "Content-Type" = "application/json"
        "X-Sync-API-Key" = $CloudflareConfig.syncApiKey
    }
    
    if ($script:DryRun) {
        Write-Log "      DRY RUN: Would upload $($ChunkInfo.R2Key)" -Level Debug
        return $true
    }
    
    $attempt = 1
    $maxAttempts = $script:Config.sync.retryAttempts
    
    while ($attempt -le $maxAttempts) {
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 120
            return $true
        }
        catch {
            Write-Log "      Upload attempt $attempt failed: $_" -Level Warning
            if ($attempt -lt $maxAttempts) {
                Start-Sleep -Milliseconds $script:Config.sync.retryDelayMs
                $attempt++
            } else {
                return $false
            }
        }
    }
    return $false
}

function Upload-TableMetaToR2 {
    param(
        $MetaFilePath,
        $R2Key,
        $CloudflareConfig
    )
    
    if (-not (Test-Path $MetaFilePath)) {
        Write-Log "      Metadata file not found: $MetaFilePath" -Level Warning
        return $false
    }
    
    $uri = "$($CloudflareConfig.apiUrl)/api/sync/r2/upload"
    
    $fileContent = [System.IO.File]::ReadAllText($MetaFilePath, [System.Text.Encoding]::UTF8)
    
    if ([string]::IsNullOrWhiteSpace($fileContent)) {
        Write-Log "      Metadata file is empty" -Level Warning
        return $false
    }
    
    $body = @{
        key = $R2Key
        content = $fileContent
        contentType = "application/json"
    } | ConvertTo-Json -Depth 10 -Compress
    
    $headers = @{
        "Content-Type" = "application/json"
        "X-Sync-API-Key" = $CloudflareConfig.syncApiKey
    }
    
    if ($script:DryRun) {
        return $true
    }
    
    try {
        Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 60 | Out-Null
        return $true
    }
    catch {
        Write-Log "      Failed to upload metadata: $_" -Level Warning
        return $false
    }
}

function Request-EmbeddingGeneration {
    param(
        $DatabaseName,
        $TableKey,
        $CloudflareConfig
    )
    
    $uri = "$($CloudflareConfig.apiUrl)/api/sync/embeddings/generate"
    
    $body = @{
        database = $DatabaseName
        tableKey = $TableKey
    } | ConvertTo-Json
    
    $headers = @{
        "Content-Type" = "application/json"
        "X-Sync-API-Key" = $CloudflareConfig.syncApiKey
    }
    
    if ($script:DryRun -or $script:SkipEmbeddings) {
        return $true
    }
    
    try {
        # Batch embedding should be faster, give it 60 seconds
        $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 60
        return $response
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Status -eq 'Timeout') {
            Write-Log "      Embedding request timed out (will process in background)" -Level Warning
            return @{ queued = $true }
        }
        Write-Log "      Failed to generate embeddings: $_" -Level Warning
        return $null
    }
    catch {
        Write-Log "      Failed to generate embeddings: $_" -Level Warning
        return $null
    }
}

#endregion

#region Main

function Start-Sync {
    Write-Log "========================================" -Level Info
    Write-Log "AskMeSC R2 Data Sync Starting" -Level Info
    Write-Log "Config: $ConfigPath" -Level Info
    Write-Log "Full Sync: $FullSync" -Level Info
    Write-Log "Dry Run: $DryRun" -Level Info
    Write-Log "Discover Only: $DiscoverOnly" -Level Info
    Write-Log "Skip Embeddings: $SkipEmbeddings" -Level Info
    if ($DatabaseName) { Write-Log "Database Filter: $DatabaseName" -Level Info }
    Write-Log "========================================" -Level Info
    
    # Load configuration
    $script:Config = Load-Configuration -Path $ConfigPath
    
    # Process each enabled database
    foreach ($dbConfig in $script:Config.databases) {
        if (-not $dbConfig.enabled) {
            Write-Log "Skipping disabled database: $($dbConfig.name)" -Level Info
            continue
        }
        
        if ($DatabaseName -and $dbConfig.name -ne $DatabaseName) {
            continue
        }
        
        Write-Log "" -Level Info
        Write-Log "Processing database: $($dbConfig.name)" -Level Info
        Write-Log "-" * 50 -Level Info
        
        # Connect to SQL Server
        Write-Log "Connecting to $($dbConfig.sqlServer.server)/$($dbConfig.sqlServer.database)..." -Level Info
        
        try {
            $connection = Connect-SqlServer -SqlConfig $dbConfig.sqlServer
            Write-Log "Connected successfully" -Level Success
        }
        catch {
            Write-Log "Failed to connect: $_" -Level Error
            $script:Stats.Errors += "Database $($dbConfig.name): Connection failed - $_"
            continue
        }
        
        try {
            # Discover tables
            Write-Log "Discovering tables..." -Level Info
            $tables = Discover-Tables -Connection $connection -DiscoveryConfig $dbConfig.discovery
            Write-Log "Found $($tables.Count) tables to process" -Level Info
            
            if ($DiscoverOnly) {
                Write-Log "" -Level Info
                Write-Log "Tables in $($dbConfig.name):" -Level Info
                Write-Log "-" * 60 -Level Info
                $totalRows = 0
                foreach ($t in $tables | Sort-Object -Property RowCount -Descending) {
                    Write-Log ("  {0,-45} {1,12:N0} rows" -f $t.FullName, $t.RowCount) -Level Info
                    $totalRows += $t.RowCount
                }
                Write-Log "-" * 60 -Level Info
                Write-Log ("  {0,-45} {1,12:N0} total" -f "TOTAL ($($tables.Count) tables)", $totalRows) -Level Info
                continue
            }
            
            # Create database export directory
            $dbExportPath = Join-Path $script:Config.sync.exportPath $dbConfig.name
            if (-not (Test-Path $dbExportPath)) {
                New-Item -ItemType Directory -Path $dbExportPath -Force | Out-Null
            }
            
            # Process each table
            foreach ($tableInfo in $tables) {
                Write-Log "" -Level Info
                Write-Log "  Processing: $($tableInfo.FullName) ($($tableInfo.RowCount) rows)" -Level Info
                
                try {
                    # Get columns
                    $columns = Get-TableColumns -Connection $connection -SchemaName $tableInfo.Schema -TableName $tableInfo.Table
                    
                    Write-Log "    Got $($columns.Count) columns from schema query" -Level Debug
                    
                    if ($null -eq $columns -or $columns.Count -eq 0) {
                        Write-Log "    No columns found, skipping (check VIEW DEFINITION permission)" -Level Warning
                        continue
                    }
                    
                    # Export to chunks
                    $chunks = Export-TableToChunks `
                        -Connection $connection `
                        -SchemaName $tableInfo.Schema `
                        -TableName $tableInfo.Table `
                        -Columns $columns `
                        -DbConfig $dbConfig `
                        -ChunkSize $script:Config.r2.chunkSize `
                        -ExportPath $dbExportPath
                    
                    if ($chunks.Count -eq 0) {
                        continue
                    }
                    
                    # Upload chunks to R2
                    Write-Log "    Uploading to R2..." -Level Info
                    $uploadedCount = 0
                    foreach ($chunk in $chunks) {
                        $success = Upload-ChunkToR2 -ChunkInfo $chunk -CloudflareConfig $script:Config.cloudflare
                        if ($success) {
                            $uploadedCount++
                            $script:Stats.ChunksUploaded++
                        }
                    }
                    Write-Log "    Uploaded $uploadedCount/$($chunks.Count) chunks" -Level Info
                    
                    # Upload table metadata
                    $tableKey = $tableInfo.FullName -replace '\.', '_'
                    $metaFilePath = Join-Path (Join-Path $dbExportPath $tableKey) "_meta.json"
                    $metaR2Key = "databases/$($dbConfig.name)/tables/$tableKey/_meta.json"
                    Upload-TableMetaToR2 -MetaFilePath $metaFilePath -R2Key $metaR2Key -CloudflareConfig $script:Config.cloudflare | Out-Null
                    
                    # Request embedding generation
                    if (-not $SkipEmbeddings) {
                        Write-Log "    Generating embeddings..." -Level Info
                        $embedResult = Request-EmbeddingGeneration -DatabaseName $dbConfig.name -TableKey $tableKey -CloudflareConfig $script:Config.cloudflare
                        if ($embedResult) {
                            Write-Log "    Embeddings queued" -Level Info
                        }
                    }
                    
                    $script:Stats.TablesProcessed++
                }
                catch {
                    Write-Log "    Error processing table: $_" -Level Error
                    $script:Stats.Errors += "$($tableInfo.FullName): $_"
                }
            }
            
            # Write database metadata
            $dbMetaPath = Join-Path $dbExportPath "_meta.json"
            $dbMeta = @{
                name = $dbConfig.name
                server = $dbConfig.sqlServer.server
                database = $dbConfig.sqlServer.database
                tableCount = $tables.Count
                syncedAt = (Get-Date).ToString("o")
            }
            $dbMeta | ConvertTo-Json | Set-Content -Path $dbMetaPath -Encoding UTF8
            
            # Upload database metadata to R2
            $dbMetaR2Key = "databases/$($dbConfig.name)/_meta.json"
            Upload-TableMetaToR2 -MetaFilePath $dbMetaPath -R2Key $dbMetaR2Key -CloudflareConfig $script:Config.cloudflare | Out-Null
        }
        finally {
            $connection.Close()
            $connection.Dispose()
        }
    }
    
    # Print summary
    $duration = (Get-Date) - $script:StartTime
    
    Write-Log "" -Level Info
    Write-Log "========================================" -Level Info
    Write-Log "Sync Complete" -Level Success
    Write-Log "  Tables processed: $($script:Stats.TablesProcessed)" -Level Info
    Write-Log "  Rows exported: $($script:Stats.RowsExported)" -Level Info
    Write-Log "  Chunks uploaded: $($script:Stats.ChunksUploaded)" -Level Info
    Write-Log "  Duration: $($duration.ToString('hh\:mm\:ss'))" -Level Info
    
    if ($script:Stats.Errors.Count -gt 0) {
        Write-Log "" -Level Info
        Write-Log "Errors encountered:" -Level Warning
        foreach ($err in $script:Stats.Errors) {
            Write-Log "  - $err" -Level Warning
        }
    }
    
    Write-Log "========================================" -Level Info
}

# Run the sync
Start-Sync
