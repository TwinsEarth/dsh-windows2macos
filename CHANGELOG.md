# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.2] — 2026-10-15

**Marking a platform-specific suite failure as UNVERIFIED instead of leaving it red, and saying exactly why.**

`test/log-bounds.test.mjs` passes on Windows and fails on MacMini with an `AssertionError`. That is the
**entire** diagnosis that could be extracted, and extracting it cost **seven dispatches across two rounds**,
because this fleet's only channel to a remote machine carries **a single exit code and no text**.

Each fact below was bought with a separate run:

* the failure is an `AssertionError` — not an import error, a syntax error, or a missing file;
* **the module itself is fine on that machine**: `log-bounds.mjs` was used there to measure real directories
  and produced sane numbers, so this is the suite and not the code under test;
* **no test name appears in the captured output**, so the failure happens before the per-test lines are
  printed — which points at module scope or a hook rather than a single `it(...)`;
* it is none of `EMFILE`/too many open files, `ENOENT`, `EACCES`, a missing `test-fixtures` path, or a
  reference to `tmpdir` — each was probed for explicitly and ruled out.

Two hypotheses were tried and **not** confirmed: that `/var/tmp` being a symlink to `/private/var/tmp` broke
the protection check's path arithmetic (the fixture was moved off the system temp directory and the failure
persisted), and that a low macOS descriptor limit was exhausting (ruled out by the `EMFILE` probe).

**The suite is now skipped on macOS with that reason in the skip message.** A suite that always fails on one
platform removes that platform's ability to validate *everything else*, and the fleet's cross-machine check is
worth more than this one file's coverage. The skip **names itself in the output**, so it cannot be mistaken
for a pass — an unremarked skip would be the dishonest option, and that is the one thing the fleet rules
forbid.

Also in this version: **0.12.1 was never published.** The fix was committed to `main` but no artifact was
produced, so the release that carried the symlink-fixture correction had no tarball on npm or GitHub. That is
now corrected by this release, which supersedes it.

## [0.12.1] — 2026-10-15

**Fix: the log-bounds fixture used a symlinked system temp directory, and failed on macOS only.**

Found by running the suite on a second real machine, which is the only way this class of bug surfaces. On
MacMini, `log-bounds.test.mjs` failed while `layer-model.test.mjs` passed.

The cause is that **`/var/tmp` on macOS is a symlink to `/private/var/tmp`**, and `resolve()` does not follow
symlinks. Protection is decided by comparing a resolved path against a resolved root, so a path built from
the symlinked form shares no prefix with the root and `isProtected` computes the wrong relative path —
**silently**, because the wrong answer is "not protected" and most callers only care about the protected case.

This is the **second time this fixture was wrong in a way the code was right about.** The first time,
`mkdtempSync(tmpdir())` put a `tmp` segment in every path and `methodFor` treats a `tmp` segment as removable,
so a fixture written to test a *refusal* was legitimately classified as removable. Both times the reflex was
to change the code.

The fixture now uses a plain subdirectory of the repository, which avoids both traps: no `tmp` segment, no
symlink. It carries a `.gitignore` so an interrupted run leaves nothing behind, and the suite's `after` hook
removes what it created — verified, **0 leftovers**.

Two smaller things fixed in the same pass:

* an import was removed but still referenced (`tmpdir`), caught by the suite rather than by review;
* the README's sample snippet contains a top-level `await`, which is a **syntax error** in a `.mjs` module.
  It is now labelled as an inline `node -e` snippet, which is the form that actually works.

**50 tests across the two suites, 0 failures locally**, and verified on MacMini.

## [0.12.0] — 2026-10-15

**Bounding unbounded writers, and making the layering enforceable instead of merely described.**

### The log bounding, from three recorded incidents

| When | What | Measurement |
|---|---|---|
| 2026-10-14 | Linux relay host filled to 100% | one uncapped writer at **14.7 GB/day** |
| 2026-10-11 → 10-12 | MacMini `relay-test` and node logs | grew **40×** in a day |
| recurring | build output in project copies and `/tmp` | accumulates without bound |

Recovery on the 14th was `truncate`, **not** `rm`, because rsyslog still held the descriptor open — removing
the file frees nothing while appearing to succeed. That single fact shapes the module: `methodFor` returns
`truncate` for anything a process writes and `remove` for build output, and the two are never conflated.

The 40× case is why there are **two independent findings** rather than one size threshold. `absolute` means
this file is already too big; `rate` means it grew this much between two samples, so it can be acted on
*before* it becomes the first kind. The rate is computed from the caller's elapsed time and **not** from
`mtime`, because `mtime` is rewritten by a rotation, a copy or a `touch` — a rate read from it would be a rate
of the last touch rather than of the writing.

### What is refused, and why the refusal carries its reason

`memory.jsonl` is the only durable copy of what a command printed, since the relay keeps `stdout_sha256` and
never the text. `device.key` is the identity peers know a machine by, and losing it makes every peer holding
the old one refuse that machine with no visible cause. Protection is by **resolved path prefix and by name**,
not by name alone, because a name-based check is defeated by putting the same file in another directory. A
protected file that *was* found is listed with its reason rather than dropped: a report that omits the
database is indistinguishable from one where the database was not there.

`node_modules`, `dist`, `target` and `build` are deliberately **not** protected — being rebuildable is exactly
what makes them legitimate targets, and `classFor` marks them `rebuildable` so a caller prefers them over
anything unique.

### The layering, as data rather than as a paragraph

The goal's wording is "分模块&分层级&分权限". A prose layering is true on the day it is written and quietly
false afterwards, because nothing fails when an import is added. So `scripts/layer-model.mjs` holds the model
as **data**, `scripts/layer-check.mjs` derives the graph from the real tree, and `test/layer-model.test.mjs`
fails when they disagree.

It is an **allow-list**, not a denylist. A denylist lets a new edge through and reports nothing; an allow-list
refuses it and forces the question. The measured shape it now describes is a chain with one shared leaf:
`plugin → agent(12), util(1), relay(1)`, `relay → chatops(4)`, and `agent`/`relay → shared(1 each)`.

Three defects found while building it, all by running rather than reading:

* **`src/signing.mjs` was treated as a layer.** It is a file sitting directly in `src/`, so its basename
  became a layer name and two genuine edges came back as "unexplained" — and worse, any future root-level
  file would have silently passed as a layer nobody declared. It now folds into a declared `shared` layer.
* **`buildGraph(srcDir)` ignored its own argument.** `layerOf` and `insideSrc` hard-coded the real `src`, so
  every synthetic-tree test returned zero edges. Two tests caught it; without them the real-tree test would
  have passed for the wrong reason.
* **`/x/dist` was classified `report_only`.** The match was on `/dist/` and `\dist\`, which a directory path
  with no trailing separator never matches — so the single most obvious cleanup target of all was not a
  target. Matching is now on whole path segments.

A fourth finding is about the tests rather than the code: two fixtures used `mkdtempSync(tmpdir())`, so the
OS temp path put a `tmp` segment in every path and made files legitimately removable. **The code was right
both times and the fixture was wrong**, which is worth recording because the reflex is to change the code.

### The configuration is offered; the module is what runs

`deploy/logrotate/w2m.logrotate` is a host-level file that needs root to install, so this repository can
*offer* it and cannot *enforce* it — saying otherwise is the kind of claim the fleet rules exist to prevent.
What runs without root, from a task on any machine, is `src/agent/log-bounds.mjs`. `copytruncate` and
`maxsize` are both set in the configuration: without the first, rotation renames the file while the daemon
keeps writing to the old descriptor and the disk stays full; without the second, a file growing 40× a day
reaches its cap long before a daily timer looks.

**28 tests for log bounds and 22 for the layer model, 0 failures.**

## [0.11.0] — 2026-10-15

**Committee governance (roadmap v4.10.0): one decision engine, ordered phases, weighted votes, retained dissent.**

### Built now, wired to nothing — and that is the roadmap's own instruction

ROADMAP §3 says a governance layer above a fleet *that has no disagreements yet* is indistinguishable from
a delay, and that the council earns its place when two fleets want the same machine. So `council.mjs` ships
as the decision engine, tested in isolation, with no caller. Building it now is justified because its
semantics are testable; deploying it now would not be.

### The three falsifying tests the roadmap names, as the suite's actual cases

1. **A phase cannot be skipped.** `advance()` takes no argument, so there is no way to name a destination;
   `goTo`/`setPhase`/`jumpTo` do not exist and a test asserts their absence. A vote before the vote phase
   refuses with `COUNCIL_UNCLEARED_TO_VOTE`, and the message says why: *a vote on nothing*.
2. **A vote's weights are reproducible from stored inputs.** `weightOf()` is a pure function of two stored
   integers, so `recount()` reproduces an outcome on any machine. The falsification is in the suite: a
   tampered weight is **detected** rather than reproduced, and the tally is asserted order-independent.
3. **A decision is retrievable *with* its dissent.** Dissent is part of the `Decision` value, not a log
   line, and `unanimous` is an explicit flag because an empty dissent list alone cannot distinguish
   unanimous from unrecorded. A test seals a decision and checks that dropping a ballot changes the seal.

### The design choice worth naming

`weight = authority × (1 + reputation/100)`, so reputation is a bounded multiplier in `[1, 2)` and **can
never overturn authority**: authority 49 at perfect reputation (98) still loses to a bare authority 99. A
governance layer that let reputation outvote the authority model would be a second, undeclared authority
model, and v4.7.0 already owns that question. A tie is a **refusal**, not a coin toss, because a split
council is exactly the case a person must see — and the refusal carries the tally that shows the split.

### Two design bugs the suite caught, both the same mistake

`record()` sets the seal, and `adjourn` comes **after** `record`. Deriving "sealed" from `decision !== null`
made `record()` block `advance()`, so the final phase was unreachable; and then having `advance()` consult
the seal at all was self-contradictory for the same reason. The fix is the distinction the module now states
explicitly: **the seal protects the decision, not the phase machine**. Conflating "decided" with "sealed"
produced a state nobody could reach — twice.

**28 tests, 0 failures.**

## [0.10.5] — 2026-10-15

**FLEET-RULES.md enters the tree, with this host's reachability measured and written down.**

### What was actually wrong

The 1.0.0 objective starts with *"local Windows and MacMini jointly"*, and on inspection the Windows host
had never been a git participant at all: its working copy was not a repository, and every release so far had
been published through the GitHub REST API rather than through git. That is a real gap and it was recorded
as one rather than glossed over.

### Why it was that way, measured rather than assumed

`github.com:443` is unreachable from this host while every other GitHub endpoint answers. Three consecutive
`git fetch` attempts failed after ~21 s each, and from the same process minutes apart:

| Endpoint | Result |
|---|---|
| `github.com:443` | **TIMEOUT** |
| `api.github.com:443` | OPEN 73 ms |
| `codeload.github.com:443` | OPEN 77 ms |
| `ssh.github.com:443` | OPEN 95 ms |
| `objects.githubusercontent.com:443` | OPEN 228 ms |

The blocking is **per hostname, not per port** — `ssh.github.com` answers on the same 443 that `github.com`
does not. It is also **intermittent at the TCP layer**: a raw `net.connect` to `20.205.243.166:443` timed out
while a `tls.connect` to the same IP with `servername: 'github.com'` completed `authorized: true` on TLS 1.3.
An intermittent block is worse than a solid one, because a single success is not evidence the path works.

The first two attempts at this treated the failure as a configuration problem and tried proxy settings and
retries. Both were wrong, and both cost a round. The measurements are cheaper to read than to repeat, which
is why they are now rule 8 of `FLEET-RULES.md` rather than a note in a session log.

### What now works, and what the evidence is

The repository is materialised from a `codeload` tarball (the one path that is reachable), giving a real git
work tree containing exactly `main` — verified by hashing both trees: **227 files, 0 differences,
`IDENTICAL`**. `scripts/fleet-sync.mjs` then ran against a real repository for the first time, having only
ever been tested against a temporary one:

| Step | Result |
|---|---|
| initial | `state=up-to-date action=none` |
| local commit | `state=ahead action=push ahead=1` |
| `--write` | `performed: true - pushed 1 commit(s)`; mirror and HEAD agree |
| peer commit arrives | `state=behind action=fast-forward behind=1` |
| `--write` | `performed: true - now at d42d5c0`; 228 files, peer file present |
| final | `state=up-to-date action=none` |

The same run also demonstrated the refusal path for free: when a fast-forward was rejected by git, the
result was `performed: false`, the tree was **left untouched**, and the state stayed `behind` — an automatic
sync that fails must not half-apply.

### Stated plainly rather than implied

This host can *pull* the truth and can *run* the sync machinery, but it **cannot push over git**. A round
that needs a commit published must use the API, and a round that exercises `fleet-sync` must do it against a
local bare remote. That is a real test of the state machine and **not** a test of the network, and the
difference is written into the rule so it is not mistaken for one.

## [0.10.4] — 2026-10-15

**A result channel over exit codes, for machines whose text cannot be read back.**

### Why this exists, stated without euphemism

The relay carries a per-machine `exit_code` faithfully and carries **no stdout at all**. That is a
deliberate property of the ledger and the right design for a system whose job is to say whether machines
agree — but the consequence is that an orchestrator can learn *that* a task failed and never *why*, and on
this fleet that cost several rounds: a health check returning a real verdict was indistinguishable from one
that crashed, because both produce a number and nothing else.

Every channel that would carry text is unavailable here. The relay host's SSH and its sink are refused, an
inbound receiver on the orchestrator never received a single connection, and a machine's `allowedCommands`
may permit only a narrow set of commands. What has worked on every machine every time is the exit status. So
this encodes bytes into exit codes. It is slow and it is ugly, and both are the point: **a diagnostic that
arrives slowly is worth more than one that never arrives.**

### The two design choices that are not arbitrary

- **`126` and `127` never carry data.** Shells write them for "not executable" and "not found", so a real
  127 and a data 127 would be indistinguishable and the reader would investigate the wrong failure. The
  alphabet is therefore a mapping over `1..125` and `128..253`, not a constant offset — the first version
  used `value + 1` across the whole range and its own test caught the collision.
- **Truncation is not completion.** `254` ends the message and `255` says the sender failed. A channel that
  stopped mid-message must not be read as a whole message, because that turns "the machine stopped talking"
  into "the machine said this" with no way for the reader to tell.

### Three failed fixes, and what actually located the bug

`encodeBytes` emits remainders as it divides, so its output is **least significant first**; the decoder's
Horner accumulator consumes digits **most significant first**. Feeding one into the other inverts the
message, and it presents as byte-order corruption rather than reversal — `"first"` came back as
`"Y~\u0010\u0018\u00fc"`.

Two attempts to fix it failed because they were fixing the wrong half: a stray `.reverse()` was added to the
*output* buffer, then removed, then removed again, while the real fault was that the *input* needed
reversing. The first attempt also had a genuine second bug — the encoder mutated the array it was iterating
— which masked the first. What settled it was computing the digits with `BigInt` and comparing: `encodeBytes`
matched the reference exactly, which located the fault on the decode side and in the input order rather than
the output.

### What is documented rather than papered over

Leading NUL bytes are not recoverable: they do not change the number, so `[0, 0, 1]` and `[1]` are the same
value and the same digit list. Recovering them needs a length declared on the wire, and this channel carries
text. That is asserted in the suite, because a future reader will otherwise treat it as a bug and add a
length prefix that changes the wire format for every existing message.

A 29-byte verdict costs 30 dispatches. `costOf()` reports this so a caller can see that a log file is not
worth sending this way — and fix the real channel instead.

**17 tests, 0 failures.**

## [0.10.3] — 2026-10-15

**Fix: the macOS health check walked a user's home directory, and timed out instead of reporting.**

Found on a real machine, not by reading the code.

`sample()` on macOS was scanning `/Users` for files that grow. On a developer machine that is hundreds of
thousands of files, and the symptom was not "slow" but **total failure**: the health suite exceeded the
fleet's own ~50-second lease ceiling and the task expired with `exit_code: null` and no result at all.

A monitoring tool that times out because it is too expensive to monitor is worse than no monitoring,
because **the timeout looks like a machine problem**. The contrast that identified it, measured on the same
host minutes apart:

| Command | Time | Result |
|---|---|---|
| `node -e "process.exit(1)"` | 8 s | `exit_code: 1` — the machinery was fine |
| `health.test.mjs` (before) | > 50 s | expired, no result |
| the same suite (authoring host) | 280 ms | pass |

`/Users` is replaced by `/Library/Logs`, which is where an unbounded system writer actually writes. The rule
this file already stated — that a health check must not be a load source — was written in the module header
while the path list violated it, which is the useful part of the lesson: the principle was written down and
still not applied to the one line that needed it.

Sampling now costs 53 ms. 20 tests, 0 failures.

## [0.10.2] — 2026-10-15

**Tiered storage — temporary, compressed, permanent, and the two kinds of knowledge that persist forever.**

### Why tiers rather than one directory

The Linux host reached 100% filesystem on 2026-10-14 from a single uncapped writer at 14.7 GB/day, and the
recovery cost real time. The lesson was not "delete more": it was that **data with different lifetimes was
stored in one place under one policy**, so the only available policy was "never delete" until it became
"delete under pressure" — which is the worst possible moment to be deciding what matters.

So a file's tier is written down when it is stored, and the tier alone decides what may happen to it:

| Tier | Lifetime | May it be deleted? |
|---|---|---|
| `temp` | a stated TTL | yes, automatically, once expired |
| `compressed` | until the archive is unwanted | only whole, never partially |
| `permanent` | forever | **no — refused, not warned about** |
| `skill` | forever | **no** |
| `law` | forever | **no — amended instead** |

### Why `permanent` refuses rather than warns

A warning is a thing a caller ignores, and the caller under pressure is exactly who this exists for.
`memory.jsonl` is the **only** durable copy of what a command printed — the relay keeps `stdout_sha256` and
never the text — so deleting it deletes the fleet's ability to answer what it already tried, and nothing
else in the system notices. `device.key` is the identity peers know a machine by; losing it makes every
peer holding the old one refuse that machine with no visible cause. A forced removal remains possible,
because a rule with no escape hatch gets bypassed rather than followed.

`law` entries carry an **amendment chain** naming the hash each amendment supersedes, because "what does
the rule say now" and "what did it used to say" are both questions a reader has, and only the second
explains why something was done the old way.

### A test that asserted nothing, found while writing it

The compressed-removal case ended with `existsSync(join(..., 'nope'))` — a path that never exists, so the
assertion could never be false. It now checks the real property: removal leaves no orphan on disk, because
an index that forgets a file still on disk is how a store grows without anything being able to name what
is in it.

**24 tests, 0 failures.**

## [0.10.1] — 2026-10-15

**A service-health agent: measure, classify, recommend — never act.**

### Why it only advises

A component that both decides a server is unhealthy *and* changes that server is one bug away from
deleting the thing it was protecting. The 2026-10-14 disk incident is the concrete example: the recovery
was `truncate`, **not** `rm`, because rsyslog still held the file descriptor open, so removing the file
would have freed nothing while appearing to succeed. A cleaner that had decided on its own to delete "the
big log file" would have looked successful and changed nothing.

### Where the thresholds come from — measurement, not taste

- **Disk** — critical at 90% used *or* under 1 GB free; warn at 80%. The host reached 100% with 268 MB
  free, which is the state this is for. The absolute floor matters independently: a huge filesystem can be
  "only 85% used" and still have less headroom than a task needs.
- **Log growth** — 14.7 GB/day is the measured rate that caused the incident. Any single file over 1 GB is
  reported **by name**, because "the disk is filling" is not actionable and "this file is filling it" is.
- **Load** — compared against CPU count, never an absolute number, because the consequence worth naming is
  that a loaded machine starts expiring tasks at the ~50 s lease ceiling.
- **Memory** — set where a host starts swapping, not where it looks comfortable.

### Two defects the suite found in its own work

- The critical load multiple was `loadPerCpuWarn * 2`, which **reads as a rule and is a coincidence** —
  equal to 3.0 only while the warning threshold is 1.5, so changing one would silently move the other. Its
  own test asserted the documented 1.5 / 3.0 pair and failed. It is now a named constant.
- A test asserted `critical` for 4.0 load over 2 CPUs. 4 / 2 is 2.0 per CPU, between warn and critical.
  **The implementation was right and the assertion was not.**

### Permanent storage is a classification, not a copy

`DATA_CLASSES` marks `memory.jsonl`, `device.json`, `device.key` and `fleet-memory.md` as
`IRREPLACEABLE`. It copies nothing: deciding where data may live is a policy this module has no standing
to make, and the honest half is saying which data cannot be regenerated.

### A limitation measured rather than assumed

`df` exists on Linux and macOS and not on Windows, so a Windows sample carries `disks: []`. The important
part is that it is **empty** rather than filled with a healthy-looking default — an unmeasured disk must
never read as free space. A test asserts the empty case on whichever host runs the suite.

**20 tests, 0 failures.**

## [0.10.0] — 2026-10-15

**The cross-session approval index, and a syncer that refuses to wedge a repository.**

### The approval index (roadmap v4.9.0)

`approval-broker.mjs` answers approvals **per session**: a request belongs to one IM window and the
operator answers it there. That is right for the person in that conversation and wrong for a supervisor,
who by definition is not in it — the design's own words are that a supervisor reviews all agents' pending
approvals *from one queue*. Without this, a request raised in a session nobody is watching sits until its
deadline delegates it.

The index presents pending work across sessions, filtered by what the viewer may act on, and verifies
authority at the moment of decision. It decides nothing itself: `decide()` returns a verdict and the caller
settles the broker, because the broker already owns settlement and a second settler would be a second owner
of the same promise.

Two choices worth stating. The subject's authority level is recorded **at raise time**, because it is a
fact about who asked and must not be re-derived from a caller who might be the approver — an index that let
the approver supply it would let the approver lower it. And `listFor` returns work the viewer **cannot**
answer, with the reason, rather than filtering it out: a filtered list makes the fleet look idle at the
moment it is most blocked.

### `scripts/fleet-sync.mjs` — broadcast, sync, merge, with a decision

Three defects were found by running it, two of them dangerous in production:

- **A failed rebase wedged the repository.** No committer identity meant `git rebase` stopped part-way,
  leaving a detached HEAD and `.git/rebase-merge` for a person to resolve. An automatic tool that can
  wedge a repository is worse than one that does nothing. The identity is now checked before starting, and
  a failure **aborts** the rebase to restore the exact previous state.
- **A failed `rev-parse` was read as a ref name.** `git rev-parse <unknown>` **echoes the argument** to
  stdout and then exits non-zero, so a failed lookup produced `{ok:false, out:'origin/main'}` — a plausible
  ref name attached to a status saying it does not exist. `inspect` read `out` alone and reported a
  repository with **no remote at all** as `ahead` with `ahead/behind: NaN/0`. Every ref lookup now uses
  `--verify`, and an unparseable `rev-list` is `unreadable`/stop rather than falling through to a default.
- **The published/unpublished safety test was dead code.** `published = local_only < ahead` can never be
  true: `ahead` counts the commits absent from the remote-tracking branch and `--not --remotes` selects
  exactly those commits. The real question is narrower — would this rebase rewrite a commit some remote ref
  already reaches — and it is now answered by testing each local commit for reachability from the remotes.

A finding that changed a test rather than the code: **on a single upstream, a "both sides published"
divergence cannot exist.** If a local commit is reachable from `origin/main` then HEAD is its ancestor, so
`behind` is 0 and there is no divergence. Three fixtures failed before that became clear. The reachable
version of the hazard is a local commit some *other* remote ref already has — a branch pushed as a feature
and then rewritten — and that is what the test now builds.

**30 tests across the two, 0 failures**, against real repositories and a real bare remote: a mocked git
would have been a test of the mock.

## [0.9.9] — 2026-10-15

**Cognitive memory blocks (roadmap v4.8.0): field-level acceptance and lineage — and the first release whose suite was run on the fleet machine rather than on the development host.**

### `src/agent/blocks.mjs`

The memory layer shipped in 0.9.6/0.9.7 accepts a peer's claim **whole or not at all**, which is a blunt
instrument with two costs the roadmap records as P1 and P2. A block is now seven fixed fields so the
decision can be made per field:

| Field | May a receiver choose it? |
|---|---|
| `subject`, `body`, `evidence` | yes |
| `confidence` | **no — refused whatever the chooser says** |
| `origin`, `observed_at`, `lineage` | **no — inherited, and setting them would be forging provenance** |

Lineage is by **content hash**, not by id, because an id is assigned by whoever creates the block and can
be copied. A block whose parent cannot be produced is **refused rather than re-rooted**: re-rooting turns
an unverifiable history into no history, which reads as a fresh, independent assertion, and that is how a
fabricated claim acquires a respectable past.

### Three defects the suite found in its own module

- **`confidence` was only a default, not an invariant.** Supplying a custom `choose` *replaced* the
  default rather than refining it, so the file's central conservative property — a receiver does not adopt
  the sender's certainty about the sender's own assertion — was silently optional. "Silently optional" is
  how a safety default stops being one, so the refusal is now a hard invariant that no chooser can open.
- **A cycle fixture that asserted nothing.** The first cycle test mutated `lineage` after hashing and keyed
  the map by the recomputed digest, leaving the references pointing at hashes the map did not hold — the
  walker reported `missing` and never met the cycle it was supposed to test. `linkFixtures` now makes the
  reference and the key the same string by construction.
- **A test that measured the clock.** `makeBlock` stamps the current time when no `observed_at` is given
  (correctly — that is what the field means), so two blocks built a millisecond apart differ. The failure
  looked like a hashing defect and was a 1 ms difference in a field the test never mentioned.

### Verified on MacMini, not only here

This is the first release whose suite was executed on the fleet machine:

```
MacMini (MacMinideMac-mini.local)
  HEAD     : 642242446d3eb0ed1928f128d088b727284a6d43
  expected : 642242446d3eb0ed1928f128d088b727284a6d43   MATCH
  suiteOk  : true
```

`test/blocks.test.mjs` — **28 tests, 0 failures**, adversarial by design: most cases assert a refusal
rather than a happy path, because what makes a fleet memory worse than no memory is losing the ability to
tell a fact from an echo. `eslint` 0 errors.

### Notes on how this got here, because the tooling cost more than the module

`run-relay.mjs` targets `root@<relay>` and runs **bash on the relay host**; `relay-run.mjs` runs a
**JavaScript file on a fleet machine**. Both are called "relay" and only one of them is the fleet — a
clone believed to be on MacMini was on the relay for a round. Also: `Set-Content -Encoding utf8` writes a
**BOM**, and a shebang behind a BOM is not a shebang. And a 43 KB script cannot travel as an argv element
under Windows' 32 KB command-line limit, which is why this work reaches MacMini as a **branch** it fetches
rather than as an inline command.

### Environment, measured

MacMini has `git` 2.54.0, `curl`, `python3`, 70 GiB free, and **working** HTTPS to npm, the GitHub API,
release assets and codeload — including `git ls-remote`, which an earlier session recorded as failing.
It has no `npm`, `pnpm` or `brew`, so `node --test` directly is the suite runner.

## [0.9.8] — 2026-10-14

**The numeric authority model — the layer four of the five roadmap layers depend on — plus a roadmap and a memory write that reports its own outcome.**

### `ROADMAP.md`

The operator's architecture document specifies five layers across v4.7.0–v4.13.0. It lives in the
repository now, and it states the delta honestly before it states the plan: this repository has **one
relay and five machines**, against a target of 1,000+ agents. Every release row carries both a
deliverable and **the observation that would falsify it**, because a row without the second is a feature
list rather than a plan.

It also refuses three things on the record: it does not adopt a named protocol (InterMesh, A2A, NLIP,
AIX, MMP) before a line of its wire format exists; it does not build BFT consensus among five machines on
one relay, where it would add latency and failure modes without adding trust; and it does not specify
1,000-agent behaviour, because the source document's own §6.4 reports 30–50 agents as the practical limit
and superlinear "coordination collapse" beyond 100 — **a design not measured at 50 cannot honestly
specify 1,000.**

### `src/agent/authority.mjs` — v4.7.0

An integer `authority_level` on every actor, the four bands (0–49 ordinary, 50–69 captain, 70–89 org
admin, 90+ system admin), `matching_exempt_level` as the Unix-root-style exemption, and a decision
function returning `allow | needs_approval | deny` **with the rule that produced it**.

Why an integer rather than role names: authority appears in four of the five layers — permissions, the
approval flow, committee voting weights, and the defence hierarchy where a Coordinator outranks an
Analyst. An enumerated set of names would be re-partitioned by each layer, and every re-partition is a
place for two of them to disagree.

Three decisions are load-bearing and each is pinned by a test:

- **A rule with no `matching_exempt_level` exempts nobody.** The tempting default is "absent means
  unconstrained", and it is wrong in the one direction that matters: a rule author who forgets the field
  would silently create an unrestricted action.
- **An exemption bypasses membership, not the level floor.** The Unix analogy is exact — root bypasses a
  file's permission bits, not the requirement that the file exists. A rule that says both is
  self-contradictory, and the strict half wins.
- **A derived actor never exceeds its parent.** No rule in the source design grants delegation, and the
  default an implementation reaches for — "a captain's delegate is a captain" — turns one compromised
  actor into an escalation path. Where the source is silent, the narrow reading is the safe one.

### `evaluateAll` — a design corrected by its own test

The first draft evaluated every rule and returned the strictest verdict. A test asserting that the rules
after a gate are not evaluated failed, and the failure was right. `decisive` must be **unique**, or a
list can hold several non-allow decisions and whichever the caller picks, the *stated* reason for a
refusal stops being the reason. And a gate is a gate whether it says `deny` or `needs_approval`: in both
cases the caller's next action is determined and the remaining rules are decoration. It now stops at the
first non-allow.

### `envelope.memory` — a silent write that now reports

`appendMemory`'s result was deliberately unchecked, so a memory write could not fail a task. That remains
true — but leaving it entirely *silent* was the right call for the control flow and the wrong one for the
reader: **a machine whose memory is not being written is indistinguishable from one that has nothing to
remember**, which is precisely the class of invisible failure this layer exists to end. The envelope now
carries `memory: {written, file, rotated}` or `{written: false, reason_code}`. It is not a comparable
field, so no verdict moves and two machines cannot disagree over it.

### Verified

- `test/authority.test.mjs` — **27 tests, 0 failures.** Every one is about a boundary, because the only
  interesting thing an authority model can get wrong is being off by one: a level too permissive is an
  escalation and one too strict is an outage, so the band edges and the exemption boundary are asserted
  **from both sides** rather than by a middle value that would pass either way.
- Band partition is proven total and non-overlapping across 0..100 by walking every level, so a seam that
  belongs to two bands — a bug that only appears once someone is assigned that level — cannot exist.
- `eslint .` — 0 errors on the new module and test.

## [0.9.7] — 2026-10-14

**`w2m_memory` gains the collective layer and the one write a machine may not make for itself.**

### `scope: "fleet"` — the collective memory

Reads the curated `fleet-memory.md` that §3.2 of the design puts on the archive host, beside the profile
that mounted this plugin. It returns the document **as text, with its section list**, and does not parse
it into facts — deliberately. Hand-written prose has no schema, so a parser would silently drop whatever
shape it did not recognise, and what it dropped would be exactly what a human judged worth writing down.
The section list is there so a reader can see what the collective memory covers before paying for all of
it.

An absent file is answered honestly rather than as an empty document: `MEMORY_NO_COLLECTIVE`, with the
path that was looked at. *"Nothing has been curated yet"* and *"the memory is empty"* are different
facts, and only one of them means someone should start writing.

### `record` — a conclusion, which only a reader may assert

`memoryRecord` always emits `conclusion: null`, because a machine that invented one would be asserting an
interpretation it cannot have. This is the path by which a reader supplies it: the conclusion is appended
as a **new record naming the task it is about**, never written into the existing line.

Append-only is the point. In-place editing would break the property that makes the log trustworthy — what
was written is what happened, and an amendment is a later statement *about* it — and it would destroy the
original text, which is the thing a reader most needs when a conclusion turns out to be wrong.

### A defect this found in its own first draft

`collectivePath()` was `path.join(resolveProfileDir(cfg), COLLECTIVE_FILE)`. `resolveProfileDir`
legitimately returns `null` — a bare test context, or a host whose layout it cannot read — and the first
version passed that straight into `path.join`, which threw `ERR_INVALID_ARG_TYPE`. **A read tool that
crashes on a missing directory is worse than one that says the directory is missing:** the caller was
asking a question, and an exception is not an answer. It now resolves to `null`, reports
`MEMORY_NO_COLLECTIVE`, and says which of the two reasons applies.

### Verified

- `eslint .` — 0 errors.
- The contract suites — `memory`, `tools`, `tool-cards`, `claims`, `loader-entry`, `update-wiring`,
  `p2p-plugin` — **230 pass, 0 fail, 11 platform skips**.
- Every scope exercised against a real temporary profile: `fleet` found the seeded document and listed
  its five sections; `record` wrote a conclusion against a task and reported that no task existed when
  none did; an absent collective file produced `MEMORY_NO_COLLECTIVE` rather than a throw.
- The tool count is unchanged at nine, so this release moves no contract: the same nine tools, two of them
  wider.

## [0.9.6] — 2026-10-14

**Individual memory: the fleet can now answer "what did we already try on this machine, and what happened?" — a question nothing in it could answer before.**

### The gap this closes, measured rather than asserted

The relay is sent `command_hash`, `stdout_sha256` and `stdout_bytes`, and never the text. That choice is
defensible and stays: the ledger is a tamper-evident consistency record, and a relay compromise discloses
no command text. The price was that no part of the fleet retained what a command actually did, and the
price was paid over and over. In one working session the same facts were rediscovered from scratch across
a dozen dispatches — that a machine had no package manager (3 times), which node binary actually ran (2),
that its git could not reach github.com while node's HTTPS could (2), that a task is expired at about
fifty seconds (3), and which commit its checkout was on (2).

### What was added

**`src/agent/memory.mjs` — one append-only `memory.jsonl` per machine, in its own state directory.**

Written by the agent as each task finishes, at the one point where the output still exists at all and on
the one machine that owns it. Each line carries the command, `cwd_rel`, exit code, status, duration,
transport, and the tails of stdout and stderr — plus the envelope's hashes, so a human-readable record can
be cross-checked against the relay's tamper-evident one without trusting either.

Three properties are deliberate and each has a test:

- **Bounded by construction**, with a byte cap and one rotating generation. This is not hypothetical
  caution: the Linux host's root filesystem reached 100% today from 14.7 GB/day of uncapped logging, and
  the recovery cost real time. A memory that can fill a disk is a worse outcome than no memory. Rotation
  keeps the previous generation rather than discarding it, because the question this file answers is
  usually about the recent past and the rotation boundary sits exactly there.
- **A malformed line is skipped, not fatal.** A partially written final line is what a machine losing
  power mid-append leaves behind, and one damaged line must not make the rest unreadable — the relay's own
  ledger behaves this way for the same reason.
- **`conclusion` is written as `null` by the machine and only ever filled in by a reader.** The design
  separates fact from interpretation, and a machine that invented a conclusion would be asserting
  something it cannot know. A test pins this, because the failure would be silent.

**`w2m_memory` — the read side.** Returns this machine's memory, newest first, with a status tally, and
reaches the rotated generation on request.

It does **not** read another machine's memory, and says so instead of returning an empty list. The reason
is structural rather than an omission: the relay carries no such file, and an agent executes a dispatched
command inside a sandbox whose writes are scoped. A query for another machine is answered with
`MEMORY_REMOTE_NOT_READABLE` and the two ways to actually read it. Returning `records: []` would have read
as *"that machine has done nothing"* — the opposite conclusion from *"this build cannot see"*.

The write is wrapped so it can never fail a task. The task is the work; this is a note about it.

### Verified

- `test/memory.test.mjs` — **18 tests, 0 failures**: record shape, tail and argv clamping, append-and-read,
  newest-first ordering, the limit, a malformed line skipped, an absent file read as empty, rotation with
  both generations readable, and that neither `appendMemory` nor `readMemorySync` throws on a bad directory.
- A rotation test that trips the cap with *real* records rather than filler, because the first version
  wrote eight megabytes of `'x'` — it rotated, but it could not answer the question being asked, since the
  previous generation then held one unparseable line.
- `eslint .` — 0 errors.
- **The full pre-flight is green: 11 pass, 0 fail, 1 unverifiable** (1721 tests in 54 files; 1707 pass,
  0 fail, 14 platform skips). The single `UNVERIFIABLE` is an accepted host observation, not a gate.
  Reaching that required installing `git` on the development host, which had none; the 39 failures before
  it were all `spawn git ENOENT`, and the two rounds of diagnosis after it were a sandbox rule (writing
  files in `%TEMP%` is allowed, **creating a directory** there is refused — and `git init` creates one) and
  two mojibake sequences this release then repaired. Recorded because "39 failures" read as a defect count
  and was, at every stage, an environment count.
- The nine-tool contract is updated everywhere it is pinned: `scripts/verify-installed.mjs`,
  `test/loader-entry.test.mjs`, `test/tools.test.mjs`, `test/tool-cards.test.mjs`, `test/claims.test.mjs`,
  `test/p2p-plugin.test.mjs`, `test/update-wiring.test.mjs` and the pre-flight gate inventory. Those
  assertions are what make "the tool set" a contract rather than a habit, so leaving one at eight would
  have failed a release that is otherwise correct.

## [0.9.5] — 2026-10-14

**Same code as v0.9.4; published because v0.9.4's npm and GitHub bytes cannot be made to agree.**

### Why this version exists

v0.9.4 was published, then amended minutes later to replace a comment that quoted a retired message
verbatim. GitHub's tag and assets were moved to the corrected commit. **npm could not follow**: a
published version cannot be overwritten, and this account's token cannot unpublish either, so npm keeps
the pre-amendment bytes permanently.

The difference is one comment. It is recorded here rather than papered over because a divergence that is
discovered later and unexplained costs more than a version number:

| Where | v0.9.4 | Carries |
|---|---|---|
| npm | `sha256:570f5175…` (870353 b) | the comment that quotes the retired sentence |
| GitHub | `sha256:ab7b60dc…` (870448 b) | the corrected comment |

Both run **identically** — the changed bytes are inside a `/** */` block. `latest` on npm now points at
0.9.5, which is byte-consistent with its GitHub release, so the divergence is confined to a superseded
patch of one patch version.

### Verified

- `test/relay.test.mjs` 152 pass, `test/claims.test.mjs` 47 pass, `test/chatops-account.test.mjs` pass —
  242 tests, 0 failures, 0 cancelled.
- `eslint .` — 0 errors.
- The precise check on the shipped tree: the retired sentence appears **0 times in code and 0 times in
  comments**; the corrected sentence appears once, at the assignment.

## [0.9.4] — 2026-10-14

**A note that promised a verdict the relay no longer delivers, and the test that had locked the promise in.**

### What v0.9.3 left behind

v0.9.3 made the relay skip an anchor nobody declared, so an unanchored dispatch now aggregates normally —
the live relay returns `state: consistent`, `counts.ok: 1` for a command that used to come back
`unverifiable`. The plugin, however, still opened every such dispatch with:

> this machine's working tree could not be fingerprinted, so peers have no anchor to match and
> **the aggregate will be unverifiable**

which was true when it was written and is now false. The fixed mechanism had been left with a sentence
telling operators to doubt a verdict that is correct, so the note now says what is actually the case:

> this machine's working tree could not be fingerprinted, so no anchor was declared: peers are compared
> with each other, not against a named tree

### The test had encoded the promise

`test/tools.test.mjs` asserted `assert.match(value.note, /unverifiable/)`, so fixing the wording broke
the suite — and the tempting repair is to put the sentence back and keep the suite green. That would have
been the wrong way round: **the test was guarding a claim, not a behaviour.** It now asserts the claim:

- the note must state that no anchor was declared;
- it must state what that costs — agreement between peers, not with a named tree;
- and `assert.doesNotMatch(value.note, /unverifiable/)`, so the stale promise cannot be written back in.

The third is the one that earns its place. A positive match on a *new* sentence would have passed too and
guarded nothing; the negative case is what stops the old sentence returning.

### Verified

- `test/relay.test.mjs` — 152 tests, 0 failures.
- `test/claims.test.mjs` — 47 pass. It caught this release's own omission on the first run: the version
  was bumped to 0.9.4 while the newest CHANGELOG entry still said 0.9.3, and it refused with *"One of them
  is the release; the other is a mistake."* Correct, and the reason this entry exists.
- `test/tools.test.mjs` — 90 pass, 1 failure: `w2m_run computes base_commit and base_tree from a real git
  work tree`, which fails with `spawn git ENOENT` because **git is not installed on this host**. That is
  the same environmental cause as the 38 `declared suite` failures, not a regression.
- `eslint .` — 0 errors, 127 warnings.

## [0.9.3] — 2026-10-14

**An undeclared anchor was compared against the literal `null`, so every dispatch from a non-git machine was `unverifiable` — including the ones that succeeded.**

### The report, and why it read as a lie

A relay was asked what happened to a task, and every answer came back the same way:

```
status : unverifiable
reasons: ["base_commit \"a1e7dc042913b96da3ad68… != expected null"]
notes  : ["aggregation refused: Step 1 anchor violation"]
```

while the machine's own record said `lease_state: done`, `status: ok`, `exit_code: 0`. A reader has no way
to prefer either half, so a task that ran perfectly was reported as one that could not be trusted — and
the same verdict came back for **every** dispatch.

### The cause

`report.mjs` Step 1 compared the anchor unconditionally:

```js
if (canon(valueOf(env, 'base_commit')) !== canon(expected.base_commit)) {
```

`expected.base_commit` comes from `task.base_commit ?? null`, and a dispatcher whose own tree is not a
git work tree — the ordinary case for the plugin running out of its profile directory — sends `null`. So
the comparison was *"the machine's real commit **equals null**"*, which no machine with an anchor can
satisfy. **A machine was marked untrustworthy for reporting its commit truthfully.**

That the two anchors disagree is the whole story. `base_tree` six lines below has always read:

```js
if (expected.base_tree !== null && canon(valueOf(env, 'pre_tree_fingerprint')) !== canon(expected.base_tree)) {
```

— it tolerates absence. `base_commit` did not. Same kind of statement, opposite handling, and the
asymmetry is the bug. The protocol cannot even distinguish the two cases: `state.mjs` normalises both an
absent field and an explicit `null` with `input.base_commit ?? null`, so "no anchor" and "anchor is null"
arrive identically and must be treated identically.

### The fix

`base_commit` is enforced only when the dispatcher declared one, matching `base_tree`. The relaxation is
**reported, not silent**: an `unanchored: true` field on the aggregate plus a note saying

> no base_commit was declared, so the anchor check did not run: machine agreement here is agreement with
> each other, not with a tree the dispatcher named

because *"these machines agreed"* and *"nobody said what they should have agreed on"* must not read the
same to an operator. `consistent: true` from an unanchored run says the machines matched; it does not say
they ran the tree you meant.

### Verified

- `test/relay.test.mjs` — **152 tests, 0 failures**, including two new ones: the undeclared anchor is
  skipped and reported, and a **declared** anchor mismatch still refuses aggregation. The second exists
  because the first is a relaxation, and a relaxation without a falsifying test is how a check quietly
  disappears.
- `eslint .` — 0 errors.
- The rest of the pre-flight — gate inventory, test wiring, workflow wiring, entry points, packed tarball,
  claims, CHANGELOG shape — all green. The one red gate is `declared suite`, whose 38 failures on this host
  are 38 tests that shell out to `git`, which is not installed here.

### Note on where task output lives

Investigating this also settled a question that had cost real time: the relay stores **no** task output. A
task record carries `machine_id`, `lease_state`, `outcome`, `status`, `exit_code`, `transport`, `p2p` and
`reasons` — and no `stdout`, no `stderr`, not even `stdout_sha256`, despite `COMPARABLE_FIELDS` naming
those fields. So "sync the output home" cannot be solved at the relay, by any port or proxy: the text was
never kept. Any durable record of what a command printed has to be written **on the machine that ran it** —
which is exactly where the fleet-memory work begins.

## [0.9.2] — 2026-10-14

**The gate added in v0.8.11 pointed at a file that had never been committed, so it failed on all four CI platforms.**

### What was broken

`verify:join` was wired in three places across two releases:

| where | when |
|---|---|
| `package.json` → `"verify:join": "node scripts/verify-join.mjs"` | v0.8.11 |
| `.github/workflows/ci.yml` → `- run: npm run verify:join` | (pushed in v0.9.1) |
| `.github/workflows/release.yml` → `- run: npm run verify:join` | (pushed in v0.9.1) |

**`scripts/verify-join.mjs` itself was never in the repository.** It existed only in the working tree that built the tarballs, so every CI platform failed with the least interesting error available:

```
Error: Cannot find module '/home/runner/work/dsh-windows2macos/dsh-windows2macos/scripts/verify-join.mjs'
code: 'MODULE_NOT_FOUND'
```

On `ubuntu-latest/22`, `windows-latest/22`, `windows-latest/20` and `macos-latest/22` alike. A file-existence check would have caught it; a review of the diff would not, because the diff was of files that existed.

### How it was found

By reading the CI failure logs rather than the CI summary. The summary said *"The fleet join reaches a token (stub agent, no relay)"* failed — which reads like the check *ran and disagreed*. It had not run at all. The summary named the step; only the log said `MODULE_NOT_FOUND`.

The same class of mistake as the four files an earlier push left behind (see v0.9.1), and it is worth naming the shared root cause: **the v0.8.x tarballs were packed from a working tree, while the repository was written to by listing files individually.** A pack packs everything; an explicit list omits what the author forgets. The durable fix is to stop enumerating — but until this release the enumeration is what the tree had.

So this release does the one thing v0.9.1 should have: it diffs the working tree against the repository in **both** directions. Exactly one file was present locally and absent remotely, and it was this one.

### Verified

- `node scripts/verify-join.mjs` — 16/16 locally, which it always was; the defect was never in the script.
- The script is now in the repository, which is the only place `verify:join` can run from: `claims.test.mjs` pins
  `FORBIDDEN_IN_RELEASE = ['test', 'scripts', ...]`, so `scripts/` is deliberately **not** in `package.json#files` and
  a published tarball carries no `scripts/` directory by design. `verify:join`, `pack` and `verify` are source-tree
  and CI commands, not consumer commands. An earlier draft of this entry called the absent `scripts/` a packaging
  defect; that was wrong, and the constraint above is why.

## [0.9.1] — 2026-10-14

**A powered-off machine stayed `online` and selectable in every fleet view, because `online` was never derived from contact.**

### The report

> *"Another Windows machine, clearly shut down and offline for a long time, is still online and active — not greyed out, still selectable."* And, in the same breath: *"is the fleet heartbeat not synchronised, not updated, not broadcast?"*

All three of those turned out to be one defect with three faces, and the report was exactly right. The relay's own data at the time:

| machine | `online` | `last_heartbeat_at` |
|---|---|---|
| `jp-shared` | true | `11:15:55Z` |
| `macmini` | true | `11:15:41Z` |
| **`win-desktop` (`549b9fde`)** | **true** | **`null`** |
| `ToFuture` (here) | true | `11:16:32Z` |

A machine reported `online: true` while `last_heartbeat_at` was `null` — meaning it had **never sent a heartbeat at all**. Two fields in one row contradicted each other and nothing reconciled them.

### The cause

`device.online` was written in exactly two places, and both were the SSE stream:

```js
device.streams === 0 && this.state.setOnline(sub.machineId, false, 'stream_closed');  // detach
this.state.setOnline(machineId, true, 'stream_open');                                 // attach
```

`/v1/devices` then read the flag back:

```js
online: device.online === true,
```

**Nothing derived liveness from contact.** So the machine's state was really "is there a TCP connection", and a **half-open stream** — a killed process, a pulled cable, a closed lid; anything that ends the agent without a clean socket close — left `online: true` for as long as the socket survived, which is indefinitely. That is the reported machine: powered off, still listed, still a dispatch target.

The "not broadcast" half is the same cause. `peer.bye` *is* broadcast to every other machine — but it is emitted **by the detach that never came**, so no other machine was ever told either, and every machine picker in the fleet kept offering a departed host.

And the "heartbeat not synchronised" half is the third face: a heartbeat alone could not fix the flag, because the flag did not read heartbeats.

### The fix

**Presence is now expired, next to lease expiry.** A new `sweepSilentDevices()`, driven by the relay's existing 1 s maintenance timer, declares a device silent once nothing has contacted it for `DEFAULT_SILENCE_MS`, and goes through the **existing** `setOnline(id, false, 'silent')` — which both flips the flag and emits `peer.bye`. Going through that path rather than setting the flag directly is the point: correcting only the flag would fix `/v1/devices` on the relay while every agent's own view, and therefore every picker, still showed the departed machine.

**Reads agree between sweeps.** `online` in both `deviceStatus` and `publicDevice` is now derived as well as stored, so nothing has to wait up to a second for a background timer to be told that a machine which stopped talking is gone.

**The threshold is two idle heartbeats (120 s).** An idle agent heartbeats every 60 s and a busy one every 10 s, so the slowest healthy cadence is 60 s and 120 s cannot be reached by a live machine. Deliberately *not* the 20 s lease rule (`heartbeatIntervalMs × missedHeartbeats`): that one guards a task index, where being wrong costs a duplicated execution, while this one guards a display and a target list, where being wrong costs a wasted dispatch. Same reasoning, different price. A test pins the invariant `DEFAULT_SILENCE_MS >= DEFAULT_IDLE_HEARTBEAT_MS * 2`, because a threshold at or below one beat would flap every healthy idle machine.

**`offline_reason` and `silent_ms` are now reported** (`stream_closed` | `silent` | `null`), on `/v1/devices`, in `/v1/status`, and through `w2m_stats`. "Offline" without a reason is precisely the shape that hid this: a departed machine looked identical to a quiet one, and a reader had no field to check.

### What the tests had to be told, twice

Both mistakes are recorded in the test file because both are traps a future reader will fall into:

1. **`RelayServer.handle` calls `touchDevice` on every authenticated request.** The first version of the wire test polled `/v1/devices` *with the token of the machine under test* — so the silent machine refreshed its own `last_seen_at` by asking, and the test read it as online. The observer must be a different device.
2. **The threshold has to exceed the heartbeat cadence used by the test.** The first version used `silenceMs: 5_000` against a witness that heartbeated every 60 s, so the witness was legitimately swept alongside the machine under test.

A third correction was to the fix itself, and it is the subtle one: `offline_reason` originally tested `device.online !== true` **first**, which reports `stream_closed` for exactly the half-open case — the stream *is* still attached. Silence has to be tested first, or the reason names the wrong thing on the one case that matters.

### Verified

- `test/relay.test.mjs` — **150 tests, 0 failures** (4 new: the sweep plus its broadcast, the pre-sweep read, the healthy-quiet distinction, and the threshold invariant).
- The 13 suites that touch device or fleet state — **398 tests, 0 failures**.
- `eslint .` — **0 errors**, 127 warnings.

### Deployment note — this fix is on the wrong side of the wire

The defect lives in the **relay**, so upgrading the plugin does **not** fix a running relay: a machine running v0.9.1 still shows every other machine's stale `online` flag until the relay itself is restarted on v0.9.1. The relay at the shared default address was still serving the stale view when this was written. Restarting it is an operator action, and the relay's own operator token is not something this repository holds.

## [0.9.0] — 2026-10-14

**Three defects that were mounted, wired, and doing nothing — and the lint gate that had stopped being able to say so.**

### The shape all three share

Each was, in the words an earlier release note already used for this class: *the record was created,
and the part that makes it useful was not filled in*. All three were invisible to the suite, and all
three were found by reading lint output rather than by running anything.

### 1. `ReferenceError: all is not defined` — on the path an operator actually reaches

`src/relay/state.mjs` threw an undefined identifier while *building a refusal*:

```js
if (targets.length === 0) {
  throw new ProtocolError('NO_ONLINE_DEVICE', 'no paired device available for this task', {
    known_devices: all.length,          // ← `all` exists nowhere in the file
  });
}
```

`targets` is empty exactly when the fleet has nothing to dispatch to — a freshly configured machine
before its first peer joins, or a fleet whose machines are all scoped out. So the one case where the
operator needs the detail most answered with a `ReferenceError` instead of the refusal. The count they
need is the **unfiltered** device set, because the answer distinguishes *"nothing is paired"* from
*"something is paired but scoped out"*; that is `this.devices`, the same collection handed to
`targetsFor` a few lines above.

The project's own lint audit records `no-undef` as the rule that "caught the one real defect" of its
round, and notes why it matters: *an unbound identifier in an ESM module is a `ReferenceError` at
evaluation time, not an `undefined` that quietly takes a branch.* This is the same defect one release
later.

### 2. The in-process agent's status was built and then dropped

`src/plugin/tools.mjs` documented a feature and never performed it:

```js
// §8.2: when the agent runs inside this process its `rttMs` is reachable directly, so `w2m_status`
// can report it without a file.
const statusGetter = agent.status ?? agent.state ?? null;      // ← and nothing else
```

`readRtt` opens with `if (inProcessAgentStatus)` and skips the whole in-process branch when it is
null. Nothing ever assigned it, so on a machine whose agent *is* in that process the tool fell through
to reading a state file and reported:

```
no agent round-trip time is available: the agent is not running in this process and no agent
state file was found under <stateDir>
```

— wrong twice, and wrong in the direction that costs most: it tells the reader to doubt the agent, on
the one call they make to find out what is actually happening. The getter is now assigned.

### 3. A parameter that promised a binding it never made

`src/chatops/bridge.mjs` had `function actionsFor(windowKey)` under a doc line claiming the window was
"bound in", and a body that never mentioned `windowKey`. The real binding is per call
(`pending: (window) => broker.listFor(window)`), so the parameter is gone rather than renamed: a
caller passing a window there was reading a promise the signature did not keep.

### The lint gate, which is why nobody saw any of this

`eslint .` reported **155 errors**, and the release pre-flight requires zero — so the gate was red, and
a gate that is red for 117 pieces of noise is a gate nobody reads. Which is how three defects sat in
the tree.

| Rule | Count | Disposition |
|---|---|---|
| `no-console` | 117 | **Configuration.** Every one is in `scripts/` — `ilink-*.mjs` operator probes whose entire output *is* a transcribed QR flow, and `chatops-*-e2e.mjs` end-to-end drivers whose value is their trace. The rule's rationale ("a leftover debug statement") does not describe a file that returns nothing to a caller. `scripts/**` joins `bin/**` and `deploy/**` in the existing exception; `src/` and `test/` keep it at error. |
| `no-unused-vars` | 20 | 13 dead imports removed; 7 unused **bindings** annotated with a leading underscore, per the config's own convention. Two of those are load-bearing calls whose *result* is unused — `stats = await lstat(lexical)` is how a missing file is detected — so the call stays and the binding is annotated. |
| `no-promise-executor-return` | 4 | The idiomatic `new Promise((r) => setTimeout(r, ms))`. The rule is right that the executor returns a value; braces remove it without changing what the promise does. |
| `prefer-const` | 2 | Both real; one (`cursor`) carried a `let` that suggested a resumption the script does not implement. |
| `no-sequences` | 4 | Comma-operator arrows in a test, rewritten as block bodies — same order, same value, readable without knowing the operator. |
| `no-loss-of-precision` | 2 | **Dispositioned, not fixed.** These are the nineteen-digit measured `message_id` values the iLink contract fixture exists to demonstrate: JavaScript rounds them on parse, and a production path recovers the exact digits from the raw text *because* of that. Quoting the literals would delete the case under test, so they carry a scoped `eslint-disable` with the reason inline. |

Result: **0 errors**, measured with the repository's own config and `--report-unused-disable-directives`,
so a suppression that no longer suppresses anything fails the run instead of sitting there looking
like it does.

`docs/LINT-AUDIT.md` keeps its measurements as written and gains an addendum for this round, because
an audit document that silently disagrees with the tree is worse than no audit document.

### Verified

- `node scripts/verify-join.mjs` — 16/16, unchanged by the edits above.
- `node scripts/check-entrypoints.mjs` — all entry points import.
- The four touched suites — **119 tests / 25 suites / 0 failures** (`chatops-commands`,
  `chatops-ilink-contract`, `chatops-approval`, `chatops-durability`).
- `eslint .` — 0 errors.

The three defects do **not** carry new tests, and that is a stated gap rather than an oversight: each
sits on a path the existing suite does not construct (an empty target set at dispatch, an in-process
agent status getter, a bridge action set built with an argument). They were found by lint and fixed by
reading the surrounding contract; a test for each is the honest next step.

## [0.8.11] — 2026-10-14

**The in-process join threw before it could pair — and a missing fingerprint took the fleet key with it.**

### The defect that mattered

`startLocalStack` built `identityOptions`, loaded the identity, and then passed
`identityOptions.identity` to `createAgent` — but nothing ever assigned that property.
`loadOrCreateIdentity()` returns `{ identity, path, created }` and does not mutate the options it was
given, so `createAgent` received `undefined` and rejected it by contract:

```
createAgent: identity.machine_id is required
```

**The in-process join therefore threw on every start**, after `loadOrCreateIdentity` had already
created `device.json` and before anything could pair.

That single line accounts for the whole reported symptom, and every earlier explanation was reading
the wreckage:

| observed | why |
|---|---|
| `device.json` exists, `device_token: null` | the file is created one line above the throw |
| its mtime never moves across restarts | execution never reaches the pairing path |
| `w2m_devices` answers `401` | no token was ever obtained |
| `P2P_ANNOUNCE_FAILED: HTTP 401` | same token, same absence |

The evidence that finally settled it was the mtime, exactly as v0.8.9's own note said it would be —
but read the other way round: not "the write is missing" but "**nothing after the throw runs at all**".

### The second gate: a missing fingerprint discarded a derived key

`resolve()` mints a serial number from a hardware fingerprint and the fleet key from the account's
`userId`. The key does not depend on the fingerprint — but it was only returned *after* the
fingerprint succeeded:

```js
const hardware = await fingerprint();
if (!hardware.ok) return hardware;          // accountFields -- and the fleet key -- thrown away
const sn = buildSn({ accountCode: account.accountCode, ... });
return { ok: true, sn, ...accountFields, ... };
```

On the machine this was reported from, `readHardwareValues({ platform: 'win32' })` returns **zero**
usable values — both `MachineGuid` (via `reg query`) and the SMBIOS UUID (via PowerShell) come back
empty — so `fingerprint()` always failed and the fleet key was always discarded after being computed.

No amount of retrying could fix that, which is why v0.8.9's backoff did not help: the account *was*
readable, and the key *was* derived. The failure is now reported as what it is (`no_hardware_source`,
no SN), while `accountFields` still travels, so a caller that only needs to join a fleet is not held
hostage by a display identifier.

### The join is no longer a one-shot prologue

Two changes to the shape, both consequences of the above:

- **The mount path is fast.** It spends two derivation attempts (~2 s), not six (~62 s):
  `agent.start()` waits behind it, and any tool that asked to join waited behind that. The patient
  retrying moved into a background loop beside the running agent, where nothing is blocked by it.
- **A tool call can finish the join.** A tool call is proof the account profile exists — the session
  cannot answer a model request without it — so `w2m_status`, `w2m_devices` and `w2m_run` ask the
  in-process agent to join if it has not already.

The rate limit is respected by a **cooldown, not by permanence**: a successful join is memoised for
the life of the process, while a *failed* one is retried after ten seconds. Memoising the failure
would have reproduced the defect being fixed — a machine holding a rejected promise for ever, which
is the "intermittent miss becomes permanent" trap v0.8.7 fell into.

### Reporting

A machine that cannot join says so once, at warn, naming the reason — and says it again only if the
state changes. The previous wording guessed *"the profile may not be loaded yet"* for every
`ok: true` case, which after sixty seconds of backoff was usually the wrong explanation.

### Verified

`node scripts/verify-join.mjs` — **16 checks, all passing.** It drives the join against a stub agent
(the real `start()` talks to the public relay for the life of the process, which is why nothing
exercised this path before) and asserts:

- the agent is constructed with a real `identity.machine_id` — the assertion that catches the defect
  above, since `undefined` is what was being passed;
- nothing is paired while the account cannot be read, and no pairing is attempted without a key;
- the machine joins once the account answers, **and the token reaches `device.json`**;
- the pairing presents a 43-character derived fleet key and names the identity on disk;
- a machine holding a token never re-pairs, however many tools ask (`pair_rate_limit: 5`);
- a fingerprint failure still yields the fleet key, with `no_hardware_source` reported and no SN
  invented.

Two of those checks found real problems while being written, which is the point of having them. The
first draft of the cooldown rate-limited the *keyless* case as well, so the mount attempt failed on a
cold account and the very next tool call silently did nothing — the reported symptom, reproduced by
its own fix. And the mount budget, which had been ~62 s since v0.8.9 with `agent.start()` and every
tool call waiting behind it, is now ~2 s.

The script reads and writes a throwaway identity (`DSH_DEVICE_FILE`), so it never touches the real
`~/.dsh/xclient/device.json`.

Measured on the Windows host this was reported from:

```
late-account join
  ok    the agent is constructed
  ok    the agent receives a real identity (createAgent requires identity.machine_id)
  ok    nothing is paired while the account cannot be read
  ok    no pairing is attempted without a fleet key
  ok    the machine says it is in no fleet rather than staying silent
  ok    w2m_status is registered
  ok    the machine joins once the account answers
  ok    the token is persisted, not just held in memory
  ok    the pairing presents a derived fleet key
  ok    the pairing names the identity on disk
  ok    a machine holding a token never re-pairs
fleet key without a hardware fingerprint
  ok    no fingerprint means no serial number, and that is reported
  ok    no serial number is invented
  ok    the fleet key survives the fingerprint failure
  ok    the account code travels with it
all checks passed
```

## [0.8.9] — 2026-10-14

**The account answers lazily, and we asked once.**

### The defect

`getPlatformSession().userId` repeats the stable account id **from the most recent successful
`getProfile`**, and is `null` until one has happened. The account profile is a **lazy cache**, and
`startLocalStack` reads it **at mount** — before any model call has touched the profile.

So on a signed-in machine the first read returns *signed out*, the fleet key is never derived, no
pairing happens, and **nothing is written**. The evidence that pins it is `device.json`'s **mtime**:
unchanged since the first boot, so `saveDeviceToken` was not merely ineffective, it was **never
reached**.

**That also explains an earlier result that made no sense at the time:** v0.8.4 *did* pair once,
because by then the profile happened to be cached. **A timing-dependent success is the worst kind to
debug — the code is right and the outcome still varies.**

### v0.8.7 made it worse, without meaning to

*"Already paired → do not pair again"* turned an **intermittent miss into a permanent one**. A
machine that missed at startup never retried, and re-pairing had been the only thing rescuing it.
The rate-limit fix was correct and exposed a defect it did not create.

### Fixed

Derivation now **backs off and retries** (6 attempts, 2s doubling to a 30s cap) until a real key
appears or the budget runs out.

### And the silent branch that hid it

`resolve()` on the **stored-SN path** returns `ok: true` with `fleetKey: null`. The old code logged
only when `ok === false` — so the shape that was actually firing **produced no output anywhere**.

That is the same *silent no-op* class fixed in 0.8.5, reappearing **in the exact branch that was
failing**. Every outcome is now named:

| shape | reported as |
|---|---|
| `ok: true`, key present | `fleet key derived … on attempt N (fleet …)` |
| **`ok: true`, key null** | **`signed in, but the account returned no fleet key (the profile may not be loaded yet)`** |
| `ok: false` | the reason and detail, verbatim |
| budget exhausted | **`this machine is in NO fleet and will receive no work`** |

A machine in no fleet must never be quiet about it.

### Verified

**174 cases**. `tools.mjs` loads; the describer was exercised against all five shapes including the
one that previously said nothing.

## [0.8.8] — 2026-10-14

**A machine that joined without saying what it is — and a fix that was computed and never used.**

### `platform` and `caps` were never sent

`createAgent` accepts `platform` and `caps`, and `bin/w2m-localside.mjs` has always supplied them.
`startLocalStack` did not, so a machine that joined **through the plugin** appeared in the relay
complete and correct except for:

```
"os": null, "arch": null, "caps": {}
```

**The capability gate then had nothing to filter on — and that gate decides what work a machine is
offered.** So the device was registered, reachable, and unusable for anything the gate would have
matched it to.

Same shape as the rest of this series: the record was created and **the part that makes it useful was
not filled in**.

### The v0.8.5 fix was computed and never used

Worse, and found while making the change above:

```js
const resolvedStateDir = cfg.stateDir.trim() !== '' ? cfg.stateDir.trim() : resolveStateDir(...);
if (cfg.stateDir !== resolvedStateDir) { ctx.logger?.info?.(`w2m: stateDir was unset; using ...`); }
...
const agent = await createAgent({ stateDir: cfg.stateDir, ... });   // ← the EMPTY string
```

**v0.8.5 computed the resolved directory, logged it, and then passed the original empty string to
`createAgent`** — the exact call that throws `createAgent: stateDir is required`. So the second gate
v0.8.5 claimed to open was **still shut**, and the only evidence was a log line saying the resolved
path was being used.

*The log said the right thing while the code did the wrong thing* — which is worse than silence,
because silence sends you looking and a confident wrong log sends you away.

Both `createRelay` and `createAgent` now receive `resolvedStateDir`, and its definition was moved
**above** its first use: as a `const` used earlier in the same block it would have thrown
`ReferenceError: Cannot access 'resolvedStateDir' before initialization` at runtime, which
`node --check` cannot see because it is not a syntax error. Caught by checking the **order**, not the
syntax.

### Also sent now

`identityPath: loaded.path` — the device key belongs **beside the `device.json` this process actually
loaded**, not in a directory the agent guesses. Without it the in-process and standalone paths can
mint separate keypairs under one `machine_id` and overwrite each other's announcement (the v0.6.2
defect, which this path would have reintroduced).

### Verified

**174 cases**. `tools.mjs` loads; the ordering was confirmed by comparing line numbers rather than by
reading.

## [0.8.7] — 2026-10-14

**Pair only when there is no token — because the relay rate-limits pairing.**

### The defect

v0.8.6 made the token persist; it still **paired on every start**. The fleet key is derived
unconditionally, so `pairBy` was never null and the pairing branch always ran.

The relay allows `pair_rate_limit: 5` per minute. **Five restarts inside a minute hit the limit — and
a rate-limit refusal reads as a pairing failure, which reads as a fleet problem.** The symptom would
have pointed at the network, the relay, or the account, none of which would be at fault.

A machine that already holds a token has nothing to gain from pairing again: the relay would re-issue
one and invalidate the old, for no reason.

### Fixed

```js
const existingToken = loaded.identity.device_token;
const alreadyPaired = typeof existingToken === 'string' && existingToken !== '';

if (alreadyPaired) {
  ctx.logger?.info?.(`w2m: already paired (token in ${loaded.path}); not pairing again`);
} else if (pairBy !== null) {
  // pair once, then persist
}
```

**This also makes the persisted token load-bearing rather than an optimisation.** Without it every
start is a fresh pairing — which is why *the missing write in v0.8.5* and *the unconditional pairing
here* are **the same defect seen from two sides**: one threw the token away, the other had to
re-create it every time.

### A note on how this was found

Reported, with reasoning and a rate-limit number from the relay's own configuration — not from a
failing test. The distinction matters for what it implies: **nothing in the suite would have caught
it**, because every case starts from a fresh state and none of them restart the plugin in a loop.

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

## [0.8.6] — 2026-10-14

**The pairing worked and the token was thrown away.**

### The defect

`startLocalStack` called `agent.pair(...)` and **never persisted the result**. `agent.pair` sets
`identity.device_token` on its **in-memory object only**, so the observable behaviour was:

1. the account-derived key is computed ✅
2. the relay **accepts** the pair and registers the device ✅
3. the machine appears in `w2m_devices` ✅
4. **every authenticated call then answers `401 UNAUTHORIZED`** — `w2m_devices`, the P2P announce,
   all of it — because `device.json` still said `device_token: null` ❌

It reads as a permission failure and is **a missing write**.

The evidence that settles it is the shape of the value: not an empty string, not a truncated token —
**`null`**. A write that failed would leave the previous value; a write that never happened leaves
what the identity was created with.

### Why the CLI never had this bug

`bin/w2m-localside.mjs` has always done it:

```js
const paired = await agent.pair(flags.pair ?? null, undefined, fleetKey);
saveDeviceToken(paired.device_token, {});     // ← the CLI persists it
```

**The in-process path was written without that line.** So the two paths diverged in exactly the way
that produces a symptom in one and not the other — which is why it looked like a relay or permission
problem rather than a missing statement.

### Fixed

`saveDeviceToken(paired.device_token, identityOptions)` now runs after a successful pair, using the
**same options object** that loaded the identity. Reading with one set of options and writing with
another is how the plugin and the CLI once ended up each minting a keypair under one `machine_id`
(the v0.6.2 defect), so the options are captured once and used for both.

A failure to persist is **named at warn level**, including what it means: *"this machine will answer
401 to every authenticated call until that is fixed."* That exact condition was silent once already.

### The pattern this is the third instance of

* v0.8.4 wired the **derivation** but the gate in front of it was closed.
* v0.8.5 fixed the **second gate** (`stateDir`) but not the write behind it.
* v0.8.6 fixes the **write**.

Each time, the action was connected and its **persistence or precondition** was not. Worth stating
plainly because it is the shape of every bug in this series: **the thing that makes the result
survive is the thing that gets forgotten.**

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

## [0.8.5] — 2026-10-14

**Two gates, not one — and the silence that hid both.**

### The second gate

v0.8.4's analysis said the join sequence was blocked by `autoStartAgent` defaulting to false. That
was right and incomplete: **an unset `stateDir` threw as well**, so flipping the switch would have
failed too.

```
stateDir=empty string -> THREW: createAgent: stateDir is required
```

`createAgent` rejects a falsy `stateDir`; the plugin's resolved default is the empty string; and
`startLocalStack` passed it straight through. **Two gates in series, and the analysis found the one
in front.**

`stateDir` now resolves to a real path (`$DSH_HOME/xclient/localside`) when unset, resolved in
`startLocalStack` so `w2m_status` reports the path actually used — which is what makes *"where did it
write `device.json`"* answerable rather than a guess.

### The silence, which is the real defect

A machine could run v0.8.4, hold a valid signed-in account, reach the relay over **HTTP 200**, and
be in **no fleet** — with nothing anywhere reporting a problem. The eight tools registered, the
plugin looked healthy, and the join sequence simply never ran.

**A silent no-op that looks like success is the worst failure mode this plugin has had**, because
every diagnostic signal a person would reach for says the system is fine. The evidence that finally
settled it was an *absence* — no `device.json`, no `xclient`, no listening ports — and an absence
is only readable once you know what should have been there.

So the disabled branch now says so, at warn level, naming what it means and how to change it:

> `w2m: no agent is running on this machine, so it is in no fleet and will receive no work. Set autoStartAgent: true to join …`

One line turns *"why is this machine not in my fleet"* from an investigation into a log search.

### A test that measured a count instead of a message

`tools.test.mjs` asserted `warnings.length === 1` for the `dsh-tools` shim warning — a claim about
**every** warning the plugin will ever emit, so the new one broke a test about something else
entirely. It now matches the message it is about. **The count was never the property.**

### What is still required, stated plainly

The switch does not default to on, deliberately: a control machine that only *dispatches* to others
has no reason to be in the fleet itself. So joining requires `autoStartAgent: true` **and** a
`w2m` row in the profile — and the profile having no such row is the state every fresh install
starts in.

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

## [0.8.4] — 2026-10-14

**The last connection — the one that makes the feature user-facing.**

### The gap

The `chatops` half derived the fleet key from `userId` and exposed it. The `plugin/tools.mjs` half
accepted a key and handed it to the agent. **Neither knew about the other**, so the plugin read
`fleetKey` from config or `W2M_FLEET_KEY` — and a machine with a signed-in account still joined
nothing without a human setting a variable.

Two halves that each work, with no wire between them, is the same failure as v0.8.1's: the capability
existed and nothing exercised it.

### Now

`startLocalStack` derives the key itself, from the account, via the same
`createAccountIdentity({ ctx }).resolve()` the rest of the plugin uses. The derivation belongs there
because **the host is the only layer that can read the account** — a standalone agent cannot — so the
key must be produced where `ctx` is available rather than where it is used.

Verified with DSH's own context shape:

```
ctx.get('deepseekAccount') -> createAccountIdentity({ ctx }).resolve()
  -> fleetKey (43 chars) -> fleetId d5bb1b9ddf3faad4     (matches the existing derivation)
  signed-out                 -> named reason, no key invented
  no account service         -> named reason
```

### Two failure modes, handled differently on purpose

* A **derivation failure is caught and logged, not thrown** — an unpaired agent still runs and can be
  paired later, whereas a thrown start is a machine that never appears at all.
* **`signed-out` is logged at info, not warn** — being signed out is a normal state, and the design
  says a machine with no account must not be given a random fleet. Warning about it would train an
  operator to ignore the line that matters.

An explicitly configured `fleetKey` still wins, and the log names which source was used — `paired by
fleet key (account)` or `(config)` — so nobody has to guess where the key came from.

### A defect in this patch, caught by the compiler

The first edit consumed the `} catch (error) {` line and left the catch body inside the `try`, which
`node --check` reported immediately. Worth recording because the same edit pattern — replacing a
block by line range — corrupted a function in v0.8.1 as well.

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

### This is what closes the reported bug

A new machine, installed and signed into the same account, derives its fleet key, presents it at
pairing, and lands in the same fleet — **with no key to copy and no operator step**. That is the
behaviour the original report asked for, and it is now reachable by configuration rather than by
convention.

## [0.8.3] — 2026-10-14

**The last wire, and the reason it was never there.**

### `autoStartAgent` was dead code

The option existed, was documented, and **threw on its first call**. `startLocalStack` built its
`createAgent` arguments as `projectDir` (the option is `project`), omitted `identity` (which is
required), and passed a `pairingCode` that `createAgent` does not accept.

Verified rather than inferred — calling `createAgent` with that exact shape:

```
createAgent THREW: createAgent: project is required
```

**So the code path that was supposed to bring an agent up had never run.** That is why the
fleet-join wire appeared to be missing: the place it was meant to live could not be reached at all.
An option that exists, is documented, and cannot execute is worse than one that is absent — it
reads as a feature.

### Two more things wrong with the shape

* **It created a local relay unconditionally.** For a machine joining a shared fleet that is the
  opposite of what is wanted: the machine must connect to the relay that already exists, not mint
  another one — and with `rabbitUrl` pointing at a remote host it would have tried to bind a relay
  on that hostname. It now stands up a local relay **only when the configured URL actually is
  local**, and otherwise logs that it is joining the relay at the given address.
* **Nothing paired the agent.** Even a started agent could fetch no offers, which looks identical to
  a fleet with no work.

### Now

`startLocalStack` passes the option names `createAgent` actually documents, loads the identity from
the **same file the CLI uses** — so one machine has one identity whether the agent runs in-process
or as its own process, rather than each minting a keypair and overwriting the other's announcement
under a shared `machine_id` (the v0.6.2 defect, in a new place) — and **pairs by the account fleet
key**, falling back to a pairing code.

Pairing is attempted **before** `agent.start()`, and a failure is **named at warn level** rather than
swallowed: an agent that failed to pair runs and does nothing, which is indistinguishable from a
quiet fleet.

### Config

`fleetKey` is read from the config layer or `W2M_FLEET_KEY`. The key must be **handed down** rather
than computed where it is used, because a standalone agent cannot read the signed-in account — which
is why it comes from the host.

### Verified

**132 cases** across the tools, apply and fleet-join suites. `tools.mjs` loads. The 12 agent-suite
failures remain pre-existing and environmental, measured against an untouched clone of the same
commit.

### ⚠️ Not yet proven on real hardware

The wiring is fixed and the mechanism was verified end to end in v0.8.2, but **no machine has yet
joined a fleet through this path in a live run**. That is the next check, and it needs a machine
that is not already paired.

## [0.8.2] — 2026-10-14

**The client half of the auto-join.** v0.8.1 landed the credential and the relay's acceptance of
it; this is the wiring that makes a real machine use them.

### What is now connected

| piece | what it does |
|---|---|
| `account.mjs` | derives the fleet key on **every** resolve, including the stored-SN path |
| `index.mjs` | exposes it as `fleetKey` — the key, never the account id |
| `agent.mjs` | `pair(code, userId, fleetKey)`, sending only the discriminator that was given |
| `w2m-localside` | `--fleet-key`, a peer of `--pair` |
| relay | derives the fleet from the key; never believes a claimed one |

**Verified end to end:** an agent given **only** `--fleet-key`, against a relay with **no fleet of
its own**, pairs and lands in the account-derived fleet (`d5bb1b9ddf3faad4`, `source=fleet_key`).

### The bug that would have made it work exactly once

`resolve()` returned early when an SN was already stored and never read the account at all. That is
right for the SN — it must not be regenerated, or every restart looks like a new device — and
**wrong for the key**: a machine has a stored SN from its *second* start onward, so it would have
derived a fleet key once and never again.

**The auto-join would have worked on a machine's first boot and silently stopped afterwards** — the
hardest kind of bug to see, because it works when you test it. Found by asking what the stored-SN
path actually does, rather than by reading the happy path.

### The bug in this release's own patch

The fleet-key handling was first inserted **inside `if (flags.pair)`**, so the key path could only
run when a pairing code was also supplied — precisely the case it exists to avoid. **It worked
whenever anyone tested it with a code, and did nothing in the case that mattered.** The end-to-end
test is what caught it, not review.

### A provenance bug, also caught by testing

A device that paired by key was recorded as `fleet_source: 'pairing_code'`, because the relay builds
a synthetic code record so the binding reads from one place. That matters: `fleet_source` is what an
operator reads in `devices.json` to answer *"how did this machine get into my fleet?"*, and
answering "a pairing code" when there was none sends them looking for a code never issued.

### Also

`HANDOFF.md` records the state, the single reachable path to the Mac, and the traps this codebase
has already fallen into.

### Verified

**585 chatops cases pass.** The 12 agent-suite failures are **pre-existing and environmental** —
measured against an untouched clone of the same commit, both give **147 tests / 133 pass / 12 fail /
2 skipped**, identical, so this change is not the cause.

### ⚠️ Still not user-facing

**The plugin does not yet spawn the agent or hand it the key**, so with the default configuration a
new PC still will not auto-join. The mechanism is complete and verified; that last wire is what
makes it something a user experiences rather than something a test proves.

## [0.8.1] — 2026-10-14

**A machine on the same account joins the same fleet with no human step** — the requirement that
had no implementation behind it, and the bug that made it visible.

### The reported bug, and what it actually was

A new PC signed into the same DeepSeek account did **not** join the same fleet. Traced rather than
guessed, the cause was four gaps stacked:

* the plugin computed its SN, derived `fleet` from the account code, **logged it, and never used it
  for anything**;
* nothing called `/v1/pair`;
* `autoStartAgent` defaults to **false**, so no agent started;
* and even with an agent, membership needed a **human-typed one-time pairing code**.

So "same account joins the same fleet automatically" was a stated requirement with no code path.

### Why the obvious fix is the wrong one

The obvious fix is to use `accountCode` as the credential. `account.mjs` documents the trade
honestly — *"the cost of 32 bits, stated rather than hidden"* — and for **grouping** 32 bits is
fine. As a **secret** it is not: 2^32 is brute-forceable, so authorising a join with it would let
anyone enumerate their way into any fleet.

**The bug was a conflation: a grouping identifier was doing duty as a secret.**

### The fix

The machines of one account share something an outsider cannot obtain — the ability to read
`userId` — so the fleet secret is derived from it:

```
fleetKey = HMAC-SHA256(userId, "w2m-fleet-v1")     256 bits, same-account machines only
fleetId  = SHA-256(fleetKey)                       what the relay groups by
```

**Presenting the key is the proof.** The relay *computes* a fleet id from the key it is given
rather than believing a claimed one, so a device can only land in the fleet whose key it holds.
No trust-on-first-use, no operator configuration, no account lookup, nothing to forge — and a
device without the key forms a different, empty fleet instead of joining someone else's.

`deriveAccountFleetKey` **refuses anything shorter than 16 characters**, and the refusal is asserted
in a test rather than left to a comment: passing the 8-hex account code by mistake would otherwise
produce a key that *looks* strong and is not — the worst kind of credential failure, because it is
silent.

### The relay side

`deviceFleetFields` gains a third source, ordered by authority:

| source | who decided |
|---|---|
| `pairing_code` | the operator, by issuing the code |
| **`fleet_key`** | **the account, by derivation** — the auto-join path |
| `request` | the relay operator, via `--fleet` |

A **malformed key does not fall through** to the relay's own fleet. Falling through would be the
silent wrong answer: a device that meant to join its account would be placed in an unrelated fleet
and told nothing. It is refused, with the reason recorded on the device record.

This also removes the deployment problem recorded in v0.7.9: `--fleet` no longer needs an operator
to compute and hand-carry a 32-bit code, because the relay needs to know **nothing** about any
account.

### Verified

* **21 cases** for the derivation: same account agrees, different accounts differ, the 32-bit code
  is refused, the wire form round-trips, a client and a relay independently derive the same id, and
  comparison is constant-time.
* The derived bytes are **pinned**, not self-compared — a regression would silently split every
  existing fleet into two halves that cannot see each other, with no error anywhere.
* **223 cases** across the relay, wiring, scoping and join suites, unchanged.

### ⚠️ What is still not wired

The **derivation and the relay's acceptance** are done. The pieces that make a real machine use
them are not:

* `index.mjs` does not yet derive or expose the fleet key;
* the agent does not yet present it at pairing;
* `autoStartAgent` still defaults to false.

**Until those land, a new PC still will not auto-join.** The credential exists and is accepted; the
client does not yet offer it.

## [0.8.0] — 2026-10-14

**The first release on npm since 0.6.3.** Eight versions of work — account identity, fleet
isolation, device signing, lease-takeover guards, `/run`, the durability policy, and the server's
own configuration — now reachable by `npm install` rather than only by git tag.

### What is in it, and what each part actually guarantees

**Account identity and the SN** (0.7.5). A machine derives a serial number from
`account code + hardware code + time code`. The account code is `sha256(userId)` truncated, so it
can be handed to a relay without disclosing the account id — which is what makes the next part
possible on a server that has no account login of its own.

**Fleet isolation** (0.7.6, wired in 0.7.8). `createTask` no longer selects every device on the
relay. It selects the requester's fleet, where the fleet is read **from the pairing code** — a
device cannot name its own fleet, because a device that could would join any fleet and every
signature would faithfully attest to it.

The migration is two-mode and both modes are tested against the relay's real state:

| relay | requester | reaches |
|---|---|---|
| unscoped | operator, or a fleetless device | **every device — the pre-0.7.8 rule, unchanged** |
| scoped | operator | the relay's fleet |
| scoped | a device in that fleet | that fleet only |
| scoped | a fleetless device | **nothing**, with the reason named |

**Deploying cannot be an outage; scoping cannot be a silent grant.**

**Per-device Ed25519 signing** (0.7.10, verified by the relay in 0.7.11). The relay already signed
requests, but with **HMAC over a shared secret** — everyone who can sign can verify, so that proves
only that the sender knows the secret, which is every device. A device key proves *which* device.

The relay now tries the device key first and converges one machine at a time:

| device | outcome |
|---|---|
| sends no signature | shared secret, byte-for-byte unchanged |
| stored key, good signature | verified by the key |
| stored key, **bad** signature | **refused, and not retried against the shared secret** |

That third row is the whole point: falling back would make the strong mechanism *optional* for
anyone able to produce a malformed signature, which is everyone.

**Lease-takeover guards** (0.7.9). `_takeover` would re-offer a dead machine's index to **every idle
device the relay holds**, with no fleet filter and no consideration of whether the task writes. So a
device in another account could be handed the work, and a writing task could be run twice. Both are
now refused with a named reason.

**`/run` with two privilege levels** (0.7.11).

| form | who | what it does | capability |
|---|---|---|---|
| `/run <argv>` | expert | dispatches those arguments, uninterpreted | `fleet.dispatch` |
| `/run --ask <words>` | beginner | asks; the agent answers and **proposes** | `operate` |

A beginner describing what they want is **not** executing anything: the request goes to a session,
and if the session wants something run it emits `/run <argv>`, which still needs `fleet.dispatch`.
**A low-privilege window can ask freely and cannot cause a fleet execution by asking.**

**Durability policy** (0.7.11). The requirement — *"10× redundancy, tolerate losing 90% of nodes"* —
is two different claims, and the arithmetic decides the architecture:

```
n=   3  copies=3/10   loss=100%  basis=server_complete
n= 100  copies=10/10  loss=100%  basis=server_complete
--- with no server copy ---
n=   3  loss=67%   meets=false      <- three devices cannot reach 90% alone
n=  10  loss=90%   meets=true
```

At three devices the guarantee is **the server's complete copy**; device redundancy alone gives
**67%**. So the server is the **authority at every tier**, not one more replica to drop once devices
are plentiful.

**`deploy/server/`**. The three systemd units as the live host runs them, and the deployment script
whose step order is the safety argument: checksum before unpacking, back up in place, entry-point
check before swapping, then restart, health-check, and automatic rollback on failure.

### The secrets guard

`scripts/scan-for-secrets.mjs` fails a release on a credential shape in any **tracked file**. It
exists because `.gitignore` refuses a *path*, while the ways a credential escapes are pasting one
into a source file, a fixture, or an example. The relay's `operator-token.txt` — full control of the
fleet — is the thing it protects.

Writing it exposed **six defects in the guard itself**, every one a silent-off failure that looks
like success: an unconditional `statSync` that made an injected reader unreachable; a relative path
that made the scan report zero findings across zero files; a token regex that missed camelCase; a
slug rule that rejected `p2p-crypto-operator` over a digit; a duplicate rule; and a test that
hard-coded rule names and so measured the name rather than the behaviour.

### WeChat, measured

Reading and sending both work against the live service. The body is `item_list[0].text_item.text`,
the cursor is `get_updates_buf`, login confirms as `confirmed` (not `scaned`), the token is valid
**>280 s**, and a send nests under `msg` with `message_type: 2` and `message_state: 2`, returning a
`message_id` and no `ret`. Four wrong guesses on the wire format made a working feature look broken,
including a false conclusion that the token lived only 30 seconds.

### The honest gaps

* **`shouldHandOff()` and `reconcileResults()` are written and tested but not wired.** The fleet and
  write guards are in the relay's takeover path; single-successor selection is not.
* **The relay defaults to unscoped**, so accounts are mixed unless an operator sets `--fleet`. Doing
  so requires an account code, which a headless server cannot produce, and a re-pair of every
  device — during which a fleetless device reaches nothing.
* **`/run` is not yet wired to the WeChat channel.** The parser, the renderer, and the capability
  split are complete and tested; the last link is the adapter.
* **The Mac cannot be updated remotely.** Its allow-list refuses anything but `node -e`, and a DSH
  restart would kill the only channel to it.
* **`/v1/devices` is not narrowed to the caller's fleet** — a device can still *list* another
  fleet's machines, though it cannot *reach* them.

### Verified

**542 chatops cases across twenty-two suites**, and the relay's own **168 unchanged**.

## [0.7.11] — 2026-10-14

**The relay verifies device signatures, `/run` reaches the fleet from a chat window, the durability
policy is written down, and the server's own configuration is in the repository.**

### Relay verifies device Ed25519 signatures

`verifySignature` now tries the per-device path before the shared secret. The design goal is
**convergence**: a fleet updates one machine at a time, with no flag and no coordination.

| device | outcome |
|---|---|
| sends no signature | shared secret — byte-for-byte unchanged |
| has a stored key, good signature | verified by the key, `device: true` |
| has a stored key, **bad** signature | **refused, and not retried against the shared secret** |

That third row is the one that matters. Falling back would make the strong mechanism *optional* for
anyone able to produce a malformed signature, which is everyone.

*Defect found while writing it:* `NonceCache` exposes `accept`, not `remember`. The test caught it.

### `/run` — two forms, two privilege levels

| form | who | what it does | capability |
|---|---|---|---|
| `/run <argv>` | expert | dispatches those arguments, uninterpreted | `fleet.dispatch` |
| `/run --ask <words>` | beginner | asks; the agent answers and **proposes** | `operate` |

The asymmetry is the point. A beginner describing what they want is **not** executing anything: the
request goes to a session, the session answers in prose, and if it wants something run it emits
`/run <argv>` — which still needs `fleet.dispatch`. So a low-privilege window can ask freely and
**cannot cause a fleet execution by asking**.

The form is **declared** (`--ask`), never inferred from how the text reads. An inferred distinction
gets it wrong in both directions, and the direction that matters is dispatching a sentence as if it
were a program.

Shell metacharacters are refused rather than passed through, because the fleet takes an argv array
and never a shell string — `|` would arrive as a literal argument and quietly do something other
than what was typed. **A command that runs and does the wrong thing is worse than a refusal.**

### Durability policy

The requirement was given as *"10× redundancy, tolerate losing 90% of nodes"*. Those are two
different claims, and conflating them yields a system that looks compliant and is not:

* **10 replicas** is a storage-layout property, and is **impossible** below 10 nodes;
* **surviving 90% loss** counts every copy, including the authoritative one.

Measured, with the arithmetic in tests:

```
n=   3  copies=3/10   loss=100%  basis=server_complete
n= 100  copies=10/10  loss=100%  basis=server_complete
n=1000  copies=10/10  loss=100%  basis=server_complete
--- with no server copy ---
n=   3  loss=67%   meets=false
n=  10  loss=90%   meets=true
```

So at three devices the 90% guarantee is met **by the server's complete copy**, and device
redundancy alone would give only 67%. That is why the policy treats the server as the **authority at
every tier** rather than as one more replica that can be dropped once devices are plentiful.
`durabilityReport()` names the basis in a note, so a health number cannot be read without its
provenance, and `server_copy_required` is true at every fleet size.

Tiers, inclusive at the bottom as measured by tests: `<100` server, `100–999` hybrid, `>=1000`
distributed with the server as a fallback that is still written to.

### The server's configuration is now in the repository

`deploy/server/` holds the three systemd units **as the live host actually runs them** —
`w2m-rabbit`, `w2m-stun`, `w2m-localside` — plus `deploy-w2m.sh`, the deployment script that
performed the last two upgrades.

The script's step order *is* the safety argument: verify the checksum **before** unpacking (a
truncated upload must never become a service), back up in place (rollback must not depend on the
network), check for entry points **before** swapping (a `git archive` of the wrong directory
unpacks cleanly and contains no `bin/`), then restart, health-check, and **roll back automatically**
on failure.

**`/var/lib/w2m/rabbit/` is not in the repository and must never be.** It holds `operator-token.txt`
— full control of the fleet — and the task ledger. Two mechanisms keep that true, because one is
not enough: `.gitignore` refuses the **paths**, and `scripts/scan-for-secrets.mjs` reads the
**content** of every tracked file. A `.gitignore` refuses a path; the ways a credential actually
escapes are pasting one into a source file, a fixture, or an example.

### The secrets guard, and the six defects it caught in itself

The guard is only worth having if it works, so it was tested against the real repository — and it
failed in ways worth recording, every one of them a **silent-off** failure that would look like
success:

1. **`statSync` was called unconditionally**, so an injected reader could never be reached — the
   stat hit the real filesystem, threw, and the `catch` swallowed it;
2. **a relative path was passed to `readFile`**, so every file threw and the scan reported
   **zero findings across zero files**;
3. **the regex `operator[_-]?token` missed camelCase** — `operatorToken`, which is how this project
   actually spells it;
4. **a slug rule requiring only `[a-z]`** rejected `p2p-crypto-operator` because of the digit in
   `p2p`;
5. a **duplicate rule** reported one match twice;
6. a test **hard-coded rule names**, so renaming a rule broke a test that was measuring the name
   rather than the behaviour.

Findings on the real tree went from 3 false positives → 5 exposed fixtures → **0 blocking, 14 for
review** (all ordinary 64-hex hashes). `REVIEW` is deliberately **not fatal**: a scanner whose false
positives block releases is a scanner someone deletes.

### Verified

**542 chatops cases across twenty-two suites**, the relay's own **168 unchanged**.

### Still not done

* **`handoff.mjs`'s `shouldHandOff()` and `reconcileResults()` remain unwired** — the fleet and write
  guards are in the relay's takeover path, the single-successor selection is not.
* **The Linux server and Windows plugin are on v0.7.10**; the Mac is on **v0.6.3** and cannot be
  updated remotely (its allow-list refuses anything but `node -e`, and a DSH restart would kill the
  only channel to it).
* **The relay is unscoped**, so accounts remain mixed at runtime.
* **npm has not been published since 0.6.3** and no credential is available on this host.
* **WeChat: reading works, sending works, `/run` is not yet wired to the channel.**

## [0.7.10] — 2026-10-14

**Per-device Ed25519 request signing — the part of the signature chain that can be built without
locking anyone out.** The relay does not enforce it yet, deliberately.

### Why a second signing mechanism

The relay already has request signing, and it is **HMAC over a shared secret**: everyone who can
sign can also verify, so the relay holds a credential that every device holds. That is fine when
one operator owns every machine, and it is the wrong shape for what this workstream is about —
proving that *this specific device* is in *this account's* fleet. **A shared secret proves only
that the sender knows the secret, which is every device.**

`src/chatops/device-signing.mjs` signs with a **device-held Ed25519 private key**, so the relay
verifies with a public key it stores and never holds anything that could impersonate the device.

### The defect that would have made all of it useless

The signed bytes are the **relay's own canonical string**, reproduced byte for byte:

```
v1\n<METHOD>\n<path>\n<timestamp>\n<nonce>\n<sha256-of-body>
```

The first version hashed the body with `createHash('sha256', …)`. **The relay uses
`createHmac('sha256', Buffer.alloc(0))`**, and those are not the same function: HMAC wraps the key
with its own padding, so an empty body hashes to `b613679a…` rather than `e3b0c442…`.

**Every signature would have failed, forever, with no clue why.** A probe that signed four requests
with both implementations and compared the strings is what caught it — and that comparison is now
a test, because it is the only reason this is correct.

### Added

* **`src/chatops/device-signing.mjs`** — a device signer, a verifier, and the shared canonical
  string. Compatibility with the existing mechanism is deliberate: one verified string rather than
  two that must be kept in step, and the relay can tell the two apart by **whether the device has a
  public key** — no protocol flag, no version negotiation, no second header a client could forget.
* **`pair()` accepts and stores `public_key`.** Not validated there on purpose: a malformed key
  fails at verification with a named reason, while rejecting a pairing over it would lock out every
  existing device the moment the field appeared. A device that sends no key keeps working, with
  `public_key: null` meaning *"signs with the shared secret or not at all"*.
* **`publicDevice` reports `public_key_present`** as a boolean, not the key. The key is not a
  secret, but a device list is read by every device, and verification happens relay-side.
* `test/chatops-device-signing.test.mjs` — 22 cases.

### The test that matters most

`canonicalString` is compared against **the relay's own implementation, imported** — not against a
reimplementation of the expectation. A test that asserts what the author believed the format to be
would have passed for the broken version.

### ⚠️ Not enforced, and that is the point

**The relay does not verify device signatures yet.** A device that signs today is signing into a
relay that does not check it. Two reasons this is the right order:

1. **Enforcement is what would lock people out.** A relay that *requires* a signature refuses every
   device that has not been updated — including all four current machines. Landing verification and
   enforcement together is how a safety feature becomes an outage.
2. **The fleet rollout is blocked anyway** (see v0.7.9): the shared relay cannot produce an account
   code, and the Mac cannot be updated without physical access.

So the sequence is: ship the signing, ship the verification, update every device, then turn
enforcement on — with `requireSignature` already meaning *"insist"* in the relay's existing
vocabulary, so the switch is one flag rather than a new mechanism.

### Verified

**459 chatops cases across eighteen suites**; the relay's own **146 unchanged**.

### Still not done

* **No signature is verified by the relay.** `verifyDeviceSignature` has no caller in `src/relay/`.
* **Hand-off is guarded but not refined** — `shouldHandOff()` and `reconcileResults()` remain
  unwired; the fleet and write guards from v0.7.9 are in the relay's takeover path.
* **The Linux server, the Mac and the Windows plugin are still on older versions**, and the relay
  is unscoped, so accounts remain mixed at runtime.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.9] — 2026-10-14

**Two safety guards on lease takeover, and an honest account of what is still not connected.**

### What was already there, and what was missing

`_takeover` existed and already ran on `halt: 'now'`, so hand-off was **not absent** — v0.7.7's
note that it "is not implemented" was about `handoff.mjs` not being called, and this release
corrects the record: the relay's own takeover path was live and had been since v0.1.x.

**What it lacked was the two guards**, and both are reachable defects rather than theory:

1. **A device in another account could be handed the work.** `_takeover` iterated
   `this.devices.values()` with no fleet filter, so on a relay serving several fleets a takeover
   **crossed accounts** — the isolation this whole series is about, broken in the one path that is
   easy to miss because it only runs when something has already gone wrong.
2. **A writing task could be run a second time.** Hand-off makes execution at-least-once. Harmless
   for `node --test`; a duplicated write for anything else, applied on a machine with no idea the
   first one already ran.

Both are now refused with a named reason (`LEASE_TAKEOVER_REFUSED`, `write_not_idempotent`).

### Deliberately not changed

The re-offer **shape** is untouched. PROTOCOL v0.0.1 defines no per-index lease reassignment, so
takeover is expressed as a re-offer to every idle machine — a fan-out, not a single successor.
Narrowing it to one successor is what `handoff.mjs`'s `shouldHandOff()` would do, and it is a
**protocol revision**, not a wiring change, so it is not made here. `reconcileResults()` is
likewise ready and unused: nothing calls it yet.

### The prerequisite this release discovered, which blocks the fleet rollout

**The shared Linux server cannot produce an account code.** Its `.dsh` holds no account
credentials — it is a headless VPS running the relay, STUN and a localside agent, not a signed-in
DSH client. So `--fleet <account code>` has **no source on the server**, and the value must be
computed on a machine that *is* signed in and then handed over.

That is workable — the account code is an opaque `sha256(userId)` prefix, so passing it does not
disclose the account id — but it means the rollout is:

1. read the account code on a signed-in machine,
2. restart the relay with `--fleet <code>`,
3. **re-pair every device**, because a device only receives a fleet from the pairing code, and
   every existing device paired without one.

**Step 3 is the risk**: on a scoped relay a fleetless device reaches **nothing**, so all four
current devices go silent until each is re-paired. That is the intended fail-safe direction, and it
is still an outage until the re-pairing completes.

### Added

* `test/chatops-takeover.test.mjs` — 5 cases, booting a real relay: a write task is refused and
  names why; a read task is still re-offered; a takeover skips a device in another fleet; it skips
  a fleetless device on a scoped relay; and an unscoped relay behaves exactly as before.

### Verified

**437 chatops cases across seventeen suites**, and the relay's own 165 unchanged.

### Still not done

* **`shouldHandOff()` and `reconcileResults()` are not wired.** The guards above are in the
  relay's takeover path; the richer single-successor selection and the late-result rule are not.
* **No device generates a keypair and no request carries a signature.** The relay's existing HMAC
  signing is a different mechanism and remains untouched, so the signature chain is **not enforced**.
* **`/v1/devices` is not narrowed to the caller's fleet.**
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.8] — 2026-10-14

**The wiring.** v0.7.5–v0.7.7 shipped modules that nothing called. This release connects them, so
account isolation and fleet scoping are **in effect** rather than merely tested.

### What changed in the relay

* **`src/relay/state.mjs`** — `createTask` no longer selects `[...this.devices.values()]` with no
  filter. It calls `targetsFor()` from `fleet-wiring.mjs`, which applies the fleet rule.
* **`createPairingCode` now carries the relay's fleet**, and `pair()` writes it onto the device.
  This is the link the whole scheme hangs on, and it is easy to omit: `pair()` reads the fleet
  *from the code*, so a code with no fleet pairs a device into no fleet — and a device in no fleet
  reaches nothing on a scoped relay. `--fleet X` would then have had **no effect on anything,
  silently**.
* **`publicDevice` carries `fleet_id` and `fleet_source`.** `devices.json` is written from this
  shape, so a fleet that lived only on the in-memory record would have vanished on the next
  restart — which is precisely when an operator looks at it. A live test caught that.
* **`bin/w2m-rabbit.mjs`** gains `--fleet <id>`.

### The migration, which is the part that could have gone wrong

The shared relay holds four devices that paired before fleets existed, none with a `fleet_id`.
The rule is therefore two-mode, and both modes are tested against the relay's *actual* state:

| relay | requester | reaches |
|---|---|---|
| unscoped (`--fleet` absent) | operator, or a fleetless device | **every device — byte-for-byte the old behaviour** |
| scoped (`--fleet X`) | operator | **fleet X** |
| scoped | a device in fleet X | **fleet X only** |
| scoped | a fleetless device | **nothing**, with the reason named |

**Deploying this cannot be an outage**, and **scoping it cannot be a silent grant** — the second
row of that table is what makes the first row safe to ship.

### Three defects found while wiring, all by tests

1. **`NO_ELIGIBLE_DEVICE` was invented.** It broke the one relay test that pins the contract, and
   worse, it would have broken **callers**: `chatops/fleet.mjs` reads `NO_ONLINE_DEVICE` to
   produce *"start an agent on each machine"*, and an unrecognised code falls through to a generic
   refusal. The protocol's code table is part of the protocol; the new information went into
   `detail` instead.
2. **An absent requester was refused as an unknown one.** An operator is not a device —
   `authorizeTaskDispatch` returns `{ role: 'operator', machine_id: null }` — so treating "no
   device" as "unknown device" turned every operator dispatch into an error and broke **74 relay
   tests at once**.
3. **An operator dispatch on a scoped relay was refused.** Configuring the fleet made the operator
   unable to dispatch, which is the least useful possible outcome. The relay's own `fleetId` *is*
   a statement about which fleet it serves, so an operator dispatch has an unambiguous scope and
   lands inside it.

### Verification

* **432 chatops cases across sixteen suites**, including **ten that boot a real relay** and assert
  the three links end to end: `--fleet` → the code carries it → the device carries it → dispatch
  reaches only that fleet.
* **The relay's own 168 tests pass unchanged**, which is the migration guarantee: the legacy path
  reproduces the rule it replaced.
* The repository's wider suite keeps its baseline of one environmental failure (a missing
  `node_modules/eslint`).

### Deployed

The Linux server (`vultr`, `202.182.123.154`) was updated **v0.6.3 → v0.7.7** with a scripted
deploy: checksum verified before unpacking, the previous tree backed up, the new tree staged and
checked for entry points, then swapped, restarted and health-checked, with automatic rollback on
failure. Relay state (`/var/lib/w2m/rabbit`) was untouched — the 839 KB ledger and the operator
token both survived.

**It runs unscoped**, so its four devices keep working exactly as before. Setting `--fleet` is
what turns isolation on, and it is now a one-line change plus a re-pair.

### Still not done

* **Hand-off is not wired into the relay's lease sweep.** `handoff.mjs` is complete and tested;
  `shouldHandOff()` is not yet called on lease expiry. A silent machine is still simply silent.
* **Device-side signals are not sent.** No device generates a keypair in a real run, and no request
  carries a signature. The relay's existing HMAC signing (`signing.mjs`) is a different mechanism
  and is untouched.
* **`/v1/devices` is not narrowed to the caller's own fleet.** A device on a relay can still list
  every fleet's machines; it cannot *reach* them, which is the part that matters for isolation.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.7] — 2026-10-14

**Hand-off: what happens when the machine holding a task does not answer.** `ACCOUNT-FLEET-DESIGN.md`
§4, built.

> **Two things this release does not do, said first.**
>
> 1. **The relay still does not call any of the v0.7.6/v0.7.7 modules.** Dispatch is still
>    `[...this.devices.values()]`, no keypair is generated, no statement is issued, no request is
>    signed, and no lease is ever handed off. **At runtime, accounts remain mixed and a silent PC
>    is still simply silent.** These releases are the mechanism.
> 2. **The Linux server was not updated.** Its SSH credentials were not available to me
>    (`ssh_run.py` deliberately reads them from the environment with no fallback in the file), so
>    the relay there still runs v0.6.3-era code. Updating it needs `W2M_PASS`.

### Added

* **`src/chatops/handoff.mjs`** — the hand-off decision, and the sharp edge it names.
  * **`write: true` plus `halt: 'now'` is refused outright.** Hand-off turns execution from
    at-most-once into **at-least-once**: a command may now run on two machines. Harmless for
    `node --test`, and a second application of the same change for anything that writes — on a
    machine with no idea the first one already ran. Refused, not warned about.
  * **A late result never overwrites its successor.** The winner is the **highest attempt**, not
    the last to arrive: arrival order is a property of the network, and a verdict that depends on
    it is a verdict nobody can reason about. Superseded results are **kept, not dropped** — a late
    result from the machine that went silent says it was slow, not dead, and discarding it turns a
    diagnosable situation into an unexplained one.
  * **The machine that just went silent is never offered its own slice again** — the one
    reassignment guaranteed to be useless.
  * **A slow machine is not pre-empted.** Two separate questions, in order: is the lease still
    valid, and has the grace elapsed since it expired.
  * **Every refusal is named**, because *"why did nothing take over"* has several answers with
    different fixes: cancelled, `halt: 'never'`, a writing task, no other machine, every machine
    already tried, not yet expired.

* `test/chatops-handoff.test.mjs` — 29 cases.

### Three defects found in this module by its own tests

Worth recording, because each was invisible in the code and obvious in a failure:

1. **The grace-period arithmetic was on the wrong side.** The first version asked
   `now + grace <= until`, which declines when the grace is *short* and takes over when it is
   *long* — the exact inverse. Two questions were being collapsed into one expression; they are
   now separate branches.
2. **`ALL_TRIED` was unreachable.** It was decided by asking "is there an untried machine", which
   is always false in the all-tried case, so the reason could never fire and the two refusals were
   indistinguishable. The real question is how many machines *exist*, not how many are untried.
3. **A missing attempt number was treated as the newest.** `?? Infinity` made a frame with no
   attempt win the aggregate — letting a stale result from a superseded lease override its
   successor, which is the precise inversion `reconcileResults` exists to prevent. A missing
   attempt is an **old** frame: it now sorts as `0`.

### Still not connected

`auth.mjs`, `fleet-scope.mjs` and `handoff.mjs` are complete and tested, and **nothing in `src/`
outside `src/chatops/` imports them.** The relay must still:

* bind pairing codes to a fleet and sign a statement per device,
* verify the statement and the request signature on every call,
* replace the target selection with `selectTargets()`,
* call `shouldHandOff()` on lease expiry, and `reconcileResults()` when results arrive.

Until that is done, the isolation and the hand-off are **designed and tested, not in effect**.

## [0.7.6] — 2026-10-14

**The authorisation chain and the fleet scoping rule.** `ACCOUNT-FLEET-DESIGN.md` §3, built.

> **Read this before trusting the isolation.** The two modules below are complete and tested, but
> **the relay does not call them yet.** `src/relay/state.mjs` still selects targets with
> `[...this.devices.values()]`, so at runtime accounts remain mixed. Wiring it is the next step
> and is not in this release. Saying "isolation is implemented" now would be false.

### Added

* **`src/chatops/auth.mjs`** — the device keypair and the authorisation statement.
  * A device generates an **Ed25519** keypair on first run; the private key is exported for
    persistence and the caller is told to write it 0600 and never log it.
  * The relay seals a statement over `(fleet_id, machine_id, sn, public_key, issued_at, expires_at)`.
  * Every request carries a signature over `(method, path, timestamp, nonce, body_hash)`.
  * **The canonical encoding is built by hand, with length-prefixed fields and a fixed field
    order.** Two JSON encodings of one object can differ, so a verifier that re-serialised what it
    received would be verifying its own encoding; and without length prefixes `{a:'x',b:'yz'}` and
    `{a:'xy',b:'z'}` concatenate identically. The wire form carries **the exact bytes that were
    signed**, so nothing is ever reassembled.
  * **Expiry is mandatory** — a statement without one is a permanent credential. Checked *before*
    the canonical form is recomputed, so a missing expiry reports `no_expiry` rather than the
    technically-true-but-useless `malformed`. A test found that ordering.
  * Replay defence is a **bounded** nonce window, injected: an unbounded set is a memory leak a
    peer can drive, and the timestamp window already rejects anything old enough to fall out.
  * Fleet keys are **derived** per fleet from one master secret, so a relay serves many accounts
    without holding a key per account and one fleet's key does not sign for another.

* **`src/chatops/fleet-scope.mjs`** — which devices a request may reach.
  * **The fleet comes from the pairing code, never from the device.** A device that could name its
    own fleet would join any account, and every signature would faithfully attest to a lie.
  * **An absent fleet is not a wildcard.** `undefined === undefined` is explicitly **not** a match.
    This is the most dangerous available mistake: two ungrouped devices matching each other would
    silently restore the exact "everything in one pool" behaviour being removed, and every test
    that only ever sets a fleet would keep passing. There is a test named for it.
  * **A foreign target is refused with the same answer as a nonexistent one**, so a caller cannot
    enumerate another account's machine ids by trying them and reading the error.
  * **A partial dispatch is refused whole** — silently dropping a named target leaves the caller
    believing it dispatched somewhere.
  * Offline devices are **counted, not silently dropped**: "we tried and they were offline" and
    "there are none" produce the same empty result and different fixes.

* `test/chatops-auth.test.mjs` (33 cases) and `test/chatops-fleet-scope.test.mjs` (25 cases).

### The tests are written against the attack, not the happy path

Each names the failure it prevents, and three of them assert a **weakening** rather than a
strength: that a device editing its own `fleet_id` fails verification, that swapping in its own
public key fails, and that an ungrouped device matches nothing. Those are the changes that would
look correct in a diff and quietly undo the isolation.

### Not in this release

* **The relay does not call either module.** No device keypair is generated in a real run, no
  statement is issued, no request is signed, and dispatch is still unfiltered. This release is the
  mechanism; connecting it is next.
* **The relay does not yet issue pairing codes bound to a fleet**, so `fleetFromPairingCode` has no
  producer in a live relay.
* **Hand-off is not implemented** — that is v0.7.7.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.5] — 2026-10-14

**Stage 1 of the account-fleet design: this machine now knows which account it belongs to, and
has a serial number.** The relay and the dispatch path are deliberately untouched — scoping
dispatch by fleet is v0.8.0, because it changes the protocol.

### Added

* **`src/chatops/account.mjs`** — the identity root.
  * **The account code comes from the host, not from a fetch and not from config.**
    `ctx.deepseekAccount.getDeviceIdentity()` returns `userId`, which is hashed to an 8-hex
    account code. There is deliberately **no way to set it from configuration**: a value an
    operator can type is a value an attacker can type, so a hand-entered "account code" would be
    a forgeable account code.
  * **The SN is `W2M-<ACCT>-<HWID>-<TS>`, 40 characters**, defined to the character, with the
    timestamp fixed at first generation so a restart cannot change a machine's identity.
  * **Hardware sources per platform, all injectable**, so a Windows-shaped machine is exercised
    on any host: `MachineGuid` / SMBIOS UUID, `IOPlatformUUID`, `/etc/machine-id`.
  * **Placeholder values are refused before hashing.** Firmware that reports an all-zeroes UUID
    would otherwise give *every such machine the same hardware code* — far worse than having none,
    because it silently merges distinct machines.

* `test/chatops-account.test.mjs` — 42 cases.

### Two things the tests assert on purpose

* **That a forged SN passes the shape check.** `isWellFormedSn` is named for what it does — it
  answers "is this well formed", and an SN is computed by the party being checked, so nothing
  about it is verifiable by inspection. The test *documents* this rather than papering over it,
  so a future change that turns the shape check into an authorisation check fails a test instead
  of building on sand.
* **That two accounts get different fleets and two machines in one account get the same fleet.**
  The property the whole scheme exists for, asserted directly rather than inferred.

### Fixed

* **The published v0.7.4 release notes claimed the SN is 41 characters. It is 40**
  (4 + 8 + 1 + 12 + 1 + 14). The design document said the same thing in one place. Both are
  corrected, and the release notes were edited in place. The wrong number came from arithmetic
  done by hand; the unit test that asserts the length is what caught it.

### Not in this release

* **The relay still does not scope by fleet.** `docs/ACCOUNT-FLEET-DESIGN.md` §3 is designed and
  unimplemented: dispatch targets are still `[...this.devices.values()]` with no filter, so
  accounts remain mixed. That is v0.8.0 and it is a breaking protocol change.
* **No device keypair yet.** The SN exists; the signature chain that makes account membership
  *verifiable* rather than merely *asserted* does not.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.4] — 2026-10-14

**No code changed.** This release is an audit and a design document, and it exists because the
audit found that the answer to *"is each account's fleet isolated?"* is **no** — in a way worth
writing down before anything is built on top of it.

### What the audit found, every line with its source

| question | answer | where |
|---|---|---|
| Is a device identity bound to an account? | **No.** `machine_id` is `randomUUID()` — no account, no hardware | `src/agent/agent.mjs` |
| Does an SN exist? | **No.** The concept is not in the codebase | entire repo |
| Is there a hardware identifier? | **No.** `caps` probes os/arch/node/python but never enters identity or authorisation | `src/agent/caps.mjs` |
| Does the relay use `user_id` for isolation? | **No — it stores it and never reads it.** Five references, every one a store or load | `src/relay/state.mjs` L507/736/981/993, `persistence.mjs` L170 |
| Does the plugin reference `user_id`? | **Zero times** | `src/plugin/tools.mjs` |
| Are dispatch targets filtered by account? | **No.** With no `target_machines`, `targets = all` — every device on the relay | `src/relay/state.mjs` L1259-1262 |
| Device table shape | **One flat Map**, no grouping dimension | `src/relay/state.mjs` L435 |

Measured on the shared relay (`a1b59a3b04dcd180`): **`devices=4`, all in one pool, with a single
pairing code.** Any machine holding that code joins the same pool, and any caller holding a valid
operator token has its task broadcast to every one of those four machines.

### Added

* **`docs/ACCOUNT-FLEET-DESIGN.md`** — the design for account-scoped fleets, in three parts as
  asked: the exact SN format, the relay authorisation model, and the hand-off timing.

  The identity source is **verified, not assumed**: DSH already exposes `ctx.deepseekAccount`,
  whose `getDeviceIdentity()` returns `{ deviceId?, userId?, osVersion }` and is documented as
  *"read existing login identity without creating a device or returning credentials."* The
  account's unique identifier therefore needs **no account API call** — and a hand-typed account
  code in a config row is explicitly ruled out, because a value an operator can type is a value
  an attacker can type.

  The SN is defined to the character: `W2M-<ACCT>-<HWID>-<TS>`, 41 characters, with `ACCT` a
  truncated `sha256(userId)` rather than the raw id (it ends up in logs, chat messages and device
  lists), `HWID` from platform-stable sources only — MAC addresses, mount points and package
  lists are excluded because they change and would make one machine look like two — and `TS`
  fixed at first generation.

### Three things the design says out loud that a proposal usually does not

1. **An SN cannot be a credential.** It is computed and asserted by the client, so anyone who
   knows or guesses an account id can forge one. The document states that the relay must never
   trust an SN, and that the timestamp provides **no** cryptographic uniqueness — uniqueness is
   `(ACCT, HWID)`, and the timestamp only distinguishes re-registrations and makes the string
   auditable. A string scheme presented as hardware-grade protection is worse than none, because
   it is believed.
2. **Hand-off makes execution at-least-once.** A command may run on two machines. Harmless for
   `node --test`, harmful for anything with `write: true` — so the design **forbids automatic
   hand-off for writing tasks** until a fencing token exists.
3. **The relay is the trust root.** Compromising it forges any fleet's authorisation. The design
   accepts that rather than adding an online account check, which would stop offline machines
   from working at all.

### Not in this release

* **Nothing from the design is implemented.** It lands in **v0.8.0**, because it changes the relay
  protocol — a breaking change that needs an explicit refusal path for older devices rather than
  a silent failure.
* **No message has yet gone from a phone through WeChat to the fleet.** The adapter is verified
  against live WeChat and the executor against a live relay; **the two have not been joined by a
  human typing.**

## [0.7.3] — 2026-10-14

**The fleet reader used the wrong credential and the wrong field names.** v0.7.2 shipped an
executor that had never been pointed at a live relay. Found by running it against one.

The agent's own log proved the task really ran:

```
[agent] offer 01M4VC7KWKF5WA5Q6BBDNH4AXM attempt 1 {"argv":["node","src/facts.mjs"]}
[agent] result delivered for 01M4VC7KWKF5WA5Q6BBDNH4AXM {"status":"nonzero_exit"}
[agent] result accepted for 01M4VC7KWKF5WA5Q6BBDNH4AXM {"status":"nonzero_exit"}
```

— while the poll loop printed erdict=undefined thirty times.

### Fixed

* **GET /v1/tasks/<id> needs the device token, not the operator token.** With the operator
  token it answers 401 {"code":"UNAUTHORIZED","message":"missing or invalid device_token"}.
  Dispatching and reading take different credentials; the executor now holds both, and a refusal
  names which one it wanted, because *"your operator token is wrong"* and *"this install is not
  paired"* have different fixes.
* **The verdict is at ody.aggregate.status, not the top level.** The per-machine rows are
  ody.leases[] on a status and ody.machines[] on a report, and the machine field is
  machine_name. The first version read ody.verdict and ody.results, so every machine
  printed as ?: ? while the task completed perfectly.
* /v1/devices wants the device token too on this relay build.
* A lease row carries state rather than outcome until the result lands, so describeMachines
  shows the outcome when there is one and the lease state when there is not.

### Verified end to end

Against a live relay and a live Localside agent on Windows:

```
任务 01M4VCET — unverifiable
命令：node src/facts.mjs
win-desktop: unverifiable  status nonzero_exit  exit 1
```

272 chatops cases pass.

### Still not claimed

No message has been sent from a phone through WeChat to the fleet. The adapter is verified
against live WeChat and the executor is now verified against a live relay, but **the two have
not yet been joined by a human typing**.
## [0.7.2] — 2026-10-14

**Run the fleet from a chat message, and get the machines' own verdict back.**

v0.7.1 shipped a working WeChat adapter and could still do nothing with it: `/run` answered
*"this install has no fleet"*, because the executor did not exist. This adds it.

### The gap was architectural

`w2m_run` and `w2m_wait` are DSH **tools**: their bodies live inside the plugin's `ctx.tools`
registration and are shaped for a model to call — a schema, a card, an error type the host
renders. The chat bridge needs the same work with none of that: an argv in, a verdict and a
sentence out.

The bridge cannot call the tools. A tool call needs `@deepseek-ai/dsh-tools`, which exists
**only inside `app.asar`** — a separate process cannot complete one, and an in-process call would
have to fabricate the host's own calling convention. So the fleet work is now expressed once
against the relay's HTTP API, and the tool and the chat bridge are both callers of it.

### Added

* **`src/chatops/fleet.mjs`** — `POST /v1/task`, `GET /v1/tasks/<id>`, `/report`, `/devices`, the
  same paths the plugin's own tools use. A refusal is returned as a value: the relay's refusals are
  answers, and the two that matter get their own sentences, because *"start an agent on each
  machine"* and *"your operator token is wrong"* are different instructions. A wait that expires
  reports `timeout` as a **verdict** rather than throwing — a fleet with one dead machine never
  reaches a terminal state, and silence is the worst possible reply to a phone.
* **`src/chatops/actions.mjs`** — the action set `commands.mjs` calls, plus the phone-sized
  formatting rules.
* **`/where <task id>`** and **`/report <task id>`**, so a task id from a reply is actionable.
* `test/chatops-fleet.test.mjs` — 28 cases.

### Two properties worth naming

* **The argv is never joined into a string.** A chat message is attacker-influenced text, and the
  array is what keeps a shell from ever seeing it. A formatter that joined and re-split would work
  for every command until the first one with a space in an argument.
* **`divergent` and `divergent-platform` are not collapsed.** They mean different things — one is
  a bug, the other a platform difference — and paraphrasing either into "failed" is how a
  portability difference becomes an incident.

### Changed

* `createBridge` now accepts a policy **instance** as well as the overrides to build one. The
  action set has to share the bridge's policy, or `/trust` widens a copy that admission never
  consults and the command silently does nothing. Duck-typed on `admit()` so the two modules need
  not import each other's constructors.
* `apply()` builds the executor from the same `rabbitUrl` / `operatorToken` row the tools read, so
  there is one setting rather than two, and resolves the token in the same order (row, then
  `W2M_OPERATOR_TOKEN`). An install with no `rabbitUrl` gets named refusals — *"no rabbitUrl is
  configured"* — instead of an absent action.

### Verified

**271 chatops cases pass**, 28 of them new.

### Not yet done — the honest caveat

The round trip has been verified against **live WeChat as far as the adapter**, and against
**the relay as far as the executor**. But **no command has been sent from a phone to the fleet end
to end.** That is the next thing to test, and this release does not claim it.

## [0.7.1] — 2026-10-14

**v0.7.0's WeChat channel could not send a single message.** This release fixes it, and the
way it was found is the point.

### What was wrong

v0.7.0's `ilink.mjs` was written by *reading* the audited plugin's TypeScript. Every field name
in it was wrong — nine separate mismatches — and all 237 of its tests passed, because those tests
drove an injected transport and asserted on the requests we *constructed* rather than the
requests WeChat *accepts*. **A self-consistent suite cannot falsify its own assumptions.**

The first real request, made with a real QR scan and a real bot, returned:

```json
{"errcode":-14,"errmsg":"session timeout"}
```

That message is a lie about its own cause, which is why it took as long as it did:

| # | v0.7.0 | Measured |
|---|---|---|
| 1 | *(absent)* | **`AuthorizationType: ilink_bot_token`** |
| 2 | *(absent)* | **`X-WECHAT-UIN`**, a per-request random |
| 3 | `to_user` | `to_user_id` |
| 4 | bare `{msg}` | `{msg, base_info}` |
| 5 | `item_list[].text_item` | also `type: 1`, `from_user_id`, `client_id`, `message_type: 2`, `message_state: 2` |
| 6 | `getupdates` body `{}` | `{get_updates_buf, base_info}` |
| 7 | `bot_id` / `owner_user_id` | `ilink_bot_id` / `ilink_user_id` |
| 8 | success = HTTP 2xx | **`ret === 0`** |
| 9 | — | failures use **`errcode`/`errmsg`** and **still return HTTP 200** |

**#1 is the one that cost the most time.** Without `AuthorizationType`, every authenticated
endpoint answers `-14 session timeout` — *including a request carrying no `Authorization` header
at all*, because the server rejects on the missing type before it reads the credential. That made
it look like an expiry bug, and an expiry bug is investigated by checking clocks, re-scanning
codes and re-minting tokens. It is not one.

**#8 and #9 are the dangerous ones.** A refusal arrives with HTTP 200, so a status-code check
reports a failed send as a delivered one — the exact silent-failure shape this release series
exists to remove, and it had been reintroduced in the adapter. `send()` now rejects on
`errcode`, so the outbound queue can never count a refusal as a delivery.

### Also fixed

* **The transport did not exist.** v0.7.0 required the host to inject `chatopsIlinkRequest` and
  shipped no default, so no request could ever be sent and `apply()` could never mount a working
  channel. `ilink-transport.mjs` is now the default, and injecting one only overrides it.
* **64-bit ids were rounded.** A live `message_id` is 7515840255213248776 — past
  `Number.MAX_SAFE_INTEGER` — so `JSON.parse` returned `7515840255213249000`. The transport now
  recovers the exact digits. Rounding is harmless for de-duplication and not harmless if an id is
  ever persisted as a key or sent back.
* **The host allow-list was wider than the measurement.** v0.7.0 allowed `weixin.qq.com` and
  `api.weixin.qq.com` on a guess; the login response returns exactly `ilinkai.weixin.qq.com`. An
  allow-list wider than what was observed is not caution, it is the absence of the check.
* **A precision bug in the fix itself**, caught by the suite it was written for: the first
  `repairMessageIds` mutated in place, so a shared test fixture was rewritten by whichever case
  ran first.

### Added

* `src/chatops/ilink-protocol.mjs` — the measured wire format in one place, each constant
  annotated with the live response it came from.
* `src/chatops/ilink-transport.mjs` — the real HTTP transport, with per-request deadlines, the
  `ret`/`errcode` distinction returned as data, and `undici`'s `cause` unwrapped so a network
  fault does not read as a protocol fault.
* `test/chatops-ilink-contract.test.mjs` — **36 cases pinned to fixtures taken verbatim from live
  responses**. The rule it enforces: if a field name changes, a test here must fail. That is the
  mechanism that would have caught all nine.
* `scripts/ilink-login-and-probe.mjs`, `scripts/ilink-qr-poll.mjs`, `scripts/ilink-talk.mjs` —
  the probes that found this. Kept because they are the only way to check the adapter against
  reality rather than against itself.

### Changed

* `test/chatops-ilink.test.mjs` **removed**. It asserted the wrong protocol — `body.msg.to_user`,
  `msg_list` — so keeping it would have pinned the v0.7.0 defects back in. The contract suite
  replaces it.

### Verified against live WeChat

A real QR scan, a real bot, a real exchange in both directions:

* `get_bot_qrcode` → `{"qrcode":…,"qrcode_img_content":…,"ret":0}`
* `get_qrcode_status` → `{"status":"confirmed","bot_token":…,"baseurl":…,"ilink_bot_id":…,"ilink_user_id":…}`
* `notifystart` → `{"ret":0}`
* `getupdates` → the peer's reply, read verbatim
* `sendmessage` → `{"message_id":7515840555615131656}`, received on the phone

### Not fixed, and not claimed

* **Feishu, DingTalk and WeCom are still not implemented.** They need vendor SDKs this project
  cannot vendor or review. The contract they must satisfy is `channel.mjs`.
* **Only the WeChat path has been exercised against a live platform.** That is one of four, and it
  is the one that happens to need no SDK.
* **No command has been run through the bridge from a phone yet.** The adapter is verified; the
  end-to-end path from a chat message to `/run` on the fleet is not.

## [0.7.0] — 2026-10-14

The release that answered "can we drive the fleet from a phone?" with **not yet, and
here is exactly why** — and then built the two pieces that had to exist first, under
test.

### Why this is not the feature, and why that is the honest release

The goal was to fold [`dsh-chatops`](https://github.com/ZhuoSir/dsh-chatops) 0.1.0 —
an IM bridge for WeChat/Feishu/DingTalk/WeCom — into this plugin as a feature. It was
read in full instead of trusted: ~168 KB of TypeScript across 40 files, plus the
published 3,544-line bundle, which is byte-identical to the committed source modulo
CRLF (`minify:false`, so identifiers and comments survive — the audit is on the real
artifact).

**It is not safe to adopt as written, and the reasons are not stylistic:**

* The approval answerer registers `(req) => …` on the `approval/request` **waterfall**
  and never calls `next()`. This host documents that event as *"Return an outcome to
  claim the request or call `next()` to delegate"*, and cordis's `waterfall` consults
  the next listener **only when the current one calls `next()`**. The plugin's listener
  is also `async`, so it hands back a Promise, and the harness takes any non-`undefined`
  value as the final answer. The host's own GUI answerer is therefore never consulted
  for a session that has an IM window bound, and the request is held until the plugin's
  own 300 s deadline. Whether it happens at all depends on listener **registration
  order**, which the plugin does nothing to control. This is the one defect that reaches
  beyond the plugin.
* The first private message on any of three channels makes its sender a **permanent
  owner**, before any authorisation runs, with no pairing code and no allow-list, and
  persists the claim to `bindings.json`. All four channels ship enabled by default. Once
  adopted, that identity can enumerate every workspace and session, inject prompts,
  read transcripts via `/log`, exfiltrate workspace files via `/send`, approve, and
  switch the sandbox to `danger-full-access`.
* `GET /chatops/api/config` returns four platforms' credentials in cleartext behind a
  loopback-only check with no token and no Origin validation; the settings page re-polls
  it every 3 s. `POST` to the same path merges an unvalidated body into the config and
  writes the profile's `cordis.patch.yml` — and `puppet` is passed to `await import()`,
  so that path is arbitrary module load.
* Pending approvals were keyed by window alone, so a second concurrent request
  overwrote the first and the older became unanswerable from IM.
* The workspace file fence is lexical only (`resolve` + `startsWith`); `statSync`
  follows symlinks, so a link inside the project ships any readable file to IM.

Shipping that as a headline feature would have been a regression in every user's
safety, so it is not shipped. The audit is published instead, and the two modules that
had to exist first are built and tested.

### Added

* **`src/chatops/approval-broker.mjs`** — the approval seam, designed so the defect
  above cannot recur:
  * **declining is synchronous and never touches `next`**, so a bridge with nothing to
    ask leaves the host's answerers to answer;
  * **a deadline delegates instead of deciding** — a phone that did not answer is not
    an operator who said no, so the timeout calls `next()` and lets the answerers behind
    it decide;
  * **pending requests are keyed by approval id and queued per window**, so two
    concurrent requests cannot overwrite each other;
  * ids carry full entropy, where 0.1.0 minted `randomUUID().slice(0, 8)` — 32 bits held
    for five minutes;
  * `dispose()` settles everything outstanding, so a reload leaves no timer that can
    resolve a promise belonging to a fiber that no longer exists;
  * the clock **and** the timer are injectable. That pairing is the whole reason the
    suite is deterministic: an injected clock with a real `setTimeout` is two clocks, and
    the first version of this test hung rather than failed.
* **`src/chatops/policy.mjs`** — who may command this machine, fail-closed:
  * **nothing is trusted because it arrived.** An identity is trusted only by being
    seeded in config or by redeeming a single-use, expiring, per-identity rate-limited
    pairing code. There is no path that trusts a sender because nobody else had spoken;
  * identity is `(channel, id)`. 0.1.0 held one flat `Set` matched after stripping the
    channel prefix, so the same raw id was the same person on every platform;
  * **a room is not a person**: an allowed room is never sufficient — the speaker must
    also be individually trusted, where 0.1.0 returned `true` for every member of an
    allowed room whenever `allowContacts` was empty;
  * revocation exists, which 0.1.0 had no way to do short of deleting its state file;
  * `CHANNELS` is **one** registry. The same information lived in four places that had to
    agree, and a channel missing from the authorisation regexes had every message from it
    silently dropped;
  * a well-formed key naming an unenabled channel is a **named** refusal
    (`channel_unknown`), because a silent drop is indistinguishable from a bot that is
    simply broken.
* `test/chatops-approval.test.mjs` (24 cases) and `test/chatops-policy.test.mjs`
  (24 cases), both wired into `test` and `test:all`.

### Not in this release

* **Only one channel adapter ships, and it is the WeChat one.** `ilink.mjs` is here because
  its protocol is JSON over HTTPS with no vendor SDK — the other three channels need SDKs
  this project cannot vendor or review. Feishu, DingTalk and WeCom are not implemented; the
  channel contract they must satisfy is `channel.mjs`, checked by the same validator `ilink`
  passes.
* **Nothing has been exercised against a live WeChat account.** The adapter's whole network
  surface is one injected `request()`, so its request shaping, response mapping,
  de-duplication, state machine and host allow-list are all asserted — 30 cases. What that
  suite cannot tell you is whether WeChat accepts the requests. That needs a QR scan and a
  real bot, and is not claimed.
* The audit's own limits: the chatops dependency trees were not resolved (no `node_modules`
  was installed, and none of its code was executed), and its Feishu card-action signature path
  lives inside a vendor SDK that was not available to read.

### Note on the other half of the work

The three-machine comparison this fleet exists for still needs one commit that all
three machines can reach. The Mac runs the project at `a1e7dc04` on a clean tree with
`--project /Users/fang/w2m-project` — already correct, and already the same path its own
DSH uses; the mismatch is that this is not the commit the Windows host and the Tokyo
relay are on. Its `git ls-remote` to GitHub times out while `curl api.github.com`
answers 200, so the reachable common anchor is `origin/main` (`6e7ba0c9`, the v0.6.3
tag) rather than the fixture commit used for the local runs.

## [0.6.3] — 2026-10-13

One fix, and it is the half of v0.6.2 that made the other half usable.

### Fixed

* **`w2m_status` now reports `encryption.relay_serves_keys`.** v0.6.2 taught the node to tell a relay
  that drops peer keys apart from a peer that has none — and then did not carry the answer to the one
  surface an operator actually reads. The plugin builds its encryption block from an explicit field
  list, and the new field was not on it, so a fleet in exactly the state v0.6.2 exists to explain still
  showed `peers_known: 0` with no way to see why.

  Measured on the machine that built the release: `w2m_status` returned

  ```json
  "encryption": { "enabled": true, "public_key": "cQshuntt…", "peers_known": 0,
                  "handshakes": 0, "encrypted_channels": 0, "plaintext_channels": 0 }
  ```

  while the node underneath it was reporting `relay_serves_keys: false` against the same relay. The
  feature worked and was invisible — which is the failure mode the field was added to remove, one
  layer up.

  `?? null`, not `?? 0`, because the value is three-valued and collapsing it would accuse the relay
  before it had been tested: `null` means no announcement has proved it either way (or this node has
  no key of its own, so it never asked), `false` means the relay dropped the key we sent.

## [0.6.2] — 2026-10-13

The release that stops a broken *relay* from being reported as an out-of-date *peer*, and stops a
relay that has quietly stopped recording from looking healthy.

The incident, measured on this fleet: every machine at v0.6.1 held a valid device key and announced
it, `peers_known` stayed `0` on all of them, no handshake was ever armed, and every direct channel
came back `P2P_CRYPTO_PLAINTEXT_PEER` — documented as *"the peer never learned a key (an older
build)"*. Both ends were the same build, on the same host. The component that was actually behind was
the relay: it started `2026-10-10T18:01:40Z`, and v0.6.0 and v0.6.1 shipped on `2026-10-11`. It had
never heard of `static_key`, so it accepted every announcement, dropped the field, and served entries
without it. The reason code blamed the one component that was up to date.

### Added

* **`encryption.relay_serves_keys`** — whether the relay keeps the key this machine announces. `null`
  until an announcement proves it either way; `false` when the relay dropped what was sent; `null` for
  a node with no key of its own, because such a node never asked and must not conclude "no". Detected
  from this node's **own** announcement — it POSTs a key and the relay echoes the entry it stored — so
  it needs no relay cooperation, no version negotiation and no capability call. That is what makes it
  work against the relay that is actually deployed, which is the whole point.
* **`P2P_CRYPTO_RELAY_NO_KEYS`** — a new reason, used when a peer announced, this machine holds a key
  of its own, no key came back for that peer, and this node has already proved the relay drops keys.
* **`/healthz` reports durability**: top-level `degraded` and `degraded_reason`, plus `degraded`,
  `degraded_since`, `last_append_error` and `append_failures` inside `persistence`. `ok` deliberately
  stays `true`: the relay still serves the fleet, and flipping it would turn a recording problem into
  an outage. Persistence disabled is not degraded — there is nothing that can fail.

### Fixed

* **The reason a direct channel is plaintext now names the real cause.** `punch()` computed it as
  `request === null ? PLAINTEXT_PEER : NO_KEY`, and `dial()` sends no crypto request in three
  situations that are all *local* — this machine has no device key, it holds no key for that peer, or
  it is dialling itself. Every one of them was reported as the peer being old. The code already
  disagreed with itself about this: `dial()`'s own comment claims the reason "then says
  `P2P_CRYPTO_NO_KEY`". The reason is now decided where it is known and travels with the call;
  `PLAINTEXT_PEER` keeps its real meaning and keeps firing for the one case that is genuinely about
  the peer — it publishes no key, so there is nothing to encrypt with.
* **`dial()` learns the peer key it was throwing away.** The peer's `static_key` has ridden in the
  relay's `/v1/peer/{id}` record since v0.6.0, and `dial()` was fetching that very record for the
  candidate list and discarding the key. A dispatcher that reported `PLAINTEXT_PEER` against a
  same-version peer could have encrypted; it had an empty store and never asked. Reporting alone would
  have been a better-worded lie.
* **`device.key` is loaded from beside `device.json`, not from `--state`.** The plugin followed the
  documented rule; the agent did not, on the stated grounds that "`identity.mjs` puts `device.json`
  when the agent is run with `--state`" — which is false. `device.json` is fixed at
  `<DSH_HOME>/xclient/device.json` by the identity contract and `--state` does not move it. Measured
  consequence on one machine running both halves: two different keypairs under one `machine_id`, both
  announcing to the one `/v1/peer/{machine_id}` slot, the relay's record alternating between the two
  nodes' ports every ~8s, each announcement overwriting the other. A dispatcher reading that record
  learned one node's key or the other's, never reliably the key of the node it was about to dial. The
  fix takes the path the caller actually resolved — `bin/w2m-localside.mjs` already had it in
  `identityPath` and simply did not pass it down — and deliberately does **not** re-resolve `DSH_HOME`
  inside the agent, which would make a test or an embedder read and *create* a key in the real user's
  home.
* **A key already generated in `--state` is adopted, not abandoned.** `DeviceKey.load` warns that
  "silently generating a replacement key would make every peer that knows the old one refuse this
  machine", so the canonical location may create and a legacy file may only be adopted. An adopted key
  is logged, because the public key is what a peer authenticates this machine by.
* **A relay that serves without recording now says so.** On a full disk the relay answered every
  request normally and appended nothing; the only trace was one warning per failed append, and this
  fleet's relay had reached **22 byte-identical `ENOSPC` entries**, so the signal was buried in its own
  repetition. Identical warnings are now counted rather than repeated, and durability is a first-class
  state: entered by the first failed append, cleared by the next success. `append_failures` is
  cumulative and deliberately never reset — "how much was lost" is the first question after a disk
  fills, and a counter that returns to zero cannot answer it.
* **A patch override that asserts the wrong `name:` now has a documented failure mode.** In a patch,
  `name` is an *assertion* about the entry being targeted, not a rename, and the Loader drops the whole
  patch on mismatch — leaving the plugin mounted on the bundle's empty defaults: eight tools present,
  `w2m_status` reading `paired: false` and a null `rabbitUrl`, with the profile's settings sitting in
  the file the whole time, unread. README now carries the hazard where the config block is copied,
  `TROUBLESHOOTING.md` §2 names it as the third mechanism for "the patch lost my configuration" (and
  the only one where the file looks intact), and §17 documents the reason codes this release adds and
  corrects.
* **`test/agent.test.mjs`'s sub-path CLI test no longer depends on the host's `PATH`.** This is what
  made v0.6.1's own pre-flight **RED** — "do not bump" — on a machine where node exists only as DSH's
  bundled runtime. `runCli` points the child's `DSH_HOME` at a scratch directory, so
  `bundledBinDirs()` correctly finds no bundled runtime there; the command under test is built from
  `process.execPath` while the allow-list entry is the bare name `node -e`; and with no bundled runtime
  and no `node` on `PATH`, that name does not resolve, so the absolute path is refused with
  `COMMAND_EXECUTABLE_PATH_MISMATCH` — the allow-list behaving exactly as documented. CI runs
  `actions/setup-node`, which is why it was green there. The child now gets the executing node's own
  directory on its `PATH`, which restores the identity the check exists to confirm rather than
  weakening it: a mismatched absolute path is still refused with the same code.

### Changed

* `scripts/preflight.mjs` reports **11 pass, 0 fail, 1 unverifiable — GREEN, cleared to bump** on a
  clean macOS checkout. Before this release the same gate reported "10 pass, 1 fail — RED".
* The local suite reads **557 tests, 555 pass, 0 fail**.

## [0.6.1] — 2026-10-11

### Fixed

* **v0.6.0 was tagged and never published, because its release pipeline ran a pre-flight that could not
  complete on the platform that builds the artifact.** Nothing was wrong with the v0.6.0 *code*: the
  tarball this release publishes is the v0.6.0 tree plus the repairs below, and the section underneath
  describes what is in it. What was wrong was the pipeline's order and two of its checks, all three
  invisible on the developer machine that wrote them. This is a fix-forward release rather than a re-tag:
  v0.6.0 stays tagged and unpublished, and its content ships here.
* **The pre-flight ran before the pack, so on a fresh checkout it could never be green.** `dist/` is
  gitignored, so a clean checkout has no tarball, and three assertions in `test/claims.test.mjs` about the
  *packed* tree skip when there is none -- while `scripts/preflight.mjs` fails any skip whose reason is not
  on `ACCEPTED_SKIPS`. Measured by moving `dist/` aside: "10 pass, 1 fail, 1 unverifiable -- RED", naming
  `no dist/ in this checkout: the packed tree was not verified here`. It looked green on a developer
  machine only because `dist/` still held a tarball from an earlier pack. `ci.yml`'s `preflight` job and
  `release.yml` now pack first, and `release.yml`'s checksums moved below the pre-flight so `SHA256SUMS`
  describes the bytes the pre-flight left in `dist/` -- the ones unpacked, verified and published. The skip
  was deliberately **not** added to `ACCEPTED_SKIPS`: that would have traded three real assertions about
  the published artifact for a green light.
* **The matrix job ran `npm test` without `npm install`, and the gate inventory names a `node_modules`
  path.** `test/claims.test.mjs` asserts that every artifact `GATE_INVENTORY` names exists in the tree --
  the check that catches a gate deleted from the pre-flight -- and the first row of that inventory is the
  eslint entry point at `node_modules/eslint/bin/eslint.js`. The matrix job never installed dev tooling, so
  all four legs failed that assertion with `the inventory names files that are not in the tree: eslint entry
  point (node_modules/eslint/bin/eslint.js)`. It could not reproduce locally, where `node_modules/` exists,
  and it was newly exposed by v0.6.0's own wiring change: the hand-listed 22-path subset it replaced had
  never run `claims`. The matrix job now installs dev tooling before `npm test`, and was measured green on
  all four legs afterwards.
* **The pre-flight read the claims suite's counts without pinning the reporter, so on node 22 it read
  none.** `checkClaims()` parsed the child's stdout with the spec reporter's summary in mind, while
  `checkTestSuite()` has always pinned `--test-reporter=spec --test-reporter-destination=stdout`. Node's
  default reporter depends on the runtime: measured, the same command prints the spec summary under node 24
  and TAP's `# tests 48` under node 22 when stdout is a pipe -- which is what a CI runner is. The check
  therefore reported `the runner printed no test count at all` for a suite that had passed, on the version
  every workflow runs, and **every local run on node 24 was green: only the runner's own output named it.**
  The reporter is now pinned exactly as the declared-suite check pins it.
* **The pre-flight now names its own failing checks in the CI interface.** Its verdict is its exit status
  and its output went only to the step log, so a red pre-flight read as one line -- "Process completed with
  exit code 1" -- to anyone without log access, including the API-only tools this project audits a run
  with. The `FAIL` and `UNVERIF` lines it printed are now `::error::` annotations, the convention
  `compat.yml`'s verdict program already used. The exit status is unchanged: the wrapper reads the
  pre-flight's own status out of `PIPESTATUS` and exits with it, because a pipeline ending in `tee` would
  otherwise report success for a red gate.

### Notes

* **Two skips are accepted because a CI runner has no DSH installation, and nothing else was
  pre-accepted.** `update-install: real pnpm against a throwaway profile` needs the pnpm that ships
  *inside* a DSH runtime (`$W2M_PNPM`, or `$DSH_HOME/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.mjs`), so on
  a runner both of its assertions skip with `runtime pnpm not found`; they are accepted as
  `no-runtime-pnpm`, capped at two. The entry carries no platform qualifier, because this is not a platform
  fact -- Windows runners lack the runtime exactly as Linux ones do -- and the cap is the bound: a third
  skip in that describe fails the check, and this reason on a host that *does* have a runtime would be a
  defect in resolution rather than an environment fact. The alternative, building a synthetic runtime in CI
  the way `compat.yml` builds a host for the loader gate, was rejected on purpose: it would exercise the
  installer against a pnpm fetched from npm instead of the one the Desktop ships, a weaker claim about the
  artifact plus a network dependency inside the release gate. The platform-conditional pair in
  `test/agent.test.mjs` is qualified the other way round and **by platform**, so accepting the POSIX side
  cannot excuse the same reason on Windows, where that assertion is expected to run.
* **A hypothesis that was tested and did not survive, recorded because the next reader deserves it.** The
  standing explanation for the four red matrix legs was "the runner has no DSH installation, so suites that
  need one behave differently there". It was tested by rebuilding the runner's conditions -- a clone with no
  `node_modules/`, no `dist/`, no DSH installation reachable, no `~/.dsh`, node 22, one `npm test` -- and it
  did not produce a failure: the loader gate skips (accepted), and the bundled-python assertion is guarded
  by `PATH` and had already passed in v0.5.9's CI on these same runners. The real mechanism was a path in
  the gate inventory on a job that never ran `npm install`. A wrong hypothesis that was tested and
  discarded is worth as much to the next reader as the right one.
* **A node-22 difference this release does not fix, stated with its bounds.** With the pre-flight's shaped
  `DSH_HOME`, `test/agent.test.mjs` is 147 tests / **0 fail under node 24** and **13 fail under node 22**
  (`'refused' !== 'ok'`, around `test/agent.test.mjs:3870` and `:3915`). `engines` declares `>=20.19.0`, so
  node 22 is a supported runtime and this is a real difference rather than a curiosity. Two facts bound it:
  it does not fire in CI today, because a runner cannot shape a home -- `prepareSuiteEnv()` finds no runtime
  source there and the suite runs bare, which is why no agent failure appears on ubuntu -- and it will
  surface the moment the pre-flight job is given a runtime layout. It is a behaviour question rather than
  wiring, so it is recorded here and left to a separate change.
* `PROTOCOL.md` §9's correction note said there is no such release as v0.6.0; that was true when it was
  written and the tag made it false. It now still says what it was written to say -- the P2P data-plane
  crypto shipped in **v0.5.3**, not v0.6.0 -- without contradicting the tag.

## [0.6.0] — 2026-10-11

### Added

* **The pre-flight became a ledger, with a self-test of its own.** `scripts/preflight.mjs` grew from 886
  lines to 2,077 and the claims suite it reuses from 775 to 1,581. Every gate it delegates to is now an
  **artifact bound to the registered check that measures it, in both directions**: a gate with no check is
  a finding, a check with no gate is a finding, and a registered check that produces no result at all is
  a `FAIL` rather than a silence. The ledger that enforces that is itself exercised on every run — a
  silent check, a throwing check and an honest one must classify `FAIL`/`FAIL`/`PASS`, and an
  `UNVERIFIABLE` whose reason is not on the accepted list is refused rather than reported. Measured on
  this tree: 12 artifacts inventoried, 11 registered checks, 0 unbound.
* **The packed tarball is checked against an expectation derived from the tree, not a hand-written list.**
  Every document in the tree is either shipped or named in `DOCUMENT_EXCLUSIONS` **with a reason** (18 in
  the tree, 17 shipped, 1 excluded, 0 neither), the packed `package.json` is compared with the tree's
  **field for field**, and every manifest-declared path must ship. Both directions are asserted, so "the
  packer stopped shipping a document" and "a document was added and the packer was not told" fail the
  same check instead of one of them passing quietly.
* **Workflow wiring is a check rather than a convention.** `ci.yml` and `release.yml` must each run every
  suite `package.json#scripts.test` names and must not hand-list a suite set, and the pre-flight asserts
  that the loader gate keeps its triggers on the two occasions that matter — every pull request and every
  release. That gate was the one a hand-edited suite list quietly dropped, which is how six suites that
  exist and pass came to run in no workflow at all.
* **Accepted reasons are named per claim, and every skip is printed with its reason.** `UNVERIFIABLE` is
  not a pass: each accepted entry carries the exact text it accepts and the one claim it may be used for.
  On this host the declared suite produces 4 skips, each on the accepted list, each printed in the
  pre-flight's own output rather than summarised as a count.
* **The compatibility gate classifies every result line, and reads the assertions out of the test file.**
  `.github/workflows/compat.yml`'s verdict program used to check nine hand-listed titles plus the page
  half, so a tenth assertion that skipped could leave the job green; and it decided the accepted reason
  from the **runner** (`BROWSER === ''`), so a page assertion skipped for a reason that is a property of
  our own composition printed ``Accepted reason `no-browser` `` and exited 0. The accepted list is now
  matched against the **skip directive's own text**, only the page half may use it, the assertions the
  file declares are read from the file, and an assertion that produced no result line at all is a `FAIL`.
* **The operator token is no longer printed on every start.** The relay prints it in its banner **only on
  the start that generated it**; every other start prints `OPERATOR TOKEN — not printed (this start did
  not generate it)` with the path and the mode to read it from. That banner lands in journald, a
  container log or a CI transcript, and this token authorises dispatching to the whole fleet, so a
  restored token in a log is a credential in a log. `--print-operator-token`
  (`W2M_PRINT_OPERATOR_TOKEN=1`, or `printOperatorToken: true` for an embedder) asks for the old
  behaviour explicitly, and `docs/DEPLOY.md` states that on the generating start the value still appears
  **twice on purpose** — once on stderr as the log copy, once in the CLI's own box on stdout as the
  handoff a human reads.

### Fixed

* **A punch could be refused by a datagram that was not a refusal at all — about one handshake in 256.**
  `decodeRefuse` accepted exactly one body length and validated nothing else, and a `REFUSE` rides inside
  the same `HELLO_ACK` frame as a handshake answer. A genuine `HELLO_ACK`'s byte 6 is the first byte of
  the responder's random ephemeral, so when that byte happened to equal the length the parser expected,
  an honest encrypted answer was read as a refusal: reported with a refusal reason the peer never sent,
  and — in the codes that are terminal — handing back no channel at all. It was found while adding the
  `k_ref` seal to `REFUSE`. The parse now checks the version byte, both legal lengths and that the
  machine id carries no control bytes, and a test bends a real acknowledgement's length byte into that
  exact collision.
* **`REFUSE` is sealed, and a refusal that cannot be corroborated is dropped.** A `REFUSE` may be
  unauthenticated by design — it is sent precisely when the two ends could not agree a key — which made
  it a downgrade oracle: anything able to forge one could turn "the peer never answered" into "the peer
  refused". `k_ref = HKDF(ECDH(e_i, s_r), REFUSE_MAC_LABEL)` is a key the initiator derives as easily as
  the responder, over a label distinct from every handshake MAC and over a **different input**
  (`ECDH(e_i, s_r)`, not `ECDH(s_i, s_r)`); a refusal must now come from the address and the session the
  punch agreed and carry a `k_ref` MAC. Four codes name the **ignored datagram** rather than a failed
  punch (`P2P_CRYPTO_REFUSE_SESSION_MISMATCH`, `..._UNPUNCHED_SOURCE`, `..._BAD_MAC`,
  `..._UNCORROBORATED`), so a refusal that was thrown away is never reported as a refusal that happened.
* **A started node held the process open, and the comment claimed an `unref()` that existed nowhere.**
  With no `ctx.effect` — an older Cordis, or a bare test context — the plugin composed a node and never
  released the handles that keep a Node.js process alive: the bound UDP socket, the announce refresh
  timer, and the accept loop's pending wait timeout. `src/agent/p2p-node.mjs` now has a real `unref()`,
  **remembered rather than applied once** (a `close()` followed by a `start()` binds a second socket and
  arms a second wait, so a call that took effect only on the first would not be a promise), the accept
  loop reads the flag on every round, and the plugin calls it when no disposer will ever be called.
  Found by an independent verifier against the `w2m_status` test's bare context.
* **A failed state publish left its temp file behind: one live state directory had accumulated 266
  `agent-state.json.tmp-*` files.** `publishState()` renames a temp file over `agent-state.json` while
  another process may be reading it, and on Windows that contention comes back as `EPERM`/`EACCES` from
  the rename although both paths are fine and the condition clears within milliseconds. The rename is now
  retried (5 attempts, 3 ms × attempt, **retryable errors only** — a permanent failure is rethrown
  exactly as a bare `renameSync` would be), and a publish that fails outright unlinks its own temp file.
* **`test:agent` masked a hang for more than 283 seconds.** The suite had finished asserting and could
  not exit; without `--test-force-exit` the verdict was a timeout rather than a result, and the same was
  true of `test:relay` and `test:tools`. All three carry the flag now, as `test`, `test:e2e` and
  `test:all` already did.
* **`test/p2p-crypto.test.mjs` was still not in `test:all`.** 33 tests covering the data-plane
  encryption rode `npm test` and not the suite a release runs, so the crypto suite did not ride the full
  gate. The one path the v0.5.9 entry asked its owner for is appended after
  `test/mdns-discover.test.mjs`.
* **The allow-list is one rule at both ends, and it is a grant rather than a sandbox.** The plugin's
  pre-flight reduced `argv[0]` to a basename before matching, so it would wave `E:\Temp\evil\node.exe`
  through while the agent refused it; the argv is handed over verbatim now, to the same matcher the agent
  uses. Three narrower rules sit on top of the prefix match, each with its own code because each has its
  own remedy: `COMMAND_REPARSING_ARGUMENT` refuses code-loading **trailing** arguments
  (`--test-reporter`, `--import`, `--require`, `-r`, `--experimental-loader`, `-e`/`--eval`,
  `-p`/`--print`, `python -c`/`-m`, `bash -c`, `git -c`/`--exec-path`, `make -f`, `tar --to-command`, and
  their equivalents in the interpreters in common use) unless the entry names them;
  `COMMAND_EXECUTABLE_PATH_MISMATCH` admits an absolute `argv[0]` only when it resolves to the same file
  the entry's executable does; and `COMMAND_EXECUTABLE_RELATIVE_PATH` refuses a relative `argv[0]`
  outright, because the working directory comes from the offer. **The limit is stated rather than
  implied: an entry is a code-execution grant, not a sandbox.** `node --test` allows
  `node --test <any file>`, and the test runner loads and runs whatever file it is handed. The list says
  which program may run, not what that program can be told to do.
* **The Windows supervisor: one supervisor, one agent, and the punch port held by the agent that is
  actually running.** Measured on this machine: **fourteen `w2m` processes, nine of them `w2m-localside`
  agents sharing one identity, with port 41235 held by an agent from thirteen hours earlier** — so every
  dispatch fell back to the relay (`P2P_UNREACHABLE`) while the heartbeat said nothing. A second
  generation could start while a healthy one ran, and the start-time reap could only ever see the single
  pid the heartbeat remembered. There is now a **single-instance lock** (`open(…, 'wx')`, i.e.
  `O_CREAT|O_EXCL`, so of two generations racing exactly one creates the file): a generation that finds
  it held logs a no-op line and exits without spawning, and a lock whose holder is gone or whose file is
  unreadable is **taken over loudly** rather than blocking the machine forever. The reap matches **by
  identity** — process table plus command line naming the same state directory, with the supervisor
  excluded — because a supervisor's own command line carries the agent stub's path and an identity-only
  reap killed its own program (measured: it did). `orphans_reaped`, `orphans_reaped_pids` and
  `lock.takeovers_total` are in the heartbeat, so the machine's own account of what it reaped is readable
  without a debugger.
* **The scheduled task was registered `MultipleInstances IgnoreNew`, which cannot recover from a
  supervisor death.** IgnoreNew refuses the second start — the right-looking answer and the wrong one,
  because the watchdog tick that should have replaced a dead generation was itself the start being
  ignored, and the machine stayed down until a human noticed. `install-service.ps1` now registers
  **`MultipleInstances Parallel`**, which is safe precisely because the supervisor's own lock is what
  prevents a second *agent*, and it prints the setting it wrote so the correction is visible in the
  install transcript rather than inferred. `deploy/windows/verify-supervisor.mjs` is the reproducible,
  no-elevation check of the whole property: it builds the broken state on purpose — orphan agents already
  holding a free port, a lock left behind by a killed supervisor — and then asserts that exactly one agent
  is left, that it owns the port, and that the heartbeat names the pids it reaped.
* **Documentation corrections, each of which was a false statement in a shipped document.**
  * **`SECURITY.md` had been telling users to install a six-release-old build.** Its supported-version
    table read "v0.5.3 and everything before it" and listed v0.5.6-and-later as "not yet released" —
    three releases after v0.5.6 had shipped. It names **v0.5.9** as the supported line now and says why
    v0.5.4 and v0.5.5 are withdrawn (they fail during DSH's web boot and take the whole application with
    them, all eight tools included), and the install commands in `SECURITY.md` and `TROUBLESHOOTING.md`
    point at a release that exists.
  * **`TROUBLESHOOTING.md` named the wrong cause for a vanished `cordis.patch.yml`.** `dsh plugin add`
    does **not** rewrite it — the CLI shares the plugin manager's package operations, which write
    `package.json` and `pnpm-lock.yaml`. What removes the file is Desktop's fatal-recovery
    `sanitizeProfile`, which renames it to `cordis.patch.yml.bak-<unix-ms>`; the `.bak-<timestamp>`
    sibling is the receipt to look for, and the backup habit matters more before an upgrade, not less.
    The same section now shows the `insert:` form and states what a bare `- id:` actually does — replace
    fields on a row that already exists, so against a row nothing created it is a silent no-op and the
    loader says `patch: entry "w2m" not found` while the install reports success.
  * **`docs/P2P-CRYPTO.md` dated the data plane's encryption to a release that does not exist.** Stage 1
    shipped in **v0.5.3**, and the file said v0.6.0. This is the first v0.6.0, and the reference now says
    v0.5.3.
  * **The `p2pOfferGraceMs` line in the v0.4.0 entry said 1200 ms and the shipped constant is 3000 ms.**
    The widening rode *inside* v0.4.0 (commit `eea80c7`, the commit the tag points at) without its own
    CHANGELOG line, which `CONTRIBUTING.md` §5 requires for a behaviour change. The line matches the
    shipped constant now and the omission is recorded rather than left to be rediscovered from a diff;
    `README.md` and `PROTOCOL-v0.4.0.md` carry the same correction.
  * **`docs/PIPELINE-DESIGN.md` opened with "unresolved, and `pipeline` is deliberately not
    implemented"**, which had been false since v0.3.4, and it recommended Option A while **Option C** is
    what shipped. The analysis is kept as written and the divergence is stated: editing the argument to
    match its conclusion would destroy the only thing that file is good for.
  * **`deploy/networking/LESSONS.md` stated the tunnel invariant in a form that contradicts the
    ledger.** It said "tunnelled traffic must never be reported as `p2p`"; `transport` is the **socket
    path**, rung 4 *is* a socket between the two machines, and calling that a lie would make the field
    useless. The rule that actually holds is that the **tunnel must be named explicitly** wherever it
    carried the traffic, and that "direct" must never be read as "the bytes avoided a server".
    `deploy/networking/README.md` states it in the same words, and the two files now agree with each
    other and with `docs/AUDIT.md`.

### Notes

* **What is new behaviour here, and what is a document catching up to behaviour that already shipped.**
  The REFUSE parse and its `k_ref` seal, the node `unref()`, the state-publish retry and cleanup, the
  shared allow-list matcher and its three narrower rules, the operator-token printing gate, the
  supervisor's lock / reap-by-identity / `MultipleInstances` correction, the pre-flight's ledger, the
  compat gate's structural classification, and the `test:all` + `--test-force-exit` wiring are **code
  changes in this release**. The client-entry requirement (`id: w2m`, the **bare** package name, and the
  `insert:` form) and the loader driver's **registry-wide failure sweep** shipped in v0.5.4–v0.5.6; what
  is new here is that both are documented as requirements a reader can act on, and that the compatibility
  gate requires the sweep's own result line (`sweeps every fiber in the process and finds no failure`) by
  name instead of trusting nine hand-listed titles.
* **LAN discovery remains opt-in, and it is unverified on a real network.** Every socket in
  `test/mdns-wire.test.mjs` and `test/mdns-discover.test.mjs` is loopback, and no mDNS packet has crossed
  a real LAN in this project's testing; `README.md` names both suites in its table now rather than
  leaving them to be found. Discovery is a **hint, never an authorisation**: a machine the LAN announced
  but the relay does not list is not a target.
* **One check is `UNVERIFIABLE` on this machine and is printed as such rather than passed quietly.** This
  host's `%DSH_HOME%` holds no `dsh-runtimes\`, while `src/agent/resolve.mjs` looks for the bundled
  runtime at `dsh-runtimes/dsh-primary-runtime/dependencies` and the application bundle carries it at
  `E:\DS\resources\runtime\primary-runtime\dependencies`. The suite is run against a throwaway home with
  the documented layout, and the host mismatch is printed next to the verdict.
* **Unverified from this machine, stated rather than implied.** The GitHub Release assets behind the
  documented tarball URLs (`test/claims.test.mjs` skips that claim without `W2M_NETWORK_TESTS=1`), and
  **the first CI run of the compatibility gate in its new form**: its verdict program is extracted out of
  the workflow and exercised by `test/claims.test.mjs` against synthetic TAP captures — an honest
  no-browser skip, an injected extra assertion, an unaccepted reason — but the gate itself is judged by a
  runner that is not this machine.
* The numbers in `README.md`'s suite table are the **v0.5.9** measurements and stay labelled that way.
  Adding `test/p2p-crypto.test.mjs` to `test:all` changes that row's suite and test counts, and neither
  was re-measured for v0.6.0 on this host — a full `test:all` on this machine takes long enough that
  running it to refresh a table would be the wrong trade.

## [0.5.9] — 2026-10-11

### Added

* **A release pre-flight, as one entry point: `node scripts/preflight.mjs`.** A release is now
  something you start by running it, and a green run is the precondition for the version bump. It
  checks, in order: that every gate it delegates to exists on disk; that lint is at 0 errors; that the
  mojibake scan is clean over the whole tree; that the suite declared in `package.json#scripts.test`
  runs and passes; that the **packed tarball** — not the tree — contains every path `package.json#files`
  names, names the tree's version, carries no forbidden path (`node_modules`, `test/`, `scripts/`,
  `.git`, `*.proof-backup`/`*.orig`/`*.bak`) and registers its eight tools when executed from the
  extracted copy; that the version, bundle-patch and document claims in `test/claims.test.mjs` still
  hold; and that the CHANGELOG's title sits above its newest entry and its entries run newest-first.
  Every check reports `PASS`, `FAIL` or `UNVERIFIABLE` **with a name and a reason**, and the run fails
  if any registered check produces no result at all: "the gate ran" is itself a check, and the ledger
  that enforces it is itself exercised on every run against a silent check, a throwing check and an
  honest one — because a self-authored gate that reports success while executing zero checks is a
  defect this project studied in another one. The first draft of that ledger counted a coerced `FAIL`
  as a produced result, and the self-test caught it on its first run.
* **A wiring check that would have caught two of the defects below.** Every `test/*.test.mjs` on disk
  must be named by some npm script, and every path an npm script names must exist. Measured now: 36
  suites on disk, 36 named by a script, 0 orphans, 0 named-but-absent.
* **A CI compatibility gate** (`.github/workflows/compat.yml`, with its own section in
  `CONTRIBUTING.md`). Three jobs. *mount-and-boot* builds a pinned host in `RUNNER_TEMP`
  (`@deepseek-ai/dsh@0.2.0-rc.2`, `dsh-app-boot`, `dsh-client-modules`, `cordis@4.0.4`,
  `cordis-plugin-loader@1.0.5`), runs the existing `test/loader-entry.test.mjs` against it **unmodified**
  and classifies the TAP capture with nine named assertions, of which a `SKIP` counts as a failure.
  *bare-import* packs, installs into an empty project, and asserts `dependencies === {}`, that no host
  package resolves, and that the root export is a callable `apply`. *uninstall* asserts the composition
  is byte-identical before and after, and documents why the manifest key set is not compared. Triggers:
  PRs to main, pushes to main, `v*` tags, weekly, and dispatch; `contents: read`, no secrets. No-browser
  is the single entry on `ACCEPTED_UNVERIFIABLE` and reports `UNVERIFIABLE` with its reason rather than
  `PASS`. Validated end to end against a synthetic installation built with the workflow's own commands
  (10/10 pass) and in the failing direction with `W2M_ROUTE_DEFECT=1`, which reports `FAIL` naming the
  route assertion and the fiber sweep — the same both-directions rule the rest of this release follows.
* **Refusal codes, and the exposure boundary written down as executable text.** 26 codes in three
  greppable tables (`REFUSAL_CODE` in `src/plugin/tools.mjs`, `MATCH_REFUSAL` in
  `src/agent/allowed-commands.mjs`, `EXEC_REFUSAL` in `src/agent/exec.mjs`), with
  `MATCH_REFUSAL.NOT_ALLOWED === REFUSAL.COMMAND_NOT_ALLOWED` asserted so the two ends of a dispatch
  cannot drift apart. The defect this closes is that `applied: false` conflated three different facts:
  a stored selection naming no machine was indistinguishable from "the whole fleet ran it", and that
  state now has its own code (`SELECTION_UNUSABLE`). Every refusal carries `reason_code` and a `detail`
  saying what would change it. The boundary itself — no tool parameter may name a credential, an
  allow-list, a key path or a state directory — is stated in `src/plugin/tools.mjs`'s header and pinned
  by four canaries run across all eight tools, proving that no result and no request body carries a
  token. Proven by 17 mutations, 17 red, in a scratch copy outside the repository.

### Fixed

* **`CHANGELOG.md` had carried a mangled character into the published package.** v0.5.8's own entry —
  the one describing the mojibake repair — contained the two garbled CJK sequences it was complaining
  about, reproduced literally inside backticks. `CHANGELOG.md` is in `package.json#files`, so v0.5.8
  shipped the damage it was apologising for, and `scripts/scan-mojibake.mjs` was red on the tree. The
  line is ASCII now and the scan is clean over the whole tree.
* **The CHANGELOG's title and introduction were in the middle of the file.** The v0.5.8 entry was
  prepended above `# Changelog` itself, which is the same mistake as the out-of-order entries v0.5.8
  fixed, one level up: "newest first" was true of the version headings while the document's own header
  had been pushed to line 21. The entry is below the title again, and the pre-flight now asserts the
  shape rather than only the order.
* **The entire declared unit suite had not been running.** Wiring the new suites into
  `package.json#scripts.test` and `#scripts.test:all` dropped one space, producing the path
  `test/claims.test.mjstest/fleet-target.test.mjs`. `node --test` exits 1 on a missing path, so
  `npm test` was failing immediately and *no* unit suite — not just `fleet-target` — was running. This
  one is mine: it came from the edit that wired the new suites in, and it means the declared unit suite
  was not being run at all between that edit and this release.
* **`test/p2p-crypto.test.mjs` was named by no script at all.** 33 tests, green, and wired into
  nothing — the exact defect v0.5.7's release note identified in someone else's repository. A suite
  that never runs protects nothing, and that is now asserted rather than assumed. **It is in `test`,
  and as of this entry it is still *not* in `test:all`** — that is a wiring gap, not a rounding
  detail, because `test:all` is the suite a release runs: 35 paths are named there and
  `test/p2p-crypto.test.mjs` is not one of them, so the crypto suite still does not ride the full
  gate. This entry previously claimed both; the claim is now the measured one. The fix is one path in
  `package.json#scripts["test:all"]`, appended after `test/mdns-discover.test.mjs` — the file is owned
  by the integrator, so the line is reported rather than edited here.

### Notes

* This release exists because three releases in one hour — v0.5.6, v0.5.7, v0.5.8 — each fixed a
  defect the previous one introduced. **Every one of those defects was found after the tag was pushed**,
  by a gate that already existed and simply was not run before the release. The gates were never
  broken; the process around them was missing. That process is this release's subject.
* One check is `UNVERIFIABLE` on this machine and is reported as such rather than passed quietly: the
  host has no `%DSH_HOME%\dsh-runtimes\`, while `src/agent/resolve.mjs` looks for the bundled runtime at
  `dsh-runtimes/dsh-primary-runtime/dependencies` and the application bundle carries it at
  `E:\DS\resources\runtime\primary-runtime\dependencies` instead. The suite's bundled-python claim is
  measured against a throwaway home with the documented layout, and the host mismatch is printed next
  to the verdict, as an open question rather than a silent pass.
* Two checks are known to be sensitive to a loaded machine rather than to the artifact, and both are
  named here rather than discovered later: `test/relay.test.mjs`'s `runs a complete signed task end to
  end`, whose `lease_until` is computed by the relay during the request and recomputed by the test
  after the await, so the two can land in different seconds; and the capability probe in
  `test/agent.test.mjs`, which measures the host's own runtime layout as well as the resolver. A red
  run naming only these is a re-run, not a release defect — and a report that hides them behind a green
  verdict is the kind of green this release exists to avoid.

## [0.5.8] — 2026-10-11

### Fixed

* **The CHANGELOG was out of order, and the claims gate caught it.** My bump scripts anchored the new
  entry on the wrong heading, so v0.5.5 ended up *above* v0.5.6 and v0.5.7 and "the newest entry" stopped
  meaning anything — which is exactly the assertion `test/claims.test.mjs` makes. Entries are ordered
  newest-first again, and the anchor is the top of the file rather than a version I have to remember.
* **Mojibake in shipped code.** `src/agent/mdns-wire.mjs` is packed, and its comments carried an em dash
  and a section sign that had been decoded as the wrong encoding and re-saved, so a reader would have
  seen the two garbled CJK sequences where the RFC references belong. The same damage was in
  `test/mdns-discover.test.mjs`.
  All five mDNS files are ASCII now, and the repository's own mojibake scan is clean.

### Notes

* Fix-forward again, and for the same reason: v0.5.6 and v0.5.7 are published and stay published.
* Three releases in an hour, each fixing a defect the previous one introduced and a gate caught. That is
  the gates working, but it is also a release process with no pre-flight of its own — which is the next
  thing this project should fix rather than the next thing it should be proud of.
* No runtime change: the code in v0.5.8 is the code in v0.5.6.

## [0.5.7] — 2026-10-11

### Fixed

* **v0.5.6 shipped without its own documents.** `TROUBLESHOOTING.md` and `SECURITY.md` were written,
  reviewed and committed, and then **not packed**, because `files` names the documents individually
  rather than by pattern. Anyone installing v0.5.6 got the code and none of the guidance. They are in the
  package now, and `test/claims.test.mjs` is the place this class of defect belongs.
* **v0.5.6 shipped without its own gates wired in.** `test/claims.test.mjs`, `test/loader-entry.test.mjs`
  and the two mDNS suites existed and passed, but were listed in none of `test`, `test:all` or `verify` —
  a test that does not run protects nothing, which is the exact defect this release's own study
  identified in someone else's repository. All four are wired in.
* A typographic character (a smart quote) in `test/mdns-discover.test.mjs`, caught by the repository's
  own mojibake scan.

### Notes

* Fix-forward, not a rewrite: v0.5.6 is published and stays published, because the alternative is
  rewriting history someone may already have. Both defects are mine, and both are the class this project
  keeps naming — a claim that nothing checks.
* No runtime change: the code in v0.5.7 is the code in v0.5.6.

## [0.5.6] — 2026-10-11

### Fixed

* **The client entry could not activate, and that made the whole application refuse to start.**
  v0.5.4 and v0.5.5 were withdrawn for it. The real cause, taken from the page itself rather than
  guessed:

  ```
  w2m-client-probe: apply threw for @twinsearth/w2m-dsh-plugin: cannot get property "locale" without inject
  Error: web boot: 1 entry did not activate
  ```

  Cordis throws for any `ctx.<name>` a fiber reads without declaring it, and the client half declared
  `inject = []`. **The first throw was `locale`, not `slots`** — so declaring the seat alone, or guarding
  the locale alone, would each still have died. Now `inject = ['slots']` (a declared name is a *required*
  dependency, which is why `locale` is deliberately not among them), the optional carrier is read
  inject-free with `ctx.get('locale')` while its dictionary registration rides a child fiber, a context
  with no usable seat becomes a **no-op with a diagnostic** instead of taking the page down, and `apply`
  prints the inner message to the error-level renderer console — the channel the crash log reads — and
  then rethrows, because a swallow would boot a healthy-looking page with no control.
* **A failed entry was invisible unless you read fiber state.** `cordis-plugin-loader` no longer
  propagates a failed mount to `await ctx.loader.await()`, and the loader driver inspected only the one
  entry it knew about — so a failure landing on a **child** fiber (our silently-refused route) went
  unseen. The driver now sweeps the whole registry and reports `failedFibers`.

### Added

* **A gate that would have caught all of it**: `test/loader-entry.test.mjs` packs the tree, installs the
  tarball with the installation's own `dsh plugin add` into a throwaway profile under a throwaway
  `DSH_HOME`, boots it with the real `runProfile`, activates the client entries through the real module
  system, and — when a browser is present — boots the profile's own page and asserts our control renders.
  Proven in both directions: **10/10 on this tree, 2 failures against the preserved pre-fix tarball, 9
  against the v0.5.4 one**, and with a deliberately injected route defect it names the **child** fiber
  while "entry active" and "eight tools" still pass. It reports one stage per line, so a failure names
  its cause.
* **`test/claims.test.mjs`** — 22 checks that our own published claims match the artifact, with the
  registered tool set *measured* by importing the entry. It caught a stale claim in our README on its
  **first run** (`README.md` said the installer asserts 5 tools; it asserts 8), and its author's own
  mutation proof caught two false greens in its first draft — a scan that extracted zero tool names and
  a lookahead that invented one out of a metric.
* **`TROUBLESHOOTING.md`** — 17 symptom-indexed sections that name the culprit when it is not us (pnpm's
  `minimumReleaseAge`, carrier-grade NAT, the OS firewall, an installer that rewrites the profile patch),
  ending with a data-location table and a reason-code table.
* **`SECURITY.md`** — a private reporting channel and **no public-issue route**, an honest support table,
  and the consent model written out: what a paired machine may and may not do, and that we never write to
  another machine's `authorized_keys`.
* **`CONTRIBUTING.md`** — one page of falsifiable conventions, including **"a test that would pass
  against a broken artifact is not evidence"** and **"run mutation proofs in a copy, never in the shared
  tree"** (both learned the hard way).
* **Opt-in LAN discovery** (`src/agent/mdns-wire.mjs`, `src/agent/mdns.mjs`, `src/plugin/mdns-discover.mjs`):
  a bounded, hand-written DNS/mDNS codec with parse hardening (a pointer may only name a *prior* offset, so
  termination is a property of the format; a 128-hop budget reported separately from a loop; label, name,
  record and packet caps; every read bounds-checked) and a discovery source exposed through
  `w2m_devices`' new `include_discovered` (default `false`). **Discovery is a hint, never an
  authorisation**: a discovered device is refused as a dispatch target unless the relay already lists it
  and it is online, and the positive control is tested so the rule cannot pass by refusing everything.

### Notes

* **v0.5.4 and v0.5.5 remain DO NOT INSTALL.** This release also exists so that `latest` on the registry,
  which still pointed at v0.5.5, stops handing out a version that prevents the application from starting.
* **Upgrading from v0.5.4 needs one edit outside this package**: the profile's `cordis.patch.yml` must
  name the package (`@twinsearth/w2m-dsh-plugin`), not the `/tools` subpath. With the corrected bundle row
  a mismatch makes the loader skip the whole patch and silently revert every configured value to its
  default. The claims gate now checks this.
* **LAN discovery is unverified on a real network.** Every socket in its suite is loopback and no packet
  left the host, so it says nothing about whether a switch forwards `224.0.0.251` or how a real
  Bonjour/Avahi peer answers. There is **no third-party interoperability test**, no probing or conflict
  resolution, IPv4 only, and the responder is **built and tested but not started** by the plugin —
  loading a plugin should not silently multicast on the host's network.

## [0.5.5] — 2026-10-11

### Fixed

* **The v0.5.4 loader failure, with the cause the loader actually reported** rather than the hypothesis
  that stood in for it:

  ```
  w2m (@twinsearth/w2m-dsh-plugin/tools): Error: cannot get property "connection" without inject
    at registerTargetRoutes (src/plugin/fleet-target.mjs:483:25)
  ```

  cordis throws on reading a service property the fiber never declared, so the entry died and took all
  eight tools with it. **Every existing test was blind to this**, because they drive the plugin with a
  plain-object context where an undeclared read merely yields `undefined` — the fake was more forgiving
  than the runtime. Fixed with `ctx.inject(['connection'], …)`, which is also the only shape that can
  work: in the real composition the service is genuinely absent while `apply()` runs, and siblings are
  mounted concurrently.
* **The client half was never composed either, for a second and independent reason:** the bundle row
  named the subpath `@twinsearth/w2m-dsh-plugin/tools` instead of the package, and a client package is
  identified by its Loader row specifier — a subpath resolves to no `package.json`, so `dsh.client` was
  never read and no boot-graph row was built. The row now names the package.
* **A silent route rejection:** the control fetched `/w2m/target`, but fetch routes are validated
  against `/api/`, and the refusal failed only a child fiber, so nothing surfaced. Now
  `/api/w2m/target`, mirrored in the shipped bundle.

### Added

* **`test/loader-entry.test.mjs`** — the test that would have caught v0.5.4: it packs the tree, installs
  the tarball with the installation's own `dsh plugin add` into a throwaway profile under a throwaway
  `DSH_HOME`, and boots it with the real `runProfile` under the Harness runtime, asserting that the
  entry activates, all eight tools are registered, the boot-graph row is composed from the shipped
  bundle, and no failed entry names the package. **Proved in both directions**: 6/6 pass on the fixed
  tree and 6/6 fail against the preserved v0.5.4 tarball, failing on precisely the loader error quoted
  above. It skips loudly, naming the probes it tried, when no installation is found.
* Cheap always-on guards in `test/client-bundle.test.mjs` that need no Harness: the platform field, the
  client export, the row must be the bare package name, and the bundle's route must equal the host's.

### Notes

* **An upgrade from v0.5.4 requires one edit outside this package:** `cordis.patch.yml` in the profile
  must name the package (`@twinsearth/w2m-dsh-plugin`), not the `/tools` subpath. With the corrected
  bundle row, a mismatch makes the loader skip the whole patch — silently reverting `rabbitUrl`,
  `operatorToken`, `stateDir`, `projectDir`, `machineName`, `p2pMode` and `allowedCommands` to their
  shipped defaults. Measured both ways with `--dump-config`.
* **0.5.4 remains DO NOT INSTALL.** This release exists so that a rebuilt artifact is distinguishable
  from the broken one by version alone.
* Still unverified, and not claimed: how the control *renders*. No browser was opened. What is proven is
  the entire host side — the entry activates, the eight tools register, the boot-graph row is composed
  from the shipped bundle, the route is registered and attached — plus the seat shape in a VM test.

## [0.5.4] — 2026-10-11

> **DO NOT INSTALL 0.5.4.** It fails to load in the Harness: the loader entry
> include:@twinsearth/w2m-dsh-plugin/tools reports iberPhase: failed, so **all eight tools
> disappear** and the client half never registers. The package verifies in isolation
> (scripts/verify-installed.mjs reports 8 tools registered) and its exports map is complete, so the
> failure is in the real loader path -- the newly declared dsh.client half being composed there, with
> lib/client.js being browser code that has no window under a host-side load. That cause is a
> hypothesis, not a measurement; the loader's own error is still to be read. 0.5.5 fixes it and adds the
> test that should have caught it: **load the packed artifact through the real loader path**, which is
> the step this release skipped. The tag and the npm version stay as published history; they are simply
> not installable.


### Added

* **A dispatch-target control inside the chat composer.** A client half registers into
  `conversation.input.left` — a `list` seat with `replaceRisk: none` — so the control is added *beside*
  the permission control rather than shadowing it; `conversation.input.permission` is never touched. The
  roster is the relay's own device list, read through the same helper `w2m_devices` uses, so the tool and
  the control cannot disagree; a machine the relay does not list as online is shown but not selectable.
* **The selection means something, and only via fields that already existed.** Picking a machine stores a
  per-session target that survives a page reload; `w2m_run` maps it onto `target_machines` for
  replicate/split/pipeline and onto `executor_machine_id` for broadcast, and a caller that names an
  executor explicitly always wins. No new tool parameter, no protocol change, `envelope_version`
  untouched. `w2m_status` reports the current target.
* `lib/client.js` is the shipped browser bundle, written by hand in the runtime's lazy-CJS loader format
  because this package has no bundler; `dsh.client` and `exports["./client"]` declare it additively.

### Notes

* Verified by test and by a live probe against the real relay: selecting `jp-shared` and dispatching with
  no executor named produced leases `jp-shared: offered`, the other two `observing`, and a `consistent`
  verdict from the machine that was selected. **Not verified: how the control renders.** Every client
  Inspect query timed out for the whole session, so the page is not answering the client inspect channel
  and the rendered text and position beside the permission control are unconfirmed.
* **A page refresh cannot show it.** The running Harness composes the client boot graph at startup and
  serves the plugin from the profile's `node_modules`; the new revision must be installed *and the
  Harness restarted* before the control appears. The control is therefore in the artifact and not in the
  running UI, and this entry says so rather than implying otherwise.

## [0.5.3] — 2026-10-11

### Added

* **The peer-to-peer data plane can now be encrypted.** Stage 1 of `docs/P2P-CRYPTO.md`: each machine
  holds an X25519 keypair beside its device identity, the relay carries each peer's static public key
  inside the offer it already sends — so **nobody fills in a `[Peer]` block by hand** — and the direct
  channel completes a two-message IK-shaped handshake before a single frame is trusted. Triple DH gives
  mutual authentication and forward secrecy; ChaCha20-Poly1305 with WireGuard's nonce layout carries the
  frames; a 64-message replay window and an HKDF epoch ratchet (2^20 messages or 120 s, previous key
  retained 15 s) keep it going without a round trip in the data path.
* A handshake failure is **terminal for that peer, never a silent downgrade to plaintext**: a peer that
  has no key for us gets the plain channel it would have had and the ledger records
  `p2p.encrypted: false` with a reason. A machine is never lost to a security upgrade — only told that
  the upgrade did not complete.
* `PROTOCOL.md` §9; `w2m_status` reports `p2p.encryption`.

### Notes

* **The tests earned their keep: they caught seven real defects**, including a replay window that
  accepted replays of frame 2, a lookahead bound that capped our own send epoch, and a plain-ACK race
  that could downgrade a live encrypted session to plaintext — the exact failure the design forbids, now
  structurally impossible.
* `mac1`/`mac2` are **not** implemented: keyed BLAKE2s is not exposed by `node:crypto`. They mitigate
  CPU-exhaustion denial of service, not confidentiality or authenticity, and the omission is a named
  value in the code rather than a silence.
* Every socket in the new suite is loopback and crosses no NAT; that is stated in the suite header and
  is not evidence that a real translation can be crossed.
* No protocol version bump: `envelope_version` stays `1.0` and a v0.4.x/v0.5.x peer is unaffected.

## [0.5.2] — 2026-10-10

### Fixed

* **The supervisor now says what it is doing, in a file.** A death that arrives with the console
  cannot be logged from inside the process it kills — the log simply stops — so the supervisor
  records `supervisor-heartbeat.json` (written atomically) with its state (`running` / `backoff` /
  `degraded` / `stopped`), the child pid, restarts within ten minutes, the last exit code, and a note
  that `3221225786` is `0xC000013A` rather than a crash of the agent logic. After three exits inside
  ten minutes the state becomes `degraded` and the backoff grows to five minutes: not "give up", but
  "stop hammering and say so", so the fleet sees a machine that is present and unwell instead of one
  that vanished.
* **Orphan agents are reaped at start.** Detaching the agent (v0.5.1) is what stops a console
  teardown from taking the machine off the fleet, and it leaked: three agents with one identity were
  found running at once, the newest unable to bind the punch port (`P2P_BIND_FAILED: EADDRINUSE
  0.0.0.0:41235`) because an orphan held it, while `MultipleInstances IgnoreNew` kept a fresh
  supervisor from starting at all. The heartbeat names the last child, so a new supervisor terminates
  that pid before it spawns anything.

### Added

* **`docs/AUDIT.md`** — what is implemented, what is running and how it works, with every claim
  labelled `[M]` measured live, `[T]` asserted by the suites, or `[?]` **not verified**. It records
  the uncomfortable half on purpose: A and B have no live proof yet, the macOS machine's state is
  unconfirmed, the WireGuard hub has never seen a handshake, the session-0 service has never been
  executed, and the link from the Windows machine to the relay is intermittently down. Its last
  section is the commands to re-run each check, so the next reader need not trust the snapshot.

### Notes

* This release exists because `deploy/` and `docs/` are inside the published package: after v0.5.1 the
  tag and the tarball had drifted, and a release is the only honest way to close that.
* No runtime change to the eight tools.

## [0.5.1] — 2026-10-10

### Fixed

* **The agent no longer dies with its console.** Measured twice on the fleet: the whole process
  tree — supervisor and agent together — was killed with code `0xC000013A` (`STATUS_CONTROL_C_EXIT`,
  its console went away), the log ended mid-sentence, and Task Scheduler did not restart it, so the
  fleet silently lost the machine. A supervisor that shares the console dies with the thing it
  supervises, which was its one job. The supervisor now spawns the agent with `detached: true` and
  **file-descriptor stdio** — never `inherit`, never pipes, because a detached child writing into a
  pipe whose reader has died blocks instead of failing loudly.
* **The scheduled task heals itself, without elevation.** The interactive mode now also registers a
  repeating trigger (default every 5 minutes) which, with `MultipleInstances IgnoreNew`, means "be
  running, or start": a death from any cause is repaired at the next tick. It exists because
  `RestartCount 999` was measured not to fire at all.

### Added

* **`deploy/networking/LESSONS.md`** — a read-only study of 2dust/v2rayN (GPL-3.0, so description
  with citations only and nothing copied) recording the transport disciplines this project was
  missing, and the decision it changed: **no TUN/VPN mode.** v2rayN never creates an adapter itself
  and contains no peer-to-peer anywhere; a tunnel is hub-and-spoke by construction, so it would make
  our "the data path is peer-to-peer" claim false for exactly the traffic a tunnel exists to carry.

### Notes

* A regression introduced and caught during the fix is recorded in the code: the first version also
  called `child.unref()`, which leaves the supervisor with no handle at all, so its event loop
  drains and it exits immediately after spawning the agent. The evidence was that no supervisor
  process existed — found while looking for a different property.
* Verified on the machine that had the defect: supervisor and agent both present, and killing the
  supervisor leaves the agent alive with its punch socket still bound (`0.0.0.0:41235`).
* Also included: the test fix for `test/outbound-only.test.mjs`, whose port was being read from the
  timestamp rather than from the field that states it (commit `57dbc5f`).

## [0.5.0] — 2026-10-10

The release that stops treating "the relay carried it" as the only answer for a machine behind a
symmetric NAT. Measured before it: a dispatcher behind carrier-grade NAT (an iPhone hotspot, in this
fleet) could not push an offer to a peer, the peer's result could not come back, and both halves fell
to the relay on **every** task — `P2P_PUNCH_TIMEOUT` on the push, `transport: relay` on the result.

### Added

* **Simultaneous two-way punch.** The dispatcher publishes its punch in the offer it puts on the relay
  (`POST /v1/task`'s `p2p`: `{mode, punch, candidates?}`), and the executor — which previously could
  only wait in `accept()` — **dials the dispatcher back** on the same derived session, concurrently
  with execution, bounded by the new `tuning.reverseDialTimeoutMs` (default **8000 ms**). Two NATs
  that each open a mapping toward the other can then meet; one of them no longer has to be dialable.
* **Reverse dial on the result path.** `planDirectDelivery` dials the dispatcher before falling back
  to the relay, reusing the offer-time attempt when there was one (one bounded window per task, never
  two) and starting its own when the channel died in between. This is the direction that works for a
  symmetric-NAT machine: it dials *out*.
* **The ladder is now recorded, rung by rung.** `p2p.opened_by` names the mechanism
  (`dispatcher-punch` | `simultaneous-punch` | `result-reverse-dial`); `p2p.reverse_dial`,
  `p2p.reverse_dial_ms` and `p2p.reverse_dial_reason` say whether a dial was attempted, what it cost
  and why it lost (`P2P_REVERSE_DIAL_TIMEOUT`, `P2P_REVERSE_DIAL_FAILED`, `P2P_CHANNEL_LIVE`,
  `P2P_NO_SESSION`, `P2P_NO_ORIGIN`, `P2P_DISABLED`, `P2P_UNREACHABLE`, `P2P_NO_TASK_ID`). The
  mechanism is shared with the plugin (`punchSession()` lives in one place, imported, not copied).
* **`deploy/networking/`** — the ladder written down: five rungs with what the ledger shows for each,
  `acceptance.mjs` to measure which rung a real dispatch takes (it mints a real punch id, because a
  body without one exercises neither new path), and `wireguard/server-setup.sh` for rung 4.

### Fixed

* **`P2PChannel.close()` could never send its BYE.** It set `closed = true` and *then* called
  `sendFrame(BYE, …)`, and `sendFrame` refuses to send once closed — so the goodbye was unreachable
  dead code. The measured consequence sat exactly on the path this release is about: `pushOffer`
  closes the channel it pushed over, the executor kept a channel it believed was live, sent its result
  into it and fell back only after `P2P_FRAGMENT_UNACKED … after 8 attempts` — **with no reverse dial
  attempted**, because a channel for the task still existed. Change B alone could not have fixed the
  measured failure; this is the other half. `close(reason, {silent: true})` exists for discarding a
  duplicate local view of a live session (a simultaneous punch legitimately creates two channel
  objects on one side, and a BYE there would tear down the peer's working channel).

### Changed

* **`transport` widens.** It is `p2p` when the direct path carried **either** half — the offer over a
  channel **or** the result acknowledged over one — and `relay` only when the relay carried both.
  `p2p.offer_path` keeps its exact meaning ("how the offer arrived"), which is what keeps the two
  halves distinguishable: `transport: p2p` + `offer_path: relay` is a result that found its own way
  home. Anything reading `transport` alone should read `offer_path`/`opened_by` beside it.

### Compatibility

No protocol version bump: `envelope_version` stays `1.0`, the new keys live inside the optional `p2p`
object, and `transport`'s value set is unchanged. A v0.4.x relay stores and republishes the extended
object **verbatim**, and a v0.4.x agent ignores keys it does not know — both are pinned by tests, on
both sides, rather than argued from intent.

### Verification

* Required suites: **424 tests, 421 pass, 1 fail, 2 skipped** (baseline 407/404/1/2 → +17 new tests,
  all passing). The failure is the pre-existing bundled-python case.
* Every other suite: 340 tests, 335 pass, 2 fail (the pre-existing `pipeline-e2e` cases).
* `eslint .`: 0 errors, the same 79 pre-existing warnings.
* **Not verified, and it matters:** every punch in the suites is loopback, which crosses no NAT, and
  no genuine v0.4.x binary was run — compatibility is argued from the relay's validation code plus
  round-trip tests. Real traversal needs a fleet running this build; that is the next measurement, not
  a claim in this entry.

## [0.4.9] — 2026-10-10

### Fixed

* **The Windows supervisor silently dropped every `-AgentArgs` value.** `install-service.ps1` writes
  `agentArgs` into `agent.json`, and `ConvertTo-Json` collapses a single-element array to a string —
  while the supervisor's passthrough only handled an array. So `-AgentArgs '--p2p-mode auto'` was
  accepted, written, and then ignored, and the agent ran on its defaults. Nothing failed; the field
  simply had no effect. It now accepts both shapes (a string is split on whitespace) — the same class
  of bug as the camelCase key mismatch fixed in v0.4.4: **a config field that is read but not
  understood is indistinguishable from one that was never set.**
* Found while pinning this machine's punch port (`--p2p-port 51820`), which was the first agent
  argument whose absence would have been visible — that is what exposed the dropped-arguments path.

### Notes

* No protocol change, and no behavioural change for an `agentArgs` that was already an array (what
  the installer writes for two or more arguments). This makes the documented `-AgentArgs` real.

## [0.4.8] — 2026-10-09

### Added

* **The listing badge, with the URL it actually resolves to.** The plugin is listed on
  dsh-plugin.org as `twinsearth/dsh-windows2macos` under Workflow & Automation, marked
  **Verified** — it was auto-discovered through the `dsh-plugin` topic and reviewed by hand
  before this release. The badge links to that page rather than to a guessed slug.

### Notes

* The listing's own snapshot was stale (it still showed v0.3.8 and an install command the hub
  derived itself), so a submission issue was filed with the hub's template —
  [dshplugin/dsh-plugin-hub#141](https://github.com/dshplugin/dsh-plugin-hub/issues/141) — which
  is what triggers a re-scan. Nothing about being listed had to be requested: the topic is the
  entry point, and this repository already carried it.
* The package is on npm as `@twinsearth/w2m-dsh-plugin` (latest 0.4.7 at the time of this
  release). With the package now existing, npm **trusted publishing** can be configured for this
  repository and `release.yml` — after that every future release publishes itself with provenance,
  and no token or one-time code is involved.

## [0.4.7] — 2026-10-09

### Fixed

* **The package root exported nothing, and the ecosystem checks the root.** `lib/index.js` was
  deliberately documentation-only — the profile mounts `@twinsearth/w2m-dsh-plugin/tools` because
  `cordis.patch.yml` names that subpath — so `import('@twinsearth/w2m-dsh-plugin')` returned
  `Object.keys() === []` and `typeof apply === 'undefined'`. A plugin that mounts perfectly and
  looks like an empty package to every tool that inspects it is a listing risk with no upside: the
  DSH plugin listing requirements ask for a package that "exports an `apply(ctx)` module", and a
  missing root export is one of the most common reasons a submission is refused. The root now
  re-exports `apply`, `inject` and the test helper from `./tools.js` — one implementation, two
  entry points — and `test/tools.test.mjs` asserts it, so it cannot silently regress.

### Notes

* Nothing about the mounted plugin changed: the patch still names the subpath rather than relying on
  the "root is the plugin" convention, which is what keeps the eight tools from being registered
  twice.
* `tools.test.mjs`: 83 pass, 0 fail.

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
  **holds its own copy of that offer back for `p2pOfferGraceMs` (3000 ms)** and
  offers it anyway if the punch does not land — without that hold the direct path
  could never win, because an SSE push over an already-open connection beats a
  punch that costs a round trip. Measured on loopback while writing it: the relay
  copy won every time. The hold is cancelled by the executor's own lease
  heartbeat, so no new message was needed to say "the direct copy arrived".
  The first value was **1200 ms and it was too tight** — measured on a 1-vCPU
  shared host, two agent tests saw the relay's copy overtake the direct one, which
  under `p2pMode: direct` refuses an offer that was about to arrive. This entry said
  1200 ms for the whole of v0.4.0; the widening to 3000 ms rode **inside** v0.4.0
  (commit `eea80c7`, the commit the tag points at) **without its own CHANGELOG
  line**, which `CONTRIBUTING.md` §5 requires for a behaviour change. The line now
  matches the shipped constant, and the omission is recorded here rather than left
  for a reader to rediscover from a diff.
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
