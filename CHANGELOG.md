# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
| plugin | 73 | six tools registered, operator token, sub-path, diagnostics, plus config validation and `ctx.effect` ownership |
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
