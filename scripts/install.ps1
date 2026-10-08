<#
.SYNOPSIS
  One-command installer for the W2M DSH plugin (Windows / PowerShell).

.DESCRIPTION
  Installs @twinsearth/w2m-dsh-plugin into a DSH profile, from a GitHub release,
  with the checksum verified *before* anything is written and a load-check
  afterwards.

  What it does, in order (nothing is written before step 5):

    1. checks Node >= 20.19.0 (the version ESLint 10 requires; `engines` says so too);
    2. resolves the profile directory `<DSH_HOME>/profiles/<name>` and refuses to
       guess if it does not exist (it lists what is there instead);
    3. finds the release: `SHA256SUMS` is read from the release assets and it is
       the *manifest*, not a decoration -- the tarball name and expected hash
       both come from it. An explicit -Version pins a tag;
    4. if the profile already has that exact version and -Force is absent, prints
       "already up to date" and exits 0 without downloading anything (idempotent);
    5. downloads the tarball next to the profile (`<profile>/.w2m-update/`), NOT
       into %TEMP% -- the profile's `package.json` records a `file:` path, and a
       temp path that later disappears breaks every future `pnpm install`;
    6. verifies sha256. On a mismatch the downloaded file is deleted and the
       install never starts: zero bytes reach the profile;
    7. backs up `package.json` and `pnpm-lock.yaml`, then installs with
       `dsh plugin --profile <name> add <tarball>` (falling back to the DSH
       runtime's own pnpm when the `dsh` CLI is not on PATH);
    8. on any install failure, restores the backup and says so;
    9. loads the *installed* copy through scripts/verify-installed.mjs -- "it
       installed" is not "it loads", which this project has been burned by;
   10. prints how to start the relay and the agent.

  Every failure names the cause and the next command to run. No bare exit codes.

.PARAMETER ProfileName
  DSH profile to install into (alias: -Profile). Must exist.

.PARAMETER Version
  Release tag to install, e.g. `v0.3.0`. Defaults to the latest release.

.PARAMETER Tarball
  Install from a local .tgz instead of downloading. Useful offline and in CI.
  With -Tarball the version comparison is skipped (an explicit file is an
  explicit request) but the checksum is still enforced when -Sha256 is given.

.PARAMETER Sha256
  Expected sha256 of -Tarball. Required to be meaningful offline: without it a
  local tarball cannot be verified against the project's own promise.

.PARAMETER DshPath
  Path to the `dsh` CLI when it is not on PATH.

.PARAMETER DshHome
  Override DSH_HOME (default: $env:DSH_HOME, else ~/.dsh).

.PARAMETER Repo
  GitHub repository, owner/name. Overridden in tests.

.PARAMETER ReleaseBase
  Directory (or URL) that holds `SHA256SUMS` and the tarball, instead of GitHub.
  For mirrors and air-gapped hosts. The checksum is still mandatory on this path.

.PARAMETER Force
  Reinstall even when the profile already has the target version.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile desktop
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Alias('Profile')]
  [string]$ProfileName = 'default',

  [string]$Version = '',
  [string]$Tarball = '',
  [string]$Sha256 = '',
  [string]$DshPath = '',
  [string]$DshHome = '',
  [string]$Repo = 'TwinsEarth/dsh-windows2macos',
  [string]$ReleaseBase = '',
  [switch]$Force,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$PackageName = '@twinsearth/w2m-dsh-plugin'
$RequiredNode = '20.19.0'
$StagingDirName = '.w2m-update'

if ($Help) {
  Get-Help $PSCommandPath -Detailed
  exit 0
}

# ---------------------------------------------------------------------------
# output helpers: every failure carries the next command
# ---------------------------------------------------------------------------

function Write-Head($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Write-Info($text) { Write-Host "  [info] $text" }
function Write-Warn2($text) { Write-Host "  [warn] $text" -ForegroundColor Yellow }

function Fail {
  param([string]$Reason, [string[]]$Next = @())
  Write-Host "`n  [FAIL] $Reason" -ForegroundColor Red
  if ($Next.Count -gt 0) {
    Write-Host "  next steps:" -ForegroundColor Yellow
    foreach ($line in $Next) { Write-Host "    - $line" -ForegroundColor Yellow }
  }
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Node
# ---------------------------------------------------------------------------

function Get-NodeVersion {
  $exe = Get-Command node -ErrorAction SilentlyContinue
  if (-not $exe) {
    Fail "Node.js was not found on PATH, and this project requires Node >= $RequiredNode." @(
      "install Node.js $RequiredNode or newer from https://nodejs.org/en/download",
      "then open a NEW terminal (PATH is only refreshed in new shells) and re-run this script",
      "the DSH app ships its own runtime, but the plugin's install/verify steps need a system node"
    )
  }
  $raw = (& node -v) 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    Fail "node is on PATH but 'node -v' failed; the installation looks broken." @(
      "run 'node -v' yourself and fix the Node installation",
      "reinstall from https://nodejs.org/en/download"
    )
  }
  return $raw.Trim().TrimStart('v')
}

function Assert-NodeVersion {
  param([string]$Found, [string]$Required)
  $f = @($Found -split '\.' | ForEach-Object { [int]($_ -replace '\D.*$', '') })
  $r = @($Required -split '\.' | ForEach-Object { [int]$_ })
  while ($f.Count -lt 3) { $f += 0 }
  while ($r.Count -lt 3) { $r += 0 }
  for ($i = 0; $i -lt 3; $i++) {
    if ($f[$i] -gt $r[$i]) { return }
    if ($f[$i] -lt $r[$i]) {
      Fail "Node $Found is too old: this project needs >= $Required." @(
        "upgrade Node: https://nodejs.org/en/download (the version ESLint 10 and the build scripts require)",
        "if you use nvm/fnm: 'nvm install $Required' or 'fnm install $Required', then re-run"
      )
    }
  }
}

# ---------------------------------------------------------------------------
# 2. profile
# ---------------------------------------------------------------------------

function Resolve-DshHome {
  if ($DshHome) { return (Resolve-Path -LiteralPath $DshHome).Path }
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $HOME '.dsh')
}

# Parameter names must not collide with PowerShell's read-only automatic
# variables either: `-Home` is `$HOME`, so it is `-DshHomeDir` here.
function Resolve-Profile {
  param([string]$DshHomeDir, [string]$Name)
  $profilesRoot = Join-Path $DshHomeDir 'profiles'
  $dir = Join-Path $profilesRoot $Name
  if (Test-Path -LiteralPath $dir -PathType Container) { return (Resolve-Path -LiteralPath $dir).Path }

  $available = @()
  if (Test-Path -LiteralPath $profilesRoot) {
    $available = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  }
  $options = @(
    "list the profiles DSH already has: Get-ChildItem '$profilesRoot'",
    "create the profile in the DSH desktop app (Profiles), then re-run with -Profile <name>"
  )
  if ($available.Count -gt 0) { $options = @("existing profiles: " + ($available -join ', ')) + $options }
  Fail "DSH profile '$Name' was not found at $dir." $options
}

# ---------------------------------------------------------------------------
# 3. release metadata
# ---------------------------------------------------------------------------

function Invoke-Download {
  param([string]$Url, [string]$Dest)
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    # curl follows the 302 that GitHub's release assets always answer with, and
    # --fail turns an HTTP error into a non-zero exit instead of a saved HTML page.
    & curl.exe -L --fail --silent --show-error --retry 2 --max-time 300 -o $Dest $Url
    if ($LASTEXITCODE -ne 0) {
      return @{ ok = $false; reason = "curl exited with $LASTEXITCODE while downloading $Url" }
    }
    return @{ ok = $true }
  }
  try {
    # Windows PowerShell 5.1 defaults to TLS 1.0 in some environments; GitHub requires 1.2+.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 300
    return @{ ok = $true }
  } catch {
    return @{ ok = $false; reason = "$($_.Exception.Message) while downloading $Url" }
  }
}

# An artifact is either an https URL or a path, so a release can be served from a
# local mirror (`-ReleaseBase \\share\w2m` or a directory) exactly like GitHub.
function Get-Artifact {
  param([string]$Source, [string]$Dest)
  if ($Source -match '^https?://') { return Invoke-Download -Url $Source -Dest $Dest }
  if (-not (Test-Path -LiteralPath $Source)) {
    return @{ ok = $false; reason = "no such file: $Source" }
  }
  try {
    Copy-Item -LiteralPath $Source -Destination $Dest -Force
    return @{ ok = $true }
  } catch {
    return @{ ok = $false; reason = "$($_.Exception.Message) while copying $Source" }
  }
}

function Invoke-Json {
  param([string]$Url)
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    return Invoke-RestMethod -Uri $Url -UseBasicParsing -TimeoutSec 60 -Headers @{ 'User-Agent' = 'w2m-install' }
  } catch {
    return $null
  }
}

function Get-ReleaseInfo {
  param([string]$RepoName, [string]$Pinned, [string]$WorkDir, [string]$InstalledHint = '', [string]$Base = '')

  $tag = $Pinned
  if (-not $Base -and -not $tag) {
    $api = Invoke-Json "https://api.github.com/repos/$RepoName/releases/latest"
    if ($api -and $api.tag_name) { $tag = $api.tag_name }
  }

  # `-ReleaseBase` serves the same two files as a release: SHA256SUMS and the
  # tarball. It is how a mirror or an air-gapped host installs, and it keeps the
  # checksum mandatory on that path too.
  $sumsSource = if ($Base) {
    if ($Base -match '^https?://') { "$Base/SHA256SUMS" } else { Join-Path $Base 'SHA256SUMS' }
  } elseif ($tag) {
    "https://github.com/$RepoName/releases/download/$tag/SHA256SUMS"
  } else {
    "https://github.com/$RepoName/releases/latest/download/SHA256SUMS"
  }
  $sumsPath = Join-Path $WorkDir 'SHA256SUMS'
  $sums = Get-Artifact -Source $sumsSource -Dest $sumsPath
  if (-not $sums.ok) {
    $next = @(
      "check network/proxy access to github.com (a proxy may need HTTPS_PROXY set)",
      "or install a local file instead: -Tarball <path.tgz> -Sha256 <expected>",
      "or point at a mirror directory that holds SHA256SUMS and the tarball: -ReleaseBase <dir>",
      "or pin a specific release: -Version v0.3.0"
    )
    if ($InstalledHint) {
      # Without the release metadata we cannot tell whether the installed copy is
      # already the newest, so say what is known rather than leaving a dead end.
      $next = @("this profile already has $PackageName $InstalledHint; if that is the version you want, no action is needed") + $next
    }
    Fail "could not read SHA256SUMS from $sumsSource ($($sums.reason))." $next
  }

  $entry = $null
  foreach ($line in (Get-Content -LiteralPath $sumsPath)) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+\.tgz)\s*$') {
      $entry = @{ sha256 = $Matches[1].ToLower(); file = $Matches[2].Trim() }
      break
    }
  }
  if (-not $entry) {
    Fail "SHA256SUMS from $sumsUrl contains no .tgz entry; the release looks malformed." @(
      "open the release page and check that the tarball asset was uploaded",
      "or install a local file: -Tarball <path.tgz> -Sha256 <expected>"
    )
  }

  $version = $null
  if ($entry.file -match 'twinsearth-w2m-dsh-plugin-(.+)\.tgz$') { $version = $Matches[1] }
  $url = if ($Base) {
    if ($Base -match '^https?://') { "$Base/$($entry.file)" } else { Join-Path $Base $entry.file }
  } elseif ($tag) {
    "https://github.com/$RepoName/releases/download/$tag/$($entry.file)"
  } else {
    "https://github.com/$RepoName/releases/latest/download/$($entry.file)"
  }
  return @{
    tag = $tag
    version = $version
    file = $entry.file
    sha256 = $entry.sha256
    url = $url
  }
}

# ---------------------------------------------------------------------------
# 4/5/6. download + verify
# ---------------------------------------------------------------------------

function Get-InstalledVersion {
  param([string]$ProfileDir)
  $manifest = Join-Path (Join-Path (Join-Path $ProfileDir 'node_modules') '@twinsearth') 'w2m-dsh-plugin\package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return $null }
  try { return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version } catch { return $null }
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

# ---------------------------------------------------------------------------
# 7/8. install (with backup + restore)
# ---------------------------------------------------------------------------

function Find-Dsh {
  if ($DshPath) {
    if (Test-Path -LiteralPath $DshPath) { return (Resolve-Path -LiteralPath $DshPath).Path }
    Fail "-DshPath '$DshPath' does not exist." @("pass the real path to the dsh CLI, or drop -DshPath to use the runtime pnpm fallback")
  }
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Find-RuntimePnpm {
  param([string]$DshHomeDir)
  $runtimes = Join-Path $DshHomeDir 'dsh-runtimes'
  if (-not (Test-Path -LiteralPath $runtimes)) { return $null }
  foreach ($runtime in (Get-ChildItem -LiteralPath $runtimes -Directory -ErrorAction SilentlyContinue)) {
    $candidate = Join-Path $runtime.FullName 'dependencies\pnpm\bin\pnpm.mjs'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Backup-Profile {
  param([string]$ProfileDir, [string]$Stamp)
  $backupDir = Join-Path (Join-Path $ProfileDir $StagingDirName) "backup-$Stamp"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $saved = @()
  foreach ($name in @('package.json', 'pnpm-lock.yaml')) {
    $src = Join-Path $ProfileDir $name
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $backupDir $name) -Force
      $saved += $name
    }
  }
  return @{ dir = $backupDir; saved = $saved }
}

function Restore-Profile {
  param([string]$ProfileDir, [hashtable]$Backup)
  foreach ($name in @('package.json', 'pnpm-lock.yaml')) {
    $from = Join-Path $Backup.dir $name
    $to = Join-Path $ProfileDir $name
    if (Test-Path -LiteralPath $from) {
      Copy-Item -LiteralPath $from -Destination $to -Force
      Write-Warn2 "restored $name from $($Backup.dir)"
    } elseif (Test-Path -LiteralPath $to) {
      # pnpm may have created a lockfile where there was none; a restored profile
      # must not keep a lock describing a version that was never installed.
      Remove-Item -LiteralPath $to -Force
      Write-Warn2 "removed $name (it did not exist before the install)"
    }
  }
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

Write-Head 'W2M DSH plugin installer'
Write-Info "profile : $ProfileName"
Write-Info "repo    : $Repo"

$nodeVersion = Get-NodeVersion
Assert-NodeVersion -Found $nodeVersion -Required $RequiredNode
Write-Ok "node $nodeVersion (>= $RequiredNode)"

# NOTE: never name a variable `$home` here. PowerShell variable names are
# case-insensitive and `$HOME` is a read-only automatic variable, so assigning
# to it aborts the script ("Cannot overwrite variable HOME").
$dshHomePath = Resolve-DshHome
$profileDir = Resolve-Profile -DshHomeDir $dshHomePath -Name $ProfileName
Write-Ok "profile $profileDir"

$installedVersion = Get-InstalledVersion -ProfileDir $profileDir
if ($installedVersion) { Write-Info "installed version: $installedVersion" } else { Write-Info 'installed version: (not installed yet)' }

# The work directory lives inside the profile on purpose: `package.json` will
# record a `file:` path to the staged tarball, and %TEMP% is not a durable place
# to point a dependency at.
$stagingDir = Join-Path $profileDir $StagingDirName
New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

$source = $null
if ($Tarball) {
  if (-not (Test-Path -LiteralPath $Tarball)) {
    Fail "the tarball given with -Tarball does not exist: $Tarball" @(
      "check the path (it must be a .tgz built by 'node scripts/pack.mjs')",
      "or drop -Tarball to install from the latest GitHub release"
    )
  }
  $source = @{
    tag = '(local)'
    version = $null
    file = (Split-Path -Leaf $Tarball)
    sha256 = $(if ($Sha256) { $Sha256.ToLower() } else { $null })
    url = (Resolve-Path -LiteralPath $Tarball).Path
    local = $true
  }
  Write-Info "source  : local file $($source.url)"
} else {
  $source = Get-ReleaseInfo -RepoName $Repo -Pinned $Version -WorkDir $stagingDir -InstalledHint $installedVersion -Base $ReleaseBase
  Write-Info "source  : $($source.url)"
  Write-Info "release : $($source.tag)"
}

# Idempotence: with a known target version, an up-to-date profile is a success,
# not a no-op failure -- and nothing is downloaded in that case.
if (-not $source.local -and $source.version -and $installedVersion -eq $source.version -and -not $Force) {
  Write-Host "`n  [ok]   already up to date: $PackageName $installedVersion" -ForegroundColor Green
  Write-Info 'nothing was downloaded or installed; pass -Force to reinstall anyway'
  exit 0
}

$stagedTarball = Join-Path $stagingDir $source.file
$tmpDownload = "$stagedTarball.part"

Write-Head 'download'
if ($source.local) {
  Copy-Item -LiteralPath $source.url -Destination $tmpDownload -Force
  Write-Ok "copied local file to a temporary file for verification"
} else {
  $download = Get-Artifact -Source $source.url -Dest $tmpDownload
  if (-not $download.ok) {
    if (Test-Path -LiteralPath $tmpDownload) { Remove-Item -LiteralPath $tmpDownload -Force }
    Fail "download failed: $($download.reason)" @(
      "check network/proxy access to github.com (set HTTPS_PROXY if you are behind a proxy)",
      "retry: same command",
      "offline install: download $($source.file) and run with -Tarball <path> -Sha256 <hash from SHA256SUMS>",
      "or point at a mirror directory: -ReleaseBase <dir>"
    )
  }
  Write-Ok "downloaded $($source.file)"
}

Write-Head 'verify checksum'
if (-not $source.sha256) {
  Remove-Item -LiteralPath $tmpDownload -Force -ErrorAction SilentlyContinue
  Fail "no expected sha256 is available, so the tarball cannot be verified; refusing to install." @(
    "install from the release instead (drop -Tarball), where SHA256SUMS supplies the hash",
    "or pass -Sha256 <64 hex chars> alongside -Tarball"
  )
}
$actual = Get-Sha256 -Path $tmpDownload
if ($actual -ne $source.sha256) {
  Remove-Item -LiteralPath $tmpDownload -Force
  Fail "checksum mismatch -- nothing was installed." @(
    "expected $($source.sha256)",
    "actual   $actual",
    "re-download: the file may have been truncated or modified in transit",
    "if it keeps happening, report it: the release asset itself may be corrupt"
  )
}
Write-Ok "sha256 $actual"

# Only now does anything durable appear: the verified bytes are moved into place.
Move-Item -LiteralPath $tmpDownload -Destination $stagedTarball -Force
Write-Ok "staged -> $stagedTarball"

Write-Head 'install'
$dsh = Find-Dsh
$pnpm = Find-RuntimePnpm -DshHomeDir $dshHomePath
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$backup = Backup-Profile -ProfileDir $profileDir -Stamp $stamp
Write-Ok "backed up $($backup.saved -join ', ') -> $($backup.dir)"

$installOk = $false
$viaDsh = $false
if ($dsh) {
  Write-Info "running: dsh plugin --profile $ProfileName add <tarball>"
  & $dsh plugin --profile $ProfileName add $stagedTarball
  $installOk = ($LASTEXITCODE -eq 0)
  $viaDsh = $true
  if (-not $installOk) { Write-Warn2 "dsh exited with $LASTEXITCODE" }
} else {
  Write-Warn2 'the dsh CLI was not found on PATH; using the DSH runtime pnpm instead'
  Write-Warn2 '(that is the same package manager `dsh plugin` drives; -DshPath overrides)'
  if (-not $pnpm) {
    Restore-Profile -ProfileDir $profileDir -Backup $backup
    Fail 'neither the dsh CLI nor the DSH runtime pnpm could be found.' @(
      "pass the CLI explicitly: -DshPath 'C:\path\to\dsh.cmd'",
      "or point at the DSH home that holds dsh-runtimes: -DshHome 'C:\Users\<you>\.dsh'",
      "the DSH desktop app ships both; installing/updating it restores them"
    )
  }
  Write-Info "running: node --expose-internals <pnpm.mjs> add <tarball> --dir <profile>"
  & node --expose-internals $pnpm add $stagedTarball --dir $profileDir
  $installOk = ($LASTEXITCODE -eq 0)
  if (-not $installOk) { Write-Warn2 "pnpm exited with $LASTEXITCODE" }
}

if (-not $installOk) {
  Restore-Profile -ProfileDir $profileDir -Backup $backup
  Fail "the package manager failed, so the profile was restored from $($backup.dir)." @(
    "re-run and read the output above: it names the failing step",
    "if the tarball was staged correctly, retry with -Force",
    "if the profile is shared/corrupted: check that '$profileDir\package.json' is valid JSON"
  )
}
Write-Ok "installed via $(if ($viaDsh) { 'dsh' } else { 'pnpm' })"

Write-Head 'verify the install actually loads'
$pkgDir = Join-Path (Join-Path (Join-Path $profileDir 'node_modules') '@twinsearth') 'w2m-dsh-plugin'
$verifyScript = Join-Path $PSScriptRoot 'verify-installed.mjs'
if (-not (Test-Path -LiteralPath $verifyScript)) {
  Write-Warn2 "could not find $verifyScript, skipping the load check"
} else {
  & node $verifyScript $pkgDir
  if ($LASTEXITCODE -ne 0) {
    Restore-Profile -ProfileDir $profileDir -Backup $backup
    Fail "the package installed but does not load, so the profile was restored. That combination is exactly what this check exists for." @(
      "the output above lists the tools that *did* register; compare with the expected six",
      "if the release predates a tool you expect, install a newer release: -Version v0.3.0",
      "re-run with -Force after fixing the release"
    )
  }
  Write-Ok 'the installed copy loads and registers its tools'
}

$newVersion = Get-InstalledVersion -ProfileDir $profileDir
Write-Head 'done'
Write-Ok "$PackageName $newVersion installed into profile '$ProfileName'"
Write-Info "tarball  : $stagedTarball"
Write-Info "backup   : $($backup.dir)   (kept; delete it once you are happy)"
Write-Host "`n  next steps:" -ForegroundColor Cyan
Write-Host "    1. start the relay (on the machine that will coordinate):"
Write-Host "         w2m-rabbit --port 8787 --state `"$dshHomePath\xclient\rabbit`""
Write-Host "       it prints a PAIR-XXXXXXXX code on first start."
Write-Host "    2. start an agent on every machine that should run commands:"
Write-Host "         w2m-localside --rabbit http://<relay-host>:8787 --pair PAIR-XXXXXXXX ``"
Write-Host "           --project <path> --allowed-commands '[""node --test""]'"
Write-Host "    3. restart DSH so the profile picks up the new plugin version."
Write-Host ""
exit 0
