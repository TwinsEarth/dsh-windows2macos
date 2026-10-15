# TEST-LEDGER — every test item, its result, and where the evidence is

**This file is the record the test plans ask for.** Each row is one test item with a stable id, what it
checks, the result as measured, when it was last corrected, and the **test instance** — the exact command,
exit code and artifact that produced the result. Nothing here is inferred.

## How this file is maintained

| Trigger | Scope |
|---|---|
| **every release** (`0.x.0`) | re-run the rows whose `Scope` is `release`, then update `Result` / `Date` / `Instance` for any that changed |
| **every major version** (`x.0.0`) | **re-run every row**, including the ones marked `major`, and re-date all of them |

**A row's `Result` may only be changed by re-running its `Instance` and reading the new output.** A result that
was not re-measured keeps its old date — **a stale date is information, and quietly refreshing it destroys it.**

### The five columns, and what each refuses to be

| Column | Meaning | What it must not become |
|---|---|---|
| **ID** | stable serial, never reused | renumbered when a test moves |
| **Content** | what is checked, in one line | a restatement of the implementation |
| **Result** | the measured outcome | a prediction, or a copied-forward value |
| **Date** | when the result was last produced | today's date because the file was edited |
| **Instance** | the exact command / exit code / artifact | "the suite" without naming it |

### Result vocabulary

| Mark | Means |
|---|---|
| **PASS** | measured, and the expectation held |
| **FAIL** | measured, and the expectation did not hold |
| **REFUTED** | a claim in a test plan was measured and is **not true of the code** |
| **UNVERIFIED** | not measured, and the reason is named |

---

## Phase 1 — baseline (single machine)

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `BASE-001` | declared suite: every suite on disk runs and passes | **PASS** — 2228 tests, 82 suites, 2214 pass, 0 fail, 14 skip | 2026-10-15 | `node scripts/preflight.mjs` → `PASS declared suite (package.json#scripts.test, skips itemized)` at v0.45.0 |
| `BASE-002` | the project's **own** entry point is used, not a hand-rolled one | **PASS** | 2026-10-15 | same as `BASE-001`; a single-process run gave 41 failures vs 1 — see `HARNESS-001` |
| `BASE-003` | lint: 0 errors | **PASS** — 0 errors, 129 warnings | 2026-10-15 | `eslint .` via `scripts/preflight.mjs` |
| `BASE-004` | layer-check: every cross-layer edge declared | **PASS** | 2026-10-15 | `node scripts/layer-check.mjs` → prints `clean:` **and exits 0** (see `GATE-003`) |
| `BASE-005` | pre-flight: all declared checks registered and reported | **PASS** — 12 pass, 0 fail, 1 unverifiable | 2026-10-15 | `scripts/preflight.mjs` → `pre-flight: 12 pass, 0 fail, 1 unverifiable` |
| `BASE-006` | packed tarball ships the tree, and the pinned entries | **PASS** — 131 files, 11 tools | 2026-10-15 | `PASS packed tarball (tree-derived documents + entry points, whole manifest, forbidden paths, 11 tools from the pack)` |
| `BASE-007` | claims suite: documents do not contradict the artifact | **PASS** — 48 claims, 47 pass, 1 skip | 2026-10-15 | `PASS claims (test/claims.test.mjs, reused not reimplemented)` |
| `BASE-008` | cross-layer dependency direction | **PASS** | 2026-10-15 | `layer-check: clean: every cross-layer edge is declared` |

## Phase 4 — security (executable on one machine)

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `SEC-CMD-001` | an entry matches its own prefix | **PASS** | 2026-10-15 | `test/plan-sec-cmd.test.mjs` → `node --test` allowed |
| `SEC-CMD-002` | a flag named by **its own entry** is allowed, while the bare entry still refuses it | **PASS** | 2026-10-15 | same suite, 3 assertions: bare entry refuses; second entry naming `--test-reporter=tap` allows it; `--test-reporter=file:///tmp/evil.mjs` **still refused** |
| `SEC-CMD-003` | `node --test-reporter=tap` with no `--test` | **PASS** — refused | 2026-10-15 | same suite |
| `SEC-CMD-004` | code-loading flags: `-e`, `--eval`, `-p`, `-pe`, `--import`, `--require`, `--experimental-loader` | **PASS** — all refused as `COMMAND_REPARSING_ARGUMENT` | 2026-10-15 | same suite, 7 argv forms |
| `SEC-CMD-005` | `python -c` against a bare `python` entry | **PASS** — refused | 2026-10-15 | same suite |
| `SEC-CMD-006` | a **relative `argv[0]`** is refused | **PASS** | 2026-10-15 | same suite. **This had ZERO coverage before**: `grep COMMAND_EXECUTABLE_RELATIVE_PATH test/` returned 0 hits across 81 suites |
| `SEC-CMD-007` | a different file with the same basename is refused | **PASS** | 2026-10-15 | `E:\Temp\evil\node.exe` refused; 1 existing suite already covered the code |
| `SEC-CMD-008` | a bare `node.exe` **is** allowed — on Windows that is `node` | **PASS** | 2026-10-15 | same suite. My first version asserted the opposite and the code was right |
| `SEC-CMD-009` | the executable-path check fires on a real dispatch | **PASS** | 2026-10-15 | live dispatch to `jp-shared` of `/bin/sh` → `refusal_reason: COMMAND_EXECUTABLE_PATH_MISMATCH` |
| `SEC-CMD-010` | the reparse refusal fires on a real dispatch | **PASS** | 2026-10-15 | live dispatch of `node --test --test-reporter=spec test/` → `COMMAND_REPARSING_ARGUMENT` |
| `SEC-CMD-011` | a real dispatch cannot smuggle `--eval` behind `--test` | **PASS** | 2026-10-15 | live dispatch to `jp-shared` of `node --test --eval …` → `COMMAND_REPARSING_ARGUMENT` — the plugin answered *re-parseable*, not *unknown flag* |
| `SEC-CMD-012` | a machine whose allow-list omits `node -e` refuses it | **PASS** | 2026-10-15 | live dispatch to `jp-shared` → `COMMAND_NOT_ALLOWED` |
| `SEC-SIG-001` | sign / verify round trip | **PASS** — covered | 2026-10-15 | 30 hits / 3 suites (`signing.test.mjs`, `signing-e2e.test.mjs`, `chatops-device-signing.test.mjs`) |
| `SEC-SIG-002` | tampered payload fails verification | **PASS** — covered | 2026-10-15 | 45 hits / 14 suites |
| `SEC-SIG-003` | wrong public key fails | **PASS** — covered | 2026-10-15 | 3 hits / 2 suites |
| `SEC-SIG-004` | key rotation: retired signer rejected | **PASS** — covered | 2026-10-15 | 43 hits / 12 suites |
| `SEC-SIG-005` | an unpaired device's signature | **PASS** — covered | 2026-10-15 | 8 hits / 3 suites |
| `SEC-PERM-001` | `device.json` mode `0600` | **PASS on POSIX, SKIP on NTFS** | 2026-10-15 | 13 assertions; the suite self-skips as `ntfs-has-no-posix-bits` on Windows — **so this machine cannot verify it** |
| `SEC-PERM-002` | `--trust-proxy` is off by default | **PASS** — documented as *"Enable ONLY behind a proxy you control: otherwise a client can forge its address and bypass the pairing rate limit"* | 2026-10-15 | `bin/w2m-rabbit.mjs` option text; 22 hits / 2 suites |

## Phase 2 — field propagation (relay → offer → agent)

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `PROP-001` | `createTask` keeps `cwd_outside_project` on the task | **PASS** | 2026-10-15 | `test/cwd-outside-project.test.mjs` |
| `PROP-002` | it defaults to `false`, not `undefined` | **PASS** | 2026-10-15 | same suite |
| `PROP-003` | it is `=== true`, not truthy — the value arrives over the wire | **PASS** — `'true'`, `1`, `{}`, `[]` all read as false | 2026-10-15 | same suite |
| `PROP-004` | the `task.created` **ledger row** carries it, so a restart cannot forget a granted permission | **PASS** | 2026-10-15 | same suite, via the real `persistence.append` seam |
| `PROP-005` | the plugin puts it on the wire, and omits it when false | **PASS** | 2026-10-15 | `src/plugin/tools.mjs` payload builder; asserted in `tools.test.mjs` |
| `PROP-006` | containment: an escape is refused unless asked for | **PASS** | 2026-10-15 | `test/cwd-containment.test.mjs` — `..`, absolute paths, and a sibling sharing a path prefix |
| `PROP-007` | the escape works when asked, and **reports** `outside_project` | **PASS** | 2026-10-15 | same suite |
| `PROP-008` | the escape is off for every value that is not exactly `true` | **PASS** | 2026-10-15 | same suite — `undefined`, `null`, `false`, `0`, `''`, `'true'`, `1`, `{}` |
| `PROP-009` | **end-to-end across two machines** | **FAIL — then UNVERIFIED** | 2026-10-15 | live dispatch → `refusal_reason: CWD_OUTSIDE_PROJECT`. Cause measured: **both the relay and MacMini's agent were running pre-change code in memory**. Not re-run since |

## Phase 5 — real-machine (MacMini, macOS 27.0 arm64)

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `REAL-001` | the packed plugin **loads** on macOS and registers every tool | **PASS** — 11 tools, `w2m_council` and `w2m_approvals` present | 2026-10-15 | live dispatch, `exit_code: 0`, after upgrading MacMini to 0.42.0 |
| `REAL-002` | a **seven-phase council** runs on macOS | **PASS** | 2026-10-15 | live dispatch, `exit_code: 0`: phases 7, dissent retained, `recount` reproduced |
| `REAL-003` | **field-level acceptance** holds on macOS | **PASS** | 2026-10-15 | live dispatch, `exit_code: 0`: level 0 cannot reach `evidence`, level 70 can, tampering caught, a missing ancestor refused **not re-rooted** |
| `REAL-004` | a restarted DSH **rejoins the fleet by itself** | **PASS** | 2026-10-15 | MacMini left the fleet and returned after `pkill`+`open`, twice. **This is what proved `autoStartAgent` is load-bearing** |
| `REAL-005` | `node_modules` is present on MacMini | **PASS** | 2026-10-15 | encoded probe: bit 4 set |
| `REAL-006` | the repo checkout on MacMini is complete and at the target version | **PASS** — `package.json`, `test/`, `node_modules/`, `scripts/preflight.mjs`, `.gitattributes` | 2026-10-15 | encoded probe `exit_code: 219` = `0b11011011` |

## Phase 3 — network and P2P

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `P2P-001` | punching succeeds between two machines on a punchable network | **UNVERIFIED** — no second online machine | 2026-10-15 | needs both `win-desktop` machines, silent since 2026-10-14 |
| `P2P-002` | `auto` falls back to the relay, with the reason visible | **PASS (fallback only)** — the relay carried every task, `reason: P2P_NO_CANDIDATES` | 2026-10-15 | every live dispatch; `transport: relay` |
| `P2P-003` | `P2P_PUNCH_FAILED: Digest method not supported` | **UNVERIFIED** | 2026-10-15 | reproduced on **every** dispatch to MacMini **while MacMini ran 0.44.0** — so it is **not** version skew. Three hypotheses excluded (BLAKE2s-256, the wider primitive set, skew) |
| `P2P-004` | a direct channel opened at all | **PASS, once** — `transport: p2p`, `rtt_ms: 3.67`, `opened_by: simultaneous-punch`, peer `192.168.56.1:58889` | 2026-10-15 | one dispatch to `ToFuture` in the `direct_pushes` report |
| `RELAY-001` | ledger persistence across a relay restart | **UNVERIFIED** | — | needs the relay upgraded and restarted; **blocked: `jp-shared` refuses `node -e`** |
| `RELAY-002` | a corrupted ledger line is skipped and reported | **UNVERIFIED** | — | same blockage |
| `RELAY-003` | a corrupted `devices.json` starts empty and says so | **UNVERIFIED** | — | same blockage |
| `RELAY-004` | `--no-persist` keeps nothing across a restart | **UNVERIFIED** | — | same blockage |

## Gate and harness items

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `GATE-001` | a module nothing reaches fails the pre-flight unless accepted with a reason | **PASS** | 2026-10-15 | `PASS reachable or accepted (no orphan module without a written reason): 7 orphan module(s), every one accepted` |
| `GATE-002` | an accepted orphan that is no longer an orphan fails — the list cannot go stale | **PASS** | 2026-10-15 | `field-authority` was removed when 0.41.0 gave it a caller, **because this check went red** |
| `GATE-003` | `layer-check` prints `clean` **and exits 0** | **PASS** | 2026-10-15 | after the fix. **Before it printed `clean:` and exited `1`** — every reader trusting the status read a passing check as a failure; the pre-flight never noticed because its step reads the *printed text* |
| `HARNESS-001` | a hand-rolled test harness measures the harness | **PASS (as a warning)** | 2026-10-15 | **41 failures** running every suite in one process with `--experimental-test-isolation=none`, vs **1** via the project's own entry. The other 38 were `mdns-discover`'s fetch stub leaking into `outbound-only` |
| `HARNESS-002` | **a count typed by hand drifts from the table it describes** | **FAIL, then corrected** | 2026-10-15 | CHANGELOG 0.46.0 claimed *"54 rows / 32 executed / 22 not"*. Read from `TEST-MATRIX.md`: **61 rows / 53 executed / 8 never run / 11 blocked / 1 skipped / 2 refuted.** I had merged **`阻塞`** (the command ran and the environment stopped it) with **`待执行`** (never run) — so 61 became 54 and 8 became 22 |

## WeChat bridge (real service, one live bot)

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `BOT-001` | bind a WeChat bot by scanning a QR | **PASS** | 2026-10-15 | `get_bot_qrcode` → scan → `get_qrcode_status` = **`{"status":"confirmed","ilink_bot_id":"09bbed4c7570@im.bot"}`** |
| `BOT-002` | the bridge reads the live channel | **PASS** | 2026-10-15 | one second after start it logged a real inbound message. **The QR minting script had already exited on `qr_expired` before the code was scanned**, so nothing was polling to catch the token — it had to be written by hand |
| `BOT-003` | **WeChat → dispatch → verdict → WeChat**, end to end | **PASS** | 2026-10-15 | `/run node --version` → task `01M5028GSHPH5JGHYCKJXQ80SW`, `status: partial`, `step 2 ok: [macmini]`. **The first WeChat-triggered fleet task in this project's history** |
| `BOT-004` | a window without the capability is refused, by name | **PASS** | 2026-10-15 | default `W2M_CAPABILITIES=operate` → *"这个窗口没有 fleet.dispatch 权限，不能执行。"* |
| `BOT-005` | the dispatch permission can be granted, and the warning that guards it | **PASS** | 2026-10-15 | with `operate,fleet.dispatch` **and** `W2M_DEVICE_FILE`, the script's *"dispatch succeeds and the verdict is unreadable"* warning is gone |
| `BOT-006` | natural language is never dispatched, and never guessed at | **PASS** | 2026-10-15 | `--ask` is the explicit marker (`run-command.mjs:136`). **Measured: a plain sentence dispatched as argv and refused `COMMAND_NOT_ALLOWED` on all three online machines** |
| `BOT-007` | a swallowed space produces a correct refusal, not silence | **PASS** | 2026-10-15 | WeChat delivered `node--version` as one token (the parser was verified correct on all three spacings); three machines answered `COMMAND_NOT_ALLOWED` |
| `BOT-008` | **every message gets an answer** | **FAIL, then fixed in 0.49.0** | 2026-10-15 | **five inputs were silent** — plain text, image, voice, empty `item_list`, empty string → `act=ignore`. All five now `act=reply` |
| `BOT-009` | the one silence that survives, and why | **PASS** | 2026-10-15 | `no sender` / `no context_token` still `ignore` — **there is nowhere to send an answer, so `reply` would make the plan lie.** This is why the vocabulary still contains `ignore` |
| `BOT-010` | the help must not advertise a capability the bridge lacks | **PASS** | 2026-10-15 | `textOf` reads only `type: 1`; measured that an image and a voice note both answer `not a text message`. The help says 语音、图片、文件、表情 are unsupported |
| `BOT-011` | every `/run` example in the help is accepted by the real parser | **PASS** | 2026-10-15 | one test feeds **every `/run` line in the help** through `parseInvocation` — the help cannot drift into advertising refused syntax |

## Defects found and fixed in this span

| ID | Content | Result | Date | Instance |
|---|---|---|---|---|
| `DEF-001` | **`--dry-run` must not dispatch** | **FAIL, then fixed in 0.48.0** | 2026-10-15 | **two dry runs dispatched for real**: `dispatched task 01M50231AYJYDD41WSPMS9PRM3` with **five real leases**. The reply was guarded (`scripts/…:174`); `fleet.run` (`193-199`) was not |
| `DEF-002` | the fix aligns with what this repository already means by `dryRun` | **PASS** | 2026-10-15 | `update-install.test.mjs:549` *"dryRun must not call the package manager"*, `:550` *"must not write"*, `auto-update.test.mjs:325` *"writes nothing to the profile"* — **two flags, one name, and the bridge held the unsafe one** |
| `DEF-003` | the guard precedes the only call that reaches the fleet | **PASS** | 2026-10-15 | a test **reads the script** and asserts `if (!dry.dispatch)` appears before `await fleet.run(` — **a test of the pure function alone would pass while the script still dispatched, which is exactly the original defect's shape** |
| `DEF-004` | **`--ask` must be discoverable** | **FAIL, then fixed in 0.49.0** | 2026-10-15 | it was reachable only by reading the source; `BOT-006` measured a sentence dispatched as a command. It is now in help section 【1】, with a test asserting it cannot leave |
| `DEF-005` | a verdict needs a running bridge | **NOT A DEFECT** | 2026-10-15 | a `/run` got no reply because **the bridge had been stopped**. No process, no answerer |
| `DEF-006` | the release flow must not delete a credential | **FAIL, UNFIXED** | 2026-10-15 | **every release runs `Remove-Item dist`, which deletes `dist/ilink/ilink-login.json`** — the WeChat token. Symptom is *"no login at …"*, **which says nothing about a deletion** |
| `DEF-007` | a credential must not be printed into a transcript | **FAIL** | 2026-10-15 | **I caused this**: to confirm the binding I queried `get_qrcode_status`, and that endpoint returns `bot_token` in plaintext. The token is in the conversation. It is `.gitignore`d (`dist/`), but it is disclosed, and the choice to look was mine |

---

## Plan claims that measurement refuted

| ID | Claim | Source | Result | Date |
|---|---|---|---|---|
| `REF-001` | `observing_only` is an aggregate verdict | plan §4.2.2 / §9.1 | **REFUTED** — 0 occurrences. It is a **lease state**, not a verdict | 2026-10-15 |
| `REF-002` | `environmental` is an aggregate verdict | plan §4.2.2 | **REFUTED** — 0 occurrences. The real name is **`divergent-platform`** | 2026-10-15 |
| `REF-003` | the project defines **nine** aggregate states | plan §9.1 | **REFUTED** — **6** verdicts declared: `consistent`, `divergent`, `divergent-platform`, `partial`, `failed`, `unverifiable`. `pending`/`refused`/`observing` are non-verdict values | 2026-10-15 |
| `REF-004` | the four accepted orphans are all `library` | plan §9.2 | **REFUTED** — 4 `library` **and 3 `interface-unrouted`** (`health`, `log-bounds`, `storage`), which is the defect class | 2026-10-15 |
| `REF-005` | the `/Library/Logs` health fix shipped in v0.44.0 | plan §1 | **REFUTED** — it is **v0.10.3** | 2026-10-15 |
| `REF-006` | v0.44.0's core changes were approval index / fleet sync / health / storage | plan §1 | **REFUTED** — those shipped across **v0.10.0–v0.10.4**. v0.44.0 is the field-propagation tests | 2026-10-15 |
| `REF-007` | `autoStartAgent: true` is forbidden and unverified | plan §3.3 | **REFUTED — and acting on it causes harm.** It restarted MacMini twice; **unset, a restarted machine does not rejoin the fleet at all**, so following the warning would lose that machine until someone reached it physically | 2026-10-15 |
| `REF-008` | perf baseline: dispatch latency < 200 ms | plan §8 | **REFUTED** — no such assertion exists in the project; the number has no baseline and no measurement method | 2026-10-15 |
| `REF-009` | `w2m-rabbit` has no `--tls-cert` / `--tls-key` | *my own suspicion* | **REFUTED — the plan was right and I was wrong.** Both flags exist | 2026-10-15 |
| `REF-010` | 79 suites / 2199 tests | both plans | **REFUTED** — **82 suites / 2228 tests** as of v0.45.0 | 2026-10-15 |

---

## Baseline counters, by version

**These are the numbers a test plan should quote.** Reading them from here rather than copying them forward is
what stops `2199` from being repeated after it stopped being true.

| Version | Suites | Tests | Pass | Fail | Pre-flight | Orphans | Note |
|---|---|---|---|---|---|---|---|
| `0.45.0` | 82 | 2228 | 2214 | 0 | 12 pass / 0 fail | 7 (4 library, 3 defect) | current |

## Version of the plugin installed on each machine

| Machine | Disk | In memory | Note |
|---|---|---|---|
| `ToFuture` (this host) | **0.43.0** | 0.43.0 | two versions behind the tree |
| `macmini` | **0.44.0** | 0.44.0 | restarted 2026-10-15; 0.45.0 not installed |
| `jp-shared` (relay + STUN) | **unknown** | pre-0.43.0 | `/opt/w2m/app`; **cannot be read or restarted remotely** — its allow-list refuses `node -e` and `node --test <script>` does not execute a plain file |
| `win-desktop` ×2 | unknown | — | offline since 2026-10-14 |

**The relay row is why `RELAY-*` and `PROP-009` are unverified.** Upgrading it is one documented command on
that host — `bash install.sh /tmp/w2m-pkg-0.45.0.tgz`, which re-deploys *and* restarts and preserves
`/var/lib/w2m/rabbit`. **It is not something this side can do without widening an allow-list, which this
project does not do to make its own work easier.**
