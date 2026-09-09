#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [switch]$SkipDependencies
)

$ErrorActionPreference = 'Stop'

$TaskName = 'KinoPub Compat Proxy'
$Port = 3000
$InstallDir = $PSScriptRoot
$ServerFile = Join-Path $InstallDir 'server.mjs'

if (-not (Test-Path -LiteralPath $ServerFile -PathType Leaf)) {
    throw "server.mjs was not found in $InstallDir"
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $NodePath = $nodeCommand.Source
} else {
    $NodePath = Join-Path ${env:ProgramFiles} 'nodejs\node.exe'
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'Node.js was not found. Install Node.js 22 or later and run this script again.'
}

if (-not $SkipDependencies) {
    $npmPath = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($npmCommand) {
            $npmPath = $npmCommand.Source
        }
    }
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
        throw 'npm.cmd was not found beside Node.js.'
    }

    Write-Host "Installing production dependencies in $InstallDir ..."
    Push-Location $InstallDir
    try {
        & $npmPath ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument 'server.mjs' `
    -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'KinoPub compatibility reverse proxy' `
    -Force | Out-Null

Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -DisplayName $TaskName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow `
    -Profile Private `
    -Description 'Allow private-network clients to reach the KinoPub compatibility proxy' |
    Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

try {
    $health = Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "http://127.0.0.1:$Port/__local/health" `
        -TimeoutSec 5
    if ($health.StatusCode -ne 200) {
        throw "Health check returned HTTP $($health.StatusCode)"
    }
} catch {
    throw "The scheduled task was installed, but the proxy health check failed: $($_.Exception.Message)"
}

Write-Host "Installed '$TaskName'."
Write-Host "Listening on http://0.0.0.0:$Port"
Write-Host 'The task starts at boot and restarts after a process failure.'
