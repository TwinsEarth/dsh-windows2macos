# ============================================================================
#  install-service.ps1 -- run the W2M Localside agent as a Windows service
# ============================================================================
#
#  WHAT "SERVICE MODE" MEANS HERE, AND WHAT IT DOES NOT
#
#  A Node process cannot be an SCM service by itself: the Service Control Manager
#  requires the process to answer StartServiceCtrlDispatcher, which needs native
#  bindings this project does not have (and will not add -- zero runtime
#  dependencies is a stated property, not an accident). So there are two honest
#  shapes, and this script implements the first:
#
#    1. SERVICE-MODE TASK (this script) -- a scheduled task with LogonType S4U:
#       starts at boot, runs in session 0 with no console, survives sign-out, and
#       is managed with Start-ScheduledTask/Stop-ScheduledTask. No third-party
#       binary. Requires **elevation** (S4U needs SeBatchLogonRight, and the
#       registration is refused with "Access is denied" without it -- measured).
#
#    2. REAL SCM SERVICE via WinSW or NSSM -- a genuine entry in services.msc and
#       for `Restart-Service`. It needs a third-party service host binary, which
#       is a dependency decision rather than a deployment detail; see README.md
#       in this directory for the template and the caveat.
#
#  WHY THE AGENT RUNS UNDER A SUPERVISOR
#
#  Measured twice: an agent started directly can be gone ~40 s later with
#  0xC000013A (STATUS_CONTROL_C_EXIT -- its console went away) and no log line,
#  because whatever was logging died with it. The task therefore runs
#  w2m-agent-supervisor.mjs, which respawns the agent with a capped backoff and
#  logs one line per run.
#
#  USAGE
#
#    # elevated PowerShell, from the repository root:
#    powershell -ExecutionPolicy Bypass -File deploy\windows\install-service.ps1 `
#      -Project 'E:\path\to\your\project' `
#      -AllowedCommands '["node --test","git status --porcelain"]'
#
#    # inspect / remove
#    Get-ScheduledTask -TaskName 'W2M Localside agent' | Get-ScheduledTaskInfo
#    powershell -ExecutionPolicy Bypass -File deploy\windows\install-service.ps1 -Uninstall
#
#    # repair a task registered by an older version of this script (one that used
#    # `MultipleInstances IgnoreNew` and therefore could not recover from a supervisor death):
#    powershell -ExecutionPolicy Bypass -File deploy\windows\install-service.ps1 -UpdateTask
#
#  Everything after the parameters goes to the agent, so `-AgentArgs
#  '--p2p-port','41235'` pins the punch socket (and then one inbound firewall rule
#  is enough, instead of a rule per restart).
# ============================================================================
[CmdletBinding()]
param(
  [string]$TaskName = 'W2M Localside agent',
  [string]$Rabbit = 'http://202.182.123.154:8787',
  [string]$Project = (Get-Location).Path,
  [string]$MachineName = $env:COMPUTERNAME,
  [string]$AllowedCommands = 'node --version, node --test, git status --porcelain, git rev-parse',
  [string]$StateDir = "$env:USERPROFILE\.dsh\w2m\localside",
  [string]$LogPath = "$env:USERPROFILE\.dsh\w2m\agent.log",
  [string]$Bin = '',
  [string]$AgentArgs = '',
  [int]$RestartBackoffMs = 60000,
  [int]$WatchdogMinutes = 5,
  [switch]$Interactive,
  [switch]$UpdateTask,
  [switch]$UpdateConfig,
  [switch]$Uninstall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # ...\deploy\windows -> repo root
$supervisor = Join-Path $PSScriptRoot 'w2m-agent-supervisor.mjs'

# ---------------------------------------------------------------------------------------------
# -UpdateTask: repair an EXISTING registration, and touch nothing else.
#
# This exists because the task and the supervisor have to agree, and an installation registered by an
# older version of this script does not: `MultipleInstances IgnoreNew` together with the watchdog
# trigger means a task whose supervisor died while the task still reports Running can never start
# again. Measured on this machine: one supervisor, one agent, the port bound, and no way back.
#
# It runs FIRST and RETURNS, before the agent config is written and before node is even looked for,
# so it needs no elevation: `Set-ScheduledTask` on a task this user already owns is permitted
# (measured), while re-registering the S4U principal is not. Triggers and settings only -- the action,
# the principal and `%USERPROFILE%\.dsh\w2m\agent.json` are left exactly as they are.
# ---------------------------------------------------------------------------------------------
if ($UpdateTask) {
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "nothing to update: $TaskName is not registered. Run without -UpdateTask to install it."
    return
  }
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes) `
    -RepetitionDuration ([TimeSpan]::FromDays(3650))
  $existingTriggers = (Get-ScheduledTask -TaskName $TaskName).Triggers
  $isInteractive = -not ($existingTriggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })
  $updateTriggers = if ($isInteractive) {
    @((New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"), $watchdog)
  } else {
    @(
      (New-ScheduledTaskTrigger -AtStartup),
      (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
      $watchdog
    )
  }
  $updateSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances Parallel `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -StartWhenAvailable -Hidden
  Set-ScheduledTask -TaskName $TaskName -Trigger $updateTriggers -Settings $updateSettings | Out-Null
  $updated = Get-ScheduledTask -TaskName $TaskName
  Write-Host "updated $TaskName (triggers and settings only; the action and the config are untouched)"
  Write-Host "  multiple instances : $($updated.Settings.MultipleInstances)  (Parallel: the supervisor's lock is what prevents a second agent)"
  Write-Host "  watchdog           : every $WatchdogMinutes min, indefinitely"
  Write-Host "  state              : $($updated.State)"
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH; install Node 20.19+ first' }
if (-not (Test-Path $supervisor)) { throw "supervisor missing: $supervisor" }

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed scheduled task: $TaskName"
  } else {
    Write-Host "nothing to remove: $TaskName does not exist"
  }
  return
}

if (-not $Bin) {
  $Bin = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@twinsearth\w2m-dsh-plugin\bin\w2m-localside.mjs'
}

# THE ALLOW-LIST GOES INTO A FILE, NOT ONTO A COMMAND LINE.
#
# Measured three times on this project: `cmd`, PowerShell 5.1 and finally Task Scheduler each
# mangled a JSON argument. Registered through a task, `--allowed-commands "[\"node --version\"]"`
# came back stored as `"[node --version]"` -- the escapes gone, the agent reading `[node` and
# exiting 2 with ALLOWED_COMMANDS_INVALID. A config file has no quoting rules, and it is one more
# thing this installer can write for whoever has to debug the service later.
$configPath = Join-Path (Split-Path -Parent $StateDir) 'agent.json'
$agentArgs = @($AgentArgs -split '[,\s]+' | Where-Object { $_ -ne '' })
# Comma/semicolon/newline separated, NOT JSON. Measured: `powershell -File` strips the quotes out of
# a JSON argument (`["node --version"]` arrives as `[node --version]`), which is one mangling more
# than this installer needs to survive. Nothing in an allow-list entry contains a comma.
$allowList = @($AllowedCommands -split '[,;\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($allowList.Count -eq 0) { throw '-AllowedCommands must name at least one command prefix' }
$config = [ordered]@{
  bin             = $Bin
  rabbit          = $Rabbit
  project         = $Project
  name            = $MachineName
  state           = $StateDir
  log             = $LogPath
  allowedCommands = $allowList
  agentArgs       = $agentArgs
  backoffMs       = $RestartBackoffMs
}

$arguments = @("`"$supervisor`"", '--config', "`"$configPath`"")

Write-Host 'service-mode task plan'
Write-Host "  task        : $TaskName"
Write-Host "  runs as     : $env:USERDOMAIN\$env:USERNAME ($(if ($Interactive) { 'interactive: signed in only' } else { 'S4U: whether signed in or not, session 0' }))"
Write-Host "  command     : `"$node`" $($arguments -join ' ')"
Write-Host "  config      : $configPath"
Write-Host "  allow-list  : $($config.allowedCommands -join ' | ')"
Write-Host "  log         : $LogPath"
if ($WhatIfOnly) {
  Write-Host 'config that would be written:'
  $config | ConvertTo-Json -Depth 4
  return
}
# THE CONFIG IS THE PART THAT CANNOT BE REBUILT FROM DEFAULTS.
#
# Measured the hard way while testing this deployment: re-running the installer with no parameters
# overwrote a live `agent.json` with the defaults -- the project became the current directory, the
# machine name became the hostname, and `--p2p-mode auto --p2p-port 41235` disappeared, so the agent
# immediately took an ephemeral port and every dispatch would have fallen back to the relay. Nothing
# errored and nothing warned; the file was simply replaced. Refusing by default, and naming exactly
# what would be lost, is one line of protection against the failure this whole directory is about.
if ((Test-Path $configPath) -and -not $UpdateConfig -and -not $WhatIfOnly) {
  $current = Get-Content $configPath -Raw | ConvertFrom-Json
  if ($current.project -ne $Project -or $current.name -ne $MachineName -or [string]$current.agentArgs -ne ($agentArgs -join ' ')) {
    Write-Error @"
$configPath already exists and differs from what this run would write:
  now : project=$($current.project) name=$($current.name) agentArgs="$($current.agentArgs)"
  next: project=$Project name=$MachineName agentArgs="$($agentArgs -join ' ')"
Re-run with -UpdateConfig to replace it, or with -WhatIfOnly to see the whole file first.
A silent replacement is how a machine loses its pinned punch port and its identity.
"@
    return
  }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $configPath) | Out-Null
# Write it WITHOUT a BOM. `Set-Content -Encoding utf8` on PowerShell 5.1 prepends one, `JSON.parse`
# refuses it, and the supervisor then exits 78 before it has opened its log -- a failure with no
# trace anywhere. (The supervisor also strips a BOM now; both ends, because the file is meant to be
# hand-editable and Notepad writes BOMs too.)
$json = $config | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote $configPath"

$action = New-ScheduledTaskAction -Execute $node -Argument ($arguments -join ' ') -WorkingDirectory $PSScriptRoot
# ---------------------------------------------------------------------------------------------
# THE WATCHDOG TRIGGER, AND WHY THE TASK MAY NOW RUN MORE THAN ONE INSTANCE
#
# Measured twice on this machine: the whole process tree (supervisor + agent) is killed with
# 0xC000013A (STATUS_CONTROL_C_EXIT -- its console went away), the log ends mid-sentence, and Task
# Scheduler does NOT bring it back even with RestartCount 999: the task simply ends. The fleet then
# silently loses the machine, which is exactly the failure a supervisor was supposed to prevent.
#
# A repeating trigger fixes that without any administrator right: the task means "be running, or
# start", so a death from any cause is repaired at the next tick. Until recently that trigger had to
# be paired with `MultipleInstances IgnoreNew` to keep it from producing a second agent, and that
# pairing is what cost this machine a day: measured, a supervisor killed while the task still
# reported Running left the task in `Running` forever (the rejected start is 0x800710E0, "the
# operator or administrator has refused the request"), so the watchdog could never fire again while
# the detached agent kept the punch port -- one supervisor, one agent, port bound, and no way back.
#
# `MultipleInstances Parallel` is now the correct setting, because the supervisor's own lock is what
# makes a second start harmless: a generation that finds the lock held logs a no-op line and exits
# without spawning, so a tick during a healthy run costs one short-lived process and nothing else.
# The trigger therefore does what it was written to do -- repair a dead supervisor -- and cannot do
# the thing it was feared for.
# ---------------------------------------------------------------------------------------------
$repetition = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes) `
  -RepetitionDuration ([TimeSpan]::FromDays(3650))
# AtStartup only makes sense for the session-0 (S4U) shape, which also runs whether or not anyone is
# signed in. Registering an AtStartup trigger on an interactive task is refused without elevation --
# measured, and the reason this list is conditional rather than always two entries.
$triggers = if ($Interactive) {
  @((New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"), $repetition)
} else {
  @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    $repetition
  )
}
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances Parallel `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable -Hidden

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType $(if ($Interactive) { 'Interactive' } else { 'S4U' }) -RunLevel Limited

if ($Interactive) {
  # The no-elevation shape. It works and it is what this project shipped first, but the process
  # lives in the sign-in session: closing that session's console is what produced 0xC000013A, which
  # is the death the supervisor now at least records.
  Write-Warning 'Interactive mode: the agent runs only while this user is signed in, and a console close can kill it (the supervisor will restart it when the session returns).'
}

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
} catch {
  Write-Error @"
could not register the task: $($_.Exception.Message)

For the default (session-0, S4U) shape that refusal is the expected one when this
script is not elevated: S4U needs SeBatchLogonRight, and an AtStartup trigger needs
elevation too -- the registration is denied with "Access is denied". Re-run the same
command from an **elevated** PowerShell.

If you cannot elevate, ask for the interactive shape instead (one trigger, AtLogOn):

  powershell -ExecutionPolicy Bypass -File deploy\windows\install-service.ps1 -Interactive `
    -Project '$Project' -AllowedCommands '$AllowedCommands'

It works, and it is what this project shipped first -- but the process lives in the
sign-in session, so signing out stops it and a console close can kill it.
"@
  return
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 10
$task = Get-ScheduledTask -TaskName $TaskName
$info = $task | Get-ScheduledTaskInfo
Write-Host "state=$($task.State) lastRun=$($info.LastRunTime) lastResult=$($info.LastTaskResult)"
Write-Host "session of the agent process (0 = service session):"
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-2) } |
  Select-Object Id, SessionId, StartTime | Format-Table -AutoSize
Write-Host "log tail:"
Get-Content $LogPath -Tail 5 -ErrorAction SilentlyContinue
