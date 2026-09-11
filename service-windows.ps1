#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

$TaskName = 'KinoPub Compat Proxy'
$Port = 3000
$HealthUri = "http://127.0.0.1:$Port/__local/health"

function Test-Proxy {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUri -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Wait-ForProxy([bool]$Running) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ((Test-Proxy) -eq $Running) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    if ($Running) {
        throw 'The proxy did not pass its health check.'
    }
    throw 'The proxy is still responding.'
}

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    throw "Scheduled task '$TaskName' is not installed. Run install-windows.cmd first."
}

switch ($Action) {
    'start' {
        Start-ScheduledTask -TaskName $TaskName
        Wait-ForProxy $true
        Write-Host "Started '$TaskName'."
    }
    'stop' {
        Stop-ScheduledTask -TaskName $TaskName
        Wait-ForProxy $false
        Write-Host "Stopped '$TaskName'."
    }
    'restart' {
        Stop-ScheduledTask -TaskName $TaskName
        Wait-ForProxy $false
        Start-ScheduledTask -TaskName $TaskName
        Wait-ForProxy $true
        Write-Host "Restarted '$TaskName'."
    }
    'status' {
        $task = Get-ScheduledTask -TaskName $TaskName
        $running = Test-Proxy
        Write-Host "Task:   $($task.State)"
        if ($running) {
            Write-Host "Health: responding on http://127.0.0.1:$Port"
        } else {
            Write-Host "Health: not responding on http://127.0.0.1:$Port"
            exit 1
        }
    }
}
