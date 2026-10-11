# Security policy

This document covers two things: how to report a vulnerability **privately**, and the consent model —
what a machine that joins your fleet can and cannot do. The second is the claim this project asks you
to trust, so it is stated as behaviour you can check, not as a promise.

---

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** A public issue is readable by everyone the moment
it is filed, including anyone who has not updated yet, and it turns a fix into a race. This project
deliberately does **not** offer a public-issue route for security reports.

Use GitHub's private vulnerability reporting — the form creates a private advisory only the
maintainers can see:

```
https://github.com/TwinsEarth/dsh-windows2macos/security/advisories/new
```

If that page is unavailable, open a **non-sensitive** issue that says only _"I have a security report
and need a private channel"_, with no details, no reproducer and no affected version. A maintainer
will open the private thread. Do not put the substance in the issue.

### What to include

The report is only actionable if it starts from a shape we can reproduce. Please include:

1. **What you can do that you should not be able to** — one sentence, then the steps.
2. **Affected version**, exactly as installed
   (`node -p "require('./node_modules/@twinsearth/w2m-dsh-plugin/package.json').version"`), and which
   of the two halves is involved: the DSH plugin, the relay (`w2m-rabbit`), the per-machine agent
   (`w2m-localside`), or the STUN responder.
3. **The trust boundary you crossed.** This project's boundaries are: the operator token vs. the
   device token; the per-machine allow-list; and the direct UDP path vs. the relay. Saying which one
   moved is most of the analysis.
4. **A reproducer**, or the exact commands and their output. If it needs two machines, say what the
   second one was doing.
5. **Your assessment of impact**, and whether the issue is public already.

### What we will do

- Acknowledge the report in the private thread.
- Say whether we can reproduce it, and if not, say what we would need.
- Tell you when a fixed version is published, and credit you unless you ask us not to.

No bug bounty is offered. Do not test against infrastructure you do not own: the shared relay is a
real service and other people's machines are paired to it.

---

## Supported versions

**The supported line is v0.5.9, the newest published version.** A version is installable unless the
table says otherwise. Security fixes land on the newest installable version; older installable
versions are not back-patched unless a report makes that necessary, and if it does, this table will
say so.

| Version            | Installable        | Note                                                                                                                           |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **v0.5.9**         | **yes**            | The supported line, and the current release. The client half is present and activates.                                         |
| v0.5.6 – v0.5.8    | **yes**            | Installable, and each one works, but each is superseded by v0.5.9. Prefer the newest.                                          |
| v0.5.5             | **no — withdrawn** | Fails to activate during DSH's web boot, which makes the whole application refuse to start, and takes all eight tools with it. |
| v0.5.4             | **no — withdrawn** | Same loader failure. `CHANGELOG.md` marks it `DO NOT INSTALL`.                                                                 |
| v0.5.3 and earlier | **yes — outdated** | Installable, and v0.5.3 is the last host-only release. Nothing before v0.5.4 has the client half, so no composer control.      |

**v0.5.4 and v0.5.5 are withdrawn because they prevent the application from starting.** That is not a
degraded plugin or a missing feature: the loader entry fails, so the whole host entry is skipped and
DSH's web boot refuses, taking all eight tools with it. The failure and its cause are written up in
§3 of `TROUBLESHOOTING.md`.

The withdrawals are not a security judgement: those versions are not installable, so they are not
supported. `CHANGELOG.md` is the authority — an entry marked `DO NOT INSTALL` is not supported
whatever this table says, and the reverse is also true.

### Installing a supported version

```bash
# The newest installable version from the registry
dsh plugin --profile <profile> add @twinsearth/w2m-dsh-plugin@0.5.9

# Or the same bytes from the release, verified against SHA256SUMS from the same release
dsh plugin --profile <profile> add \
  https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v0.5.9/twinsearth-w2m-dsh-plugin-0.5.9.tgz
```

A version published minutes ago may be invisible to pnpm's `minimumReleaseAge` gate. That is the
gate working, not a supply-chain problem — see `TROUBLESHOOTING.md` §11.

---

## The consent model

Pairing a machine is a decision. This is exactly what it grants, and what it does not.

### Two credentials, on purpose

| Credential         | Held by                                                                           | Can                                                                     | Cannot                                                                                            |
| ------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Operator token** | the dispatcher: your DSH profile (`operatorToken` config or `W2M_OPERATOR_TOKEN`) | authorise a _dispatch_ — send work to machines                          | read another machine's results, or act as an agent. No request that dispatches is sent without it |
| **Device token**   | each machine's agent, in its own state directory (§16 of `TROUBLESHOOTING.md`)    | take work offered to **that** machine and report that machine's results | dispatch work to any machine, including itself                                                    |

The split is the point: a machine that can receive work does not thereby gain the ability to command
the others. If a machine's device token is stolen, the damage is confined to that machine's own
execution surface; it cannot be used to drive the fleet.

**It does, however, read the fleet's task metadata.** `GET /v1/tasks/{task_id}`, `POST /v1/heartbeat`
and the result/notice routes accept a **device** token, and a task's aggregate is keyed by `task_id`,
not by which machine is asking. So any paired machine's device token can read the aggregate of **any**
task on **every** machine — statuses, per-machine outcomes, anchors, comparable fields, counts. What it
cannot read that way is the captured output itself: the aggregate carries hashes and byte counts, not
`stdout`/`stderr` text. Treat the device token as a **fleet-wide metadata read credential**, not as a
credential scoped to its own machine.

The relay writes the operator token once, on first start, and prints it once on stderr. It is
deliberately absent from `--json` output — a token in a log is a leak. Treat it as a credential: it is
never needed in a bug report.

### What a paired machine can do

- **Run commands you allow, in the project directory it was pointed at.** The allow-list is
  **default-deny** and matches the whole `argv`, token by token: an entry `node --test` permits
  `node --test x.test.mjs` and refuses `node --testify x`. That permission is **as wide as the tool**:
  the test runner loads and runs the file it is handed, so `node --test` is a grant of code execution
  from any file the machine can read — a prefix entry is not a sandbox. Two narrower rules apply on
  top of the prefix match: trailing arguments that make the tool load code the entry never named
  (`--test-reporter`, `--import`, `-e`, `python -c`, …) are refused with `COMMAND_REPARSING_ARGUMENT`,
  and `argv[0]` is admitted as a path only when it is the file the entry's executable resolves to
  (`COMMAND_EXECUTABLE_PATH_MISMATCH`; relative paths are refused outright with
  `COMMAND_EXECUTABLE_RELATIVE_PATH`). Neither turns a prefix entry into a per-argument policy — if
  you need that, name the arguments in the entry. **An empty allow-list means two opposite
  things on the two sides, so set both.** The plugin's list (`allowedCommands`) is not a gate at all
  when it is empty: with nothing configured the plugin declines to refuse, deliberately, and says so —
  `checkAllowedCommand` returns "may proceed" rather than duplicating a policy it was not given. The
  agent's list (`--allowed-commands`) is default-deny with nothing configured: an empty list refuses
  **every** offer, and the refusal names the reason. So a fleet with no list on either side runs
  nothing, and a fleet with the plugin's list empty but an agent list set runs exactly what the agent
  allows — which is the only one of the two that is a control.
- **Read the project** it was started with, and compute git anchors and fingerprints over it.
- **Report results**, including command output, to the relay — where the operator who dispatched the
  work can read them.
- **Reach its peers' punch port over UDP**, if the punch succeeds.

### What a paired machine cannot do

- **Run anything outside its allow-list.** A refused command is reported as `refused` with
  `COMMAND_NOT_ALLOWED` — or, for the narrower rules above, `COMMAND_REPARSING_ARGUMENT`,
  `COMMAND_EXECUTABLE_PATH_MISMATCH` or `COMMAND_EXECUTABLE_RELATIVE_PATH` — not executed.
- **Command other machines.** That requires the operator token, which the agent is not given.
- **Read another machine's captured output.** This is the claim people most reasonably doubt, so it is
  worth being exact rather than broad — see the read-scope paragraph above, which is the other half of
  it. The operator token authorises _dispatch_, and no step of a dispatch needs a machine's `stdout`.
  The relay's stored envelope does carry `stdout_head`/`stdout_tail`, but the aggregate that
  `GET /v1/tasks/{task_id}` and the report render expose only `stdout_sha256`, `stdout_bytes` and the
  comparable fields, so a device token alone cannot fetch that text. **Fleet-wide metadata, no captured
  output** — if you need stronger than that, it is not there today.
- **Ask for your interactive confirmation per command.** There is no approval prompt in the loop. The
  allow-list is the gate, which is why it is default-deny and why you should make it as narrow as the
  work allows.
- **Write to `~/.ssh/authorized_keys` — on any machine, ever.** Neither the plugin, the relay nor the
  agent installs an SSH key, opens an SSH server, or adds a key file anywhere. The design reason is
  that cross-machine execution here does not need SSH: every machine makes only outbound connections,
  and Windows has no `sshd` by default. If you find anything in this project writing to an
  `authorized_keys` file, that is a security report — please use the private channel above.

### The guarantees nobody has tested yet

The consent model above is the claim this project asks you to trust. Four of its statements are, as of
v0.5.9, **not backed by any test** — and the difference between "enforced", "true by absence" and "true
because we looked" matters, so each is labelled here the way an audit would label it rather than the way
a policy document would.

| Statement                                                          | Why it holds today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | What it would take to be checkable                                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The relay holds no model credentials and no working copy.**      | **Enforced by the code's shape, not by a test or a guard.** The relay is a process whose entire filesystem access is its own state: `src/relay/persistence.mjs` reads and writes `devices.json`, `ledger.jsonl` and `operator-token.txt`, and `src/relay/server.mjs` reads the TLS cert and key. It never reads a project directory, so there is no code path a model credential could arrive through. It _does_ hold your task metadata, results and the operator token — that is the ledger's job, and it is stated above. | A test that the packed relay, started in a temp home with a project directory containing a `.credentials.yaml`, opens no file under that directory. `test/claims.test.mjs` is the natural home. |
| **The plugin never reads `.credentials.yaml`.**                    | **True by absence.** There is **no code path that references it anywhere in this repository** — no `readFile`, no `join`, nothing but the one comment in `src/plugin/tools.mjs` that promises not to. That is the strongest evidence available and it is **weaker than a test**: it says nobody wrote it yet, not that nothing can.                                                                                                                                                                                          | A source-level assertion over the shipped files: no `src/**` or `bin/**` file mentions a credentials path. Cheap, and it would catch the day someone adds one.                                  |
| **Nothing writes `authorized_keys`, and no SSH server is opened.** | **True by absence**, same as above, and the same caveat: no `authorized_keys`, `ssh-keygen` or equivalent string exists in any `.mjs` in this repository. The design reason is real (every machine makes only outbound connections, and Windows ships no `sshd`), but the design reason is not the check.                                                                                                                                                                                                                    | Same as above: a source-level scan asserted by a test, plus the existing `test/outbound-only.test.mjs`, which already shows the machine side opens no listening TCP port.                       |
| **There is no approval prompt in the loop.**                       | **True by design, and nameable.** The plugin contains no permission-gating code at all — the word does not appear in it outside a comment listing what the tool dispatcher does _not_ implement — so a command that reaches the agent runs, and the allow-list is the only gate. Note that this is deliberately **not** the DSH permission prompt: if the dispatching session's own policy asks you to approve a call, that prompt is the harness's and is unaffected.                                                       | Hard to assert negatively; a claims check that the plugin registers no `approval`/`permission` request surface is the nearest honest form.                                                      |

None of the four becomes a guarantee by being written down. If you need one of them to be load-bearing
for a workload, treat it as **unverified** until a test in `test/claims.test.mjs` carries it.

### What it touches on your machine

Declared here and machine-readably in `package.json`'s `disclosure`, because installing a plugin runs
its code with your permissions:

| Surface          | What it is                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem**   | reads and writes inside the project directory you name (anchors, fingerprints), plus its own state directory: the spool, `agent-state.json`, `device.json` and `device.key`                                     |
| **Network**      | the configured relay (default: the shared server), the STUN servers (one is the shared server, three are public), and UDP to peer machines                                                                      |
| **Inbound**      | peers can reach this machine's punch port. It is **ephemeral unless you pin it** with `--p2p-port`; pinning is what makes a narrow firewall rule possible, and an ephemeral port means a broader rule is needed |
| **Credentials**  | the operator token in profile config or `W2M_OPERATOR_TOKEN`; the device token and key under the state directory                                                                                                |
| **Jurisdiction** | data crosses between wherever your machines are and wherever the relay is; the reference deployment is CN ↔ JP                                                                                                  |

### What this project does not claim

- **The relay sees your task metadata and results.** It is the ledger. If that is not acceptable for
  a workload, run your own relay — `deploy/` covers shared-server, nginx, Caddy, Docker, WireGuard and
  systemd shapes — or do not use this plugin for that workload.
- **The direct path is a security boundary.** A successful UDP hole punch means a peer can send you
  packets on that socket. The data plane's encryption status is a separate, in-progress subject and is
  specified in `docs/P2P-CRYPTO.md`; `w2m_status` reports what is actually in force rather than what is
  intended.
- **`chmod 0600` means the same thing everywhere.** On NTFS it is best-effort: the file mode does not
  restrict other users of that Windows machine. The key file's protection on Windows is the account's
  own filesystem ACLs, not the mode this project sets.
- **Anything is verified by the attacker's absence.** The plugin's own test suites are the evidence we
  have, and they are listed in `README.md` with what is and is not covered. Two things in particular
  are **not** verified: a real Windows↔macOS pair over the network, and one account driving two
  machines' model sessions.
