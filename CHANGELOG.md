# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.6] — 2026-10-09

### Added

* **Published to npm.** `@twinsearth/w2m-dsh-plugin` is now installable by name:

  ```bash
  dsh plugin --profile <profile-name> add @twinsearth/w2m-dsh-plugin
  ```

  which is the form the marketplaces and every reader's muscle memory expect, and the form the
  README had to warn against until now. It is the **same file** the GitHub release publishes —
  `release.yml` packs with `scripts/pack.mjs`, the release uploads the tarball and `SHA256SUMS`, and
  the npm publish uploads that fetched-back tarball after checking it against those sums. Nothing
  is repacked, so "which artifact did you install?" has one answer rather than three.
* **`release.yml` gained an `npm` job** with two ways to authenticate, preferred first: **trusted
  publishing (OIDC)** — nothing stored in the repository, configured once on npmjs.com against this
  repo and workflow — or an `NPM_TOKEN` repository secret. It is `continue-on-error` on purpose:
  those credentials live outside the repository, so an unconfigured npm account must not paint
  every future release red, but it must not pass silently either. It also skips cleanly when the
  version is already published, so re-running a release is idempotent.

### Changed

* The README's install section leads with the npm form, the version badge is replaced by a live npm
  badge, and the "not from npm yet" warning is gone — it was true for exactly one release cycle and
  would have been the first thing a visitor to the npm page read.

## [0.4.5] — 2026-10-09

### Fixed

* **The supervisor v0.4.4 shipped would have failed the lint job.** `deploy/windows/` was not in the
  rule block that turns `no-console` off for entry points — and a supervisor's only output channel
  *is* the console and the log it tees into — and it carried an unused import left over from an
  earlier draft. CI #41 caught it after v0.4.4 was published; the release itself was fine, the
  repository was not. `deploy/**/*.mjs` now shares the entry-point block with `bin/**/*.mjs`.

### Notes

* Released as its own version rather than re-tagged, because `deploy/` is inside the published
  package: re-pointing v0.4.4 at different bytes would make the tag and the tarball disagree, which
  is exactly the drift this project's release notes have complained about before.
* The lesson is the same one v0.4.2 taught and it is worth repeating: a *filtered* view of the lint
  output is not the lint output. The local run ended in `Select-Object -Last 1`, printed a blank
  line, and 5 errors went past unread.

## [0.4.4] — 2026-10-09

### Added

* **`deploy/windows/` — the agent as a Windows service.** `install-service.ps1` registers one task
  (`-AtStartup` + `-AtLogOn`, `LogonType S4U`) that runs a new
  **`w2m-agent-supervisor.mjs`**: the agent runs in session 0 with no console, survives sign-out,
  and the supervisor respawns it with a capped backoff and logs one line per run. `-Interactive`
  registers the same thing without elevation (sign-in only). `winsw/w2m-localside.xml` is the
  template for a real SCM service if you need an entry in `services.msc` — that path puts a
  third-party binary on the machine as the service host, which is your decision and not the
  project's, so it is documented rather than scripted.

### Fixed

* **Three defects in the service path, all found by running it rather than reading it.**
  1. A JSON argument does not survive being passed to a task: `--allowed-commands
     "[\"node --version\"]"` came back stored as `"[node --version]"`, the agent read `[node` and
     exited 2 with `ALLOWED_COMMANDS_INVALID`. That is the third layer to eat those quotes
     (`cmd`, PowerShell 5.1, Task Scheduler), so the allow-list now lives in
     `%USERPROFILE%\.dsh\w2m\agent.json` and the command line only carries `--config <path>`.
  2. `-AgentArgs '--p2p-mode','auto'` through `powershell -File` arrived as the single token
     `--p2p-mode,auto` (`ERR_PARSE_ARGS_UNKNOWN_OPTION`); it is now one string, split on commas and
     whitespace.
  3. PowerShell 5.1's `Set-Content -Encoding utf8` writes a **BOM**, `JSON.parse` refuses it, and
     the supervisor exited 78 *before opening its log* — a failure with no trace at all. The
     installer writes without a BOM; the supervisor strips one if present, because the file is
     meant to be hand-edited and Notepad writes them too.

### Notes

* The supervisor also reads the camelCase keys a JSON file wants (`allowedCommands`, `agentArgs`)
  as well as the kebab-case flags the command line uses. The first version looked only for the
  kebab key in the file, so a correct config silently fell back to the default four-entry
  allow-list — silent, because a missing key is not an error.
* Verified after installing through the script: the task reports `Running`, the agent logs the full
  nine-entry allow-list, `stream ready` arrives, and a real fleet dispatch finishes `consistent`
  on both machines.

## [0.4.3] — 2026-10-09

Documentation and metadata only — no source change, and the protocol is untouched. The
reason for a release at all is the same reason the marketplace needs one: the ecosystem's
listing standard treats a version bump as the signal that something changed, so metadata
that changes without a bump is metadata nobody re-reads.

### Changed

* **The install section now names targets that exist.** It led with
  `dsh plugin ... add @twinsearth/w2m-dsh-plugin@0.4.0`, an **npm name that is not
  published** — a copy-paste that fails with a registry 404. It now leads with the release
  tarball (the form verified in this repository), documents the repository form a
  marketplace's one-click installer uses (`install TwinsEarth/dsh-windows2macos`), and
  says plainly that the npm-name form starts working the day the package is published.
  Both language sections carry the current version instead of a two-releases-stale one.
* **`package.json` declares what the plugin is and what it touches.** `dsh` gains
  `plugin: true` and `kind: "server"`, and a `disclosure` object states: cloud required,
  the default endpoints, no offline mode, where the two credentials live, which
  filesystem and network reaches are used, and that the reference deployment moves data
  between CN and JP. The README carries the same table for a human, because a disclosure
  a reader cannot find is not a disclosure.
* **`stateDir` in the documented config is an absolute path.** The example used
  `!!js (process.env.DSH_HOME + '/xclient')`, which on this build evaluated to
  `…/desktop/undefined/xclient` — a path that does not exist, silently, so the plugin had
  no device identity and the direct path stayed down. Measured, not theorised.

### Notes

* The repository already carried the `dsh-plugin` topic, which is the listing entry
  point for the topic-driven marketplaces; they scan it on their own schedule. Nothing in
  this release is an application to any of them.
* Still not on npm. Publishing needs the scope owner's token, which is a decision for a
  human rather than something a release can assume.

## [0.4.2] — 2026-10-09

### Fixed

* **`w2m_update` could never be called.** Its `execute` returned the plain object
  `{ ok, action, update }` while the host requires a **string** from a tool, so every
  call was rejected before it ran:

      tool "w2m_update" returned invalid output: "value" must be a string

  `output: jsonOutput` is a renderer, not a serialiser — the tool still owns turning its
  value into text, which is what the other seven do. It now returns
  `JSON.stringify(value, null, 2)` on both branches. Broken in v0.4.0 and v0.4.1, found
  by actually calling the tool rather than by reading it.

### Added

* **One test that makes the whole class impossible to repeat**: it calls all eight tools
  (including both `w2m_update` actions, with the updater's network lookup stubbed to
  fail so nothing installs) and asserts every result is a string that parses as JSON.
  `test/tools.test.mjs`: 82 pass, 0 fail.

## [0.4.1] — 2026-10-09

Two defects that v0.4.0 shipped, both found by using it against a live two-machine
fleet rather than by reading it. No wire change, no new endpoint: protocol version
stays **1** and a v0.4.0 peer keeps working in both directions.

### Fixed

* **The plugin's dispatch-time allow-list could never match a multi-token entry.**
  `checkAllowedCommand` compared `argv[0]`'s basename against each entry *whole*, so
  the documented configuration — `allowedCommands: ['node --test', 'git status
  --porcelain']` — refused every dispatch:

      COMMAND_NOT_ALLOWED: `git` is not in this plugin's allowedCommands (git rev-parse, node --test, …)

  The agent's own matcher has always been token-wise (`['node','--test']` allows
  `node --test --reporter=tap`, refuses `node -e …`), so the dispatcher's pre-flight
  and the machine that actually runs the command disagreed about the same setting.
  Both now use **one** implementation, moved to `src/agent/allowed-commands.mjs` and
  re-exported from `src/agent/agent.mjs`, so the public surface and every existing
  import are unchanged. The pre-flight stays *no stricter* than before: an entry
  naming an executable with an extension (`Node.exe`) still matches, which is the
  tolerance the old check had.
* **There was no way to pin the UDP punch port.** The node always bound an ephemeral
  port, so a machine that has to *accept* a punch — the executor — needed its
  firewall rule re-pointed after every restart. Measured on the shared server: with
  the rule stale, every dispatch fell back to the relay (`P2P_PUNCH_TIMEOUT` on the
  dispatcher, `offer_path: "relay"` in the ledger). `--p2p-port <n>` (and
  `W2M_P2P_PORT`) now pins it, validated loudly: `0`, `65536` and a non-numeric value
  are usage errors that name the setting, and an invalid value at the agent level is
  a recorded, non-fatal `P2P_PORT_INVALID` start failure rather than a silently
  ignored option. `p2pMode: relay` still binds no socket at all.

### Added

* **`src/agent/allowed-commands.mjs`** — `parseAllowedCommands` and
  `matchAllowedCommand`, one implementation for the agent and the plugin, with the
  rule they encode written down next to it: a string entry splits on whitespace, the
  executable is compared by path or by basename, and every later token is compared
  verbatim.
* **`normalizeP2PPort`**, exported next to `normalizeP2PMode`, because the CLI and
  the agent must not disagree about what a legal port is.
* **10 tests** across `p2p-node`, `tools`, `p2p-agent` and `outbound-only`: the
  multi-token allow-list in both directions, the default bind being exactly
  `{address:'0.0.0.0', port:0}`, a pinned port reaching the binder and being reported
  in `status.local`, the real CLI pinning a real port, and a bad value exiting 2.

### Verification

* Required suites (`p2p-node`, `agent`, `tools`, `p2p-plugin`, `p2p-agent`,
  `outbound-only`): **297 tests, 294 pass, 2 skipped, 1 failure** — the failure is
  the pre-existing `finds python in the bundled DSH runtime when PATH has none`,
  reproducible at HEAD. Baseline on the same files: 287 tests, 284 pass → exactly
  +10 tests, +10 passing.
* The whole repository (`test:all`): **896 tests, 888 pass, 3 failures, 5 skipped**,
  and the three are the same pre-existing environment cases documented in
  `RELEASE-STATUS.md` (`agent` python; `pipeline-e2e` × 2, an allow-list entry
  containing a space plus Node installed under `C:\Program Files`).
* Not verified: the pinned port was exercised on loopback and through the CLI, not
  against a live firewall. The claim it fixes — "a firewall rule no longer has to be
  re-pointed after every restart" — is the mechanism, and it is stated as the
  mechanism rather than as a measurement.

## [0.4.0] — 2026-10-09

The direct path becomes the default, and the P2P feature that v0.3.9 shipped but
did not wire up finally carries the task.

v0.3.9's own §8 said it plainly: the transport existed, `p2p.mode` was documented
as defaulting to `auto`, **nothing read it**, the Localside announcer was not
implemented, and `w2m_run` still dispatched through the relay — so a deployment
could believe it was on a direct path while every byte crossed the relay. This
release is that gap closed, with the same rule as before: what is not measured is
written down as not measured.

### Added

* **`src/agent/p2p-node.mjs`** — the announcer and dialer v0.3.9 did not have. One
  UDP socket per process: STUN discovery, mapping classification, candidate
  announcement with a 60 s TTL refreshed every 20 s on an `unref()`ed timer, a
  persistent accept loop, and `dial(machineId)` that returns a `P2PChannel` or a
  named failure. `start()`, `announceNow()`, `dial()` and `close()` never throw:
  a machine that cannot punch must still work over the relay.
* **`accept()` in `src/agent/p2p.mjs`** — the responder half of `punch()`, so an
  idle machine can receive a punch without having initiated one. `punch`,
  `P2PChannel`, `connect` and `deriveSession` are unchanged.
* **`src/relay/stun-server.mjs` + `bin/w2m-stun.mjs`** — an RFC 5389 Binding
  responder, so a fleet does not depend on three third-party STUN servers being
  reachable from every network it runs in. `XOR-MAPPED-ADDRESS`,
  `MAPPED-ADDRESS` and `SOFTWARE`; malformed datagrams are dropped and counted;
  `0x0111`/400 only for an unknown comprehension-required attribute.
* **The shared server, as a default rather than an instruction.**
  `SHARED_SERVER` in `src/agent/p2p-node.mjs`: `http://202.182.123.154:8787` for
  the relay and `202.182.123.154:3478` as the first STUN server. An empty
  `rabbitUrl` now means the shared server; `w2m_status` reports
  `rabbit_source: config | env | shared-default`, so "it works" and "it works
  because someone set it" stay distinguishable.
* **`deploy/shared-server/`** — one command to stand up the whole rendezvous
  host: Node, the relay, the STUN responder, an SSE-safe nginx front on :80, the
  ufw rules, and optionally the host itself as a fleet machine. The reference
  instance was built with it.
* **`p2pMode` / `stunServers` configuration** on the plugin (`W2M_P2P_MODE`,
  `W2M_STUN_SERVERS`) and `--p2p-mode` / `--stun-servers` on the Localside CLI.
  Both are validated loudly at load: an unknown mode is a startup error naming
  the setting, not a silent fallback to `auto`.
* **`transport` and `p2p` on every result**, plus a trailing `路径` column in the
  markdown report: which path the offer took (`offer_path`), which path the result
  took (`result_path`), the punch RTT, the peer address, and a named `reason` when
  the direct path was not used.
* **`PROTOCOL-v0.4.0.md`**, `deploy/systemd/w2m-stun.service`, and four new test
  suites (`p2p-node`, `p2p-transport-fields`, `p2p-plugin`, `p2p-agent`) plus
  `stun-server`.

### Changed

* **The direct path is the default connection method between machines.**
  `p2pMode: auto` is now real behaviour: the dispatching machine announces,
  punches to each target, and pushes the offer over the punched channel. The relay
  **holds its own copy of that offer back for `p2pOfferGraceMs` (1200 ms)** and
  offers it anyway if the punch does not land — without that hold the direct path
  could never win, because an SSE push over an already-open connection beats a
  punch that costs a round trip. Measured on loopback while writing it: the relay
  copy won every time. The hold is cancelled by the executor's own lease
  heartbeat, so no new message was needed to say "the direct copy arrived".
* **The result notice travels back over the same channel, and the payload does
  not.** `{type:'task.result', task_id, machine_id}` is acknowledged with
  `result.ack`; the envelope is not on that frame, because `result_path` is one of
  the envelope's fields and `envelope_sha256` covers it, so the acknowledgement has
  to be known before the envelope is built. The direct path saves the dispatcher the
  wait for the relay's copy, **not the bytes** — stated here because "the payload
  path is direct" would otherwise be read as more than it is. A task's channel is
  released 30 s after its attempt (`p2pChannelLingerMs`), so duplicates of a
  finished attempt are still answerable and sessions do not accumulate.
* **`w2m_run` now dispatches with intent**: `origin_machine_id` and `p2p: {mode}`
  travel in `POST /v1/task`, so the executor knows who might dial it and the relay
  records how the task was meant to travel.
* **`w2m_wait` and `w2m_status` surface the path** — per machine in `w2m_wait`,
  and as a `p2p` block (mode, mapping, reflexive address, announcements, punches
  in/out, direct-result inbox depth) in `w2m_status`.
* **`scripts/verify.ps1` / `verify.sh` pass `--test-force-exit`** and run the five
  new suites. They previously ran every suite without it, which can hang a green
  end-to-end suite on an open SSE stream — a local verification that hangs is
  indistinguishable from one that never finished.
* **`release.yml` / `ci.yml` carry the new suites** in the explicit lists, and the
  duplicated `recovery.test.mjs` entry in both e2e lines is gone.

### Fixed

* **A STUN response's attribute padding.** The responder's first draft omitted the
  mandatory 4-byte padding after a 15-byte `ERROR-CODE` value, so every `0x0111`
  response was one byte short with a declared length of 39 instead of 40. The
  existing client decoder did not notice and neither did a hand-written hex
  expectation — both were written from the same wrong assumption. It was caught by
  a vector built numerically from the RFC layout, and it is invisible on the
  success path because all three success attributes are already multiples of four.
  The regression is pinned by an explicit length assertion plus a whole-buffer
  comparison.
* **The allow-list trap that hid a suite failure.** A string entry in
  `--allowed-commands` is split on whitespace, so a single path containing a space
  (`C:\Program Files\nodejs\node.exe`) can never match and has to be written as an
  array entry. This is why `test/pipeline-e2e.test.mjs` passes on CI runners and
  can fail locally on a Windows box whose Node lives under `Program Files`; it is
  now documented in `docs/TROUBLESHOOTING.md` §10 rather than left to be
  rediscovered.

### Compatibility

* **Protocol version stays 1.** Everything here is additive: two optional task
  fields, two optional result fields, three new files, one new CLI. A v0.3.9
  agent against a v0.4.0 relay and the reverse both keep working, and a v0.3.9
  result envelope with no `transport` still compares exactly as it did.
* **`transport`/`p2p` are deliberately NOT comparable fields.** A path is not a
  result: two machines that ran identical bytes and differ only in how the offer
  reached them stay `consistent`. A test asserts exactly that, because the
  opposite would turn a network difference into a false bug report.
* **A p2p-mode difference is not silent.** Both sides validate the mode at load;
  the relay refuses an unknown `p2p.mode` in a task body with `BAD_REQUEST` naming
  the field, and creates no task.

### Verification

* Every claim in this entry has a suite behind it. Run them with
  `scripts/verify.ps1` (Windows) or `scripts/verify.sh` (macOS/Linux), which now
  include the five new suites.
* **What is measured across a real network, and what is not.** One WAN hop was
  exercised end to end: the dispatcher on a Chinese residential network behind a
  **symmetric** NAT, the executor on the shared server in Tokyo. Measured, with
  numbers rather than adjectives:
  * the client network is `endpoint-dependent` — three STUN servers reported three
    different mapped ports for one socket (36028, 5855, 26713), punchable: false —
    so nothing can dial *into* it;
  * a punch it **initiates** to a public peer still lands: `HELLO` → `HELLO_ACK` in
    **331.61 ms**, over a channel the punched path opened, and the ledger for that
    machine records `transport: "p2p"` with `result_path: "p2p"`;
  * a machine that has to *accept* a punch needs its UDP port reachable. On the
    shared server that meant one `ufw` rule for the agent's punch port, and the port
    is ephemeral today — a fixed `--p2p-port` is the obvious follow-up, and the
    absence of it is why this is a documented step rather than a one-liner.
* **Still unverified, and named as such:** a punch between two hosts behind two
  *different* NATs (the second network that would make it possible was not
  available), punching through a cone NAT, the direct path under real packet loss
  or reordering, IPv6 (not implemented in the transport; the responder's IPv6
  branch is unexercised), and the authenticity of the UDP channel itself — a
  direct path is not more trustworthy than the relay, and `PROTOCOL-v0.4.0.md` §9
  says so rather than implying otherwise.
* A loopback punch is not evidence of NAT traversal, and neither the tests nor
  this entry claim it is. The WAN measurement is one hop with one NAT, and it is
  labelled as one hop with one NAT.


## [0.3.9] — 2026-10-09

P2P hole punching, so the payload path no longer has to cross the relay.

### Added

* **`src/agent/stun.mjs`** — an RFC 5389 Binding client on `node:dgram`, no third-party
  dependency. It discovers the reflexive address and classifies **mapping behaviour** by
  comparing the mapped port across several servers: one port everywhere is
  `endpoint-independent` and can be punched; a different port per destination is
  `endpoint-dependent` (symmetric) and cannot.
* **`src/agent/p2p.mjs`** — hole punching plus a reliable, fragmenting channel over the
  punched path: selective per-fragment ACK, retransmission with doubling RTO, an 8 MiB
  ceiling, and named failures (`P2P_PUNCH_TIMEOUT`, `P2P_NO_CANDIDATES`,
  `P2P_FRAGMENT_UNACKED`, `P2P_MESSAGE_TOO_LARGE`).
* **`src/relay/peers.mjs`** and two endpoints — `POST /v1/peer/announce` and
  `GET /v1/peer/{machine_id}` — the candidate rendezvous. Announcements are ephemeral
  and deliberately never persisted; `/healthz` reports `peers_announced`.
* **`PROTOCOL-v0.3.9.md`** — the wire contract, the frame format, and the path-reporting
  rule.
* 56 tests across `test/p2p-stun.test.mjs`, `test/p2p-transport.test.mjs` and
  `test/p2p-signaling.test.mjs`, wired into `npm test` and `npm run test:all`.

### Changed

* **`p2p.mode` defaults to `auto`**: try the direct path, fall back to the relay, and
  **report which path was used**. See "Why `auto` and not `direct`" below.

### Why `auto` and not `direct`

Punching cannot succeed against a symmetric NAT, and that is not hypothetical: measured
on the authoring machine, behind an iPhone hotspot, three STUN servers reported three
different mapped ports for the same socket — `endpoint-dependent`, so no punch from that
network can work. A default that hard-required the direct path would break every
deployment on such a network the moment it upgraded.

The fallback is never silent. Every offer and result carries `transport: "p2p" | "relay"`
and, on the relay path, the reason it fell back. A fallback that is not reported is
indistinguishable from a slow direct path, and the operator then debugs the wrong thing.

### Two mistakes the tests caught, kept here because they are the interesting part

1. **The STUN address family was read from the wrong byte offset.** RFC 5389 has a
   reserved byte before `Family`; `value[0]` yields the reserved byte, so every address
   decoded to `null` — which is indistinguishable from a server that sent no address at
   all. A self-written fake STUN server agreed with the wrong offset perfectly. Only a
   real server disagreed, which is why the suite has a live layer and a frozen captured
   response.
2. **Both peers generated their own random session id**, so each discarded the other's
   `HELLO` and the punch timed out looking exactly like a NAT failure. `punch()` now
   requires an agreed id (or an explicit `allowSessionAdoption`), and **throws** rather
   than inventing one — a misleading timeout is the most expensive possible
   misdiagnosis here.

### Not yet wired

The `p2p.mode` setting is defined and documented but nothing reads it yet; the Localside
announcer and direct-path dispatch are not implemented. **The task path therefore behaves
exactly as v0.3.8.** Stated here, in `PROTOCOL-v0.3.9.md` §8 and in the README, so that no
deployment believes it is on a direct path when it is not.

### Verified / not verified

Verified on macOS 27.0 / arm64: STUN against Cloudflare, Google and Nextcloud; the
mapping classifier against a real symmetric NAT; the punch, fragmentation, selective ACK,
retransmission under injected loss, and every failure mode, over real UDP sockets.

**Not verified, and impossible on one machine:** a punch across a real NAT. Two sockets on
one host share a loopback path with no translator between them, so "the punch succeeded"
says nothing about traversal. That still needs two hosts behind two different NATs.

### The v0.3.5 / v0.3.6 release gap

Both versions are tagged, and **neither was ever published**. The flake fixed above failed inside the
`Release` workflow, so those two tags have no GitHub release and no downloadable tarball. The evidence
for the cause is the release list itself: v0.3.4 published, v0.3.7 published, and the two in between
absent.

They cannot be published retroactively, and this is worth stating precisely rather than papering over:
a tag pins the tree that ran, and the tree at those tags **contains the flaky test**. Re-running their
`Release` workflow fails again for the same reason. Moving a tag forward to pick up the fix would
publish the right code under the wrong version — `package.json` at v0.3.5's commit says `0.3.5`, so the
tarball would be named 0.3.5 while containing later code.

What that means in practice: **v0.3.7 is the first published artifact that contains the shared config
(v0.3.5) and the metrics endpoint (v0.3.6).** Anyone installing from releases gets all three. The gap is
cosmetic in effect and real in the record, which is why it is written down instead of skipped.

The process lesson is the one that cost the most here: a flaky test does not just fail a build, it can
block every release behind it until someone notices that the failures share a cause. Three consecutive
release runs failed before the pattern was visible in the release list.

## [0.3.8] — 2026-10-08

The last open v0.3.3 item, resolved by reading the shipped runtime rather than guessing.

### The finding

**UI cards: there is nothing to add.** `defineTool` treats `presentCall`'s return value as an opaque
hint and never validates it —

```js
if (userPresentCall) tool.presentCall = (args) => {
  if (validate(args).length > 0) return void 0;
  return userPresentCall(args);
};
```

— which means two things. There is **no registry of card types** to choose from: nothing in the shipped
bundle reads `card` at all. And a wrong field **cannot be caught by the runtime**; it would fail
silently in the UI. That is precisely why guessing a richer card was the wrong move, and why this item
sat open rather than being closed by inventing something.

The shipped runtime contains exactly two reference implementations, and they are the only evidence for
what the fields mean:

| where | card | kind |
|---|---|---|
| built-in `run_code` (`dsh-tools/lib/index.js:1445`) | `"generic"` | `"execute"` |
| the plugin manager (`dsh-plugin-manager/lib/types/tools.js:85`) | `'generic'` | `action.startsWith('list_') ? 'read' : 'other'` |

Both use `generic`. `kind` varies by whether the action mutates. That is the whole vocabulary with a
reference behind it.

### Fixed

- **`w2m_update` reported `kind: 'read'` for its check-and-install action**, which can install a new
  version into the very profile it runs in. A false "read" is worse than no hint, because the hint is
  what a user reads to decide whether a call is safe — the same class of defect as the `intervalDays`
  option that silently did nothing, and fixed for the same reason. It now reports `other` for `check`
  and `read` for `status`, matching the plugin manager's vocabulary for exactly that distinction.

  `w2m_run` keeps `write` when `write: true`: it executes on other machines, which `read` would
  understate. The other six tools were already accurate.

- **`rawInput` is now asserted never to carry a credential.** It is handed to the UI, so anything in it
  is rendered — and the shared-config work in 0.3.5 was specifically about keeping tokens out of files
  that travel. The same rule applies to a card.

`presentResult` was deliberately **not** adopted: it is a second, equally unvalidated hook whose
result-side contract appears nowhere in the shipped bundle. Adopting it would be the same guess this
release declines to make. The reasoning is recorded in `docs/UI-CARDS.md` so the question is not
re-opened from memory.

### Verification

626 unit tests, 624 pass, 2 skip, 0 fail, 0 todo; 21 suites wired into `ci.yml`, `release.yml` and
`package.json` with exhaustiveness checked. ESLint 0 errors, 56 warnings. Five new tests in
`test/tool-cards.test.mjs`, including the credential check and a call with no arguments — which is what
the runtime itself does on a schema-invalid call.

### v0.3.3 is now complete

broadcast, pipeline, shared configuration, metrics and multi-arch images were delivered in 0.3.2
through 0.3.6; UI cards are settled here. The two items from the v0.3.0 batch that remain undone are
the optional WebSocket transport and the optional libp2p fallback package — both judged to duplicate
what HMAC signing plus the existing backoff already provide, and neither is required by any acceptance
criterion.

## [0.3.7] — 2026-10-08

### Fixed

- **A flaky assertion in the agent suite, which failed on CI and passed locally every time.**
  `never publishes a half-written document` asserted `reads > 20` inside a fixed 1200 ms wall-clock
  deadline. That is a **throughput** threshold, not the property under test: whether the loop manages 20
  iterations depends on how loaded the runner is, so on a busy machine it failed at 15 reads while the
  atomic-publish code was perfectly correct. It passed here every time because this machine is fast.

  The test now waits until the writer has actually published the file — so the loop cannot pass
  vacuously by reading a file that never existed — and asserts `reads > 0` plus `parsed === reads`,
  which is the real invariant and a torn write would break it. Verified over five consecutive runs of
  the specific test and a full agent suite pass.

  Worth recording because of where it surfaced: CI, not here. A test that measures machine speed will
  always pass on the author's machine, which is exactly why the timestamped evidence has to come from
  somewhere other than the machine that wrote the code.

- **Two wrong metric-type and metric-set decisions corrected before release**, both pushed back on by
  the teammate who implemented the renderer, and both worth stating because the reasoning is the
  valuable part:

  - `w2m_task_status_total{status}` is declared **`gauge`, not `counter`** despite the `_total` suffix. The
    values are the *current* count of tasks in each state, so a task moving from `pending` to
    `consistent` decrements one bucket and increments another. A counter is monotonic by definition, so
    declaring this one would make `rate()` produce nonsense and violate the "counters reset on restart"
    convention. The `_total` name is kept deliberately — a dashboard or recording rule may already point
    at it — and this note is the record that the suffix is a name, not a claim about the type.
  - `w2m_rtt_stale{machine_id}` was added (0/1, emitted only for machines that reported an RTT), because
    `w2m_rtt_ms` alone cannot distinguish "genuinely slow" from "reported 40 ms once and then vanished
    forever" — a stale series reads as a healthy machine. With both, the operator's query works:
    `w2m_rtt_ms > 500 and on(machine_id) w2m_rtt_stale == 0`.

  The implementer also **proved the null-versus-zero assertion has teeth by mutation**: pushing a
  fabricated `rtt_ms: 0` for a silent machine turned three assertions red, then the mutant was deleted.

### Verification

621 unit tests, 619 pass, 2 skip, 0 fail, 0 todo; 63 end-to-end. 20 suites wired into `ci.yml`,
`release.yml` and `package.json` with exhaustiveness checked. ESLint: 0 errors, 56 warnings, all
pre-reviewed. The `Docker` workflow built both architectures successfully on the runner — which
upgrades the multi-arch images added in 0.3.5 from "unverified" to **built**, though still not pushed
anywhere.

### Still not done

**UI cards** — the last of the four v0.3.3 items.

## [0.3.6] — 2026-10-08

### Added

- **`GET /metrics`**, Prometheus text format, off unless `--metrics` is passed. It is **token-free**
  like `/healthz` and for the same reason: a scraper that needs the operator token puts that token in a
  Prometheus config file, which is a credential in a place nobody reviews. It is likewise exempt from
  signature checks, because the scraper has no secret to sign with — requiring one would make metrics
  unreachable on exactly the hardened deployments that most want them.

  Disabled answers **404, not 403**: a 403 tells a scanner the surface exists, and an endpoint that
  appears without being asked for is a surface nobody chose.

  The renderer was implemented separately from the route on purpose, and this release is the evidence
  for why the two are different: the module had 16 green tests while `GET /metrics` still returned 401,
  because a correct renderer behind an unreachable route is indistinguishable from an unimplemented
  feature. `test/metrics-route.test.mjs` now covers the route itself — absent by default, token-free
  when enabled, reachable under `--require-signature`, and never leaking the operator token or the
  signing secret into a body that gets scraped into long-lived storage.

  Where the renderer's rule lives: a machine that never reported an RTT has **no series at all**, not a
  `0`. In Prometheus `0` is a real measurement meaning "instantaneous" while a missing series is
  `absent()` — the same null-versus-zero distinction the relay-side RTT work turns on.

### Fixed

- **`--signing-secret`, `--signing-secret-previous`, `--require-signature` and `--signature-skew` were
  parsed but missing from `--help`**, so an operator could not discover them from the CLI. A flag
  nobody can find is a flag that does not exist in practice. Found by the teammate building the Docker
  images, who reported it rather than fixing it outside their scope.
- A fourth mojibake casualty: `cannot dispatch a tas` in the operator-token error, another word the
  earlier GBK round trip truncated.

### Verification

621 unit tests, 619 pass, 2 skip, 0 fail, 0 todo. 20 suites wired into `ci.yml`, `release.yml` and
`package.json` with exhaustiveness checked. ESLint: 0 errors, 55 warnings, all pre-reviewed.
`/metrics` was also confirmed against a live relay process: 404 without `--metrics`, and 200 with the
correct content type and metric series with it.

### Still not done

**UI cards** — the last of the four v0.3.3 items. The eight tools render through the generic card.

## [0.3.5] — 2026-10-08

Two of the four remaining v0.3.3 items: shared configuration and multi-arch images.

### Added

- **Shared configuration** (`src/plugin/shared-config.mjs`). One committed file, `.w2m.json` at the
  project root, that every machine reads — so the allow-list, the timeout and the update schedule stop
  drifting per machine. Layering is `.w2m.json` → `~/.w2m/machine.json` → the host's own config object,
  highest wins key by key.

  It lives **in the project, not on the relay**, because a relay-hosted config would mean the relay
  holds the fleet's credentials or the config splits into secret and non-secret halves — and the
  operator ruled that the relay must not hold credentials. A file in the project needs nothing from the
  relay, works while the relay is unreachable, and is reviewed in the same pull request as the code it
  governs.

  Four decisions worth stating, each of which is a way config systems fail their users:

  - **Secrets are refused, not ignored.** A key matching `token`/`secret`/`password`/`credential`/
    `apikey` is rejected with a message naming the key. Silently dropping it would let the operator
    believe a token is in effect, and a token in a committed file is a leak that survives every later
    decision.
  - **A typo'd key is refused.** A silently-dropped key is indistinguishable from a setting that works,
    which is the worse of the two failures.
  - **Absence is tolerated, breakage is not.** No file is the normal case and yields defaults; a file
    that exists and does not parse is a loud error. Running on defaults while the operator believes
    their settings apply is exactly the silently-wrong outcome this project refuses elsewhere.
  - **Every effective value reports its source** through `w2m_status`. "The setting is in the file I
    edited and something else wins" is the characteristic failure of layered configuration, and the
    answer must be readable from one call instead of by bisecting the layers.

  `timeout_ms` lost its schema `default` for a related reason: with a default in the parameter map, DSH
  fills it in before `execute` runs, so a timeout set in the shared config would be silently overridden
  on every call and the operator would see their setting do nothing.

- **Multi-arch Docker images** (`deploy/docker/`, `.github/workflows/docker.yml`) for `linux/amd64`
  and `linux/arm64`. The relay's real import closure was computed to prove the image installs **no npm
  packages**: 7 files, ~175 KiB, all `node:` builtins. The image is non-root with a `VOLUME` state dir
  and a token-free `HEALTHCHECK`.

### Verification

600 unit tests, 598 pass, 2 skip, 0 fail, 0 todo. 19 suites wired into `ci.yml`, `release.yml` and
`package.json` with exhaustiveness checked. ESLint: 0 errors, 55 warnings, all pre-reviewed.

### Not verified

- **No Docker image was built.** Docker, Podman and buildah are all absent from this machine, and
  Docker Hub is unreachable from it, so every build/push/platform claim is unverified. What *was*
  verified without Docker: all COPY sources exist, all 7 closure files are covered by the COPY set, no
  package manager appears anywhere, the base tag is an exact patch version, and — the strongest one —
  the container's `CMD` was executed directly against the same file set, starting the relay, answering
  `/healthz` without a token, exiting 0 from the exact `HEALTHCHECK` command, and writing the pairing
  code to stderr.
- The base tag `node:22.23.3-bookworm-slim` could not be confirmed against the registry. The version
  itself was verified against `nodejs.org/dist/index.json`.
- `metrics` is implemented but **not yet routed**; `GET /metrics` still 401s. See v0.3.6.

### Reported, not fixed

`--signing-secret` and `--require-signature` are parsed by `bin/w2m-rabbit.mjs` but missing from its
`--help` output, so an operator cannot discover them from the CLI. Outside the scope of the task that
found it.

## [0.3.4] — 2026-10-08

### Added

- **`pipeline` mode.** Every machine runs the whole chain from `stages`, in order, stopping at the
  first stage that fails. The semantics were chosen against the alternative — fan stage 1 out, converge
  its outputs into stage 2 — because that one has **no well-defined input**: on a fleet, stage 1
  produces *n* different outputs, and "feed them all to stage 2" does not say in what order, or
  whether stage 2 then runs once or *n* times. Worse, two machines finishing in a different order would
  produce different stage-2 inputs, so one `task_id` would no longer describe one reproducible
  execution — which is the property this system is built on. A pipeline is therefore `replicate`
  applied to a sequence: no cross-machine data flow, so nothing can be silently dropped in transit.
  The reasoning is in `docs/PIPELINE-DESIGN.md`.

  The chain's `command_hash` binds **every** stage. Bound to stage 0 alone, two chains differing after
  the first stage would share a hash, and an envelope produced by the wrong chain would still verify —
  defeating the point of the anchor. The agent and the relay compute this hash with independent
  implementations, and a test recomputes both to catch a drift rather than letting them agree silently.

  A per-stage record travels in the envelope, so a reader can tell "stage 1 failed" from "stages 2..n
  never ran" — a single exit code cannot, and the two call for different responses.

### Fixed

- **`pipelineCommandHash` was never imported into the agent.** Referenced but not bound, so every
  pipeline offer threw `ReferenceError` at envelope-build time and was reported as `crashed`. The
  mistake survived an import check because a *comment* in the same file mentioned the name: the check
  searched the file text instead of the import block, so it reported success. The check now matches the
  import statement itself.

### Verified

`test/pipeline-e2e.test.mjs` drives a real relay and a real agent: the stages append to a witness file,
so the ordering evidence is written by the stages themselves and cannot be right unless they ran in
that order. The second case proves the chain stops — a failing second stage means the third never
writes to the witness at all.

### Notes on what the e2e had to get right

Five versions of this file failed before it passed, and every failure was the test reaching for
something that does not exist:

- `GET /v1/tasks/{id}/report` returns a *string* body, not parsed JSON, and the aggregate lives under
  `body`. `GET /v1/tasks/{id}` returns parsed JSON — and requires a **device** token, not the operator
  token, which is what the first version sent.
- `aggregate.machines` is a projection that deliberately omits envelopes, so
  `aggregate.machines[0].envelope` is `undefined` by design. The per-stage shape is asserted in
  `broadcast.test.mjs` against the state object instead; the e2e asserts only what the wire publishes.
- `base_tree` must be the agent's `treeFingerprint` (`git-temp-index-tree/v1`), not
  `git rev-parse HEAD^{tree}`. A git tree SHA is a different value, and sending one made every task
  `unverifiable`.
- The agent's allow-list is **default-deny**; without `--allowed-commands` every offer is refused
  `COMMAND_NOT_ALLOWED`, correctly, with a startup warning saying so.

### Verification

578 unit tests, 576 pass, 2 skip, 0 fail, 0 todo; 61 end-to-end plus 2 pipeline end-to-end. All 17
suites are wired into `ci.yml`, `release.yml` and `package.json` with exhaustiveness checked. ESLint:
0 errors, 54 warnings, all pre-reviewed.

### Still not done

Shared config, UI cards, metrics and multi-arch images from the v0.3.3 batch remain untouched.

## [0.3.3] — 2026-10-08

The CI hardening the v0.3.0 batch called for, plus a correctness fix those tests found.

### Fixed

- **Every successful `split` was reported `divergent`.** `index` is a comparable field, the relay
  hands each machine its own slice by index, and Step 3 of the aggregation flagged any comparable
  field that differed. So a fan-out where every machine did exactly what it was asked produced a
  verdict that `README.md` defines as "machines disagreed" — a false alarm on the normal case, every
  time. Step 3 now compares **within a shard**: machines meant to produce the same output are
  compared with each other, and machines given different slices are not compared at all.

  The fix is a grouping rather than a special case, which is why it is safe: for `replicate` every
  machine has index 0, so there is a single group and the behaviour is byte-identical. The 140
  existing relay tests passing unchanged is the evidence for that, not a new test asserting it.
  `step3.comparable` still reports each machine's index — it is simply not treated as disagreement.

  Found by the stress suite written in the same release, not by inspection: no test anywhere covered
  split aggregation, because the only split test asserted index *assignment*.

### Added

- **`test/stress.test.mjs`** — bounded load, asserted on the ledger rather than on status codes: 200
  concurrent dispatches (ids unique, all retrievable, `/healthz` and `GET /v1/tasks` agreeing), 24
  concurrent redeliveries of one instance recorded exactly once (checked in `results`, `taskResults`,
  `result_seqs` and `dedupeReport`, with a verified `envelope_sha256`), 50 devices with no lease lost
  and split indices matching `i % index_total`, and a limit-3/burst-12 refusal test with two controls
  — failed attempts consume the same budget, and with the limiter off the same burst yields zero 429s.
- **`test/recovery.test.mjs`** — the disconnect story against real processes: relay killed mid-task
  and restarted, with the agent noticing on its own and the outcome still delivered; the witness file
  showing the command ran exactly once across the reconnect; a cleanly closed stream treated as a
  disconnect with a laddering backoff rather than a hot loop; and a 401 result staying spooled with
  exactly one attempt.
- **`scripts/scan-mojibake.mjs`** — the corruption that hit user-visible strings earlier is invisible
  in review because the bytes are valid UTF-8; they just spell the wrong thing. This scans for it.

### Notes on what these tests had to get right

Both new suites produced failures that were in the tests, not the product, and the distinction
mattered each time:

- The recovery suite's `waitFor` used a truthiness check on an exit code, so `0` — success — read as
  "not yet" and the case timed out while the product was working correctly. Confirmed with an
  isolated repro before changing anything.
- The stress suite's split assertion initially encoded the buggy expectation (`differences` non-empty)
  alongside the correct one. Fixing the product meant inverting that assertion, which is exactly the
  signal that the recorded defect was real rather than a misreading.
- The stress suite's independent check read `m.envelope`, which `aggregateTask` deliberately omits
  from its machine projection; it now reads `step3.comparable`, which is the field that actually
  carries the compared values.

### Verification

568 unit tests, 566 pass, 2 skip, 0 fail, **0 todo**; 61 end-to-end. All 16 suites are wired into
`ci.yml`, `release.yml` and `package.json`, and that exhaustiveness is itself checked — an earlier
release had suites that no script ever ran. ESLint: 0 errors, 53 warnings, all pre-reviewed.

### Not in this release

- **`pipeline`** — the semantics question is answered (the whole chain runs on one machine, so
  `broadcast` chooses where and `pipeline` describes the sequence) but the implementation is not
  written. The reasoning and the required changes are in `docs/PIPELINE-DESIGN.md`; the relay rejects
  `mode: "pipeline"` with `BAD_REQUEST` rather than silently falling back to `replicate`.
- **Shared config, UI cards, metrics, multi-arch images** — untouched; the next batch.

## [0.3.2] — 2026-10-08

The first half of the v0.3.3 batch: a third dispatch mode.

### Added

- **`broadcast` mode.** One machine runs the command and every other machine is told the outcome
  without running anything. Useful when the point is not redundancy but *notification* — a migration
  applied once, a deploy, a cache purge — and the other machines need to know it happened.

  The design is built around one hazard: **a machine that did not run must never be counted as
  agreeing.** If observers were ordinary participants, a broadcast of a successful command would
  aggregate to `consistent`, and a reader would reasonably conclude that the whole fleet had verified
  the result when in fact one machine ran and the others were merely told. So observers hold an
  `observing` lease, which Step 0 of the aggregation routes out of the participant set entirely:
  they cannot pass, cannot refuse, and cannot contribute to a verdict. `step0.observing` lists them
  explicitly so the report says who was informed rather than implying they were involved.

  Three consequences worth stating, because each is a bug the obvious implementation would have:

  - Without treating `observing` as "not a participant", an observer has no envelope and never will,
    so the anchor step classifies it `pending` and **the task can never reach a verdict** — every
    broadcast would hang. Covered by `does not hold the verdict open for a silent observer`.
  - A broadcast whose executor has not reported yet must be `pending`, not `consistent`. With only
    observers participating, a naive aggregation sees zero machines and zero failures, which reads as
    success. Covered by `is pending, not consistent, while the executor has not reported`.
  - The executor is chosen **deterministically** (the first machine the relay lists), not randomly. A
    random leader makes a task impossible to reproduce from its own record — the same `task_id` would
    run somewhere else on a retry — and being able to say exactly where something ran is the point of
    this project.

  `executor_machine_id` selects the machine explicitly and is **refused outside broadcast** rather
  than ignored: the relay reads it only for `broadcast`, so accepting it under `replicate` would look
  like "only this machine runs it" while the command ran everywhere. A restriction that is not
  enforced is worse than no parameter. For the same reason `broadcast` with `index_total > 1` is
  refused instead of coerced — running one shard while recording a split task would put work in the
  report that never happened.

### Verification

559 unit tests, 557 pass, 2 skip, 0 fail; 57 end-to-end. Twelve new tests in
`test/broadcast.test.mjs`, written around the failure this mode can most easily produce rather than
around the happy path. ESLint 0 errors.

### Not in this release

`pipeline` and the composable mode are **not implemented**. The relay rejects `mode: "pipeline"` with
`BAD_REQUEST` rather than falling back to `replicate`: silently running a chained request on every
machine would be an expensive misreading of what was asked.

## [0.3.1] — 2026-10-08

Two tools that landed after 0.3.0 was published, so they get their own version rather than a moved
tag: a published release is a promise about a specific tarball, and rewriting it would break anyone
who already downloaded it.

### Added

- **`w2m_history`** — recent tasks newest-first with their modes, shard counts, lease holders and
  cancellation state, without fetching a single result envelope. It reports how many tasks the relay
  *holds* alongside how many it returned, because a page emptied by a filter and an empty relay
  produce identical lists and only one of them is a problem. The limit is clamped locally so a model
  cannot make this machine allocate a million rows.
- **`w2m_stats`** — the fleet in one call: machine and task counts, aggregate RTT, whether the relay
  restarted. It degrades rather than failing: if this machine cannot read the per-machine roster it
  still reports the relay's own totals, with a note naming which half is missing.

In both, `null` means "the relay did not report it" and never "zero" — the same distinction the
0.3.0 relay-side RTT work turns on, applied at the tool boundary.

The tool count is now **eight**, which is the number the original request asked for.

### Verification

545 unit tests, 543 pass, 2 skip, 0 fail; 57 end-to-end. `scripts/verify-installed.mjs` confirms
eight tools register in both the repository and the packed artifact, and the CI `lint` job reports
0 errors.

## [0.3.0] — 2026-10-08

### Added

- **Cross-machine RTT, carried by the relay.** The round-trip time used to live only in a local
  state file, so with the plugin on machine A and the agent on machine B — the normal cross-region
  shape — there was no view at all. The heartbeat now carries `rtt_ms`; the relay stores it and
  exposes it per device (`/v1/devices`), in aggregate (`/healthz.rtt`), and per machine
  (`/v1/agents/{id}/status`).
- **Idle diagnostic heartbeats.** An agent with no work now reports every 60 s, because the moment
  you look at a machine is the moment it has nothing to do. Without this the cross-machine view
  freezes at whatever the last task measured — and once `rtt_stale` flipped, it read as "the machine
  is up but slow", which is worse than "unknown".
- **Three new aggregate verdicts**, so the status field says what actually happened:

  | verdict | replaces |
  |---|---|
  | `timeout` | `pending` forever, which made "nobody will ever answer" look like "still in flight" |
  | `cancelled` | indistinguishable from `failed`, which reports a deliberate stop as a malfunction |
  | `degraded` | `partial`, which also means "machines are still out" |

  `partial` keeps its original meaning: work is outstanding. The three additions are verdicts, not
  phase flags, which is why they sit in `AGGREGATE_STATUSES` rather than beside `pending`.
- **Request signing** (`src/signing.mjs`, wired into the relay in this same release). HMAC over the
  method, the routed path, a timestamp, a nonce and the exact body bytes. It defends replay,
  tampering and a leaked log. It is **not** end-to-end encryption and not a replacement for TLS, and
  the module says so in its first paragraph — a security claim that overreaches is worse than none.
- **`w2m_history` and `w2m_stats`**, taking the tool count from six to eight. `w2m_history` lists
  recent tasks newest-first with their modes, shard counts, lease holders and cancellation state,
  without fetching a single result envelope; it reports how many tasks the relay *holds* alongside
  how many it returned, because a page emptied by a filter must not be indistinguishable from an
  empty relay. `w2m_stats` summarises the fleet in one call — machine and task counts, the aggregate
  RTT, whether the relay restarted — and degrades to the relay-reported totals when this machine
  cannot read the per-machine roster. In both, `null` means "the relay did not report it" and never
  "zero".
- **A mechanical outbound-only check** (`test/outbound-only.test.mjs`). The project's central promise
  is that no public IP, port forwarding or SSH server is needed because every machine only dials
  out; that is easy to state and easy to break. The test runs real processes and asserts that a
  registered agent binds nothing, that the relay's default bind is loopback and says so in its
  banner, and that an unbindable host is a startup failure rather than a silent fallback.
- **One-click installers**: `scripts/install.ps1` and `scripts/install.sh`, both verifying the
  published SHA-256 before writing anything, and both re-reading the installed package afterwards to
  confirm the tools actually register ("it installed" is not "it loads").
- **ESLint and Prettier**, with `docs/LINT-AUDIT.md` recording the current state honestly: 1 real
  defect, 27 style findings, 46 deliberately accepted. Prettier is configured but not applied —
  measured, it would rewrite 23,715 of 26,383 lines (89.9 %), and obliterating `git blame` for the
  whole repository to satisfy a formatter is a bad trade. The CI job reports the number instead.

### Fixed

- **`resolveProfileDir` called `existsSync` without importing it.** Under ESM that is a
  `ReferenceError`, so `apply()` threw for any plugin loaded from a profile — the normal installed
  layout. It survived 458 green tests because no test ever executed that branch. ESLint's `no-undef`
  found it. Fixed by importing it *and* by moving the function out of the closure into an exported,
  directly testable helper with seven tests: the import alone would leave the next such mistake just
  as invisible.
- **A signing-path disagreement between the two sides.** The agent signed the raw request URL; the
  relay verified the routed path. Both unit suites passed. The mismatch breaks only the third
  documented deployment — a reverse proxy that strips the prefix — where the relay never sees the
  prefixed string at all, so no reconstruction is possible. The client now signs the routed path
  (query included), and `test/signing-e2e.test.mjs` drives a real relay behind `--base-path` with a
  real signature so the contract cannot drift again.
- **Mojibake in user-visible strings.** An earlier PowerShell edit round-trip wrote parts of
  `src/plugin/tools.mjs` through GBK, turning em-dashes into CJK sequences inside error messages and
  tool descriptions — text a model and a human actually read. Repaired with
  `scripts/fix-mojibake.mjs`, which uses only escape sequences so it cannot be corrupted by the same
  round-trip, plus `scripts/scan-truncations.mjs` to catch words the corruption had truncated
  (`unavailable` had become `unavailabl`, and only a test noticed).
- **`npm test` and both verify scripts listed three suites**, so the v0.2.3 suites never ran through
  them. Every `test/*.test.mjs` now appears in `ci.yml`, `release.yml` and `package.json`, and that
  exhaustiveness is itself checked.
- **`engines` claimed Node >= 20.0.0** while ESLint 10 requires >= 20.19.0.
- **`PROTOCOL-v0.3.0.md` was not in `package.json` `files`**, so the compatibility matrix would not
  have shipped.

### Compatibility

- `PROTOCOL_VERSION` stays **1**. Everything here is additive: new optional request fields, new
  response fields, one new endpoint, and optional verification.
- An unsigned request is accepted exactly as before unless a relay is given a signing secret **and**
  `--require-signature`. The relay suite's pre-existing tests passed unchanged when signing was
  wired in, which is the evidence for that claim rather than a new test asserting it.
- A v0.2.3 agent works against a v0.3.0 relay and vice versa. Two caveats, both documented in
  `PROTOCOL-v0.3.0.md`: a v0.2.3 relay answers an idle heartbeat with `404` (the agent must tolerate
  it, and does — as debug-only, with no retry storm), and a v0.3.0 relay reports `rtt_ms: null` for a
  machine that never reports one. `null` means "never measured"; `0` means "very fast", and the two
  are never conflated.

### Verification

539 unit tests, 537 pass, 2 skip (POSIX mode bits on NTFS); 54 end-to-end + crossnetwork.
ESLint reports **0 errors, 46 warnings**, every warning being one of the two classes
`docs/LINT-AUDIT.md` already classified as benign and deliberately accepted.

Two of the lint findings were not cosmetic, and both were restored rather than deleted:

- An agent test counted stream attempts in `requests` and never read it. The test is named
  "keeps retrying gently instead of hot-looping" — the counter *was* the assertion, so an
  implementation that backed off for the log line while opening a connection per millisecond would
  have passed. The bound is back.
- `auto-update.mjs` accepted an `intervalDays` option and never enforced it. A declared guard that
  silently does nothing is worse than no option at all, because it reads as protection. It is now
  enforced against the last *successful* install, checked before any network work.

The signing vectors from `PROTOCOL-v0.3.0.md` §9.4.1 are pinned in **both** suites and recomputed
independently in each, so a drift in either implementation turns one of them red — a shared constant
would let both agree on a wrong value.

> The `v0.3.0` tag was moved once, from the commit that first carried this version to the commit
> containing these fixes. The first tag had no published release associated with it yet, and the
> difference was in shipped source (a missing guard, three malformed error messages), so leaving the
> tag behind would have published code that does not match this changelog.

### Not verified

- **ESLint has not been run in this working tree** (no npm registry access, so `devDependencies` are
  not installed). The `lint` CI job runs it on the hosted runner. The one defect it found was fixed
  by inspection, and the `no-undef` rule is what will confirm that.
- **`scripts/install.sh` has not been executed** — there is no macOS or Linux shell on the
  development machine. It is statically reviewed only, and the script says so itself.
- **macOS remains unverified on real hardware.** CI runs the agent logic on `macos-latest`, which is
  not the same as two machines reaching one relay.
- **No real signed deployment has been exercised across a proxy.** The sub-path case is covered
  against a real relay with `--base-path`; a real nginx/Caddy stripping the prefix is not available
  here.

## [0.2.3] — 2026-10-08

### Added

- **Daily self-update.** A machine running the plugin checks its own GitHub
  releases at **00:00, 03:00 and 05:00 Beijing time** and installs a newer
  version, verifying the published SHA-256 before writing anything. Off by
  default; `autoUpdate: true` turns it on. New tool **`w2m_update`** reports the
  schedule, the installed version, the last check and whether a restart is
  pending, and can run one cycle on demand.
- **A timezone-aware daily scheduler** (`src/plugin/schedule.mjs`), used by the
  updater. The host's own `@deepseek-ai/dsh-schedule` was evaluated and rejected
  for this job: its reminders are bound to an Agent Session and delivered as
  inbox messages, and its README states it "cannot be mounted alone in a
  headless or SDK-only composition" and that the shipped Web composition carries
  no `schedule` row. A plugin-owned recurring job has no Session to bind to, so
  it owns its timer — reversibly, via `ctx.effect`.

### Why the updater is built the way it is

Each of these is a decision, not an implementation detail:

- **Never a downgrade.** `isNewer` is a strict-greater test, and a prerelease is
  refused separately: `0.2.0-rc.1` outranks `0.1.2` by SemVer, so a comparison
  alone would ship candidates to stable installs. The comparison answers "which
  is higher"; the policy layer answers "may we install it".
- **Verify, then write.** The tarball must match the `SHA256SUMS` published with
  that release. A mismatch writes zero bytes — no staging directory, no backup.
- **Back up and roll back.** `package.json` and `pnpm-lock.yaml` are restored
  byte-for-byte on failure, through the supported `dsh plugin` entry point rather
  than by editing `node_modules` by hand.
- **Say what a rollback really guarantees.** Restoring the manifest does not undo
  what pnpm already did to `node_modules`. Rather than claim "rolled back", the
  result carries `rollbackComplete` (does the installed tree match the restored
  manifest again?) plus a `reconciliation` command, and the plugin exposes it as
  `reconciliation_needed`.
- **A lookup failure is not "up to date".** They look identical in a log and only
  one of them is a problem, so a failed check is recorded as an error.
- **The updater does not restart DSH.** Installing changes what loads next start.
  Rewriting a module that a live Cordis container has already loaded is not
  something a plugin may do safely, so the status says `restart_required`
  instead of implying the new code is live.

### Fixed

- **`ctx.effect` was called through optional chaining.** `ctx.effect?.(...)` in
  `apply()` meant that on any host without it the scheduled job would be
  registered nowhere and released never — no error, no log, just a daily task
  that silently does not exist. It is now a required call that fails loudly by
  name (`W2M_NO_EFFECT`) when the feature is enabled, and is skipped entirely
  when it is not. Verified against the real runtime that Cordis 4.0.4 does
  provide it, so the strict call does not break the current host.
- **The plugin's own version is now baked in at pack time.** `PLUGIN_VERSION` is
  a placeholder in the repository and is substituted from `package.json` by
  `scripts/pack.mjs`, which fails if the placeholder goes missing. A
  hand-maintained version string would eventually disagree with the release, and
  the updater compares against exactly that string.
- **A malformed update setting fails loudly.** `autoUpdateTimes`,
  `autoUpdateTimeZone` and `updateRepo` are validated at load and name
  themselves in the error. Silently falling back to a default would move the
  check to an hour nobody chose, and nothing would say so.

### Compatibility

- `PROTOCOL_VERSION` stays **1**. This release adds no wire changes: everything
  here is local to the plugin, plus one new tool.
- The tool count goes from five to six with `w2m_update`. Nothing existing
  changed shape.

### Verification

435 unit tests, 434 pass, 1 skip (POSIX mode bits are meaningless on NTFS):

| suite | tests | covers |
|---|---|---|
| relay | 91 | unchanged from 0.1.2 |
| agent | 105 | unchanged from 0.1.2 |
| plugin | 73 | eight tools registered, operator token, sub-path, diagnostics, plus config validation and `ctx.effect` ownership |
| schedule | 39 | zone maths, exact UTC instants for each slot, DST zones, a year of consecutive arming, catch-up collapse |
| auto-update | 34 | the install/skip decision, no downgrade, prerelease refusal, unverified tarball refused, lookup failure recorded as an error, token never persisted |
| update-source | 50 | version ordering, streaming SHA-256, timeouts, rate limits, one real GitHub call |
| update-install | 28 | zero writes on hash mismatch, byte-for-byte restore, atomic staging, dry run |
| update-wiring | 15 | config validation is loud, one `ctx.effect` owns the timer, its disposer stops it |

The schedule is checked against a whole simulated year: every arming must advance,
land exactly on its configured slot, and never shift the Beijing offset — the
invariant a drifting implementation breaks slowly and invisibly.

### Not verified

- **No real install has been performed against a live DSH profile by this
  release's test suite.** The installer's integration tests use throwaway
  profiles in temp directories; `C:\Users\fangw\.dsh` was never written to.
- **The end-to-end "a new release is published and a running machine picks it up
  by itself" path has not been exercised against a real new release.** Every
  stage is covered in isolation and with injected transports; the loop closing in
  production is the first thing to watch on the next version bump.
- The updater has not been observed through a full sleep/wake cycle on real
  hardware; the catch-up rule is covered by tests against a simulated clock.
- The real-GitHub test is **opt-in** (`W2M_NETWORK_TESTS=1`) rather than part of
  the default run. It failed on CI with HTTP 403 `RATE_LIMITED` because GitHub
  allows 60 unauthenticated requests per hour *per IP* and hosted runners share
  IPs — a gate that depends on someone else's rate-limit budget eventually blocks
  a release for an unrelated reason. CI still exercises it in a separate
  non-blocking job with the workflow token; the same code paths are covered by
  mocked tests in the blocking matrix.


All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-10-07

**Cross-region, cross-network.** The relay can now live on a Tailscale network, a
public VPS behind TLS, or behind a tunnel, and the three deployment shapes are
documented end to end in [docs/DEPLOY.md](docs/DEPLOY.md).

### Breaking

- **`POST /v1/task` now requires an operator token.** Receiving work and
  authorising work are different privileges: a machine that can be told what to
  do should not automatically be able to tell the others. Device tokens keep
  working for every other endpoint.
  - The relay generates the token on first start and writes it to
    `<state>/operator-token.txt` (mode 0600), printing it once.
  - The plugin needs it as `operatorToken` (or `W2M_OPERATOR_TOKEN`).
  - To restore the old behaviour deliberately, start the relay with
    `--operator-token ''`; it will warn loudly and report
    `operator_token_required: false` on `/healthz`. Intended for a trusted LAN,
    not for anything reachable from the internet.

### Fixed

- **Sub-path deployments were completely broken.** Endpoints were built with
  `new URL('/v1/stream', rabbitUrl)`, which discards any path prefix:
  `new URL('/v1/stream', 'https://host/w2m')` resolves to
  `https://host/v1/stream`. A relay mounted at `/w2m` answered 404 to everything.
  URLs are now joined by concatenation, so `rabbitUrl` may carry a sub-path.
- **`rabbitUrl` was not validated.** A URL carrying a query string or fragment
  silently produced wrong endpoints; it now fails at startup, naming the setting.
- **Work dispatched while a machine's event stream was down was lost forever.**
  An offer is a single event. If it was published in the window after a relay
  restart but before the machines re-attached their streams, nothing ever
  re-delivered it: the lease sat at `offered` until the sweep expired it, while
  both machines reported `online=true` and idle. The relay now re-delivers every
  unclaimed (`queued`/`offered`) lease when a stream attaches — `running` is
  excluded so a task that has already begun can never be handed out twice.
- **The re-delivery path itself was broken and had never run.** It called
  `this.logger(...)` unconditionally — where `logger: null` is the documented
  "quiet" setting — after the response headers were already sent, so the
  `TypeError` was caught by the top-level handler, which then tried to answer a
  second time and produced `Cannot write headers after they are sent`. Any
  reconnect with pending work destroyed the event stream. Logging now goes
  through a call that tolerates a missing, null or throwing logger, and an error
  raised after headers are out ends the stream and records the stack instead of
  attempting a second response. The previous behaviour is also why the original
  bug hid for so long: the secondary error masked the real one.
- **A cursor from a previous relay process silently swallowed events.** Sequence
  numbers restart at 0, so an agent reconnecting with `Last-Event-ID: 42` made
  the new process believe those events had been consumed — dropping not only the
  offer but every `task.cancel` and `notice` in that range. The relay now
  recognises a cursor beyond its own last sequence, reports
  `REPLAY_TRUNCATED` (with `reason: cursor_ahead_of_relay`) and re-aligns the
  replay to the head of its window; the agent no longer sends a cursor that was
  issued by a different relay process, and re-attaches without one instead.
  > A delivery guarantee must come from re-delivery, which is cursor-independent.
  > Desynchronisation detection is a diagnostic, not a safety net: the
  > `from > lastSeq + 1` test was shown to miss a stale cursor once a few events
  > filled the gap.
- **`last_available_seq` and `oldest_available_seq` described different
  windows** — one counted the un-buffered `ready` frame — so a client computing
  its re-alignment point from them could land in the wrong place. Both now use
  the ring-buffer window.

### Added

- **Deployment base path** (`--base-path`) for reverse proxies and tunnels that
  forward the prefix through unchanged.
- **Proxy awareness** (`--trust-proxy`) for `X-Forwarded-Proto` and
  `X-Forwarded-For`. Off by default, and deliberately so: trusting those headers
  without a proxy in front lets a client forge its address and bypass rate limits.
- **TLS termination in the relay** (`--tls-cert` / `--tls-key`) as an alternative
  to terminating at a proxy.
- **Persistence.** `devices.json` (atomic snapshot) plus `ledger.jsonl`
  (append-only) mean a restarted relay keeps its paired machines and its task
  history. A corrupt line is skipped and reported rather than being fatal; a
  corrupt device file starts empty *and says so*. `--no-persist` restores the old
  in-memory behaviour.
- **Pairing rate limit**, 5 attempts per IP per minute by default, counting
  successes too — otherwise successful requests would refill the budget.
- **`/healthz` is now an operations surface**: `relay_id`, `started_at`,
  `effective_scheme`, `base_path`, `operator_token_required`, `pair_rate_limit`
  and a `persistence` block. The three questions that matter when machines are in
  different regions are "is it up", "has it restarted", and "who is connected",
  and they should be answerable without reading logs.
- **Restart is visible to clients.** `ready` carries `relay_id`; an agent that
  sees it change warns and drops its event cursor, because sequence numbers from
  a previous process are meaningless.
- **RTT visibility.** Agents measure heartbeat round-trip time and expose it
  through `w2m_status` — the first question about a distant relay is how far away
  it is.
- **Anti-buffering response headers** on the event stream
  (`X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`). A buffering
  proxy turns "connected" into "connected but silent", which is the single most
  confusing failure in tunnel deployments.
- **`REPLAY_TRUNCATED` now carries `oldest_available_seq`** so a client that fell
  outside the replay window knows where to re-align instead of only learning that
  it cannot catch up.
- Deployment assets: systemd unit, Dockerfile + compose, nginx and Caddy
  examples, and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Compatibility

- `PROTOCOL_VERSION` stays **1**: everything above is an additive change except
  the operator token, which is called out under Breaking.
- A 0.0.1 client can still pair, take work and report results against a 0.1.2
  relay. It cannot submit tasks, because it does not know about operator tokens.

### Verification

315 tests, 314 pass, 1 skip (POSIX mode bits are meaningless on NTFS):
relay 91, agent 105, plugin 73, end-to-end + crossnetwork 46. CI runs the matrix
on Windows (node 20 and 22), macOS and Linux, plus a job proving the release
artifact is reproducible from source.

The lost-offer bug above is covered by a regression test that reproduces the
exact sequence — stream attached, relay killed, task dispatched into the gap,
stream reconnecting with a stale cursor — and asserts the offer arrives. It is
deliberately not a timing-dependent test: the window it exercises is the one that
was broken.

## [0.0.1] — 2026-10-07

First release. Scope: **one DeepSeek account, one instruction, several machines running the same project.**

### Added

- **Rabbit relay** (`w2m-rabbit`) — a `node:http` server with no third-party
  dependencies. Device registry, task ledger, long-lease-with-progress-heartbeat
  scheduling, `dedupe_key` deduplication, SSE event stream with `seq` replay, and
  six-state aggregation.
- **Localside agent** (`w2m-localside`) — runs on every participating machine.
  Pairs with the relay, keeps an SSE connection open with jittered exponential
  backoff, claims leases, applies the capability gate, collects the three
  anchors, executes argv directly (never through a shell), and writes results to
  a local spool before reporting them.
- **DSH plugin** (`@twinsearth/w2m-dsh-plugin/tools`) — five model-facing tools:
  `w2m_devices`, `w2m_run`, `w2m_wait`, `w2m_report`, `w2m_status`.
- **Two coordination modes** — `replicate` (every machine runs the same command;
  results are compared side by side) and `split` (`explicit` / `modulo` sharding).
- **Rotating pairing codes** — a successful pairing consumes the code and the
  relay immediately mints and prints the next one, so several machines can join
  without restarting the relay. `pairingCodeReusable: true` keeps one code alive
  for the whole TTL for scripted onboarding.
- **Three-anchor reproducibility** — `base_commit` + `pre_tree_fingerprint`
  (algorithm `git-temp-index-tree/v1`) + `command_hash`. A mismatch is reported
  as `unverifiable`, which is accounted separately from `divergent`.
- **Capability gate** — toolchain and platform requirements are checked on the
  relay side before dispatch; an unsatisfied machine answers `refused`, which is
  not a failure.
- **Zero third-party runtime dependencies** — only `node:` built-in modules.

### Known limitations

- **Not verified on a real macOS machine.** The code is platform-neutral and
  uses `node:path` throughout, but every measurement in this release was taken
  on Windows. Treat macOS support as "expected to work, unverified".
- **No TLS.** Authentication is the pairing code plus per-device bearer tokens.
  Run the relay on a trusted network, or put a reverse proxy in front of it.
- **`write: true` does not merge.** A write-enabled task records the branch it
  used; combining branches is left to the operator.
- **No cross-machine browser dashboard.** Out of scope for 0.0.1; the design note
  for it lives in the project's design document.
- **Pairing code is single-use and shown once** at relay start. If you lose it,
  delete `state.json` in the relay's state directory and restart.

[0.0.1]: https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.0.1
[0.1.2]: https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.1.2
