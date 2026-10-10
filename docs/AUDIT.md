# Audit — what is implemented, what is running, and how it works

Written 2026-10-10 (UTC) against `main` at `460c437`, plus the live behaviour observed during the
session that built v0.4.1 … v0.5.1. Every claim is labelled with how it is known, because an audit
whose evidence cannot be told apart from its assumptions is worse than no audit:

* **[M]** measured live on the three-machine fleet during the session,
* **[T]** asserted by the repository's own test suites or CI,
* **[?]** **not verified** — stated as an open item rather than assumed.

Re-run the checks in §5 rather than trusting this file; it records a moment, not a guarantee.

## 1. Designed features: implemented?

| Designed feature | State | Evidence |
|---|---|---|
| Eight DSH tools (`w2m_devices`, `run`, `wait`, `report`, `status`, `update`, `history`, `stats`) | ✅ | **[T]** `scripts/verify-installed.mjs` on the packed artifact (`PASS: 8 tools registered`), plus a test that every tool returns a **string** (the host refuses anything else) |
| Four modes: replicate / split / broadcast / pipeline | ✅ | **[M]** replicate across three machines; **[T]** dedicated suites for the others |
| Nine aggregate verdicts | ✅ | **[M]** `consistent`, `divergent-platform`, `partial` observed live; **[T]** the rest covered by `test/relay`, `broadcast`, `recovery` |
| Anchor comparability (`base_commit` + `git-temp-index-tree/v1`) | ✅ | **[M]** Windows and Linux produced the **same** fingerprint `d6d39082…` for commit `a1e7dc0` — cross-platform comparison is real, not assumed |
| Default-deny allow-list, token-wise prefix match | ✅ | **[M]** allowed and refused commands observed on two machines; v0.4.1 unified the plugin's pre-flight with the agent's matcher |
| P2P direct path (punch / accept / dial, reliable fragmented channel) | ✅ | **[M]** `transport: p2p` between Windows and the Tokyo server, repeatedly |
| **A** simultaneous two-way punch, **B** reverse dial for results | ✅ code | **[T]** +17 tests, all passing (loopback). **[?]** **no live proof yet** — the fleet has not run this build on all three machines at once |
| Pinned punch port (`--p2p-port`) | ✅ | **[M]** `0.0.0.0:41235` bound on Windows after pinning |
| Windows deployment without elevation: supervisor + self-healing trigger | ✅ | **[M]** killing the supervisor left the agent alive with its socket bound; `every=PT5M` trigger registered |
| Supervisor heartbeat file + `degraded` marker + orphan reaping | ✅ | **[M]** marker reaches `degraded` after three exits; a clean start leaves exactly one supervisor and one agent, heartbeat `running` |
| Session-0 service mode (fully immune to console teardown) | ✅ script | **[?]** requires one elevation; **not executed** |
| **C** self-hosted WireGuard hub | ✅ server side | **[M]** `wg0` active on `:51820`, two peers configured. **[?]** no `latest handshake` has ever appeared: **no client has connected**, so rung 4 is not end-to-end |
| Delivery-ladder documentation + acceptance script | ✅ | **[M]** `deploy/networking/acceptance.mjs` ran against the live fleet; baseline recorded (all three machines on rung 5 for a relay-dispatched task) |
| npm publication with Trusted Publishing | ✅ | **[M]** `@twinsearth/w2m-dsh-plugin@0.5.1`, latest, with a SLSA provenance attestation |
| dsh-plugin.org listing | ✅ | **[M]** listed and marked *Verified*; the page's own snapshot is stale (submission issue #141 asks for a re-scan) |
| TUN/VPN mode | ❌ **deliberately not built** | Decision and reasoning in `deploy/networking/LESSONS.md`: a tunnel is hub-and-spoke, so it would make "the data path is peer-to-peer" false for exactly the traffic a tunnel exists to carry |

**Also not built, and known:** the ladder is not yet ordered *data* with per-rung budgets; the
plugin has no `p2pPort` of its own (only the agent CLI needs one, since a dispatcher only dials out).

## 2. Modules: running, and correct?

| Module | State | Notes |
|---|---|---|
| Relay `w2m-rabbit` (`:8787`) | ✅ active | **[M]** three devices tracked, ledger persisted across a restart (`revived_devices`) |
| STUN (`:3478/udp`) | ✅ active | |
| Localside `jp-shared` (Tokyo) | ✅ v0.5.x, streaming | Re-deployed from the GitHub release asset; sha256 matched the locally built tarball byte for byte |
| Localside `win-desktop` (this machine) | ✅ supervisor + agent, socket `41235`, heartbeat `running` | **[M]** after reaping three orphans that a previous generation had left behind |
| Localside `macmini` | **[?]** version and liveness unconfirmed | Four-line self-check for its owner is in `deploy/networking/README.md`'s section on rungs; it previously showed *online but not accepting work* (`expired` leases) |
| DSH plugin in this profile | ✅ v0.5.0 installed, eight tools live | Configuration is picked up by hot reload, verified via `w2m_status` twice |
| CI / Release / npm | ✅ | CI green on four platforms; Release #31 green; npm publish automatic via OIDC |
| v2ray-agent (same server, unrelated to this project) | ✅ xray active | TLS entry on **556** with live `accepted` log lines; nothing listens on 443, which that configuration does not need |
| WireGuard `wg0` | ✅ server, ❌ clients | No handshake yet (§1) |
| **Known environmental blocker** | ⚠️ | The link from this machine (an iPhone hotspot behind carrier-grade NAT) to Tokyo is intermittently unreachable — HTTP and SSH together. It takes the Windows machine off the fleet while it lasts, and it is the reason several checks above are marked **[?]** |

**Known defect classes found and fixed during the session, recorded because they are the kind that
recur:** the plugin's dispatch pre-flight could never match a multi-token allow-list entry; the punch
port could not be pinned; `w2m_update` returned an object where the host requires a string; the
Windows supervisor silently dropped every `-AgentArgs` value; a test read the punch port out of a
timestamp; and detaching the agent (which fixed the console-teardown death) leaked orphan agents.
Each is fixed with a test or a verification, and each is described in `CHANGELOG.md` under its
version.

## 3. How it works

```
DSH plugin (any machine)        Relay (the shared server)        Localside agent (each machine)
  eight tools  ──HTTPS────▶  /v1/task · leases · ledger · SSE ──▶  executes argv within the allow-list
      │                              ▲                                        │
      └──── UDP hole punch: task offer + result ──────────────────────────────┘
                                     └─ when no direct path opens, the relay carries it
```

**Control plane is centralised, data plane tries to be direct, and every task records which path it
took.** That sentence is the whole design; everything below is mechanism.

* **Two credentials, deliberately split.** The operator token authorises *dispatching* work; a
  per-machine device token authorises *taking* and *reporting* it. Measured: reading a task back with
  the operator token answers `401 missing or invalid device_token`. The credential that can order work
  around cannot also read every machine's results.
* **Anchors make "same revision" provable.** The dispatcher fingerprints its work tree
  (`git-temp-index-tree/v1`); each machine must reproduce it or the comparison is refused as
  `unverifiable`. A peer that is merely on a different commit cannot produce a misleading "the results
  differ".
* **The delivery ladder, recorded rung by rung.** A live channel, then a simultaneous two-way punch
  (**A**), then a reverse dial for the result (**B**), then a tunnel (**C**), then the relay — with
  `offer_path`, `result_path`, `p2p.opened_by` and per-rung reason codes saying which one served the
  command and why the ones above it did not.
* **Verdicts are computed in a fixed order** (§6.3 of the protocol): refusal, then anchors, then
  execution, then comparison. `divergent-platform` exists so that "the toolchains differ" is never
  reported as "the results disagree".
* **Identity and state** live in files, not in a process: `device.json` per machine, an agent state
  directory (spool and cursor), and the relay's `devices.json` + `ledger.jsonl`, which is why a relay
  restart does not lose the fleet.
* **The eight tools are the interface.** A model calls `w2m_devices` → `w2m_run` → `w2m_wait` →
  `w2m_report`; nothing about the transport is required knowledge to use it, and nothing about the
  transport is hidden once you ask (`w2m_status`, `w2m_history`, the aggregate's `transport`).

## 4. Open items, stated plainly

1. **A/B have no live proof yet.** They are implemented and unit-tested (loopback crosses no NAT), but
   the three-machine measurement needs all machines on this build at once.
2. **The MAC's state is unverified**, and one earlier episode had it online but not accepting work.
3. **WireGuard rung 4 is not end-to-end**: hub yes, clients no. When it is, the honest label is
   "direct socket over a tunnel the VPS forwards" — not "the bytes avoided a server".
4. **The session-0 service is unexecuted**; the interactive task remains vulnerable to sign-out, and
   its self-healing window is up to five minutes.
5. **The relay link from this machine is unreliable**, which is an environmental fact about a hotspot
   behind carrier-grade NAT, not a property of this project — and it is precisely why A/B and C exist.
6. `deploy/` and `docs/` are inside the published package, so any change to them owes a release for
   tag/artifact consistency; 0.5.2 is owed at the time of writing (this file included).

## 5. How to re-run this audit

```bash
# the eight tools exist in the packed artifact
node scripts/verify-installed.mjs "$(mktemp -d)"     # after extracting dist/*.tgz into it

# the suites this project gates on (see release.yml for the authoritative list)
node --test --test-force-exit test/p2p-*.test.mjs test/agent.test.mjs test/tools.test.mjs \
  test/e2e.test.mjs test/crossnetwork.test.mjs test/recovery.test.mjs test/outbound-only.test.mjs

# what path did a real dispatch take, per machine
node deploy/networking/acceptance.mjs --rabbit http://202.182.123.154:8787 \
  --token <operator token> --project <fleet checkout> --command 'git rev-parse HEAD'

# the Windows side, locally
Get-ScheduledTask -TaskName 'W2M Localside agent' | Get-ScheduledTaskInfo
Get-NetUDPEndpoint -LocalPort 41235
Get-Content "$env:USERPROFILE\.dsh\w2m\supervisor-heartbeat.json"

# the tunnel
wg show    # on the server: a `latest handshake` line per peer is the only proof
```
