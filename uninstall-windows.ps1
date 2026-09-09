#requires -RunAsAdministrator
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$TaskName = 'KinoPub Compat Proxy'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
} else {
    Write-Host "Scheduled task '$TaskName' was not installed."
}

$rule = Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue
if ($rule) {
    $rule | Remove-NetFirewallRule
    Write-Host "Removed firewall rule '$TaskName'."
} else {
    Write-Host "Firewall rule '$TaskName' was not found."
}

Write-Host 'The proxy files and node_modules were left in place.'
