<#
.SYNOPSIS
  DSH workspace registry health check / self-heal.

.DESCRIPTION
  The DSH client reports
    workspace create failed: gateway/service-unavailable: typert gateway: workspace/create:
    active Service "workspaceController" is unavailable
  when `storages/workspace.json` lists a workspace id in `global.workspaceIds` that has no row in
  `tables.workspaces` (a dangling id). One bad id stops every workspace operation, which is why this
  check exists as a separate, boring step you run before and after drills/imports and after client
  upgrades.

  Check-only by default. `-Fix` copies the file to `<file>.bak-guard-<stamp>`, stops the DSH processes
  (the client owns the document in memory and would overwrite a repair made underneath it), then runs
  `w2m-fix workspace-registry --repair` and re-validates. Visible rows are never deleted; an unlisted row
  is kept and appended to the ids; session references with no log are pruned; an invalid default is
  reassigned to the first surviving id.

.EXAMPLE
  .\tools\dsh-workspace-guard.ps1
.EXAMPLE
  .\tools\dsh-workspace-guard.ps1 -Fix
.EXAMPLE
  .\tools\dsh-workspace-guard.ps1 -Fix -NoStop
#>
param(
  [switch]$Fix,
  [switch]$NoStop,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repo 'bin\w2m-fix.mjs'
if (-not (Test-Path -LiteralPath $cli)) { Write-Output "w2m-fix CLI missing: $cli"; exit 2 }

if ($Fix -and -not $NoStop) {
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($procs) {
    Write-Output "stopping DSH processes: $($procs.Id -join ', ')"
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 3
  }
}

$mode = if ($Fix) { '--repair' } else { '--check' }
& node $cli workspace-registry $mode --dsh-home $DshHome
$code = $LASTEXITCODE
if ($Fix -and $code -eq 0) { Write-Output 'restart DeepSeek Harness to reload the registry.' }
exit $code
