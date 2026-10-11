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

**The supported line is v0.5.3 and everything before it.** A version is installable unless the table
says otherwise. Security fixes land on the newest installable version; older installable versions are
not back-patched unless a report makes that necessary, and if it does, this table will say so.

| Version                | Installable        | Note                                                                                                                           |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **v0.5.6 and later**   | not yet released   | In progress as this document is written. Check `CHANGELOG.md` for the newest entry that is not marked withdrawn.               |
| v0.5.5                 | **no — withdrawn** | Fails to activate during DSH's web boot, which makes the whole application refuse to start, and takes all eight tools with it. |
| v0.5.4                 | **no — withdrawn** | Same loader failure. `CHANGELOG.md` marks it `DO NOT INSTALL`.                                                                 |
| **v0.5.3 and earlier** | **yes**            | The supported line. The client half was added in v0.5.4; v0.5.3 is a host-only plugin that loads.                              |

The withdrawals are not a security judgement: those versions are not installable, so they are not
supported. `CHANGELOG.md` is the authority — an entry marked `DO NOT INSTALL` is not supported
whatever this table says, and the reverse is also true.

### Installing a supported version

```bash
# The newest installable version from the registry
dsh plugin --profile <profile> add @twinsearth/w2m-dsh-plugin@0.5.3

# Or the same bytes from the release, verified against SHA256SUMS from the same release
dsh plugin --profile <profile> add \
  https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v0.5.3/twinsearth-w2m-dsh-plugin-0.5.3.tgz
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

The relay writes the operator token once, on first start, and prints it once on stderr. It is
deliberately absent from `--json` output — a token in a log is a leak. Treat it as a credential: it is
never needed in a bug report.

### What a paired machine can do

- **Run commands you allow, in the project directory it was pointed at.** The allow-list is
  **default-deny** and matches the whole `argv`, token by token: an entry `node --test` permits
  `node --test x.test.mjs` and refuses `node --testify x`. An empty list is not "nothing runs" — it
  means the plugin-side gate is not applied, so rely on the agent-side `--allowed-commands`.
- **Read the project** it was started with, and compute git anchors and fingerprints over it.
- **Report results**, including command output, to the relay — where the operator who dispatched the
  work can read them.
- **Reach its peers' punch port over UDP**, if the punch succeeds.

### What a paired machine cannot do

- **Run anything outside its allow-list.** A refused command is reported as `refused` with
  `COMMAND_NOT_ALLOWED`, not executed.
- **Command other machines.** That requires the operator token, which the agent is not given.
- **Read another machine's results.** This is the claim people most reasonably doubt, and it is worth
  being precise: the operator token authorises _dispatch_. A machine's results are visible to whoever
  holds the operator token for that relay — the ledger is the relay's, not the agent's — so an agent
  holding only its device token cannot enumerate or fetch another machine's output.
- **Ask for your interactive confirmation per command.** There is no approval prompt in the loop. The
  allow-list is the gate, which is why it is default-deny and why you should make it as narrow as the
  work allows.
- **Write to `~/.ssh/authorized_keys` — on any machine, ever.** Neither the plugin, the relay nor the
  agent installs an SSH key, opens an SSH server, or adds a key file anywhere. The design reason is
  that cross-machine execution here does not need SSH: every machine makes only outbound connections,
  and Windows has no `sshd` by default. If you find anything in this project writing to an
  `authorized_keys` file, that is a security report — please use the private channel above.

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
