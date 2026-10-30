#requires -Version 5.1
<#
  Install @twinsearth/w2m-dsh-plugin 2.0.8 into a DSH profile.
  It verifies the tarball hash, backs up the old plugin directory, and extracts
  the new one. It NEVER restarts DSH and NEVER changes the allowlist.

  Usage (on the DSH machine):
    powershell -ExecutionPolicy Bypass -File .\scripts\dsh-install-2.0.8.ps1 -ProfileName desktop
#>
[CmdletBinding()]
param(
  [string]$ProfileName = 'desktop',
  [string]$TarballPath = '',
  [switch]$StopAgent
)

$ErrorActionPreference = 'Stop'
$expectedSha256 = '700c06ba81195fc36c129bc2e9337c2cf2b678965decd456d3a73d05b9aa1251'
$version = '2.0.8'
$profileRoot = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName"
$pluginPath = Join-Path $profileRoot 'node_modules\@twinsearth\w2m-dsh-plugin'

if (-not (Test-Path $profileRoot)) { throw "profile not found: $profileRoot" }
if (-not (Test-Path $pluginPath)) { throw "plugin not found: $pluginPath (install the plugin first)" }

if ($StopAgent) {
  Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -match 'w2m-localside' } |
    ForEach-Object {
      Write-Host "stopping localside PID $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force
    }
}

$tarball = $TarballPath
if ([string]::IsNullOrWhiteSpace($tarball)) {
  $tarball = Join-Path $env:TEMP "w2m-dsh-plugin-$version.tgz"
  $url = "https://registry.npmjs.org/@twinsearth/w2m-dsh-plugin/-/w2m-dsh-plugin-$version.tgz"
  Write-Host "downloading $url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tarball
}
if (-not (Test-Path $tarball)) { throw "tarball not found: $tarball" }

$actual = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expectedSha256) {
  throw "sha256 mismatch: expected $expectedSha256, got $actual"
}
Write-Host "sha256 ok: $actual"

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$backup = "$pluginPath.bak-$stamp"
Move-Item -LiteralPath $pluginPath -Destination $backup
New-Item -ItemType Directory -Force -Path $pluginPath | Out-Null
try {
  tar -xzf $tarball -C $pluginPath --strip-components=1
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
  $installed = (Get-Content (Join-Path $pluginPath 'package.json') -Raw | ConvertFrom-Json).version
  if ($installed -ne $version) { throw "installed version is $installed, expected $version" }
} catch {
  Write-Warning "install failed: $($_.Exception.Message); restoring backup"
  Remove-Item -LiteralPath $pluginPath -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $backup -Destination $pluginPath
  throw
}

Write-Host "installed $version at $pluginPath"
Write-Host "backup: $backup"
Write-Host ''
Write-Host 'next steps (manual):'
Write-Host '  1. restart DSH: Stop-Process -Name "DeepSeek Harness" -Force; Start-Process "E:\DS\DeepSeek Harness.exe"'
Write-Host '  2. start localside with --allowed-commands ''["node"]'' (or set .w2m.json allowedCommands)'
Write-Host '  3. verify: node -e "console.log(require(''<plugin>/package.json'').version)" == 2.0.8'
