# Bootstrap the M1 maintenance runner on Windows (run ONCE as Administrator).
#
# Registers a SYSTEM scheduled task that runs the fixed update/restart/diag runner.
# It does not widen any allow-list and does not execute arbitrary input.
#
# usage: powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -AppDir C:\w2m\app -MachineId <id> [-OperatorKey C:\path\op.pub.pem]
param(
  [Parameter(Mandatory=$true)][string]$AppDir,
  [Parameter(Mandatory=$true)][string]$MachineId,
  [string]$OperatorKey = ''
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'run as Administrator' }
if (-not (Test-Path (Join-Path $AppDir 'bin\w2m-maintenance.mjs'))) { throw "missing $AppDir\bin\w2m-maintenance.mjs — deploy the package first" }
$Base = Join-Path $env:ProgramData 'w2m\maintenance'
foreach ($sub in 'queue','done','claimed') { New-Item -ItemType Directory -Force -Path (Join-Path $Base $sub) | Out-Null }
$envFile = Join-Path $Base 'machine.env'
"W2M_MACHINE_ID=$MachineId" | Set-Content -Encoding ASCII $envFile
if ($OperatorKey) {
  & node (Join-Path $AppDir 'bin\w2m-maintenance.mjs') --once --allow-nonroot --queue-dir (Join-Path $Base 'queue') --done-dir (Join-Path $Base 'done') --machine-id $MachineId --pin-file (Join-Path $Base 'operator-pins.json') --operator-key $OperatorKey
}
$xml = Get-Content (Join-Path $AppDir 'deploy\windows\w2m-maintenance.xml') -Raw
$xml = $xml.Replace('C:\w2m\app', $AppDir).Replace('%W2M_MACHINE_ID%', $MachineId)
$tmp = Join-Path $env:TEMP 'w2m-maintenance-task.xml'
$xml | Set-Content -Encoding Unicode $tmp
Register-ScheduledTask -TaskName 'W2M Maintenance' -Xml (Get-Content $tmp -Raw) -Force | Out-Null
Start-ScheduledTask -TaskName 'W2M Maintenance'
Get-ScheduledTask -TaskName 'W2M Maintenance' | Select-Object TaskName, State
Write-Output "maintenance runner bootstrapped for machine $MachineId"
