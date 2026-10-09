# DSH: Windows2MacOS

**One DeepSeek account. One instruction. Every machine you own runs the same project.**

English | [中文](#中文说明)

[![CI](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml/badge.svg)](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4c6ef5)](#install)
[![version](https://img.shields.io/badge/version-0.1.2-blue)](#changelog)
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
        │  Rabbit relay — devices, tasks, leases, six-state report │
        └──────────────────────────────────────────────────────────┘
```

Both machines only ever make **outbound** connections. No public IP, no port
forwarding, no SSH server on Windows (which, measured, is not installed by
default — `ssh.exe` exists, `sshd` does not).

### Two coordination modes

| Mode | What it does | When to use |
|---|---|---|
| `replicate` | every machine runs the **same** command; results compared side by side | "does this change pass on both platforms?" |
| `split` | work divided by `index` (`explicit` or `modulo` sharding) | one large test suite, several machines |

### Six aggregation states

Not four — because "the environments differ" and "the results differ" are
different findings, and collapsing them turns noise into bug reports.

| State | Meaning |
|---|---|
| `consistent` | every machine agreed on every comparable field |
| `divergent` | machines disagreed — the report names the field and each machine's value |
| `divergent-platform` | only toolchain/platform differ, and the difference is confined to stdout text — expected |
| `failed` | every machine failed |
| `partial` | some succeeded, some failed |
| `unverifiable` | an **anchor** did not match, so comparison is refused |

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

### 1. The relay (once, on any always-on machine)

```bash
node bin/w2m-rabbit.mjs --host 0.0.0.0 --port 8787 --state ~/.dsh/xclient/rabbit
```

It prints a **pairing code**. Pair the first machine, and the relay immediately
prints a **new** code — so you can pair the second machine without restarting
anything. (For scripted onboarding, start it with `pairingCodeReusable: true`
and one code stays valid for its whole TTL.)

### 2. Localside (on every machine that should run the project)

```bash
node bin/w2m-localside.mjs \
  --rabbit http://<relay-host>:8787 \
  --pair PAIR-XXXXXXXX \
  --project /path/to/your/project \
  --name win-desktop \
  --state ~/.dsh/xclient/localside-win
```

`--allowed-commands` is a **default-deny whitelist** as a JSON array. Nothing
runs unless it matches a prefix:

```bash
  --allowed-commands '["node --test","git status --porcelain"]'
```

> ⚠️ **v0.0.1 note:** Localside is verified as a standalone process. Running it
> *in-process* from the plugin (`autoStartAgent: true`) is implemented but has
> not been exercised end-to-end in this release — start it as its own process.

### 3. The DSH plugin

```bash
dsh plugin --profile <profile-name> add @twinsearth/w2m-dsh-plugin@0.0.1
```

Then give it the relay URL in that profile's `cordis.patch.yml`:

```yaml
- id: w2m
  config:
    rabbitUrl: http://127.0.0.1:8787
    stateDir: !!js (process.env.DSH_HOME + '/xclient')
    machineName: win-desktop
```

Restart DSH. You should see eight tools: `w2m_devices`, `w2m_run`, `w2m_wait`,
`w2m_report`, `w2m_status`, `w2m_update`, `w2m_history`, `w2m_stats`.

> `dsh` may not be on your `PATH`. On a packaged install it lives under
> `resources/runtime/cli/bin/`. If `dsh` is not found, call it by path.

**No npm package yet?** Install straight from the release tarball — it needs no
registry at all:

```bash
dsh plugin --profile <profile-name> add \
  https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v0.0.1/twinsearth-w2m-dsh-plugin-0.0.1.tgz
```

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
both sides can reach. Three shapes are supported and documented end to end in
[docs/DEPLOY.md](docs/DEPLOY.md):

| Shape | TLS terminated by | `rabbitUrl` looks like |
|---|---|---|
| **Tailscale / WireGuard** (recommended) | the network — WireGuard encrypts | `http://100.x.y.z:8787` |
| **Public VPS + domain** | the relay (`--tls-cert`/`--tls-key`) or a proxy | `https://w2m.example.com` |
| **Tunnel** (Cloudflare Tunnel, ngrok) | the tunnel service | `https://<sub>.example.com` or with a sub-path |

> **Plain `http://` over a Tailscale address is not a mistake.** WireGuard already
> provides end-to-end encryption and authenticates both peers; adding TLS on top
> would add certificate plumbing without adding a property you do not already
> have. That is why shape A is the recommended default rather than a compromise.

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
others. The relay writes the operator token to `<state>/operator-token.txt` on
first start and prints it once; the plugin takes it as `operatorToken`. Starting
the relay with `--operator-token ''` removes the requirement — it warns loudly,
and that is only appropriate for a trusted LAN.

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
    - id: w2m-tools
      name: '@twinsearth/w2m-dsh-plugin/tools'
      config:
        rabbitUrl: 'http://100.x.y.z:8787'
        autoUpdate: true          # default false
        # autoUpdateTimes: ['00:00:00', '03:00:00', '05:00:00']   # Beijing wall clock
        # autoUpdateTimeZone: Asia/Shanghai                       # default
        # autoUpdateDryRun: true                                  # verify, install nothing
        # updateRepo: TwinsEarth/dsh-windows2macos                # default
```

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
- **Default-deny whitelist.** A machine runs nothing that does not match
  `--allowed-commands`.
- **Read-only by default.** `replicate` tasks run with `write: false`; there is
  no code path that writes to your project in that mode.
- **TLS is your choice, but a deliberate one.** Shape A gets it from WireGuard;
  shapes B and C get it from the relay's `--tls-cert`/`--tls-key` or from the
  proxy. Running shape B or C over plain `http://` would put the operator token
  and every result on the wire in clear text — do not.
- The plugin **does not read** `.credentials.yaml`.

## Verified, and not verified

This project's rule is that claims carry their evidence.

### v0.3.9 P2P hole punching — partial, and labelled as such

The P2P **transport** is implemented and tested: STUN discovery and mapping
classification, hole punching, a reliable fragmenting channel over the punched path,
and the two signalling endpoints (`POST /v1/peer/announce`,
`GET /v1/peer/{machine_id}`). 56 tests cover them.

The **task path is not switched over yet.** `p2p.mode` defaults to `auto` per the
contract in [`PROTOCOL-v0.3.9.md`](PROTOCOL-v0.3.9.md) §1, but nothing reads the
setting, the Localside announcer is not implemented, and `w2m_run` still dispatches
through the relay. **So the data path behaves exactly as v0.3.8 today.** This is
written down rather than left implicit, because a deployment that believed it was on
a direct path when it was not is the worst outcome this feature can produce.

Two things are worth knowing before relying on any of it:

* **Punching cannot succeed against a symmetric NAT.** Measured here, behind an
  iPhone hotspot: three STUN servers reported three different mapped ports for the
  same socket. That is why the default is `auto` with a *reported* fallback rather
  than `direct`.
* **A real NAT traversal is still unverified.** Two sockets on one host share a
  loopback path with no translator between them, so the passing punch tests say
  nothing about crossing a NAT. That needs two hosts behind two different NATs.

**The same suites run on three platforms in CI** — see the badge above, or
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). The matrix is
`windows-latest` × node 20/22, `macos-latest` × node 22, `ubuntu-latest` ×
node 22. That matters here more than in most projects: a Windows-and-macOS
coordination tool whose macOS half had never been executed would be a claim, not
a product.

| Suite | Tests | What it covers |
|---|---|---|
| relay | 91 | pairing, auth, SSE with `ready`-first and `seq` replay, leases with heartbeat renewal and expiry, dedupe, all six aggregation states, report generation, operation token, rate limiting, persistence and restart recovery, TLS, and the lost-offer recovery path |
| agent | 105 | whitelist allow/deny, timeout, output truncation, exit codes, anchors on clean and dirty trees, four concurrent fingerprint computations, spool, a 40-case URL join matrix, cursor lifecycle across relay restarts |
| plugin | 73 | eight tools registered, schemas, typed errors, polling, operator-token enforcement (no request is sent without it), sub-path endpoints |
| end to end + crossnetwork | 46 | two Localsides on two checkouts against one relay running real commands: consistent / divergent / failed / refused / unverifiable / deduped / long-lease / split, plus sub-path deployment, the two credential kinds, a SIGKILLed relay restarting with its ledger intact, pairing rate limiting, proxy-header trust boundaries, and the anti-buffering headers |
| schedule | 39 | the daily slots as exact UTC instants, zones that shift by 30 minutes for DST, a full simulated year of consecutive arming, and catch-up collapsing several missed slots into one run |
| auto-update | 34 | the install/skip decision, no downgrade, prerelease refused, an unverified tarball refused, a failed lookup recorded as an error rather than as "current", and no token ever persisted |
| update-source | 50 | version ordering, streaming SHA-256 verification, timeouts that really abort, rate-limit reporting, and one real GitHub API call (opt-in — see below) |
| update-install | 28 | zero writes on a hash mismatch, byte-for-byte restore, atomic staging, dry run, and two real-pnpm integration runs in throwaway profiles |
| update-wiring | 15 | configuration validation that names the setting, and one `ctx.effect` owning the timer whose disposer stops it |

435 unit tests total: 434 pass, 1 skip. Run them with `scripts/verify.ps1`
(Windows) or `scripts/verify.sh` (macOS/Linux). The skip is one agent test that
asserts POSIX mode bits, which NTFS does not carry.

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
node scripts/verify-installed.mjs <path-to-installed-package>   # asserts the installed copy registers 5 tools
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
| **星型中继 + 反向连接** | 两端只做出站连接：不需要公网 IP、不改防火墙、Windows 没有 `sshd` 也不影响 |
| **默认只读**（`replicate` 且 `write: false`） | 一次性消除重复提交、覆盖写、推送竞争这三类最常见的事故 |
| **三锚校验** | 实测：脏工作区上 `git checkout --detach <sha>` **退出码 0 却保留本地改动** —— 只看 commit SHA 会把"不是同一份代码"误判成"结果分歧" |
| **六态聚合** | "环境不同"与"结果不同"是两件事，合并记账会把噪声当 bug |
| **能力不匹配 → `refused`** | 拒绝执行，而不是静默降级 |
| **长租约 + 进度心跳** | 固定超时会让跑 40 分钟的机器被判死并重投 → **两台同时跑、同时产生副作用** |
| **零第三方运行时依赖** | 只用 `node:` 内置模块；下行 SSE + 上行 POST，不用 WebSocket |

### 快速开始

```bash
# 1) 中继（任一台常开的机器，一次）
node bin/w2m-rabbit.mjs --host 0.0.0.0 --port 8787 --state ~/.dsh/xclient/rabbit
#    它会打印一次性配对码 PAIR-XXXXXXXX

# 2) 每台参与机器（在其项目目录所在机器上跑）
node bin/w2m-localside.mjs --rabbit http://<中继地址>:8787 --pair PAIR-XXXXXXXX \
  --project /path/to/your/project --name win-desktop \
  --allowed-commands '["node --test","git status --porcelain"]'

# 3) 装 DSH 插件
dsh plugin --profile <profile-name> add @twinsearth/w2m-dsh-plugin@0.0.1
```

然后在 profile 的 `cordis.patch.yml` 里给插件 `rabbitUrl`，重启 DSH，即可直接用自然语言指挥：

> 列出我的机器，然后在所有机器上跑 `node --test`，告诉我输出是否一致。

### 项目前置条件

项目根必须有 `.gitattributes` 写 `* text=auto eol=lf`，否则两台机器的指纹永远不一致（实测：加了之后 `autocrlf=true` 与 `=false` 两种配置的工作区字节完全相同）。

### 已实测 / 未实测

- ✅ **Windows 上已实测**：中继（配对、鉴权、SSE 首帧 ready 与按 seq 重放、租约续期与过期、去重、六态、报告）、执行侧（白名单、超时、输出截断、退出码、干净/脏工作区锚、四路并发指纹、spool）、以及双 worktree 双 Localside 的端到端真实执行。
- ✅ **三平台 CI**：同一套用例在 `windows-latest`（node 20/22）、`macos-latest`（node 22）、`ubuntu-latest`（node 22）上跑，见上方徽章与 `.github/workflows/ci.yml`。
- ⚠️ **真实的 Windows↔macOS 互联未实测**：CI 矩阵只证明**各平台都能跑**这套代码；矩阵里的两台机器**并不会互相通信**。真正的机器到机器链路目前仅在**同一台主机上的两个进程之间**验证过。最后一步仍建议在你自己的两台机器上跑一次。
- ⚠️ **单账号驱动两台机器的模型会话未实测**：本版本执行的是**确定性命令**，不向远端 DSH 会话注入 prompt。同账号能否并发跑两个模型会话取决于你的账号额度，本项目未验证。
- ⚠️ **`write: true` 不合并**：写模式的任务会执行，但 0.0.1 没有分支合并。

### 许可

[MIT](LICENSE)
