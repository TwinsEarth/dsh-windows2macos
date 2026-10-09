#!/usr/bin/env pwsh
# W2M acceptance run — Windows / PowerShell entry point.
#
# Runs every suite in order, prints a summary, and exits non-zero if any suite
# failed. `--test` exits non-zero on failure, so the exit code is the verdict;
# the summary is only there to make a failure readable at a glance.
#
# Usage:
#   pwsh scripts/verify.ps1              # everything
#   pwsh scripts/verify.ps1 relay agent  # only the named suites

[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Suites
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# Prefer the runtime Node that ships with DSH when it is present: it is the
# interpreter the plugin will actually run under, so verifying with it verifies
# the real deployment.
$candidates = @(
  (Join-Path $env:DSH_HOME 'dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'),
  'C:\Users\fangw\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
) | Where-Object { $_ -and (Test-Path $_) }

$node = if ($candidates.Count -gt 0) { $candidates[0] } else { 'node' }
Write-Host "node: $node"
& $node -v
Write-Host ''

# Kept in step with the explicit list in .github/workflows/ci.yml. A suite that is
# not named here is silently not run, which is how four suites (166 cases) once
# shipped without ever executing in CI.
$all = @('relay', 'broadcast', 'agent', 'tools', 'schedule', 'auto-update', 'update-source', 'update-install', 'update-wiring', 'signing', 'stress', 'metrics', 'metrics-route', 'shared-config', 'tool-cards', 'p2p-stun', 'p2p-transport', 'p2p-signaling', 'p2p-node', 'p2p-transport-fields', 'p2p-plugin', 'p2p-agent', 'stun-server', 'e2e', 'crossnetwork', 'signing-e2e', 'outbound-only', 'recovery', 'pipeline-e2e')
$selected = if ($Suites -and $Suites.Count -gt 0) { $Suites } else { $all }

$results = [ordered]@{}
foreach ($suite in $selected) {
  $file = "test/$suite.test.mjs"
  if (-not (Test-Path $file)) {
    Write-Host "SKIP  $suite (missing $file)" -ForegroundColor Yellow
    $results[$suite] = 'missing'
    continue
  }
  Write-Host "=== $suite ===" -ForegroundColor Cyan
  # --test-force-exit: the end-to-end suites each hold an open SSE connection, and a
  # long-lived stream keeps Node's event loop alive after the assertions have passed.
  # Without this flag a green suite can still hang the run, which is indistinguishable
  # from a suite that never finished.
  & $node --test --test-force-exit $file
  $code = $LASTEXITCODE
  $results[$suite] = if ($code -eq 0) { 'pass' } else { "FAIL($code)" }
  Write-Host ''
}

Write-Host '=== summary ===' -ForegroundColor Cyan
$failed = 0
foreach ($kv in $results.GetEnumerator()) {
  $colour = switch -Regex ($kv.Value) {
    '^pass$' { 'Green' }
    '^missing$' { 'Yellow' }
    default { 'Red' }
  }
  if ($kv.Value -notin @('pass', 'missing')) { $failed++ }
  Write-Host ("  {0,-8} {1}" -f $kv.Key, $kv.Value) -ForegroundColor $colour
}

if ($failed -gt 0) {
  Write-Host "`n$failed suite(s) failed." -ForegroundColor Red
  exit 1
}
Write-Host "`nAll suites passed." -ForegroundColor Green
exit 0
