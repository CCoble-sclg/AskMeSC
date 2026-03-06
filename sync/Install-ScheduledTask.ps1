<#
.SYNOPSIS
    Installs the AskMeSC sync service as a Windows Scheduled Task

.DESCRIPTION
    Creates a scheduled task that runs the sync script every night at 2 AM.

.EXAMPLE
    .\Install-ScheduledTask.ps1

.EXAMPLE
    .\Install-ScheduledTask.ps1 -Time "03:00" -User "DOMAIN\ServiceAccount"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Time = "02:00",
    
    [Parameter(Mandatory = $false)]
    [string]$User = $env:USERNAME,
    
    [Parameter(Mandatory = $false)]
    [switch]$Remove
)

$TaskName = "AskMeSC-DataSync"
$ScriptPath = Join-Path $PSScriptRoot "SyncService.ps1"
$ConfigPath = Join-Path $PSScriptRoot "config.json"

if ($Remove) {
    Write-Host "Removing scheduled task: $TaskName"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Task removed successfully"
    exit 0
}

# Verify files exist
if (-not (Test-Path $ScriptPath)) {
    Write-Error "Sync script not found: $ScriptPath"
    exit 1
}

if (-not (Test-Path $ConfigPath)) {
    Write-Warning "Config file not found: $ConfigPath"
    Write-Warning "Please copy config.example.json to config.json and update settings"
}

# Create the scheduled task
Write-Host "Creating scheduled task: $TaskName"
Write-Host "  Schedule: Daily at $Time"
Write-Host "  Script: $ScriptPath"
Write-Host "  User: $User"

# Define the action
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -ConfigPath `"$ConfigPath`"" `
    -WorkingDirectory $PSScriptRoot

# Define the trigger (daily at specified time)
$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# Define settings
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)

# Register the task
try {
    # Remove existing task if present
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    
    # Create new task
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Nightly sync of data to AskMeSC AI chatbot" `
        -User $User `
        -RunLevel Highest
    
    Write-Host ""
    Write-Host "Scheduled task created successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "To run immediately for testing:"
    Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
    Write-Host ""
    Write-Host "To view task status:"
    Write-Host "  Get-ScheduledTask -TaskName '$TaskName'"
    Write-Host ""
    Write-Host "To remove the task:"
    Write-Host "  .\Install-ScheduledTask.ps1 -Remove"
}
catch {
    Write-Error "Failed to create scheduled task: $_"
    exit 1
}
