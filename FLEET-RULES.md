# Fleet working rules

Standing rules for every machine and every session in this fleet. These are **rules**, not notes: a
session that finds itself working around one of these is either misreading it or should be proposing an
amendment, not quietly making an exception.

Established 2026-10-14/15. Amended by appending with a date and a reason — never by deleting, because
*"we believed X until we measured Y"* is itself knowledge, and it is what stops the same wrong conclusion
being reached twice.

---

## 1. Broadcast, sync, merge — automatically, in the same fleet

**Added 2026-10-15 at the operator's instruction.**

Any machine that is in the same fleet **broadcasts its state, syncs from the fleet, and merges without
being asked**. This is not an optimisation; it is the rule that removes the class of work that produced
2026-10-14's largest time sink — a session holding one copy of the truth on one machine while another
machine held a different copy, and a human having to notice.

### What the rule means concretely

| Verb | Obligation |
|---|---|
| **Broadcast** | Before finishing a unit of work, publish what changed to the shared record — commit to the remote, not to a local branch nobody else can see. |
| **Sync** | On starting a unit of work, fetch. A machine that has not fetched does not know what it is working on. |
| **Merge** | Reconcile rather than choose. Two machines that both changed something must end with one tree, not with one machine's version silently winning. |

### The shared record is the remote

One repository, one remote, `main` as the integration point. Local-only work is not broadcast, and a
branch that is not pushed is a branch no other machine can sync from — which is why a work-in-progress
reaches another machine as a **pushed branch**, never as a file copied by hand.

### What must never be merged

- **A tree that has not passed its own tests.** Merge is not the place to discover a failing suite. The
  rule is: run the suite where the change will land, and merge after it is green.
- **Generated or machine-local state.** `dist/`, `node_modules/`, `memory.jsonl`, state directories and
  credentials are per-machine facts; broadcasting them would spread one machine's local state over
  another's. The repository already excludes these at the release boundary, and the same list applies
  here.
- **Anything a machine could not itself verify.** An unverified claim is broadcast as *unverified*, never
  as a fact — see rule 4.

### Why the rule is safe to apply automatically

Git's fast-forward is the common case: one machine ahead, everyone else behind. A genuine divergence is
the case that needs judgement, so the automation is: **fast-forward automatically, rebase automatically
when the local work is not yet published, and stop and report when both sides have published** — because
that is the only case where merging could discard someone's verified work.

---

## 2. Do not claim a mechanism works from a scheduling record

Added 2026-10-14, after two mistakes in one session.

A dispatch being accepted, a lease being granted, and a verdict arriving are three different
observations. The reliable evidence is **a side effect on the target machine**, or **an exit code that
nothing else would produce**. "The relay said `exit_code: 0`" is not evidence that a command ran until
something else corroborates it.

## 3. Run the suite where the change will land

Added 2026-10-14. A green suite on the development host and a green suite on the target machine are
different claims, and only the second one supports a merge. `scripts/` and `test/` are absent from the
published tarball by design, so "it passes at home" cannot be checked from an installed copy.

## 4. Mark what could not be verified

Added 2026-10-14. If a check cannot run here — no network, no installation, no credential — it is reported
as `UNVERIFIED` with the reason, never as a pass. An unverifiable check is not a passing check.

## 5. Facts carry their date and how they were measured

Added 2026-10-14, from `fleet-memory.md`.

A fact without provenance is a rumour that outlives the person who could have checked it. Correct in
place with a note rather than deleting: the correction is part of the record.

## 6. Machine roles are not interchangeable

Added 2026-10-14.

| Machine | Role | Constraint |
|---|---|---|
| the Linux relay host | relay, STUN, archive, and the development shell over SSH | no personal data |
| MacMini | real-machine work: deploy, run, test, verify, report, and now development | no personal data |
| `ToFuture` (the DSH host) | orchestration | **hard-protected**: nothing outside the session workspace or non-system `C:` folders without the operator typing the password |
| other Windows hosts | as MacMini | — |

## 7. A note about the rule itself

Rule 1 says merge automatically. That is a real transfer of authority from the human to the machines, and
it is only defensible while the checks in rules 2, 3 and 4 hold: **automatic merging is safe exactly to
the extent that "green" is trustworthy.** If a suite is ever found to pass without testing what it names
— which happened twice on 2026-10-14, once in a cycle-detection test that asserted nothing — then this
rule is the thing that spreads the damage. So a test that does not test is not a small defect here; it is
a hole in the merge gate.

---

## 8. This host's reachability, measured — do not re-derive it

**Added 2026-10-15 after round 3 of the 1.0.0 goal, because the same wrong assumption cost three rounds.**

The Windows host that writes this file cannot reach `github.com:443`. Measured, not inferred: three
consecutive `git fetch` attempts each failed after ~21 s with *"Failed to connect ... Could not connect to
server"*, while the following, probed from the same process minutes apart, all succeeded:

| Endpoint | Result |
|---|---|
| `github.com:443` | **TIMEOUT** |
| `api.github.com:443` | OPEN 73 ms |
| `codeload.github.com:443` | OPEN 77 ms |
| `ssh.github.com:443` | OPEN 95 ms |
| `objects.githubusercontent.com:443` | OPEN 228 ms |

The blocking is **per hostname, not per port** — `ssh.github.com` answers on the same 443 that
`github.com` does not. It is also **intermittent at the TCP layer**: a raw `net.connect` to
`20.205.243.166:443` timed out while a `tls.connect` to the same IP with `servername: 'github.com'`
completed with `authorized: true` and TLS 1.3. An intermittent block is worse than a solid one, because a
single success is not evidence that the path works.

### What this means in practice, so the next session does not repeat it

* **`git clone` / `git fetch` / `git push` over HTTPS do not work on this host.** Do not build a plan
  around them and do not retry them hoping for a different result.
* **The working path to materialise the repository is a tarball from `codeload`**:
  `https://codeload.github.com/TwinsEarth/dsh-windows2macos/tar.gz/refs/heads/main`, unpacked with
  `tar --strip-components=1` into a directory that is then `git init`-ed. That yields a real work tree
  containing exactly `main`, which is what `fleet-sync` needs.
* **Publishing from this host goes through the REST API**, not through git. Every release so far was
  pushed that way.
* **The consequence to state plainly:** this host can *pull* the truth and can *run* the sync machinery, but
  it cannot *push* over git. A round that needs a commit published must use the API, and a round that needs
  `fleet-sync` exercised must do it against a local bare remote — which is a real test of the state
  machine, and is **not** a test of the network.

### Why this is a rule and not a note

The first two attempts at "make Windows a git participant" assumed the failure was a configuration problem
and tried proxy settings and retries. Both were wrong, and both cost a round. **The measurements above are
cheaper to read than to repeat.**
