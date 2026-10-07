# CLI-level smoke test: real `w2m-rabbit` and two real `w2m-localside` processes.
#
# This exercises the shipped entry points rather than importing the modules, so
# it catches the class of defect unit tests cannot see: a CLI that imports the
# wrong symbol, a flag that never reaches the implementation, a process that will
# not start. (The first version of w2m-rabbit.mjs failed exactly this way.)
#
# Usage: pwsh scripts/smoke-cli.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# `git worktree add` writes its progress to stderr, and Windows PowerShell turns
# any stderr output from a native command into a terminating error under
# `Stop`. Redirecting 2>$null keeps real git failures (non-zero exit) loud while
# ignoring its chatter.
function Invoke-Git {
  # The explicit positional `ValueFromRemainingArguments` parameter is what lets
  # `-C` and other switches flow through: without it PowerShell tries to bind
  # `-C` to a parameter of this function instead of forwarding it.
  param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [object[]] $GitArgs
  )
  & git @GitArgs 2>$null
}

$node = if (Test-Path 'C:\Users\fangw\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe') {
  'C:\Users\fangw\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
} else { 'node' }

$tmp = 'E:\DS\_work\w2m\cli-smoke'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Step($m) { Write-Host "[smoke] $m" }

# --- two independent copies of one project ----------------------------------
# Clones rather than worktrees, for two reasons: it models what actually happens
# (each machine has its own checkout), and `git worktree add` writes progress to
# stderr, which Windows PowerShell 5.1 escalates to a terminating error under
# `$ErrorActionPreference = 'Stop'` even when git succeeded.
$origin = Join-Path $tmp 'origin'
New-Item -ItemType Directory -Force -Path $origin | Out-Null
Invoke-Git -C $origin init --initial-branch=main . | Out-Null
Set-Content -Path (Join-Path $origin '.gitattributes') -Value '* text=auto eol=lf' -NoNewline
Set-Content -Path (Join-Path $origin 'app.mjs') -Value 'export const answer = 42;' -NoNewline
Invoke-Git -C $origin add -A | Out-Null
Invoke-Git -C $origin -c user.name=t -c user.email=t@e.invalid commit -m base | Out-Null
$base = (& git -C $origin rev-parse HEAD).Trim()

$machineA = Join-Path $tmp 'machine-a'
$machineB = Join-Path $tmp 'machine-b'
Invoke-Git clone --quiet --no-hardlinks $origin $machineA | Out-Null
Invoke-Git clone --quiet --no-hardlinks $origin $machineB | Out-Null
Step "two clones ready at $base"

# --- relay -------------------------------------------------------------------
$rabbitLog = Join-Path $tmp 'rabbit.log'
$rabbit = Start-Process -FilePath $node `
  -ArgumentList "$repo\bin\w2m-rabbit.mjs", '--host', '127.0.0.1', '--port', '8791', '--state', (Join-Path $tmp 'rabbit-state') `
  -NoNewWindow -PassThru -RedirectStandardOutput $rabbitLog -RedirectStandardError (Join-Path $tmp 'rabbit.err')
Start-Sleep -Milliseconds 1200
if ($rabbit.HasExited) { throw "relay exited early; see $rabbitLog" }

# Read the URL and first pairing code out of the human-readable banner, which is
# the output a user actually sees.
$urlLine = Get-Content $rabbitLog | Where-Object { $_ -match 'URL\s+http' } | Select-Object -First 1
$codeLine = Get-Content $rabbitLog | Where-Object { $_ -match 'PAIRING CODE:\s+PAIR-' } | Select-Object -First 1
if (-not $urlLine -or -not $codeLine) {
  throw "relay banner incomplete; log: $(Get-Content $rabbitLog -Raw)"
}
$rabbitUrl = ([regex]::Match($urlLine, 'https?://\S+')).Value
$pair = ([regex]::Match($codeLine, 'PAIR-[A-Z0-9]+')).Value
Step "relay listening $rabbitUrl pair=$pair"

# JSON array literal for the whitelist.
#
# Deliberately a single bare token: Windows PowerShell rewrites the command line
# it hands to a native process, so an entry containing a space (`"node -e"`)
# arrives mangled no matter how it is escaped by the caller. The argument parsing
# path is identical either way, so the smoke test uses the form that can be
# asserted reliably and leaves spaced prefixes to the unit tests, which call the
# code directly.
$allowedJson = '[\"git\"]'

# --- two localsides ---------------------------------------------------------
$workers = @()
foreach ($i in 0, 1) {
  $dir = if ($i -eq 0) { $machineA } else { $machineB }
  $log = Join-Path $tmp "localside-$i.log"
  # First pairing consumes the code, so read the rotated code back from the log
  # for the second machine -- that is the documented operator flow.
  #
  # Quoting note, learned the hard way: Windows PowerShell rewrites the command
  # line it hands to a native process and strips inner quotes, so
  # `--allowed-commands ["git"]` arrives as `[git]` and the CLI rightly refuses
  # it. Passing the argument through a Base64-encoded wrapper keeps the exact
  # characters intact instead of fighting the quoting rules.
  $argList = @(
    "$repo\bin\w2m-localside.mjs",
    '--rabbit', $rabbitUrl,
    '--pair', $pair,
    '--project', $dir,
    '--name', "smoke-$i",
    '--state', (Join-Path $tmp "state-$i"),
    '--allowed-commands', $allowedJson
  )
  # Each simulated machine needs its own `machine_id`. The CLI keys the device
  # file off `$DSH_HOME/xclient/device.json`, so without an isolated DSH_HOME both
  # "machines" would load one identity and the second pairing would revoke the
  # first machine's token -- which is exactly what happened before this line.
  $home_i = Join-Path $tmp "home-$i"
  New-Item -ItemType Directory -Force -Path $home_i | Out-Null

  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($argList | ConvertTo-Json -Compress)))
  $wrapper = "`$env:DSH_HOME = '$home_i'; " +
             "`$a = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$encoded')) | ConvertFrom-Json; " +
             "& '$node' @a"
  $p = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapper))) `
    -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $workers += [pscustomobject]@{ Proc = $p; Log = $log }
  Start-Sleep -Milliseconds 1500
  if ($p.HasExited) { throw "localside $i exited early: $(Get-Content $log -Raw) $(Get-Content "$log.err" -Raw)" }
  if ($i -eq 0) {
    # The code rotates on first use and the relay prints the new one as prose, so
    # match that line. Poll rather than sleep a fixed amount: pairing involves a
    # process start, an HTTP round trip and a log flush, and a fixed sleep either
    # races (flaky) or wastes time (slow).
    $pair = $null
    for ($try = 0; $try -lt 40; $try++) {
      Start-Sleep -Milliseconds 250
      $rotatedLine = Get-Content $rabbitLog | Where-Object { $_ -match 'NEW PAIRING CODE' } | Select-Object -Last 1
      if ($rotatedLine -match '(PAIR-[A-Z0-9]+)') { $pair = $Matches[1]; break }
    }
    if (-not $pair) {
      throw "relay never rotated the pairing code; localside log: $(Get-Content $log -Raw) $(Get-Content "$log.err" -Raw)"
    }
    Step "pairing code rotated to $pair"
  }
  Step "localside $i started"
}

# --- drive a task over the real HTTP API ------------------------------------
# The device file lives under DSH_HOME (one per simulated machine), not under
# --state: the agent keys identity off `$DSH_HOME/xclient/device.json`.
$idPath = Join-Path $tmp 'home-0/xclient/device.json'
if (-not (Test-Path $idPath)) { throw "no device file at $idPath" }
$token = (Get-Content $idPath -Raw | ConvertFrom-Json).device_token
if (-not $token) { throw "no device token at $idPath" }

$anchor = & $node -e "
import('file:///$($repo -replace '\\','/')/src/agent/git.mjs').then(async (m) => {
  const r = await m.treeFingerprint({ cwd: process.argv[1] });
  process.stdout.write(String(r.fingerprint));
});" $machineA
Step "base_tree=$anchor"

$body = @{
  mode = 'replicate'
  command_argv = @('git', 'status', '--porcelain')
  index_total = 1
  timeout_ms = 20000
  write = $false
  base_commit = $base
  base_tree = $anchor
} | ConvertTo-Json -Depth 6

$task = Invoke-RestMethod -Method Post -Uri "$($rabbitUrl)/v1/task" -Body $body -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $token" }
Step "task $($task.task_id)"

$verdict = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $state = Invoke-RestMethod -Uri "$($rabbitUrl)/v1/tasks/$($task.task_id)" -Headers @{ Authorization = "Bearer $token" }
  $agg = $state.aggregate
  $pending = @($agg.machines | Where-Object { $_.outcome -eq 'pending' }).Count
  if ($agg.status -and $agg.status -ne 'pending' -and $pending -eq 0) { $verdict = $agg; break }
}
if (-not $verdict) { throw "task did not settle" }

Step "verdict status=$($verdict.status) machines=$(@($verdict.machines).Count)"
foreach ($m in $verdict.machines) {
  Step "  $($m.machine_name) outcome=$($m.outcome) status=$($m.status) exit=$($m.exit_code)"
}

$report = Invoke-WebRequest -Uri "$($rabbitUrl)/v1/tasks/$($task.task_id)/report?format=md" -Headers @{ Authorization = "Bearer $token" }
Step "markdown report: $($report.Content.Length) chars"

# --- teardown ---------------------------------------------------------------
foreach ($w in $workers) { if (-not $w.Proc.HasExited) { $w.Proc.Kill() } }
if (-not $rabbit.HasExited) { $rabbit.Kill() }
Step "stopped"

if ($verdict.status -ne 'consistent') {
  Write-Host "[smoke] FAILED: expected consistent, got $($verdict.status)" -ForegroundColor Red
  Get-Content (Join-Path $tmp 'localside-0.log') -Tail 20
  exit 1
}
Write-Host "[smoke] PASSED" -ForegroundColor Green
exit 0
