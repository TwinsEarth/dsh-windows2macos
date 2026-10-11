# W2M troubleshooting

Symptom first. Find the sentence you are looking at, follow the checks in order, and stop when one
of them answers. Every check is a command you can run; every claim about a cause says whether it is
ours, the operating system's, the network's, or another tool's.

If you are about to file a bug, run the **triage block** at the end of §15 first — it collects the
five facts a maintainer will ask for anyway.

**Where things live:** §16 is a table of every file and directory this project creates, per platform.
You will want it before §4 and §9.

---

## The first four minutes

Most reports are one of four things. In this order:

| #   | Check                                                              | Command                                           |
| --- | ------------------------------------------------------------------ | ------------------------------------------------- |
| 1   | Are the tools there at all?                                        | in DSH: _list the w2m tools_ — then `w2m_devices` |
| 2   | Is the relay reachable from **this** machine?                      | `w2m_status` and read `rabbit_source` / the probe |
| 3   | Is the agent running on the machine that is not answering?         | see §5                                            |
| 4   | Does the profile's `cordis.patch.yml` still contain the `w2m` row? | §2, §3 — an installer can rewrite it              |

---

## 1. `w2m_*` tools are missing after an upgrade

**Symptom.** You upgraded the plugin and the eight tools are gone from the session. Sometimes DSH
still starts; sometimes it does not (then read §3).

**What this is.** Almost always a _composed_ problem, not an installed one: the package is in the
profile's `node_modules`, but no `w2m` row was composed into the running config, so nothing
registered. "It installed" is not "it loads".

**Decision procedure.**

```bash
# 1. What is actually installed, and where?
cat "$DSH_HOME/profiles/<profile>/node_modules/@twinsearth/w2m-dsh-plugin/package.json" | grep '"version"'

# 2. Does that copy register eight tools on its own?
#    Run this from a checkout of this repository: scripts/verify-installed.mjs imports the real
#    entry and calls apply() against a stub tools registry.
node scripts/verify-installed.mjs \
  "$DSH_HOME/profiles/<profile>/node_modules/@twinsearth/w2m-dsh-plugin"
```

`PASS: 8 tools registered` with the tools missing in the session means the artifact is fine and the
composition is not — go to step 3. A `FAIL:` here means the installed copy itself is broken; reinstall
(§3).

```bash
# 3. Does the profile still carry the w2m row?
grep -n -A4 'id: w2m' "$DSH_HOME/profiles/<profile>/cordis.patch.yml"

# 4. Did the loader skip the patch? DSH prints the reason.
dsh --profile <profile> --dump-config 2>&1 | grep -i -e w2m -e patch -e skip
```

`patch: entry "w2m" not found` or `patch: name mismatch ... skipping` means the row was composed from
a file the loader is not mounting — see §2.

**Fix.**

1. Confirm the row exists and names the **bare package**, not a subpath (§2).
2. Restart DSH. A `cordis.patch.yml` change is read at startup, not on file change.
3. If the row is missing entirely, re-add the plugin and re-apply your config from the backup §2
   tells you to take.

**Not us.** If step 1 fails with `ERR_PNPM_NO_MATCHING_VERSION` or a message about the release being
**too new**, that is pnpm's `minimumReleaseAge` supply-chain gate refusing a version published
minutes ago — not a broken release. See §11.

---

## 2. The profile's `cordis.patch.yml` lost my configuration

**Symptom.** After installing or upgrading, the tools work but every setting is back to its default:
`rabbitUrl` points at the shared server, `operatorToken` is empty, `stateDir` and `machineName` are
blank, the allow-list is empty. Nothing errored.

**Cause.** Two different mechanisms, and the one this section used to name was wrong. **`dsh plugin add`
does not rewrite `cordis.patch.yml`** — the CLI shares the plugin manager's package operations, which
are `pnpm` plus the profile manifest and lockfile: `package.json` and `pnpm-lock.yaml` are what a package
operation writes, and a failed or cancelled install restores exactly those two. The manager's own patch
writes are _plugin toggles_ in the Web plugin page, not installs.

What actually removes the file is **Desktop's fatal-recovery `sanitizeProfile`**. When DSH hits a native
fatal error it recovers the profile without loading plugins: it **renames `cordis.patch.yml` to
`cordis.patch.yml.bak-<unix-ms>`** and rewrites the bundle list. That is consistent with what was
observed here — the configuration block vanished around a crash, and a `.bak-<timestamp>` sibling is the
signature to look for. So the failure mode is not "the installer ate my settings"; it is "the app
crashed, recovered, and the patch went with it".

**This is why the backup habit below still matters, and matters more before an upgrade.** An upgrade is
when a crash is most likely to be provoked and least likely to be watched; the `.bak-<timestamp>` file is
what makes the settings recoverable afterwards, and it costs one `cp`.

A second, sharper trap, unrelated to either mechanism: a **fresh** profile's `cordis.patch.yml` is the
placeholder `[]`. That is an empty YAML _sequence_. Appending a mapping block to it produces invalid
YAML, and the loader fails on the file as a whole — one bad row takes the entire profile down, not
just this plugin. Both cases are why this file is treated as hand-edited state, not as a generated
artifact.

**Decision procedure.**

```bash
# 1. What does the file look like right now?
cat "$DSH_HOME/profiles/<profile>/cordis.patch.yml"
```

- First characters are `[]` → the placeholder case; see the safe-edit rule below.
- The `w2m` row is absent → it was dropped; re-add it (§2 fix 3).
- The row is present but values are empty → it was reset; re-apply them.

```bash
# 2. Is the file still valid YAML? (python3 ships with macOS and most Linux; Windows: use node)
node -e "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');console.log('non-empty:', t.trim().length>0, 'starts with []:', t.trim().startsWith('[]'))" \
  "$DSH_HOME/profiles/<profile>/cordis.patch.yml"

# 3. Which config did the loader actually compose? (goes to stderr)
dsh --profile <profile> --dump-config 2>&1 | grep -n -i -e 'id: w2m' -e 'patch:'
```

`patch: entry "w2m" not found` means the loader looked for an entry named `w2m` to _replace_ and found
none, so it skipped the whole patch silently. `patch: name mismatch ... skipping` means the `name:`
in the profile's row and the mounted package disagree — usually because one of them carries the
`/tools` subpath and the other does not.

**Fix.**

1. **Back the file up before every install or upgrade.** This is the one habit that makes the rest
   recoverable:

   ```bash
   cp "$DSH_HOME/profiles/<profile>/cordis.patch.yml" \
      "$DSH_HOME/profiles/<profile>/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)"
   ```

2. **If the file is the `[]` placeholder, delete the placeholder before writing your block.** Do not
   append to `[]`, and use the `insert:` form to create the row:

   ```yaml
   # WRONG -- a sequence followed by a mapping is invalid YAML, and it takes the profile down
   []
   - id: w2m
     config: { ... }

   # ALSO WRONG, and quieter -- a bare `- id:` is a NON-insert patch: it replaces supplied fields on
   # an entry an earlier layer already created. No earlier layer creates `w2m`, so the loader warns
   # `patch: entry "w2m" not found` and skips the whole row. The install succeeds, DSH starts, and
   # none of the eight tools exist.
   - id: w2m
     name: '@twinsearth/w2m-dsh-plugin'
     config:
       rabbitUrl: ''

   # RIGHT -- `insert:` appends the entry, which is what creating a row means
   - insert:
       - id: w2m
         name: '@twinsearth/w2m-dsh-plugin'
         config:
           rabbitUrl: ''
           operatorToken: ''
           stateDir: /absolute/path/to/$DSH_HOME/xclient
           machineName: win-desktop
           p2pMode: auto
           allowedCommands: []
   ```

   **When each form is appropriate.** `insert:` is for _creating_ a row — it is the only form that can,
   and it is what the packaged `cordis.patch.yml` uses for exactly that reason. A bare `- id:` (with no
   `insert:`) is for _overriding fields on a row that already exists_, which is what the home-level patch
   and a plugin toggle do; used against a row that nothing created, it is a silent no-op.

   In other words: replace the `[]` with an `insert:` list, or add your `- insert:` item at the same
   indentation as the existing items. Never leave the `[]` above your block, and never reach for the
   bare `- id:` form to create something new.

3. **The `name:` must be the bare package.** `@twinsearth/w2m-dsh-plugin` — not
   `@twinsearth/w2m-dsh-plugin/tools`, not a path, not `.js`. A client package is identified by the
   specifier its Loader row carries, so a subpath resolves to no `package.json`, the browser half is
   never composed, and the failure is invisible on the host side.
4. Restart DSH, then re-run `w2m_status` and check the values came back.
5. If the file is unparseable, restore the backup and restart; a malformed patch file is a whole-file
   failure.

**Not us.** Neither mechanism is this plugin's: the install writes the manifest and lockfile, and the
crash-recovery rename is the host's. Treat the file as shared state — your edits can be reverted by any
tool that manages the profile, and the `.bak-<timestamp>` sibling is the receipt.

---

## 3. DSH will not start (or the entry failed to load) after installing this plugin

**Symptom.** The application refuses to start, or the log shows one of:

```
w2m (@twinsearth/w2m-dsh-plugin/tools): Error: cannot get property "connection" without inject
include:@twinsearth/w2m-dsh-plugin/tools reports fiberPhase: failed
```

and **all eight tools disappear** even though the package installed cleanly.

**Cause.** A defect in the installed version, not in your configuration. This exact failure shipped
in **v0.5.4 and v0.5.5**: the loader entry failed, so the whole host entry was skipped.

**Decision procedure.**

```bash
# Which version is in the profile?
node -p "require('$DSH_HOME/profiles/<profile>/node_modules/@twinsearth/w2m-dsh-plugin/package.json').version"
```

**Fix.** Install a version that is not withdrawn. **v0.5.9 is the current release and is installable**;
v0.5.4 and v0.5.5 are not, because they prevent the application from starting. Everything else from
v0.5.6 on is installable too, and v0.5.3 and earlier install but predate the client half.
`CHANGELOG.md` carries `DO NOT INSTALL` on the withdrawn entries — check it before
installing a version you have not run before.

```bash
# Uninstall the broken copy, then install a known-good one
dsh plugin --profile <profile> remove @twinsearth/w2m-dsh-plugin
dsh plugin --profile <profile> add @twinsearth/w2m-dsh-plugin@0.5.9
```

The plugin being uninstalled must not leave a dangling row: if the profile still lists the package
after removal, remove the `w2m` row from `cordis.patch.yml` by hand (§2) before restarting.

**Not us.** If the failure is in a _different_ plugin's entry and this one is merely in the same
profile, the loader reports the package name in the same line — read it before assuming it is ours.

---

## 4. A machine is listed but never answers

**Symptom.** `w2m_devices` lists the machine, `w2m_run` dispatches to it, and the task sits in
`claimed` (or the wait times out). The relay says the device is `online`.

**Cause, in the order they actually happen.** Three different failures look identical here:

1. **The agent is not running.** The relay lists a device by its last heartbeat; a stopped agent is
   listed while its lease has not yet expired. A machine shown online whose agent is stopped is the
   normal case, not a bug.
2. **The agent is running but cannot reach the relay** (carrier-grade NAT, a corporate proxy, DNS).
   Then it reconnects forever and the machine looks listed-but-deaf.
3. **The agent is running and reachable, but the task's `cwd` does not exist** on that machine, or
   the command is refused — both are then reported as a `refused` result, not as silence. If you are
   getting silence, it is 1 or 2.

**Decision procedure.**

```bash
# 1. On the machine that is not answering: is the agent process alive?
#    Windows (the scheduled task deploy/windows/install-service.ps1 creates):
Get-ScheduledTask -TaskName 'W2M Localside agent' | Get-ScheduledTaskInfo
Get-Content "$env:USERPROFILE\.dsh\w2m\agent.log" -Tail 40

#    macOS / Linux, started by hand:
ps aux | grep -v grep | grep w2m-localside

# 2. What does the agent's own state say? (written by the agent; no network needed)
cat "$DSH_HOME/xclient/localside/agent-state.json"
```

Read `machine_id`, the last heartbeat and the last error in that file. `agent-state.json` is the
answer to "was the agent ever up", independent of what the relay thinks.

```bash
# 3. From the dispatching side: what does the relay believe, and for how long?
w2m_devices          # compare `last_seen` / `state` across machines
w2m_status           # relay probe, configured rabbit source, per-machine path
```

A device whose `state` is `expired` was reaped after two missed 10-second heartbeats plus the lease
grace (≈50 s). A device listed `online` but whose `last_seen` is minutes old is case 1 or 2.

**Fix.**

1. **Start the agent** (case 1). On Windows, re-run the supervisor installer from `deploy/windows/`;
   on macOS/Linux start `w2m-localside` the way you normally do and check its first lines for the
   relay URL it resolved.
2. **If the agent cannot reach the relay** (case 2), read §13 — it is almost always the network, not
   the relay, and the agent's log names the error.
3. **If the machine is behind a NAT you do not control** and you need the fast path, read §6 and §13.

**Not us.** A machine that is asleep, throttled, or on a VPN that resets connections produces exactly
this symptom; the agent cannot report from a suspended process. Check `agent.log` timestamps before
suspecting the relay.

---

## 5. "Online" but no agent: how to tell

**Symptom.** You are not sure whether the agent is running, and `w2m_devices` is not enough to
decide.

**Decision procedure.** The three sources disagree in a specific order, and the disagreement _is_ the
diagnosis:

| Source                            | What it proves                                | How to read it                        |
| --------------------------------- | --------------------------------------------- | ------------------------------------- |
| Relay device list (`w2m_devices`) | the machine heartbeat within the lease window | `state: online`, `last_seen_at_ms`    |
| Agent state file (§16)            | the agent wrote a snapshot on this machine    | `agent-state.json` mtime and contents |
| The machine itself                | a process is listening/looping                | `agent.log` last line, process list   |

If the relay says `online` but the state file's modification time is older than the last heartbeat
interval, the agent has stopped since the relay last heard from it — expect the lease to expire in
under a minute. If the state file is _fresh_ but the relay lists the device as `expired`, the agent is
alive and cannot reach the relay: go to §13.

**Fix.** None needed beyond §4; this section exists so you stop guessing which of the two is lying.
They are not lying, they measure different things.

---

## 6. The direct path is never used (`transport: "relay"`)

**Symptom.** Every result reports `transport: "relay"` (or `p2p.offer_path`/`p2p.result_path` say
`relay`), and the punch never lands. Results still arrive, so nothing looks broken — it is just slow.

**Cause.** The fallback is deliberate: a failed punch costs latency, not the task. The reason is
attached to the result rather than summarised as "no direct path". Common reasons:

- `P2P_PUNCH_TIMEOUT` — the candidates were wrong or the network blocks UDP;
- both peers behind carrier-grade NAT (CGNAT) with address-dependent mapping;
- a firewall that allows the port but not the **program** (see below);
- one side pinned `--p2p-port` and the other cannot send to it.

**Decision procedure.**

```bash
# 1. Ask what path each machine reports, and the measured NAT mapping
w2m_status
w2m_devices

# 2. Force the question: run with the direct path disabled, then with it required.
#    (relay-only proves the control plane is fine; direct-only makes the punch failure loud)
#    --p2p-mode is the agent's flag; W2M_P2P_MODE is the environment equivalent.
```

- `p2pMode: relay` → no UDP socket is bound at all. Use it to take the punch out of the picture.
- `p2pMode: direct` → a failed punch is **not** hidden: the executor refuses an offer that did not
  arrive over the direct path (`refusal_reason: P2P_UNAVAILABLE`). Use it to make the failure loud.

If direct-only refuses while relay-only succeeds, the control plane is healthy and the problem is
UDP path traversal — §13 and the firewall note below.

**Fix.**

1. **Pin the punch port on the machine that has an inbound firewall.** An ephemeral port cannot be
   named in a rule that survives a restart:

   ```bash
   node bin/w2m-localside.mjs --p2p-port 41234 ...     # or W2M_P2P_PORT=41234
   ```

2. **Write the firewall rule against the program, not only the port.** This is the failure that
   wastes the most time: a rule that permits UDP 41234 but not the Node binary that owns the socket
   still drops the traffic, and from the other side it is indistinguishable from nobody listening.

   ```powershell
   # Windows: allow the program, then confirm the rule is enabled and actually matching
   New-NetFirewallRule -DisplayName 'w2m p2p (node)' -Direction Inbound -Protocol UDP `
     -Program 'C:\path\to\node.exe' -Action Allow
   Get-NetFirewallRule -DisplayName 'w2m p2p*' | Select-Object DisplayName,Enabled,Direction,Action
   ```

   ```bash
   # Linux (ufw): allow the port for the program's user, and check the rule is loaded
   sudo ufw allow 41234/udp
   sudo ufw status verbose
   ```

   ```bash
   # macOS: the application firewall prompts per binary; confirm the entry exists
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --listapps | grep -i node
   ```

3. Confirm from **outside** the machine that the port is really reachable — a rule you wrote is not
   a port that answers. `deploy/networking/LESSONS.md` records what this cost previously.

**Not us.** A symmetric NAT or a CGNAT you do not control cannot be fixed by configuration. The
relay is the permanent fallback precisely for that case; a persistently relay-only fleet is a
network property, not a defect.

---

## 7. A command is refused by the allow-list

**Symptom.** The result comes back `refused` with:

```
COMMAND_NOT_ALLOWED
`<your command>` is not in this plugin's allowedCommands (<the list as configured>)
```

and the agent log has `refused <task_id>: COMMAND_NOT_ALLOWED`.

**Cause.** The allow-list is a **default-deny prefix matcher over the whole `argv`**, token by token —
not over the executable alone. Two consequences surprise people:

- `node -e console.log` does **not** allow `node -e console.log(1)`: the tokens after the prefix must
  match too, and here the third token differs (`console.log` vs `console.log(1)`).
- A string entry is split on whitespace. A path containing a space therefore cannot be expressed as a
  string entry — write it as a **JSON array element** instead.
- **An empty list means two opposite things, one per side, and the symptom looks the same.** The
  plugin's list (`allowedCommands`) is **not a gate when empty**: with nothing configured the plugin
  declines to refuse, deliberately, because the gate belongs to the machine that runs the command and it
  will not duplicate a policy it was not given. The agent's list (`--allowed-commands`) is
  **default-deny with nothing configured**: an empty list refuses **every** offer, with
  `COMMAND_NOT_ALLOWED` and the detail _"the configured allow-list is empty, so every command is
  refused"_. So "I set nothing on either side" runs nothing at all, and "I set nothing on the plugin
  side" runs exactly what the agent allows — check both lists before concluding which one refused you.

**Decision procedure.**

```bash
# 1. What list is in force on that machine? The refusal message prints it verbatim
#    ("not in this plugin's allowedCommands (node --test, git status --porcelain)").
#    The plugin-side list comes from the profile config:
grep -n -A6 'allowedCommands' "$DSH_HOME/profiles/<profile>/cordis.patch.yml"
#    The agent-side list comes from --allowed-commands or W2M_* on that machine.
```

```bash
# 2. Reproduce the matcher's decision locally: it is a pure function, no agent and no relay.
#    From a checkout of this repo:
node --input-type=module -e "
import { parseAllowedCommands, matchAllowedCommand } from './src/agent/allowed-commands.mjs';
const prefixes = parseAllowedCommands(['node --test','git status --porcelain']);
for (const argv of [['node','--test','x.test.mjs'],['node','--testify','x'],['node'],['git','rev-parse','HEAD']]) {
  const r = matchAllowedCommand(argv, prefixes);
  console.log((r.allowed ? 'ALLOW ' : 'REFUSE') + '  ' + JSON.stringify(argv));
}
"
```

Measured against that list, so you know what the gate does rather than what it is supposed to do:

| argv                     | decision | why                                                                    |
| ------------------------ | -------- | ---------------------------------------------------------------------- |
| `node --test x.test.mjs` | ALLOW    | `node --test` is a prefix                                              |
| `node --test`            | ALLOW    | a prefix may be the whole command                                      |
| `node --testify x`       | REFUSE   | token 2 is `--testify`, not `--test` — a prefix is not a glob          |
| `node`                   | REFUSE   | shorter than the prefix                                                |
| `git rev-parse HEAD`     | REFUSE   | not a prefix of `git status --porcelain`                               |
| `/usr/bin/node --test a` | ALLOW    | the executable token is compared by name, so a full path still matches |

**Fix.**

1. Add the **shortest prefix that still constrains the command**, as an array entry when a token
   contains a space:

   ```bash
   --allowed-commands '["node --test","git status --porcelain",["C:\\Program Files\\nodejs\\node.exe","--version"]]'
   ```

2. Restart the agent: the list is read at startup.
3. An **empty** list means "no plugin-side gate", not "nothing runs" — but the agent-side
   `--allowed-commands` still applies, and a command must pass both.

**Not us.** Windows argument quoting is the usual culprit when a command you believe is allowed is
refused: the refusal message prints the tokens the agent actually received. Compare them with what
you wrote before editing the list.

---

## 8. Results are reported `unverifiable`

**Symptom.** A verdict comes back `⚠️ unverifiable` instead of `consistent`/`divergent`, with a reason
such as `envelope status = unverifiable`, `step1_unverifiable`, or
`aggregation refused: Step 1 anchor violation (see unverifiable machines)`.

**Cause.** A machine that **cannot reproduce the anchor** is reported `unverifiable` rather than
compared. This is the honest outcome, and it is deliberate: comparing a checkout that is not at the
anchor would produce a confident, wrong "divergent". The usual reasons:

1. The project on that machine has uncommitted changes, or is on a different commit than the anchor.
2. The command did not produce the required envelope fields, so the result is missing what a
   comparison needs (the agent treats a missing required field as `unverifiable`, not as a failure).
3. The machine never returned anything (then §4/§5 apply first).

**Decision procedure.**

```bash
# On the machine reporting unverifiable: what do the anchors say?
cd <project>
git rev-parse HEAD
git status --porcelain          # any output at all means the tree is not at the anchor

# From the dispatching side: which machine, and which reason?
w2m_report                      # per-machine outcome plus the reasons it lists
w2m_history                     # recent tasks with their modes and outcomes
```

**Fix.**

1. Commit or stash the local changes, check out the anchor commit, and re-run — a dirty tree is by far
   the most common cause.
2. If the tree is clean and the anchors match, treat it as a missing/partial envelope and go to §15 so
   the report includes the attempt count and the machine's own `agent-state.json`.
3. Do **not** "fix" it by making the comparison lenient: an anchor that does not reproduce is exactly
   the case where a comparison would mislead.

**Not us.** Line-ending conversion, a `core.autocrlf` difference, or a case-insensitive filesystem can
make an identical tree differ. `git status --porcelain` is the arbiter; if it is clean, the anchors
match.

---

## 9. The relay is unreachable

**Symptom.** One of:

```
W2M_UNREACHABLE: could not reach the Rabbit at <url>: <underlying error>
W2M_RABBIT_REFUSED: ... this machine is not paired, or its device_token is stale - pair the agent again
no Rabbit URL is configured, so the fleet cannot be listed
```

Every `w2m_*` tool that talks to the relay fails; `w2m_status` cannot probe it.

**Cause, in order of likelihood.** The relay is not running; the URL is wrong; DNS resolves but the
port is filtered; the machine is behind carrier-grade NAT (CGNAT) with no outbound route to that
host; the relay is up but the token is wrong (that is `W2M_RABBIT_REFUSED`, a _different_ answer).

**Decision procedure.**

```bash
# 1. Which URL is this machine actually using, and where did it come from?
w2m_status          # reports rabbit_source: "config" | "env" | "shared-default"

# 2. Can this machine reach it at all? (transport, before HTTP)
curl -sS -m 10 -o /dev/null -w '%{http_code} in %{time_total}s\n' <rabbitUrl>/healthz

# 3. Is it DNS, TCP, or the application?
nslookup <relay-host>
#   Windows: Test-NetConnection <relay-host> -Port 8787
#   macOS/Linux: nc -vz <relay-host> 8787

# 4. Is the relay itself healthy? (run on the relay host)
curl -sS http://127.0.0.1:8787/healthz
```

Resolution order is `rabbitUrl` config → `W2M_RABBIT_URL` → the shared default, and an explicit value
always wins. `rabbit_source: "shared-default"` means you are talking to somebody else's host — that
is reported so it can never be a surprise.

**Fix.**

1. **The relay is down:** restart it (`deploy/systemd/w2m-rabbit.service`, or the container) and check
   its own state directory is intact (§16) — a relay started with `--no-persist` loses its device
   table on every restart, and every machine must pair again.
2. **The URL is wrong:** set it in the profile config (§2) or `W2M_RABBIT_URL`, then restart DSH. A
   URL with a sub-path is supported.
3. **DNS or TCP fails but the host is up:** the path is filtered. Try the same `curl` from the relay
   host to confirm which side is blocking.
4. **`W2M_RABBIT_REFUSED` (HTTP 401):** the relay answered, so nothing is wrong with the network. The
   machine is not paired, or its device token is stale — pair the agent again. Do not chase the
   network.

**Not us.** A relay you do not control, a corporate proxy that intercepts plain HTTP, and a CGNAT that
blocks the outbound port all produce step 2 failures with no HTTP status. `curl`'s error text names
which one; a timeout is a path problem, a refused connection is a listener problem, and a TLS/HTTP
error is neither.

---

## 10. Port 8787 or the pinned punch port is already in use

**Symptom.** The relay or the agent exits immediately with `EADDRINUSE`.

**Decision procedure.**

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object LocalAddress,State,OwningProcess
Get-NetUDPEndpoint  -LocalPort 41234 -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess
```

```bash
# macOS / Linux
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iUDP:41234
ss -lntup | grep -e 8787 -e 41234
```

**Fix.** Stop the other listener, or move the pin (`--p2p-port`, `W2M_P2P_PORT`) and update the
firewall rule in §6 to the new port.

**Not us.** On developer machines the usual occupant is a leftover agent from a previous run, or a
second relay started from another checkout. Check the owning process before assuming a port conflict
with something unrelated.

---

## 11. The version you just published will not install (`minimumReleaseAge`)

**Symptom.** Installing a version published minutes ago fails even though it exists on npm:

```
ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @twinsearth/w2m-dsh-plugin@<version>
```

or the resolver reports the version as too new to be selected. Hours later the same command works.

**Cause.** **Not this plugin.** pnpm's `minimumReleaseAge` supply-chain gate refuses packages younger
than a configured age so that a compromised release has time to be yanked. A just-published version is
invisible to the resolver until it ages out.

**Decision procedure.**

```bash
# 1. Does the version exist in the registry at all?
npm view @twinsearth/w2m-dsh-plugin versions --json

# 2. What is this machine's configured gate?
pnpm config get minimumReleaseAge
```

If step 1 lists the version and step 2 is a non-zero number of minutes, that is the cause.

**Fix.** Pick one, consciously:

```bash
# Wait for the gate to pass (a tarball URL bypasses the resolver entirely -- but read the release
# notes first, and prefer a version that is not withdrawn; see CHANGELOG.md).
dsh plugin --profile <profile> add \
  https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v0.5.9/twinsearth-w2m-dsh-plugin-0.5.9.tgz
```

Or raise the gate for this machine — a deliberate supply-chain trade, so make it deliberately:

```bash
pnpm config set minimumReleaseAge 0        # per-machine, weakens the gate for every package
```

**Not us.** This is pnpm's behaviour and it applies to every package you install, not ours. If you
bypass the gate with a tarball URL, verify it against `SHA256SUMS` from the same release.

---

## 12. A machine is listed and paired but not _selectable_ in the composer

**Symptom.** The dispatch-target control beside the permission control shows the machine, but it
cannot be picked.

**Cause.** The control shows the relay's own device list through the same helper `w2m_devices` uses, so
the tool and the control cannot disagree about who is online. A machine the relay does not list as
online is shown but not selectable — that is the design, not a rendering bug. "Unknown" is not
"reachable": a device record with neither an `online` boolean nor `state: online` is treated as not
online.

**Decision procedure.** `w2m_devices` and compare `state`/`online` with what the control shows. If the
tool lists it as `expired`, §4/§5 apply; the control is telling you the truth.

**Fix.** Get the agent heartbeating again (§4), then reload the page: the roster is read on load.

**Not us.** A stale browser tab keeps the roster it loaded. If the tool and the control disagree after
a reload, that is ours — report it (§15).

---

## 13. Behind carrier-grade NAT: nothing works from that machine

**Symptom.** A machine on a mobile, hotel or ISP CGNAT link cannot reach the relay at all, or reaches
it but never forms a direct path. `curl` to the relay from that machine times out; other machines are
fine.

**Cause.** CGNAT puts many subscribers behind one address and typically blocks inbound connections;
outbound to a non-standard port may also be filtered. **We cannot fix this from inside the plugin.**
What we can do is report it instead of hiding it.

**Decision procedure.**

```bash
# 1. Outbound reachability first, from the affected machine
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' <rabbitUrl>/healthz || echo "no route to relay"

# 2. If that works, the control plane is fine and only the punch is blocked: check the reported path
w2m_status          # transport per machine
w2m_devices         # the measured NAT mapping
```

**Fix.**

1. **Put the relay somewhere both machines can reach** — a VPS, or the shared server. `deploy/` has
   shapes for a shared server, nginx, Caddy, Docker, WireGuard and systemd; `deploy/networking/LESSONS.md`
   records what was measured on real networks.
2. **If the relay must be reached over an outbound-only path**, a tunnel or WireGuard carries it;
   `p2pMode: relay` then removes the UDP question entirely.
3. **Accept relay-only.** The relay is the permanent fallback by design; a fleet that stays on it is
   slower, not broken.

**Not us.** The CGNAT. This is the case the architecture was built around; a machine that cannot be
punched is expected, and the reported reason (`P2P_PUNCH_TIMEOUT`, `transport: "relay"`) is the honest
answer rather than a silent degradation.

---

## 14. After a reboot the relay "forgot" every machine

**Symptom.** Every machine must pair again after the relay restarts; `revived_devices` is `0` or
absent.

**Cause.** The relay persists its device table (`devices.json`) and its ledger (`ledger.jsonl`) under
its state directory (§16). If it was started with `--no-persist`, or the state directory is inside a
container that was recreated, or the file is unreadable, the table starts empty.

**Decision procedure.**

```bash
# On the relay host: is the state directory mounted, and is it the same one as last time?
curl -sS http://127.0.0.1:8787/healthz | grep -o '"revived_devices":[0-9]*'
ls -l /var/lib/w2m/devices.json /var/lib/w2m/ledger.jsonl
```

`revived_devices` greater than zero means the table was restored and existing device tokens remain
valid — no re-pairing needed. A corrupt `devices.json` is reported as
`persistence.devices_corrupt: true` and the relay starts empty rather than refusing to start; a corrupt
`ledger.jsonl` line is skipped, counted in `ledger_lines_skipped`, and detailed in
`persistence.warnings`.

**Fix.** Point the state directory at persistent storage (`systemd`: `StateDirectory=w2m`; container: a
named volume) and restart. Back it up before you need it:

```bash
sudo tar czf w2m-state-$(date +%F).tgz -C /var/lib w2m
```

**Not us.** A container without a volume is the usual cause: the relay behaved correctly, its state
directory was deleted underneath it.

---

## 15. Before you file a bug: the triage block

Run these five and paste the output. They are the questions a maintainer asks first, and the untested
one is usually the answer.

```bash
# 1. Versions: what is installed, and is it a withdrawn version?
node -p "require('$DSH_HOME/profiles/<profile>/node_modules/@twinsearth/w2m-dsh-plugin/package.json').version"
grep -n 'DO NOT INSTALL' CHANGELOG.md

# 2. The composed config: does the w2m row exist, and what does the loader say?
grep -n -A6 'id: w2m' "$DSH_HOME/profiles/<profile>/cordis.patch.yml"
dsh --profile <profile> --dump-config 2>&1 | grep -i -e w2m -e 'patch:'

# 3. The relay as this machine sees it
w2m_status

# 4. The fleet as the relay sees it, and the last few tasks
w2m_devices
w2m_history

# 5. On the machine that misbehaved: the agent's own log tail and state file
#    Windows:  Get-Content "$env:USERPROFILE\.dsh\w2m\agent.log" -Tail 50
#    Unix:     tail -n 50 <stateDir>/../agent.log   (see §16 for where yours is)
cat "$DSH_HOME/xclient/localside/agent-state.json"
```

State plainly which of these you ran and which you did not. "I could not reproduce it" is a useful
report; "it does not work" is not.

**Report security issues privately — never in a public issue.** See
[SECURITY.md](SECURITY.md).

---

## 16. Where every piece of state lives

Relative to `$DSH_HOME`, which is `%DSH_HOME%` or `~/.dsh` on Windows and `$DSH_HOME` or `~/.dsh`
elsewhere. `<kind>` is the sub-directory a program is started with: `localside` for an agent,
`rabbit` for a relay.

| What                                 | Path                                                          | Created by                             | Windows                                                  | macOS / Linux                                | Notes                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Device identity (`machine_id`, name) | `$DSH_HOME/xclient/device.json`                               | the agent, on first use                | `%USERPROFILE%\.dsh\xclient\device.json`                 | `~/.dsh/xclient/device.json`                 | Override the _file_ with `DSH_DEVICE_FILE`; mode 0600 where the platform honours it                                                                                                                                                                                |
| Device private key                   | beside `device.json` — `$DSH_HOME/xclient/device.key`         | the agent, on first use                | `%USERPROFILE%\.dsh\xclient\device.key`                  | `~/.dsh/xclient/device.key`                  | JSON key material, mode 0600. **NTFS carries no POSIX modes: `chmod` there is best-effort and does not restrict other users**                                                                                                                                      |
| Agent state / spool root             | `--state <dir>`, default `$DSH_HOME/xclient/<kind>`           | `w2m-localside` (`--state`)            | `%USERPROFILE%\.dsh\xclient\localside`                   | `~/.dsh/xclient/localside`                   | Explicit `--state` wins; then `$DSH_HOME/xclient/<kind>`; then `~/.dsh/xclient/<kind>`                                                                                                                                                                             |
| Agent snapshot                       | `<state>/agent-state.json`                                    | the agent, continuously                | `…\xclient\localside\agent-state.json`                   | `…/xclient/localside/agent-state.json`       | The answer to "was the agent ever up", no network needed                                                                                                                                                                                                           |
| Write-ahead spool                    | `<state>/spool/<task_id>__a<attempt>/`                        | the agent, per task                    | `…\localside\spool\`                                     | `…/localside/spool/`                         | `meta.json`, `task.json`, `envelope.json`. Offers are spooled **before** execution and envelopes before the POST; an entry is deleted only after the relay acknowledges it                                                                                         |
| Auto-update bookkeeping              | `$DSH_HOME/xclient/auto-update-state.json`                    | the plugin's updater                   | `%USERPROFILE%\.dsh\xclient\auto-update-state.json`      | `~/.dsh/xclient/auto-update-state.json`      | Only exists if `autoUpdate` was turned on                                                                                                                                                                                                                          |
| Relay ledger                         | `<relay state>/ledger.jsonl`                                  | `w2m-rabbit`                           | `%USERPROFILE%\.dsh\xclient\rabbit\ledger.jsonl`         | `~/.dsh/xclient/rabbit/ledger.jsonl`         | Append-only, one JSON object per line. A corrupt line is skipped and counted, not fatal                                                                                                                                                                            |
| Relay device table                   | `<relay state>/devices.json`                                  | `w2m-rabbit`                           | `…\xclient\rabbit\devices.json`                          | `…/xclient/rabbit/devices.json`              | Atomic snapshot (temp file + rename). On a server, `deploy/` puts this at `/var/lib/w2m/`                                                                                                                                                                          |
| Relay operator token                 | `<relay state>/operator-token.txt`                            | `w2m-rabbit`, **once**, on first start | `…\xclient\rabbit\operator-token.txt`                    | `…/xclient/rabbit/operator-token.txt`        | Printed once, on the start that **generated** it, and deliberately absent from `--json` output. Later starts name the file instead; `--print-operator-token` / `W2M_PRINT_OPERATOR_TOKEN=1` prints it anyway. Treat as a credential; do not paste it into a report |
| Profile plugin list and patch        | `$DSH_HOME/profiles/<profile>/cordis.patch.yml`               | DSH, then you                          | `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` | `~/.dsh/profiles/<profile>/cordis.patch.yml` | **Not written by `dsh plugin add`** — a plugin toggle writes it, and Desktop's crash recovery renames it to `.bak-<ts>`. Back it up (§2)                                                                                                                           |
| Profile dependencies                 | `$DSH_HOME/profiles/<profile>/package.json`, `pnpm-lock.yaml` | the installer                          | same shape                                               | same shape                                   | What the profile actually resolved; the updater backs these up before a replace                                                                                                                                                                                    |
| Windows agent log                    | `%USERPROFILE%\.dsh\w2m\agent.log`                            | the Windows supervisor                 | `%USERPROFILE%\.dsh\w2m\agent.log`                       | n/a                                          | stdout/stderr of a session-0 process goes nowhere, so the supervisor owns this file                                                                                                                                                                                |
| Windows supervisor heartbeat         | `%USERPROFILE%\.dsh\w2m\supervisor-heartbeat.json`            | the Windows supervisor                 | same                                                     | n/a                                          | "Is this machine working?" without parsing a log that may itself be the casualty                                                                                                                                                                                   |
| Agent log (Unix, started by hand)    | wherever you redirected it                                    | you                                    | n/a                                                      | n/a                                          | The agent logs to stderr, and there is no shipped systemd unit for it: redirect it to a file, or run it under a supervisor of your own                                                                                                                             |
| Relay log                            | its stdout/stderr                                             | you                                    | the container log                                        | journalctl -u w2m-rabbit                     | The one place the operator token is printed, and only on the start that generated it (or with the opt-in)                                                                                                                                                          |

**Three rules about this table.**

1. **Nothing here is inside your project.** The spool, the state and the key live under the state
   directory on purpose: a read-only project directory must never be written to, and the spool is not
   part of the project.
2. **Two "machines" sharing one `device.json` are one machine.** Duplicating a state directory to run
   a second agent on one host makes both claim the same `machine_id`. Point `--state` (or `DSH_HOME`)
   somewhere else instead.
3. **A `device.json` token is a fleet-wide _metadata_ read credential, not a machine-local one.** A task's
   aggregate is keyed by `task_id`, and `GET /v1/tasks/{task_id}` and the report accept a device token,
   so **any** paired machine's token can read the aggregate of **any** task on **every** machine:
   statuses, per-machine outcomes, anchors, comparable fields, the `transport`/`p2p` blocks and counts.
   What it cannot read that way is the captured output — the aggregate carries `stdout_sha256` and
   `stdout_bytes`, not the text. Only `POST /v1/task` (dispatch) requires the operator token. So "a
   machine that can receive work cannot command the others" is true, and "it cannot see what the others
   were asked to do, or how it went" is **not**. Keep the token file as private as the operator token.

---

## 17. Reference: the reason codes you will actually see

| Code                                                                      | Where it appears                                                           | First thing to check                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W2M_UNREACHABLE`                                                         | dispatching side, relay not answering                                      | §9                                                                                                                                                                                                                                                               |
| `W2M_RABBIT_REFUSED`                                                      | dispatching side, HTTP 401 from the relay                                  | §9 fix 4 — the network is fine                                                                                                                                                                                                                                   |
| `COMMAND_NOT_ALLOWED`                                                     | `refused` result, agent log                                                | §7                                                                                                                                                                                                                                                               |
| `CAPABILITY_REFUSED`                                                      | `refused` result                                                           | the agent does not advertise the capability the task needs                                                                                                                                                                                                       |
| `NO_ONLINE_DEVICE`                                                        | dispatch                                                                   | §4 — no machine the relay considers online                                                                                                                                                                                                                       |
| `PAIRING_CODE_ROTATED`                                                    | pairing                                                                    | pair again with the current code                                                                                                                                                                                                                                 |
| `LEASE_EXPIRED`                                                           | task status                                                                | §4/§5 — the executor stopped renewing its lease                                                                                                                                                                                                                  |
| `P2P_UNAVAILABLE`                                                         | `refused` result in `p2pMode: direct`                                      | §6 — the punch did not land and direct-only refuses the fallback                                                                                                                                                                                                 |
| `P2P_PUNCH_TIMEOUT`                                                       | reported transport reason                                                  | §6, §13                                                                                                                                                                                                                                                          |
| `RUNNER_THREW`                                                            | the **auto-updater**'s spawn result (`w2m_update`), not an envelope status | the updater's own runner threw before or instead of running: read the message beside it, and check the install path. An envelope never carries this — `src/agent/exec.mjs` defines only `ok`, `nonzero_exit`, `timeout`, `crashed`, `refused` and `unverifiable` |
| `SIGNATURE_*` (`MISMATCH`, `EXPIRED`, `REPLAY`, `REQUIRED`, `INCOMPLETE`) | relay, when signing is configured                                          | the signing secret is rotated or the two sides disagree; `SIGNING_NOT_CONFIGURED` means signing is off                                                                                                                                                           |

Nine aggregate verdicts exist, of which `unverifiable` (§8) is the one that needs explaining rather
than fixing.
