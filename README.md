# DSH: Windows2MacOS

**One DeepSeek account. One instruction. Every machine you own runs the same project.**

English | [中文](#中文说明)

[![CI](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml/badge.svg)](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@twinsearth/w2m-dsh-plugin?label=npm)](https://www.npmjs.com/package/@twinsearth/w2m-dsh-plugin)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/twinsearth/dsh-windows2macos)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4c6ef5)](#install)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](#design-notes)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platforms](https://img.shields.io/badge/CI-windows%20%7C%20macos%20%7C%20linux-4c6ef5)](#verified-and-not-verified)

---

## The problem

You have a Windows desktop and a Mac laptop. You are working on one project. You
want to say *"run the test suite"* once, and have **both** machines run it — then
see whether they agree.

DeepSeek Harness cannot do this today, and not by accident:

- one `dsh` process serves **one machine** — a profile is a local pnpm workspace;
- its transport is **loopback only** (the web server accepts `127.0.0.1`/`0.0.0.0`
  and the CLI refuses `--host 0.0.0.0`, because it ships no TLS or origin policy);
- the official agent-team feature is explicit that it does **not** support
  teammates with separate working directories or **several processes
  coordinating over one team**.

So the cross-machine capability has to be built. This is that build.

## What you get

```
        you, on any machine, talking to DSH
                       │
                       ▼
   ┌──────────────────────────────────┐        ┌──────────────────────────┐
   │  Windows · DSH session           │        │  macOS · DSH session     │
   │   w2m plugin (8 tools)           │        │   w2m plugin (8 tools)   │
   │        │                         │        │        │                 │
   │   Localside agent                │        │   Localside agent        │
   │    · three anchors               │        │    · three anchors       │
   │    · local spool                 │        │    · local spool         │
   │    · executes argv               │        │    · executes argv       │
   └──────────┬───────────────────────┘        └──────────┬───────────────┘
              │  outbound POST + SSE                      │
              ▼                                           ▼
        ┌──────────────────────────────────────────────────────────┐
        │  Rabbit relay: rendezvous, ledger, STUN responder        │
        └──────────────────────────────────────────────────────────┘
```

Every machine only ever makes **outbound** connections. No public IP, no port
forwarding, no SSH server on Windows (which, measured, is not installed by
default — `ssh.exe` exists, `sshd` does not). The relay is the rendezvous and the
ledger; the payload path is a UDP hole punch between the machines themselves — on
by default in v0.4.0 — and it falls back to the relay loudly, naming the reason,
when the network will not allow it.

### The direct path (v0.4.0, default)

Both machines announce the address a STUN server sees them as, the dispatching
machine punches to the other's candidate, and the task offer travels over the
punched channel instead of the relay. The relay holds its own copy of that offer
back for **3000 ms** (`DEFAULT_P2P_OFFER_GRACE_MS`) while the punch is attempted,
and offers it anyway if the punch does not land — so a failed punch costs latency,
not the task. The constant was 1200 ms first and that was **too tight**: measured on
a 1-vCPU shared host, two agent tests saw the relay's copy overtake the direct one,
which under `p2pMode: direct` means refusing an offer that was about to arrive.
3000 ms covers a slow host with room to spare, and the cost is bounded — one delayed
copy per task, once.

The result *notice* returns the same way, with one stated limit: the frame carries
the task and machine identity, not the result payload. `result_path` is one of the
envelope's own fields and the envelope's hash covers it, so the acknowledgement has
to be known before the envelope is built. The direct path therefore saves the
dispatcher the wait for the relay's copy, not the bytes — the payload still reaches
everyone through the ledger, which is the only writer allowed to hold it.

```yaml
- id: w2m
  config:
    p2pMode: auto          # auto (default) | direct | relay
    # stunServers: ['202.182.123.154:3478']   # default: the shared server, then three public ones
```

`auto` tries the direct path and falls back with the reason attached; `direct`
refuses the relay copy rather than falling back, so a punch failure becomes a
visible failure; `relay` is byte-for-byte v0.3.9 — no UDP socket is bound at all.
Every result carries `transport` plus a `p2p` object saying which path the offer
took and which path the result took, and `w2m_wait` shows it per machine.

**Why `auto` and not `direct`.** Punching cannot succeed behind a symmetric NAT,
and that is measured rather than assumed. On the reference Windows client network
(China Mobile), three STUN servers reported three different mapped ports for one
socket — `endpoint-dependent`, punchable: false. A default that hard-required the
direct path would break every deployment on such a network the moment it
upgraded. See [PROTOCOL-v0.4.0.md](PROTOCOL-v0.4.0.md) §1.

### Four coordination modes

Four — and the third and fourth are the ones people fail to find, which is why they are named here.

| Mode | What it does | When to use |
|---|---|---|
| `replicate` | every machine runs the **same** command; results compared side by side | "does this change pass on both platforms?" |
| `split` | work divided by `index` (`explicit` or `modulo` sharding) | one large test suite, several machines |
| `broadcast` | **exactly one** machine runs it, chosen with `executor_machine_id` (or the composer's selected target); every other machine holds an `observing` lease and is told the outcome | "run this migration on the database host, and tell everyone what happened" |
| `pipeline` | **every** machine runs the whole `stages` chain, in order, stopping at the first stage that fails | "check out, build, then test — as one task with one verdict" |

Two properties of the last two are worth stating because they are what stop them from being footguns:

* **Observers are never counted as agreeing.** An `observing` lease is excluded from every aggregation
  step, so a machine that did not run the command cannot be reported as having produced the same result.
* **A pipeline has no cross-machine data flow.** It is `replicate` applied to a sequence: stage 2 on a
  machine consumes that machine's stage 1, never a peer's. The alternative — fan stage 1 out, converge
  the outputs into stage 2 — has no well-defined input on a fleet, and two machines finishing in a
  different order would make one `task_id` describe two different executions. The reasoning is in
  [docs/PIPELINE-DESIGN.md](docs/PIPELINE-DESIGN.md), which also records that the chain's `command_hash`
  binds **every** stage, not just the first.

### Nine aggregation states

Nine, not four — because "the environments differ" and "the results differ" are different findings, and
collapsing them turns noise into bug reports. Three more were added in v0.3.0, each replacing a case that
used to be reported as something less true.

| State | Meaning |
|---|---|
| `consistent` | every machine agreed on every comparable field |
| `divergent` | machines disagreed — the report names the field and each machine's value |
| `divergent-platform` | only toolchain/platform differ, and the difference is confined to stdout text — expected |
| `degraded` | every machine reported; some succeeded and some failed. Distinct from `partial`, which also means "still in flight" |
| `failed` | every machine failed |
| `partial` | some succeeded, some failed, and machines are still out |
| `timeout` | the deadline passed and the machines that never answered are not coming back |
| `cancelled` | the operator stopped it — not a defect, so it must not be reported as `failed` |
| `unverifiable` | an **anchor** did not match, so comparison is refused |

Two more values are **not verdicts**, because no terminal answer exists yet or none was ever possible:
`pending` (before the first result lands) and `refused` (every machine was refused at the capability
gate). `pending` is the only non-terminal one; `refused` reads like "still deciding" but every machine
has already answered, so waiting cannot change it. All nine verdicts are declared in
`src/relay/report.mjs`'s `AGGREGATE_STATUSES`.

## Install

> **This package can run three ways, and all three start the same binaries.**
>
> ```bash
> node bin/w2m-rabbit.mjs ...        # from a clone (what the examples below use)
> npx @twinsearth/w2m-dsh-plugin ... # if it is on a registry
> w2m-rabbit ...                     # once installed, via its bin entry
> ```
>
> The examples use the clone form because that is what is verified in this
> repository. Nothing needs to be installed to use the relay or the agent: they
> are plain Node scripts with **no runtime dependencies**.

### 1. The relay + STUN (once, on any always-on machine)

> **v0.4.0 defaults to a shared server, so this step is optional.** With no
> `rabbitUrl` configured, the plugin uses `http://202.182.123.154:8787` — a
> rendezvous, ledger and STUN responder that is already running. Point it at your
> own host when you want your own; nothing else changes.

```bash
node bin/w2m-rabbit.mjs --host 0.0.0.0 --port 8787 --state ~/.dsh/xclient/rabbit
node bin/w2m-stun.mjs   --host 0.0.0.0 --port 3478        # the punch needs this
```

`w2m-rabbit` prints a **pairing code**. Pair the first machine, and the relay
immediately prints a **new** code — so you can pair the second machine without
restarting anything. (For scripted onboarding, start it with
`pairingCodeReusable: true` and one code stays valid for its whole TTL.)

`w2m-stun` answers "what address does the world see me as", which is the address a
peer has to aim at. Machines fall back to three public STUN servers if it is not
there, so leaving it out degrades the punch rather than breaking it.

Deploying both on a fresh host, with the proxy and firewall rules, is one command:
`deploy/shared-server/install.sh` — see
[deploy/shared-server/README.md](deploy/shared-server/README.md), including the
part about TLS that this shape does not have by default.

### 2. Localside (on every machine that should run the project)

```bash
node bin/w2m-localside.mjs \
  --rabbit http://<relay-host>:8787 \
  --pair PAIR-XXXXXXXX \
  --project /path/to/your/project \
  --name win-desktop \
  --state ~/.dsh/xclient/localside-win \
  --p2p-mode auto
  # --p2p-port 41234    # v0.4.1: pin the punch socket, so an inbound firewall
  #                     # rule names one port and survives a restart
```

`--allowed-commands` is a **default-deny whitelist** as a JSON array. Nothing
runs unless it matches a prefix:

```bash
  --allowed-commands '["node --test","git status --porcelain"]'
```

> The allow-list matches the whole `argv`, token by token, and a string entry is
> split on whitespace — so `node -e console.log` does **not** allow
> `node -e console.log(1)`, and a path containing a space has to be written as an
> array entry. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) §10.
>
> **What an entry actually grants — read this before trusting a list.** An entry
> names a tool and the arguments up to a point; whatever follows is still that
> tool's own behaviour, so `node --test` allows `node --test <any file>`, and the
> test runner loads and runs whatever file it is handed. **A prefix entry is not a
> sandbox**: it says which program may run, not what that program will do. Two
> narrower rules sit on top of the prefix match:
>
> * **Code-loading trailing arguments are refused** (`COMMAND_REPARSING_ARGUMENT`):
>   `--test-reporter`, `--import`, `--require`, `-r`, `--experimental-loader`,
>   `-e`/`--eval`, `-p`/`--print`, `python -c`/`-m`, `bash -c`, `git -c`/`--exec-path`,
>   `make -f`, `tar --to-command`, and their equivalents in the interpreters in
>   common use. If a machine is meant to run one of them, name it **in the entry**
>   (`["node --test --test-reporter=tap"]`) — the entry is the explicit grant, and
>   the refusal says so.
> * **The executable is compared by identity, not by spelling.** A bare name is
>   resolved through PATH as before; an absolute path is admitted only when it
>   resolves to the same file the entry's executable does (otherwise
>   `COMMAND_EXECUTABLE_PATH_MISMATCH`), and a relative path is refused outright
>   (`COMMAND_EXECUTABLE_RELATIVE_PATH`) because the working directory comes from
>   the offer. A copy of some other program at `E:\Temp\evil\node.exe` is not
>   `node`, however it is named.

> ⚠️ **v0.0.1 note:** Localside is verified as a standalone process. Running it
> *in-process* from the plugin (`autoStartAgent: true`) is implemented but has
> not been exercised end-to-end in this release — start it as its own process.

### 3. The DSH plugin

**From npm** — the shortest form, and the one the marketplaces install:

```bash
dsh plugin --profile <profile-name> add @twinsearth/w2m-dsh-plugin
```

**From the release tarball** — the same bytes, and it needs no registry at all:

```bash
dsh plugin --profile <profile-name> add \
  https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v0.5.9/twinsearth-w2m-dsh-plugin-0.5.9.tgz
```

**From the repository** — the form a marketplace's one-click installer uses (it clones
the repo, builds nothing, and registers `cordis.patch.yml`):

```bash
dsh plugin --profile <profile-name> install TwinsEarth/dsh-windows2macos
```

All three end up with the same package: `release.yml` packs the tarball with
`scripts/pack.mjs`, the release publishes it with `SHA256SUMS`, and the npm publish uses
that exact file rather than repacking — so "which artifact did you install?" has one
answer, not three.

> Whichever form you use, the installer must end up with the plugin in the profile's
> `node_modules` **and** a row in the profile's `cordis.patch.yml`. A bundle that is
> listed in `package.json` but never composed is the failure this project hit once
> already — see `cordis.patch.yml`'s header for what that looked like.

Then give it the relay URL in that profile's `cordis.patch.yml` — or leave
`rabbitUrl` empty to use the shared server:

```yaml
- id: w2m
  config:
    rabbitUrl: ''            # empty => the shared server's default
    operatorToken: ''        # required to dispatch; the relay prints it once
    stateDir: /absolute/path/to/$DSH_HOME/xclient   # `!!js process.env.DSH_HOME` can evaluate to undefined
    machineName: win-desktop
    p2pMode: auto
```

Restart DSH. You should see eight tools: `w2m_devices`, `w2m_run`, `w2m_wait`,
`w2m_report`, `w2m_status`, `w2m_update`, `w2m_history`, `w2m_stats`.

> `dsh` may not be on your `PATH`. On a packaged install it lives under
> `resources/runtime/cli/bin/`. If `dsh` is not found, call it by path.

### What this plugin touches, before you install it

Stated here and machine-readably in `package.json`'s `disclosure`, because installing a
plugin runs its code with your permissions:

| | |
|---|---|
| **Cloud** | yes — a relay is required. The default is the shared server (`202.182.123.154:8787`, STUN on `:3478`); point `rabbitUrl` at your own host, or run the relay yourself with `deploy/shared-server/install.sh` |
| **Offline** | no. The relay is the ledger; peer-to-peer only moves the task offer, and the result still reaches the ledger |
| **Credentials** | the operator token (profile config or `W2M_OPERATOR_TOKEN`) authorises *dispatched work*; the device token lives in `$DSH_HOME/xclient/device.json` (mode 0600 where the platform honours it) and authorises *taking* work |
| **Filesystem** | reads and writes inside your project directory (anchors, fingerprints), plus its own spool and state under `--state` |
| **Network** | the configured relay, the STUN servers, and UDP to the peer machines. Peers can reach this machine's punch port, which is ephemeral unless you pin it with `--p2p-port` |
| **Jurisdiction** | data crosses between wherever your machines are and wherever the relay is; the reference deployment is CN ↔ JP |

## Use

Then just talk to DSH:

> List my machines, then run `node --test` on all of them at the same commit and
> tell me whether the output matches.

The model calls `w2m_devices` → `w2m_run` → `w2m_wait` → `w2m_report` and hands
you the comparison.

## Why you can trust the comparison

A commit SHA alone is not enough. Measured: on a **dirty** working tree,
`git checkout --detach <sha>` **exits 0 and keeps the local changes** — HEAD
matches the base while the working tree does not. Compare on SHA alone and you
will report a logic difference that is really a "these are not the same files"
difference.

So every result carries **three anchors**:

| Anchor | What it proves |
|---|---|
| `base_commit` | both machines started from the same commit |
| `pre_tree_fingerprint` | both had the **same working-tree bytes**, including untracked files |
| `command_hash` | both ran the same argv, in the same shell mode, in the same relative cwd |

The fingerprint algorithm is `git-temp-index-tree/v1`: a throwaway index file
(`git read-tree` → `git add -A` → `git write-tree`) that never touches your
working tree. Each call gets its **own** temporary index — sharing one
`GIT_INDEX_FILE` across processes makes them fail with `idx.lock: File exists`.

`git stash create` is *not* used: measured, it drops untracked files and returns
an empty string in both the "clean" and "only untracked files" cases, so the two
are indistinguishable.

**Prerequisite:** put this in your project root, or the two machines will never
fingerprint alike:

```gitattributes
* text=auto eol=lf
```

Measured: with that line, a `core.autocrlf=true` checkout and a
`core.autocrlf=false` checkout produce byte-identical working trees. Without it,
one is CRLF and the other LF.

## Across networks and regions

> **New in 0.1.2.** Before this version the relay only worked at the root of a
> host: endpoints were built with `new URL('/v1/stream', rabbitUrl)`, which
> discards a path prefix, so anything mounted under `/w2m` answered 404 to
> everything. Sub-path deployment now works, and sending work requires its own
> credential. See [CHANGELOG](CHANGELOG.md#012--2026-10-07).

Machines only ever make **outbound** connections, so the relay can be anywhere
both sides can reach. Four shapes are supported and documented end to end in
[docs/DEPLOY.md](docs/DEPLOY.md):

| Shape | TLS terminated by | `rabbitUrl` looks like |
|---|---|---|
| **The shared server** (v0.4.0 default) | nothing — plain `http://` on a public IP | `http://202.182.123.154:8787` |
| **Your own VPS** | the relay (`--tls-cert`/`--tls-key`) or a proxy | `https://w2m.example.com` |
| **Tailscale / WireGuard** | the network — WireGuard encrypts | `http://100.x.y.z:8787` |
| **Tunnel** (Cloudflare Tunnel, ngrok) | the tunnel service | `https://<sub>.example.com` or with a sub-path |

> **The shared server has no TLS, and that is stated rather than implied.** There is
> no hostname to issue a certificate for. Pairing codes, tokens and results cross
> the wire in clear text; the direct path keeps the payload off the relay, and the
> machine-side allow-list is the load-bearing control. With a domain, add TLS and
> put `https://` in `rabbitUrl` — nothing else changes:
> [deploy/shared-server/README.md](deploy/shared-server/README.md).

> **Plain `http://` over a Tailscale address is not a mistake.** WireGuard already
> provides end-to-end encryption and authenticates both peers; adding TLS on top
> would add certificate plumbing without adding a property you do not already
> have.

If your proxy or tunnel mounts the relay under a prefix — `https://host/w2m/` —
then start it with `--base-path /w2m` and put the same prefix in `rabbitUrl`.
Sub-path deployment works because URLs are joined by concatenation; see
[CHANGELOG](CHANGELOG.md#012--2026-10-07) for the bug that made this impossible
before 0.1.2.

### Two credentials, on purpose

| Credential | Held by | Authorises |
|---|---|---|
| `device_token` | each machine | taking work, reporting results |
| `operator_token` | **only you** | **sending work** (`POST /v1/task`) |

A machine that can be told what to do should not automatically be able to tell the
others. The relay writes the operator token to `<state>/operator-token.txt` (mode
0600) on first start and prints it once — on that first start only, because a
relay's stdout ends up in journald, a container log or a CI transcript and this
token authorises dispatching to the whole fleet. Every later start names the file
instead of the value; `--print-operator-token` (or `W2M_PRINT_OPERATOR_TOKEN=1`)
prints it anyway for an operator who needs it there. The plugin takes it as
`operatorToken`. Starting the relay with `--operator-token ''` removes the
requirement — it warns loudly, and that is only appropriate for a trusted LAN.

### Surviving a restart

`devices.json` plus `ledger.jsonl` mean a restarted relay keeps its paired
machines and its task history, which matters once the relay lives on a VPS you
will eventually reboot. A corrupt ledger line is skipped and reported; a corrupt
device file starts empty **and says so** rather than silently forgetting every
machine. `--no-persist` restores in-memory behaviour.

## Staying up to date

> **New in 0.2.3.** A machine running this plugin checks its own GitHub releases
> at **00:00, 03:00 and 05:00 Beijing time** and installs a newer version if there
> is one. This is **off by default** — an updater that replaces the installed
> plugin is opt-in.

Turn it on in the profile patch:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: w2m
      name: '@twinsearth/w2m-dsh-plugin'
      config:
        rabbitUrl: 'http://100.x.y.z:8787'
        autoUpdate: true          # default false
        # autoUpdateTimes: ['00:00:00', '03:00:00', '05:00:00']   # Beijing wall clock
        # autoUpdateTimeZone: Asia/Shanghai                       # default
        # autoUpdateDryRun: true                                  # verify, install nothing
        # updateRepo: TwinsEarth/dsh-windows2macos                # default
```

> **The id is `w2m` and the name is the bare package — both matter, and neither is cosmetic.**
> `w2m` is the id the packaged `cordis.patch.yml` inserts, so a second row under a different id
> is a second plugin instance rather than a configuration of the first. `@twinsearth/w2m-dsh-plugin`
> must be the **bare** package name: a subpath such as
> `@twinsearth/w2m-dsh-plugin/tools` resolves to no `package.json`, so `dsh.client` is never read
> and **the client half is silently disabled** — the composer control never registers, and nothing
> on the host side reports a problem. `./tools` remains a supported mount point; it is simply not
> the one this bundle uses, and using it costs you the browser half. See
> [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §2.

Ask it what it is doing from any session with `w2m_update` (`action: "status"` to
inspect, `action: "check"` to run one cycle now).

**What it does and does not do:**

- Compares the newest GitHub release against the version it was built as. It
  installs **only a strictly newer, non-prerelease** version — a downgrade is
  worse than a missed update, and a release candidate outranks the release it
  precedes by SemVer, so the gate is explicit.
- Downloads the tarball and **verifies the SHA-256 published in that release's
  `SHA256SUMS`** before anything is written. A mismatch installs nothing.
- Backs up the profile's `package.json` and `pnpm-lock.yaml`, then installs
  through `dsh plugin --profile <p> add <tarball>` (falling back to the runtime's
  own pnpm). If the install fails, the manifest is restored byte-for-byte.
- **It does not restart DSH.** The new version loads on the next start; the
  running process keeps the code it loaded. `w2m_status` reports
  `restart_required` once an install has happened, and the installed tarball
  lives in `<profile>/.w2m-update/` so the dependency does not dangle.
- **It does not hot-swap the running plugin.** Nothing may rewrite the module a
  live Cordis container already loaded, so claiming otherwise would be a lie in
  the status output.

**Honest limits.**

- A missed slot runs once on the next start if it was missed by less than 90
  minutes (a machine asleep across one slot). Wider than that and the check waits
  for the next slot rather than firing at an arbitrary hour.
- If pnpm fails *after* it has already changed `node_modules`, restoring the
  manifest is not enough to guarantee DSH still starts. The result then carries
  `rollbackComplete: false` and a `reconciliation` command; `w2m_status` surfaces
  it as `reconciliation_needed`. This is the one state that needs a human.
- A negative result is never reported as success: a GitHub lookup that fails is
  recorded as an **error**, not as "already up to date", because those two look
  identical in a log and only one of them is a problem.

## Security

Read this before exposing the relay to anything.

- **Admission** is a single-use, rotating pairing code, then a per-device bearer
  token stored in `device.json` (mode `0600`). Pairing attempts are rate limited
  (5 per IP per minute by default, successes included).
- **Sending work needs the operator token**, not a device token.
- **`--trust-proxy` is off by default and should stay off** unless the relay
  really is behind a proxy you control: it makes the relay believe
  `X-Forwarded-For`, and believing that header without a proxy in front lets any
  client forge its address and walk past the rate limit.
- **The relay holds no model credentials and no working copy.** It can forge
  tasks, which is exactly why the machine-side whitelist is the load-bearing
  control.
- **Commands are never shell strings.** argv arrays are passed to
  `spawn(cmd, args, { shell: false })`, so nothing a caller types can be
  reinterpreted as shell syntax.
- **Default-deny whitelist, with its limit stated.** A machine runs nothing that
  does not match `--allowed-commands`, and the matching rules are in §2 above.
  The list controls *which program* may run; a prefix entry grants what that
  program can be told to do with the arguments it is given (`node --test` runs
  the test files it is handed), so it is a control, not a sandbox.
- **Read-only by default.** `replicate` tasks run with `write: false`; there is
  no code path that writes to your project in that mode.
- **TLS is your choice, but a deliberate one.** Shape A gets it from WireGuard;
  shapes B and C get it from the relay's `--tls-cert`/`--tls-key` or from the
  proxy. Running shape B or C over plain `http://` would put the operator token
  and every result on the wire in clear text — do not.
- The plugin **does not read** `.credentials.yaml`.

## Verified, and not verified

This project's rule is that claims carry their evidence.

### v0.4.0 — the direct path is the default, and here is what that is worth

v0.3.9 shipped the P2P transport and admitted in its own §8 that nothing read
`p2p.mode`, the announcer did not exist and the task path still went through the
relay. v0.4.0 is that admission paid off:

* **the announcer exists** — a machine binds one UDP socket, asks the STUN servers
  what the world sees, announces its candidates and refreshes them;
* **the offer can arrive over the punched path**, and the result can return over it;
* **exactly-once survives both copies arriving** — the relay's offer is still
  emitted, and a second copy of the same `task_id`+`attempt` is never executed;
* **every result says which path it took** (`transport`, `p2p.offer_path`,
  `p2p.result_path`, and a `路径` column in the report);
* **the relay is still the ledger** — the direct copy is additional, never a
  replacement, so the comparison cannot become less trustworthy because a network
  was faster.

Three things are worth knowing before relying on it:

* **Punching cannot succeed against a symmetric NAT**, and this is measured twice
  on two real networks: an iPhone hotspot (v0.3.9) and the reference Windows
  client network, China Mobile (v0.4.0 — three servers, three mapped ports: 36028,
  5855, 26713). Nothing can dial *into* such a network, which is why the default is
  `auto` with a *reported* fallback rather than `direct`.
* **A punch from a symmetric NAT to a public peer still lands** — measured:
  `HELLO` → `HELLO_ACK` in **331.61 ms** from that same Chinese network to the
  shared server in Tokyo, with the ledger recording `transport: p2p` for the
  Japanese machine. A punch you initiate opens the mapping, and the peer's answer
  to the datagram it just received comes back through it. That asymmetry is why the
  dispatcher dials the executor.
* **A machine that must accept a punch needs a reachable UDP port.** On a public
  host that is a firewall rule for the agent's punch port (the shared server has
  one); behind a NAT it is the hole the punch opens. **v0.4.1 pins it**: `--p2p-port <n>`
  (or `W2M_P2P_PORT`) makes the rule name one port instead of a range, which v0.4.0 could not
  do — the node always bound an ephemeral one, so the rule had to be re-pointed after every
  restart.
* **A two-NAT punch is still unverified.** Two sockets on one host share a path
  with no translator between them, so the loopback tests prove the protocol and
  nothing about NAT. What *has* now been measured is one real WAN hop: dispatcher
  on a Chinese residential network, executor on the shared server in Tokyo. That is
  one NAT, and it is labelled as one NAT.

**The same suites run on three platforms in CI** — see the badge above, or
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). The matrix is
`windows-latest` × node 20/22, `macos-latest` × node 22, `ubuntu-latest` ×
node 22. That matters here more than in most projects: a Windows-and-macOS
coordination tool whose macOS half had never been executed would be a claim, not
a product.

| Suite | Tests | What it covers |
|---|---|---|
| relay | 142 | pairing, auth, SSE with `ready`-first and `seq` replay, leases with heartbeat renewal and expiry, dedupe, all **nine** aggregation states plus `pending`/`refused`, report generation, operator token, rate limiting, persistence and restart recovery, TLS, and the lost-offer recovery path |
| agent | 129 | allow-list allow/deny, timeout, output truncation, exit codes, anchors on clean and dirty trees, four concurrent fingerprint computations, spool, a 40-case URL join matrix, cursor lifecycle across relay restarts, and the bundled-runtime resolver |
| tools | 89 | eight tools registered, schemas, typed errors, polling, operator-token enforcement (no request is sent without it), sub-path endpoints, and the credential canaries |
| broadcast | 19 | exactly one executor, the rest `observing`; observers excluded from every aggregation step so a machine that did not run is never counted as agreeing |
| claims | 19 | the document claims themselves: the version, the bundle patch, the tool list, every documented tarball URL, and the CHANGELOG's shape |
| fleet-target | 37 | the composer's target selection, and the `executor_machine_id` narrowing that overrides it |
| client-bundle | 25 | the browser half builds, exports, and resolves against `PLATFORM_MODULES` |
| schedule | 39 | the daily slots as exact UTC instants, zones that shift by 30 minutes for DST, a full simulated year of consecutive arming, and catch-up collapsing several missed slots into one run |
| auto-update | 34 | the install/skip decision, no downgrade, prerelease refused, an unverified tarball refused, a failed lookup recorded as an error rather than as "current", and no token ever persisted |
| update-source | 50 | version ordering, streaming SHA-256 verification, timeouts that really abort, rate-limit reporting, and one real GitHub API call (opt-in — see below) |
| update-install | 28 | zero writes on a hash mismatch, byte-for-byte restore, atomic staging, dry run, and two real-pnpm integration runs in throwaway profiles |
| update-wiring | 34 | configuration validation that names the setting, and one `ctx.effect` owning the timer whose disposer stops it |
| signing | 33 | request signing: mismatch, expiry, replay and required-signature refusals |
| stress | 9 | sustained load on the relay's frame handling |
| shared-config | 16 | the fleet-wide config file, including its refusal of secret-looking keys |
| metrics / metrics-route | 16 + 5 | the Prometheus exposition and its route, with no credential ever rendered |
| tool-cards | 8 | the tool descriptions the model actually reads |
| p2p-stun | 18 | the STUN responder and reflexive-address discovery |
| p2p-transport | 28 | the reliable ordered channel over UDP |
| p2p-signaling | 17 | peer candidates: announce, fetch, expiry |
| p2p-node | 38 | the node that binds the punch socket, announces, punches and dials |
| p2p-transport-fields | 28 | `transport` / `p2p.offer_path` / `p2p.result_path` / `p2p.opened_by` on every result |
| p2p-plugin | 32 | the plugin half of the direct path, including the pushes and their named failures |
| p2p-crypto | 33 | stage 1 of the data-plane encryption: the handshake, the refusal codes, the replay window and the epoch ratchet |
| stun-server | 27 | the standalone `w2m-stun` binary |
| loader-entry | 10 | the entry DSH actually mounts, packed and installed — the gate v0.5.4 needed |
| mdns-wire / mdns-discover | 38 + 45 | the DNS wire codec, and LAN discovery |
| e2e + crossnetwork | 11 + 35 | two Localsides on two checkouts against one relay running real commands: consistent / divergent / failed / refused / unverifiable / deduped / long-lease / split, plus sub-path deployment, the two credential kinds, a SIGKILLed relay restarting with its ledger intact, pairing rate limiting, proxy-header trust boundaries, and the anti-buffering headers |
| signing-e2e | 8 | a signed task end to end |
| outbound-only | 7 | a running agent binds no TCP listener, and `relay` mode binds no UDP socket at all |
| recovery | 4 | restart and lost-offer recovery |
| pipeline-e2e | 2 | a real relay and a real agent running a chain: the stages append to a witness file, so the ordering evidence is written by the stages themselves; the second case proves the chain stops at the first failure |
| p2p-agent | 21 | the agent half of the direct path, including the reverse dial for results |

**The numbers above are from v0.5.9 on `win32 x64`, Node `v24.18.1`** — the floor this package
declares is `>=20.19.0`, and Node 24 is what DSH ships on this host. **36 suites on disk, 1,139 tests:**
1,131 pass, **2 fail**, 6 skip. The two failures are `test/pipeline-e2e.test.mjs`'s two cases on this
Windows host; **everything else is green.** Three suites are environment-sensitive and their counts
move with it: `claims` is 19 tests here and **22 when `dist/` holds a packed tarball**, which is when
its two tarball-vs-`package.json` checks run instead of skipping — so a checkout with `dist/` measures
**1,142 tests / 1,134 pass / 4 skip**, and that is the number to expect from a release tree.

**Which script runs which suite matters, because they are not the same set:**

| Command | Suites | Result on this host (v0.5.9) |
|---|---|---|
| `npm test` — the unit suite | 29 | 1,051 tests, **all pass**, 6 skip |
| `npm run test:all` — units + end-to-end | 35 | 1,106 tests, 1,098 pass, **2 fail** (`pipeline-e2e`), 6 skip |
| `pwsh scripts/verify.ps1` — the acceptance run | 29 | 1,050 tests, 1,048 pass, **2 fail** (`pipeline-e2e`), 6 skip |

> **`test:all` and `verify.ps1` are not supersets of each other.** At v0.5.9 `test:all` was still
> missing `test/p2p-crypto.test.mjs` — 33 tests covering the data-plane encryption, absent from the
> suite a release runs, and `CHANGELOG.md`'s v0.5.9 entry says so instead of claiming otherwise.
> **v0.6.0 applied the one-line fix that entry asked its owner for**, so the file is now in `npm test`
> and in `test:all`; `verify.ps1`'s own suite list still does not name it.

`%DSH_HOME%\dsh-runtimes\` is absent on this host, which is why `verify.ps1` falls back to the
`node` on `PATH`; the resolver's own bundled-runtime case is exercised against a throwaway home in
`test/agent.test.mjs`, and “Not verified” below says what that does and does not prove.

> **`pipeline-e2e` fails 2/2 at the v0.5.9 tag on this host, and the cause is the test, not the
> product.** Both cases die with `ENOENT … order.txt` / `stop.txt`: the witness files the stages are
> supposed to append to were never created, because **no stage ever ran**. In that revision the suite
> passes its agent `--allowed-commands` as the *string* entry `process.execPath`
> (`pipeline-e2e.test.mjs`, `allowedCommands = [NODE]`). A string entry is split on whitespace **by
> design**, and on a machine whose Node lives under `C:\Program Files\`, that entry becomes the two
> tokens `C:\Program` and `Files\nodejs\node.exe`, which match nothing — so the agent refused the
> chain with `COMMAND_NOT_ALLOWED` before its first stage. It is therefore **not a Node-24 artifact**:
> it is a test defect that appears wherever the interpreter's path contains a space, and it is
> consistent with this suite passing on CI runners, whose Node is unpacked to a space-free path.
> **The working tree already repairs it** (array-form entry naming `-e`, plus a third case asserting
> that a stage outside the allow-list refuses the whole chain and runs nothing), and measured on this
> host that repair takes the suite to **3/3 pass**. The failure is recorded here because v0.5.9 is
> what a reader installs, and the honest label for the tag is **failing on Windows under
> `C:\Program Files`** rather than "passes".

**Skips are per platform, not a single number, and the difference is one test.** On this Windows host
(Node 24.18.1, `dist/` present, network tests not enabled) there are **4**:

| Suite | Skipped case | Why |
|---|---|---|
| agent | `writes 0600 where the platform honours POSIX bits` | NTFS carries no POSIX mode bits. **Skips on Windows; runs on macOS/Linux.** |
| agent | `starts a bundled-only tool from runArgv even when PATH cannot see it` | A POSIX shell script is not a Windows executable. **Skips on Windows; runs on macOS/Linux.** |
| claims | `every documented tarball exists as a release asset` | network check off unless `W2M_NETWORK_TESTS=1` |
| update-source | `fetches, parses and verifies the published release end to end` | same gate |

Two further cases are environment-conditional rather than platform-conditional, and skip only when
their input is missing: `claims`'s two tarball-vs-`package.json` checks run when `dist/` holds a
packed tarball and skip when it does not, and `agent`'s `git anchors` suite skips when `git` is not on
`PATH`. On this machine `git` is present, so that one does not fire.

The consequence, stated rather than generalised: **macOS and Linux run the two agent cases Windows
cannot, and skip `reports the windows filesystem honestly`, which is Windows-only**, so their skip
count is set by the same network gate plus whichever platform case applies — **it is not this host's
number, and calling it one is exactly the generalisation this section used to make.** No macOS or
Linux run was performed for this table; only the CI matrix measures those, and by this project's own
labelling rule the figure above is `[M]` for Windows and `[?]` for the other two.

The one test that calls GitHub for real is **opt-in** (`W2M_NETWORK_TESTS=1`).
GitHub allows 60 unauthenticated API requests per hour *per IP* and hosted CI
runners share IPs, so it failed on `macos-latest` with HTTP 403 `RATE_LIMITED`
while every other job passed — and a release gate that depends on someone else's
rate-limit budget eventually blocks a release for a reason unrelated to the code.
CI still runs it in a separate **non-blocking** job with the workflow token, and
the same code paths are covered without a network in the blocking matrix.

Two behaviours are checked but not covered by a test file, because both concern
the real binaries rather than the modules:

- **CLI smoke test** (`scripts/smoke-cli.ps1`): real `w2m-rabbit` plus two real
  `w2m-localside` processes, ending in a `consistent` verdict and a rendered
  markdown report.
- **Release-artifact reproducibility**: CI packs the sources twice and fails if
  the two tarballs differ, so a published hash is a statement about the sources
  rather than about when the command ran.

Two extra gates exist because "it installed" is not "it loads" — the first
version of this package shipped a re-export naming a symbol that did not exist,
and it passed `node --check` and every unit test, failing only when DSH mounted
the plugin:

```bash
node scripts/check-entrypoints.mjs   # imports lib/tools.js, the exact specifier cordis.patch.yml mounts
node scripts/verify-installed.mjs <path-to-installed-package>   # asserts the installed copy registers 8 tools
```

**Not verified:**

- **A real Windows↔macOS pair.** The CI matrix proves each platform runs the
  suites, but the two halves of a matrix job never talk to each other: CI does
  not pair a Windows runner with a macOS runner over the network. The
  machine-to-machine link has only been exercised between two processes on one
  host. Burn-in on your own two machines is still the last step.
- **A single account driving both machines' model sessions.** This release
  executes commands deterministically; it does not inject prompts into a remote
  DSH session. Whether one account can run two concurrent model sessions at once
  depends on your account's limits and is untested here.
- **`write: true`.** A write-enabled task is executed, but there is no branch
  merge in 0.0.1.

## Design notes

- **Zero third-party runtime dependencies.** Only `node:` built-in modules. The
  relay is `node:http`; the downlink is Server-Sent Events and the uplink is
  ordinary POST, so there is no WebSocket handshake to get wrong.
- **`@deepseek-ai/dsh-tools` is an optional peer dependency**, resolved at
  runtime by DSH. It is deliberately *not* a hard dependency: declaring it would
  pull roughly 287 `@deepseek-ai/*` packages into the install for one import.
- **Long lease + progress heartbeat**, never a fixed timeout. Measured risk: a
  machine running a 40-minute test would be declared dead and the task re-sent to
  another machine — both machines then running it, both producing side effects.
  Only a *failed renewal* marks a lease dead, and only the relay's clock decides.

The full wire contract — every endpoint, field and state transition — is in
[PROTOCOL.md](PROTOCOL.md). It is frozen: changing it is a breaking change.

## Development

```bash
node --test test/                          # everything
node --test test/relay.test.mjs
node --test test/agent.test.mjs
node --test test/tools.test.mjs
node --test --test-force-exit test/e2e.test.mjs   # see note
```

> The end-to-end suite needs `--test-force-exit`: each simulated machine holds an
> open SSE connection, and a long-lived stream keeps Node's event loop alive
> after the assertions finish. The suite also needs a git binary on `PATH`.

## Contributing

Issues and pull requests are welcome. If you change observable behaviour, update
`PROTOCOL.md` in the same commit — that file is the contract three components
agree on.

When something does not work, start from the symptom: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## License

[MIT](LICENSE)

---

## 中文说明

**同一个 DeepSeek 账号，一条指令，让在线的 Windows 与 Mac 跑同一个项目。**

### 为什么需要它

DSH 目前**不能**跨机器协作，而且不是疏忽：

- 一个 `dsh` 进程只服务**一台机器**（一个 profile 就是一个本地 pnpm workspace）；
- 传输层是**仅回环**的（web 服务器只接受 `127.0.0.1`/`0.0.0.0`，CLI 明确拒绝 `--host 0.0.0.0`，因为它自身不带 TLS 与来源策略）；
- 官方 agent-team 明确**不支持** teammates 各自独立的工作目录，也**不支持多个进程协作同一个 team**。

所以跨机器能力必须自建。这就是那个实现。

### 核心设计

| 设计 | 理由 |
|---|---|
| **P2P 直连优先**（v0.4.0 默认） | 两端各报自己的反射地址，由派发方打洞并把任务直接送过去；打不通才回落到中继，并且**报告用了哪条路** |
| **中继 = 会合点 + 账本 + 回落** | 中继仍然收下每一条结果：它是账本，账本不完整，比较就不可信 |
| **默认只读**（`replicate` 且 `write: false`） | 一次性消除重复提交、覆盖写、推送竞争这三类最常见的事故 |
| **三锚校验** | 实测：脏工作区上 `git checkout --detach <sha>` **退出码 0 却保留本地改动** —— 只看 commit SHA 会把"不是同一份代码"误判成"结果分歧" |
| **九态聚合** | "环境不同"与"结果不同"是两件事，合并记账会把噪声当 bug；另有 `pending` / `refused` 两个非判定值不计入结论 |
| **能力不匹配 → `refused`** | 拒绝执行，而不是静默降级 |
| **长租约 + 进度心跳** | 固定超时会让跑 40 分钟的机器被判死并重投 → **两台同时跑、同时产生副作用** |
| **零第三方运行时依赖** | 只用 `node:` 内置模块；下行 SSE + 上行 POST，不用 WebSocket |

### 快速开始

```bash
# 1) 中继 + STUN（任一台常开的机器，一次）
#    v0.4.0 已内置共享服务器作为默认值，这一步是可选的：
#    http://202.182.123.154:8787 与 202.182.123.154:3478
node bin/w2m-rabbit.mjs --host 0.0.0.0 --port 8787 --state ~/.dsh/xclient/rabbit
node bin/w2m-stun.mjs   --host 0.0.0.0 --port 3478
#    中继会打印一次性配对码 PAIR-XXXXXXXX

# 2) 每台参与机器（在其项目目录所在机器上跑）
node bin/w2m-localside.mjs --rabbit http://<中继地址>:8787 --pair PAIR-XXXXXXXX \
  --project /path/to/your/project --name win-desktop --p2p-mode auto \
  --allowed-commands '["node --test","git status --porcelain"]'

# 3) 装 DSH 插件
dsh plugin --profile <profile-name> add \
  https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v0.5.9/twinsearth-w2m-dsh-plugin-0.5.9.tgz
```

然后在 profile 的 `cordis.patch.yml` 里给插件 `rabbitUrl`（留空即用共享服务器）与 `operatorToken`，重启 DSH，即可直接用自然语言指挥：

> 列出我的机器，然后在所有机器上跑 `node --test`，告诉我输出是否一致。

### 项目前置条件

项目根必须有 `.gitattributes` 写 `* text=auto eol=lf`，否则两台机器的指纹永远不一致（实测：加了之后 `autocrlf=true` 与 `=false` 两种配置的工作区字节完全相同）。

### 已实测 / 未实测

- ✅ **P2P 直连已接通（v0.4.0）**：宣告（announce）、打洞、任务通过直连通道送达、结果沿同一通道返回、两条路径同时到达时**只执行一次**、以及每条结果都带 `transport` / `p2p.offer_path` / `p2p.result_path`。回落到中继时带**具体原因**（`P2P_PUNCH_TIMEOUT` 等），不是一句"没走直连"。
- ✅ **跨真网一跳已实测**：派发端在**中国移动的对称 NAT 之后**（三台 STUN 服务器给出三个不同的映射端口：36028 / 5855 / 26713，`endpoint-dependent`，punchable: false），执行端在东京的共享服务器上。**实测打洞成功：`HELLO` → `HELLO_ACK` 331.61 ms**，账本为那台日本机器记录 `transport: p2p`（`result_path: p2p`）。对称 NAT 挡住的是"被拨入"，挡不住"主动拨出" —— 这正是派发方负责打洞的原因。
- ✅ **要接受打洞的机器必须有可达的 UDP 端口**：公网主机上就是一条防火墙规则（共享服务器已加）。**v0.4.1 起可以用 `--p2p-port <n>`（或 `W2M_P2P_PORT`）固定端口**，规则只需写一个端口，不必覆盖区间。
- ✅ **共享服务器已上线**：中继（`:8787` 与经 nginx 的 `:80`）、STUN 响应器（`:3478/udp`）、systemd 单元、ufw 规则，一条命令可复现：`deploy/shared-server/install.sh`。
- ✅ **三平台 CI**：同一套用例在 `windows-latest`（node 20/22）、`macos-latest`（node 22）、`ubuntu-latest`（node 22）上跑，见上方徽章与 `.github/workflows/ci.yml`。
- ⚠️ **两个 NAT 之后的互通仍未实测**：本机环回上的打洞只证明协议正确，不证明能穿透 NAT；目前实测的是**一跳、一个 NAT**（见上）。
- ⚠️ **真实的 Windows↔macOS 互联未实测**：CI 矩阵只证明**各平台都能跑**这套代码；矩阵里的两台机器**并不会互相通信**。
- ⚠️ **UDP 直连通道本身不认证**（与 v0.3.9 §6 相同）：session id 是 32 位随机数，UDP 源地址可伪造 —— 直连不比中继更可信，威胁模型包含路上攻击者时请开启请求签名。
- ⚠️ **单账号驱动两台机器的模型会话未实测**：本版本执行的是**确定性命令**，不向远端 DSH 会话注入 prompt。
- ⚠️ **`write: true` 不合并**：写模式的任务会执行，但没有分支合并。

### 许可

[MIT](LICENSE)
