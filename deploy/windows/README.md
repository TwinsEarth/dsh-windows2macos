# Windows: running the agent as a service

The agent must run without a console, start with the machine, and survive sign-out.
Three shapes do that on Windows, and they differ in one thing that matters: **whether
something third-party ends up hosting the process.**

| | Service-mode task (recommended) | Real SCM service (WinSW / NSSM) | Interactive task |
|---|---|---|---|
| Starts at boot | yes (S4U, session 0) | yes | no — at sign-in |
| Survives sign-out | yes | yes | no |
| Shows up in `services.msc`, `Restart-Service` | no (`Start-ScheduledTask`) | yes | no |
| Third-party binary required | **no** | **yes** — the service host | no |
| Needs elevation to install | yes (S4U ⇒ `SeBatchLogonRight`) | yes | **no** |
| Console-close death (`0xC000013A`) | avoided (session 0 has no console) | avoided | **hit** — measured twice |

## 1. Service-mode task — `install-service.ps1`

```powershell
# elevated PowerShell, from the repository root
powershell -ExecutionPolicy Bypass -File deploy\windows\install-service.ps1 `
  -Project 'E:\path\to\your\project' `
  -MachineName win-desktop `
  -AllowedCommands 'node --test, git status --porcelain' `
  -AgentArgs '--p2p-mode auto --p2p-port 41235'
```

It registers **one** task that runs `w2m-agent-supervisor.mjs`, which owns the agent:

* `-AtStartup` **and** `-AtLogOn`, `LogonType S4U` → runs whether the user is signed in or not,
  in session 0, with no console for anything to close;
* `MultipleInstances IgnoreNew` → two agents must never share one device identity;
* `RestartCount 999` / 1 min, `ExecutionTimeLimit 0`, `-StartWhenAvailable`.

Everything except the task's own command line goes into **`%USERPROFILE%\.dsh\w2m\agent.json`**,
which the installer writes and the supervisor reads; edit that file to change the allow-list, the
project, or the agent's flags, then `Restart-ScheduledTask`-equivalent
(`Stop-ScheduledTask` + `Start-ScheduledTask`). `-AllowedCommands` is **comma-separated plain
text** — not JSON, and not because JSON is wrong but because three separate layers eat its quotes
(see below).

Inspect and remove:

```powershell
Get-ScheduledTask -TaskName 'W2M Localside agent' | Get-ScheduledTaskInfo
Get-Content "$env:USERPROFILE\.dsh\w2m\agent.json"
powershell -ExecutionPolicy Bypass -File deploy\windows\install-service.ps1 -Uninstall
```

### The three things that were measured, not assumed

1. **Without elevation, S4U registration is refused** with `Access is denied` (S4U needs
   `SeBatchLogonRight`; an `-AtStartup` trigger needs elevation too). The script says so instead of
   half-installing. Pass `-Interactive` for the no-elevation shape — it works, but the process lives
   in the sign-in session, so signing out stops it.
2. **A JSON argument does not survive the trip.** Registered through a task,
   `--allowed-commands "[\"node --version\"]"` came back stored as `"[node --version]"`: the escapes
   gone, the agent reading `[node`, exiting 2 with `ALLOWED_COMMANDS_INVALID`. This project has now
   hit that in `cmd`, PowerShell 5.1 and Task Scheduler — hence the config file, and hence
   `-AllowedCommands` taking plain text.
3. **PowerShell 5.1 writes a UTF-8 BOM** with `Set-Content -Encoding utf8`, and `JSON.parse`
   refuses it: the supervisor exits 78 *before it opens its log*, so the failure leaves no trace
   anywhere. The installer writes without a BOM, and the supervisor strips one if it is there
   (Notepad writes them too, and this file is meant to be hand-edited).

## 2. Real SCM service — WinSW

Only if you need the entry in `services.msc` (monitoring, `Restart-Service`, a
configuration-management system that knows about services). This puts a third-party
binary on the machine as the service host, which is a decision the project will not make
for you:

```powershell
# 1. get the wrapper (verify the release hash yourself; this is the one third-party piece)
#    https://github.com/winsw/winsw/releases
# 2. put w2m-localside.exe and w2m-localside.xml (below) in C:\ProgramData\w2m\
# 3. install it -- elevated
C:\ProgramData\w2m\w2m-localside.exe install
C:\ProgramData\w2m\w2m-localside.exe start
```

`deploy/windows/winsw/w2m-localside.xml` is the template; edit the two paths in it. The
supervisor still wraps the agent, so a crash loop is visible in the log rather than
turning into a service that flaps.

## 3. The one thing that is not a deployment detail

Whichever shape you pick, the machine must be **paired** and the punch port must match its
firewall rule:

```powershell
# the identity this agent uses (create it by pairing once, with a code from the relay)
Get-Content "$env:USERPROFILE\.dsh\xclient\device.json"
# if you pinned --p2p-port, open exactly that port once -- elevated
New-NetFirewallRule -DisplayName 'W2M punch (node UDP)' -Direction Inbound -Protocol UDP `
  -Program 'C:\Program Files\nodejs\node.exe' -LocalPort 41235 -Action Allow
```

A pinned port is worth it for a service: an ephemeral one changes on every restart, and a
stale rule looks exactly like "the punch just does not work" — every task quietly falls
back to the relay with `offer_path: "relay"` in the ledger.

## Verify it, rather than trusting it

```powershell
# the task is running, and in which session
Get-ScheduledTask -TaskName 'W2M Localside agent' | Select-Object State
Get-Process node | Where-Object { $_.SessionId -eq 0 } | Select-Object Id, SessionId, StartTime

# the agent's own narration: "stream ready" is the line that means the fleet can reach it
Get-Content "$env:USERPROFILE\.dsh\w2m\agent.log" -Tail 20

# and one real dispatch from any machine with the plugin installed
#   w2m_devices  -> this machine must be listed as online
#   w2m_run ["git","rev-parse","HEAD"]  -> w2m_wait must show transport: p2p (or relay, with a reason)
```
