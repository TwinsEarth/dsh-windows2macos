# Changelog

All notable changes to this project are documented here.

## [1.1.2] — 2026-10-17

**A dispatch that names no machines now goes to the machines that are online. The rule that decides "online" had been
written three times and the three copies are now one.**

### The defect

The relay built a lease for **every paired device**, including a machine whose agent had stopped heartbeating days
earlier. That lease expired, `partial` became the only verdict the task could reach, and a fleet whose live machines
agreed reported *"incomplete"* forever. Observed on 2026-10-17:

    aggregate: partial    counts: { ok: 3, expired: 4 }

So "all machines agree" was **unreachable** while a stale entry existed, and no amount of re-running could fix it.

### The fix: one definition, three call sites

`device.online === true` alone is **not** the answer -- the flag stays true until the sweep runs. The real rule was
already computed, in two places, as `device.online === true && !silent`, and the target list was about to become a
third copy. It is now a method:

    isOnlineDevice(device, nowMs = this.nowMs())

used by `deviceStatus`, `publicDevice` and the default target list. `simtMs === null` (no contact ever observed) is
**not** silent, so an unknown age cannot be read as "gone".

### `include_offline` is the escape hatch, and it is reachable

`w2m_run` gains `include_offline` (boolean, **default false**) and puts it on the wire only when asked, so a default
dispatch sends the same bytes as before. The relay records it on the task, and a probe against a live `RabbitState`
confirmed the field is accepted and stored (`recorded: true`) rather than rejected as unknown.

### Deliberately NOT in this release

**The 72-hour archive rule is deferred to 1.1.3.** The read-path filter is written and correct, but eight
`fleet-target` fixtures carry fixed old timestamps and would need their intent reviewed one by one; shipping it with
those fixtures patched blindly is how a green suite stops meaning anything. A machine that has been offline for days is
therefore **hidden from dispatch** by this release (it is not online) but still **listed** by `w2m_devices`.

### Verified

`test/relay.test.mjs` 160 pass, `test/tools.test.mjs` 115 pass, `test/fleet-target.test.mjs` 41 pass -- 316 tests, 0
fail, after the change. The 72h filter was measured, found to break 8 fixtures, and rolled back rather than shipped.

## [1.1.1] — 2026-10-17

**The fleet is now installable from Claude Code, Codex and OpenAI's plugin surface -- and the parts that still need a
person are marked as needing one.**

### One server, three manifests

`bin/w2m-mcp.mjs` already answers both MCP eras (modern per-request `_meta`, and the legacy `initialize` handshake
most deployed clients still speak) and exposes **five read-only tools**. Adapting to a platform is therefore a
**manifest**, not a second implementation:

* `.claude-plugin/plugin.json` — the Claude Code plugin manifest, with its own `mcpServers` entry.
* `.claude-plugin/marketplace.json` — so this repository can be added **as** a marketplace.
* `codex/mcp-servers.toml` — the block to append to `~/.codex/config.toml`, kept as a reviewable file rather than
  prose in a document.
* `docs/PLATFORMS.md` — the per-platform routes, and the exact state of each submission.
* `w2m-mcp` is now a published **bin**, so a client can start the server without guessing a path.

### The trap: two schemas, two different root variables

The top-level `mcp.json` uses the agent-plugins schema's `${PLUGIN_ROOT}`. **Claude Code does not substitute that
variable** -- it substitutes `${CLAUDE_PLUGIN_ROOT}`. Reusing the top-level file verbatim would ship a literal
`${PLUGIN_ROOT}` string as the server's first argument, and the failure would present as *a missing server* rather
than *a wrong variable name*.

So the Claude Code manifest declares its own server entry, and `test/portable-plugins.test.mjs` refuses a manifest
that uses the wrong variable, points at a file that is not in the package, or drifts from `package.json`'s version.

### What is published, and what is not

| Destination | State |
|---|---|
| npm package, GitHub release, `SHA256SUMS` | **published** |
| Claude Code plugin + marketplace manifests | **shipped and tested** |
| Codex configuration snippet | **shipped and tested** |
| Pull request to `anthropics/claude-plugins-official` / `-community` / `claude-code` | **not done** |
| Submission to OpenAI's plugin portal | **not done** |

The last two require write access to repositories this project does not own; the release token is scoped to
`TwinsEarth/dsh-windows2macos` and acting on a third-party repository is refused by design. A manifest that exists is
not a listing, so it is not reported as one.

### Verified

New suite `test/portable-plugins.test.mjs`: the manifests parse, the version agrees across all four manifests and the
package, the MCP bin exists, the Codex snippet pins the version being released, both manifests are in
`package.json#files`, and `docs/PLATFORMS.md` names every platform it claims to.

## [1.1.0] — 2026-10-17

**The direct path now works on runtimes whose OpenSSL has no BLAKE2s, and the compatibility gate that measures the real
Loader was asserting a tool list that had gone stale.**

### The handshake hash no longer depends on the runtime's OpenSSL

One dispatch reported, per machine:

> `P2P_PUNCH_FAILED: handshakeHash requires BLAKE2s-256: BLAKE2s-256 unavailable on this runtime: Digest method not
> supported. It is a WIRE PROTOCOL primitive -- the handshake hash, the prologue hash and the session binding -- so it
> cannot be replaced with SHA-256 without breaking interoperability with every peer.`

That message names the constraint correctly and draws the wrong conclusion. **BLAKE2s is public and deterministic**, so
the digest can be computed here instead of by OpenSSL: the bytes are identical to what a peer with a native
implementation produces, and interoperability is preserved exactly. The alternative -- refusing to handshake -- makes
**every** direct path fall back to the relay on that runtime, which is what the fleet was doing without saying so.

* `src/agent/blake2s.mjs` — BLAKE2s-256 in plain JavaScript (unkeyed, which is all the wire protocol uses).
* `src/agent/crypto.mjs` — `handshakeHash` tries the native digest and falls back to it; `blake2s256Support()`
  now reports **how** the digest is reached (`native` or `js-fallback`); `cryptoCapabilities()` counts the fallback
  as present, because what the handshake needs is the digest, not OpenSSL's implementation of it.
* The fallback is verified before it is trusted: its empty-input digest is compared against the published vector, so a
  broken fallback reports unavailable rather than producing hashes no peer will agree with.

**The bug that made this take longer than it should have.** The first version inverted both `v[14]` and `v[15]` for
the final block. BLAKE2 sets `f0 = 0xFFFFFFFF` on the last block and leaves `f1 = 0` for sequential hashing, so
only `v[14]` is inverted. Inverting both produces a **stable, plausible-looking digest that matches no reference**:
the three RFC vectors failed while the compression function -- checked against an independent implementation -- was
correct the whole time. `test/blake2s.test.mjs` pins the vectors and compares against `node:crypto` across every
block boundary, so that class of mistake cannot survive again.

### The compatibility gate was asserting a stale tool count

`test/loader-entry.test.mjs` asserted the plugin registers a fixed set of tools, under a name that still said "eight".
The set had grown to **eleven** (`w2m_approvals` and `w2m_council` were missing), so the gate that mounts the packed
artifact in a real profile and runs the real Loader failed at:

> `registers all eight w2m_* tools`

The list is now
the actual eleven, sorted so a missing name and a renamed name fail differently, and the test says what it means.

### Two configuration facts this exposed, recorded because they are not obvious

A machine can be **installed, running, and still outside the fleet** -- both were true here:

* `dsh.profile.bundles` must list the package. Installing it as a dependency is not enough: the host composes the
  entry list from that array, so a package present in `node_modules` and absent from `bundles` simply never loads.
* `autoStartAgent: true` is **off by default**, and joining happens inside the agent it starts. Without it a machine
  never joins, no matter how correctly it is installed.

With both set, this machine joined, listed its peers, accepted a dispatch and executed it (`node --version`, exit 0).

### Verified

Full suite green; pre-flight **GREEN**, 15 of 15 checks. `test/blake2s.test.mjs`: **10 pass, 0 fail**, including
byte-identical agreement with `node:crypto` at lengths 0, 1, 2, 3, 31, 32, 33, 63, 64, 65, 127, 128, 129, 191, 192,
193, 255, 256, 257 and 1000.

## [1.0.16] — 2026-10-17

**The last two failures on Linux CI, and one of them was a defect in the release process: a release was advertised as
"latest" before its assets had finished uploading.**

### A release must not be "latest" until it can be downloaded

The release script created the release with `make_latest: 'true'` and *then* uploaded the tarball. That leaves a
window in which `releases/latest` points at a release **with no tarball** -- and CI's live-API job read exactly that,
failing with:

> `ASSET_MISSING no release asset matches /\.(?:tgz|tar\.gz)$/i`

on a release that was complete seconds later. **The ordering was the defect, not the test.** The release is now created
without `make_latest`, the assets are attached, **and only then is it promoted** -- so a reader following the
"latest" link always lands on something downloadable.

### A test that was only true on a developer machine

`test/fleet-sync.test.mjs` removes the repository's git identity to prove the tool refuses to rebase without one. It
checked `git config user.email`, which **falls back to the global and system config** -- absent on a developer machine,
**present on GitHub's runners**. So the tool correctly found an identity and the test's premise was false, on CI only.

The test now points `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at paths that do not exist, so git's config is exactly
as empty as the test claims. It also restores every environment variable it touches.

### Verified

Full suite **2380 tests in 93 files, 2366 pass, 0 fail, 14 skip**; pre-flight **GREEN, 15 of 15 checks**.

## [1.0.15] — 2026-10-17

**Every 1.0.x GitHub release was missing its `SHA256SUMS` asset, so updating from GitHub could not be verified and
would be refused. That is fixed, along with the two tests that were failing on Linux CI.**

### The product defect: un-updatable releases

`src/plugin/update-source.mjs` refuses to offer an update without a checksum asset:

> `no SHA256SUMS asset for ${tag}; cannot verify a download without it`

The 0.x releases carry **two** assets (tarball + sums). **When the 1.0 line was cut, the release script uploaded only the
tarball** -- so every 1.0.x release looked complete and was, in fact, **un-updatable from GitHub**. Nothing local could
have caught it: the tarball was present and correct, and only a job that calls the real API noticed.

Fixed in three places:

* `scripts/github-release.mjs` now derives the sums from the same bytes it uploads and attaches `SHA256SUMS` in the
  same run, **and reads back the asset list** so a missing sums file is a release failure rather than a warning;
* the asset has been backfilled on **all fourteen** 1.0.x releases (v1.0.1 … v1.0.14), each checksum computed from the
  bytes GitHub actually serves;
* the live-API test in `test/update-source.test.mjs` now passes -- it was the only thing that ever reported this.

### Two tests that failed only on Linux CI

Both were invisible on Windows, and both were **the test's** fault, not the code's:

**`test/vision.test.mjs`** created its settings fixture with the default umask, which is `0644` on Linux. The loader
correctly refuses a file that holds a key and is group-readable, so the test got *"mode 644"* instead of the message it
asserted. **The fixture should be 0600; the guard was right.**

**`test/chatops-bridge.test.mjs`** faked its timer with a real `setTimeout`. The broker calls `record.timer.unref()`,
so during the await the only pending handle is an **unref'd** timeout -- which does not keep the event loop alive. On
Linux the loop drained before it fired and node reported
`cancelledByParent: Promise resolution is still pending but the event loop has already resolved`. **It passed on Windows
by accident of scheduling.** The timer is now deterministic: the callback is captured and fired explicitly.

### Release titles are version numbers

The repository home page sidebar renders the latest release's **name**, and the name was the commit subject:

> `test(merge): verify merging while a third machine publishes -- never tears, …`

-- where a reader looking for "which version is current?" expects `v1.0.14`. The title is now the tag; **the commit
subject moved to the first line of the body**, so nothing is lost and the one slot that names the release names the
version. All fourteen 1.0.x releases were renamed to match.

### Verified

Full suite **2380 tests in 93 files, 2366 pass, 0 fail, 14 skip**; pre-flight **GREEN, 15 of 15 checks**.
`test/update-source.test.mjs` (which makes a real GitHub API call) passes: **50 tests, 49 pass, 0 fail**.

## [1.0.14] — 2026-10-17

**Merging while a third machine publishes is verified: it never tears, never writes, and names its failures.**

### The gap this closes, stated precisely

v1.0.12 verified the memory actions end to end **one machine at a time**. v1.0.13 verified concurrent *publishing*.
**Neither covered a merge racing a publish**, and the merge has a two-step read that a publish can break:

1. `GET /v1/fleet/blobs/latest` — learn the hash;
2. `GET /v1/fleet/blobs/<hash>` — fetch the bytes, re-hash, merge.

Between those steps the pointer can advance (harmless: the merge still reads the blob it was told about) or the blob
can be **evicted** (fatal if unhandled: a 404 where the code expected bytes).

### What "correct" means for a racing read

There is no single right answer for *which* document a racing merge sees -- that is the nature of a read that is not in
a transaction. What is required:

* it **never throws an error it cannot name**;
* it **never produces a torn merge** -- a result whose recorded decision disagrees with the text it produced;
* it **never writes the local file**, under any outcome;
* when the blob is gone mid-flight, it **says so by name**.

### Verified

Two tests in `test/fleet-merge-race.test.mjs`:

* **twenty rounds of a merge fired together with a publish.** Every round resolved: a completed merge with a
  consistent decision, or a **named** `W2M_*` refusal. No crash. No torn merge -- when the recorded winner is
  `local` the text carries the local value, when it is `fleet` it carries a fleet value. **The local document was
  re-read after every round and was untouched every time.** The test also asserts at least one merge *completed*, so it
  cannot pass vacuously by refusing everything.
* **a pointer naming a blob that no longer exists** raises `W2M_NOT_FOUND`, not a crash.

**One honest limitation of the second test:** it *sets up* the state the race would produce (pointer names a removed
blob) rather than catching the removal in flight. **The code path is identical; the timing is not.** Recorded because
"mid-flight" without that caveat would overstate the evidence.

### Still not verified, and now the list is short

**Two relay processes sharing one state directory.** The design is one relay per fleet; supporting the other would need
real file locking, and nothing here provides it. **"Concurrency is tested" must not be read as "any topology is safe"**
-- that sentence was written into v1.0.13's notes and it still applies.

## [1.0.13] — 2026-10-17

**Concurrent publishing is verified safe on one relay, and the reason it is safe is stated so a future change can
falsify it.**

### What v1.0.12 recorded as unverified, and is now verified

v1.0.12 closed the end-to-end gap **one machine at a time** and wrote concurrency down as open, with a specific
worry: the blob store keeps its ownership index as a read-modify-write, and a lost update there would leave **a stored
blob with no owner** -- readable by nobody, including the fleet that wrote it.

### Why it turned out to be safe, stated as a property rather than a hope

`RabbitState.putFleetBlob` and `Persistence.putBlob` **do no awaiting**: every filesystem call in that path is the
synchronous `fs` API. The request handler awaits the body first, and after that the whole read-mutate-write runs to
completion inside one Node job. **On a single-threaded event loop that makes each publish atomic with respect to
every other request on the same relay process.**

**That reasoning is the thing the tests falsify rather than assume.** If any part of that path becomes asynchronous,
they fail with a lost index entry -- which is much better than finding it in a fleet.

### What is verified

Four tests in `test/fleet-concurrency.test.mjs`:

* **ten publishes fired together** leave **ten** ownership entries, and every blob still readable and still owned -- a
  lost update would show up as a 404;
* the **latest pointer names a document that was actually written** (not a torn value) and that document resolves;
* **two fleets publishing at the same moment stay separate** -- each fleet's pointer names its own document and the
  index attributes each blob to the right fleet;
* the pointer is **stable once the writers stop** -- reading it twice gives the same hash and timestamp.

Full suite **2378 tests in 92 files, 2364 pass, 0 fail, 14 skip**. Pre-flight **GREEN, 15 of 15 checks**.

### The limit of this claim, which matters more than the claim

**One relay process.** The design is one relay per fleet. **Two processes sharing one state directory would need real
file locking**, and nothing here provides it. "Concurrency is tested" must not be read as "any topology is safe".

Also still unverified: **two machines merging while a third publishes.** The merge itself is a pure read of local bytes
plus one fetched blob, so it has no shared state to corrupt -- but that is reasoning, not a test, and it is recorded
as such.

## [1.0.12] — 2026-10-17

**The five fleet-memory actions are verified end to end, against a real relay, a real profile and a real
`fleet-memory.md` -- and the first attempt found a real defect.**

### What was unverified until now

`publish`, `pull`, `latest`, `diff` and `merge` had each been shipped marked **UNVERIFIED**. The merge *rule* was
proven exhaustively as a pure function, and the relay *routes* were proven against a real relay -- **but nothing had
ever executed the tool surface itself.** A caller with no execution is indistinguishable from a working one, which is
the same gap this project keeps restating in a different shape.

### The defect the end-to-end test found on its first run

`latest` reported `published_by: null` for a publication whose author the relay knew perfectly well.

`RabbitState.putFleetBlob` accepted a `publishedBy` argument that **nothing ever supplied**: the pointer store took
it, defaulted it to `null`, and the field looked implemented. Fixed by filling it from **the authenticated device's
`machine_id`, never from the request body** -- for the same reason the P2P announce route reads `machine_id` off the
token: a caller that could name itself in the body could attribute a publication to a machine that never made it.

**No unit test could have caught this**, because the unit under test was the pointer store, and it was behaving
exactly as written. The bug lived in the seam between two correct components, which is what an end-to-end test is for.

### What the test exercises, in the order a machine would

A real relay on an ephemeral port and a real profile, then:

1. **`publish`** — returns a 64-hex hash and the byte count.
2. **`latest`** — discovers that hash **without being told it**, and reports the publishing machine.
3. **`pull latest`** — fetches the bytes, re-hashes them, and they round-trip **exactly**.
4. **`diff`** — on an unchanged document: `same: true`, no difference, **and the local file untouched**.
5. the fleet's document is replaced out of band through the relay's own route;
6. **`diff`** — now reports the divergence, and the local file is **still untouched**;
7. **`merge`** — applies the declared rule (neither side declares a repair, so the **default layer** applies and the
   newer publication wins), records the decision with a reason, carries the winning value into the merged text, and
   **writes nothing to the local document.**

**`wrote_anything: false` is asserted three times**, because "these actions never edit the file they read" is the
property that makes it safe to let a network round trip participate at all.

### Verified

- the end-to-end suite: 1 test, passing, covering all five actions;
- `test/fleet-merge.test.mjs`: 13 tests over the rule itself;
- full suite: **2374 tests in 91 files, 2360 pass, 0 fail, 14 skip**;
- pre-flight **GREEN, 15 of 15 checks**.

### NOT verified, even now

**Concurrency.** Everything here is one machine at a time. Two machines publishing and merging simultaneously is
untested, and the pointer has no compare-and-swap, so the last writer to the pointer wins -- which is **the same rule
as the default layer**, but that is a coincidence rather than a guarantee. Recorded so the next person does not read
"end to end" as "under contention".

## [1.0.11] — 2026-10-17

**`w2m_memory {"action":"merge"}`: merge this machine's collective memory with the fleet's current blob, under the
operator's conflict rule, and still write nothing.**

### The rule, which is the operator's decision

> **默认最新的赢；如果是修复默认流程，最全 & 验证最全面的有最后修改权。**
>
> Default: the newest wins. But if it is a repair of the default flow, the most complete and most thoroughly verified
> one has final edit authority.

Two layers, and the second is the one that is easy to lose: **a declared repair outranks recency**, so a repaired
fact is not overwritten by a later-written older understanding. Between two repairs, the better-supported one wins.

### What is the operator's, and what is my operationalisation -- stated so it can be challenged

**Theirs:** the two layers above. **Mine, and it is in the source:**

* **The entry syntax.** There is no way to read "is this a repair of the default flow" out of prose; any attempt to
  guess would overwrite correct versions with wrong ones. So a keyed entry declares it:
  `- 〔id:<stable-id> fix evidence=<n> verified=<n>〕<the fact>`.
  Entries without an `id` are prose: they are unioned and never adjudicated, because without an id there is no way to
  tell "same fact, two versions" from "two different facts".
* **`completeness = evidence + 2 × verified`. The weight 2 is a judgement, not the operator's words.** One reproduced
  fact outranks three unreproduced ones. It only applies when **both** sides declare `fix`.

**Every decision is recorded** as a comment in the merged text (`<!-- <id> -> local (repair): ... -->`), because a
merge that cannot explain its choices produces a document nobody can audit -- and the first sign of a wrong rule
would be a fact nobody can find.

### What it refuses

| Case | Behaviour |
|---|---|
| the same id twice **inside one document** | **refused**, not resolved: a broken document is not a conflict |
| a blob that fails its own hash | `W2M_BAD_BLOB`, and **nothing is merged** -- comparing unverified content would launder it |
| a pointer naming an evicted blob | reported as that, with the remedy (publish again) |
| no fleet document at all | reported as a state: publishing comes first |

### And it still writes nothing

The merged text comes back in the result; **the local file is not modified.** Half of a merge's input arrived over the
network, and letting one round trip rewrite the only local copy would hand a remote party a write into local memory.

### Verified

**13 tests in `test/fleet-merge.test.mjs`** exercise the rule as a rule, with no profile and no relay: the default
layer picks the newer publication; **a declared repair beats a NEWER non-repair** (the operator's override -- if this
test flips, the rule has silently become "newest wins"); two repairs are separated by completeness, then by
verification count, then by recency; a genuine tie resolves deterministically **and is recorded as a tie**; a
duplicated id is refused; prose unions; inputs are not mutated; an identical id produces no decision.

Full suite: see the pre-flight line. Pre-flight **GREEN, 15 of 15 checks**.

### NOT verified

The `merge` action **end to end** -- the same gap as `publish`/`pull`/`latest`/`diff`: the rule is proven, the
plumbing around it is not, because that needs a profile with a `fleet-memory.md` and a live relay.

## [1.0.10] — 2026-10-17

**`w2m_memory {"action":"diff"}`: compare this machine's collective memory against the fleet's current blob,
and write nothing.**

### Merge is still not implemented, deliberately

The question merge depends on has not been answered:

> **When two machines in one fleet assert different things about the same fact, who wins?**

That is a product decision about what the fleet's memory *is*, not an implementation detail, and shipping a merge
before its rule is how a fleet silently loses one machine's memory. So this release ships **the half that needs no
decision** -- and names the other half as open rather than leaving it implied.

### What `diff` answers

* **Is my document the newest one?** `same: true/false`, decided by **whole-document hash equality**.
* **What would I be overwriting?** `preview.local_only` and `preview.fleet_only`.
* **Is the fleet's document even there?** Three distinct absence states, each named: the fleet never published; the
  pointer names a blob that eviction removed; the blob exists and verified.

### Four decisions worth recording

**It writes nothing.** No `.orig`, no `.rej`, no silent merge. Comparing is not a licence to edit a document this
machine owns.

**`same` is hash equality, not "no line differences".** Two documents with identical line sets in a different order
are **not** the same, and callling them the same would hide an order change -- which in a markdown document is a
structural change.

**A set comparison, not a diff.** A line-oriented diff would report "moved" versus "changed" and then want a merge
policy. **A set comparison cannot resolve anything, which is exactly the property this step requires.**

**The fleet copy is re-hashed before it is compared.** Comparing unverified content would launder it: the report
would give a hash-verified-looking answer about bytes nobody checked. A blob that fails its own name raises
`W2M_BAD_BLOB` and is never compared.

Trailing whitespace is normalised (it is noise); leading whitespace is preserved (it is markdown structure).

### Verified

The comparison rule is pinned directly: `local_only` / `fleet_only` separate correctly, trailing whitespace creates
no difference, and leading whitespace does. Full suite **2360 tests, 2346 pass, 0 fail, 14 skip**; pre-flight
**GREEN, 15 of 15 checks**.

### NOT verified

The `diff` action **end to end** -- the same gap as `publish`/`pull`/`latest`: type-correct and lint-clean, but
no test executes it, because that needs a profile with a `fleet-memory.md` and a live relay.

### Open: #2b

**Append-merge with conflict markers, and the marker's existence is the refusal** -- a document containing markers is
one a human must not trust until resolved. Last-writer-wins is rejected: it loses data silently, and the project's
own eviction rule already refuses "delete the only copy of a fact" in spirit. **That recommendation is in
`FLEET-SYNC-2-DESIGN.md` and is not implemented, because it encodes a rule that is the operator's to choose.**

## [1.0.9] — 2026-10-17

**Discovery: a machine can now ask the relay which blob its fleet published last, instead of a human relaying a
64-character hash between machines.**

### Why the channel needed this before it was usable

v1.0.7/1.0.8 gave the fleet a content-addressed channel -- anyone in the fleet can `pull <hash>`. **But a hash is
only useful to someone who already has it**, and the only place one appeared was `publish`'s output on the machine
that ran it. That makes the channel work exactly as well as a person copying a string, which is a demo, not a sync.

So the relay keeps **one pointer per fleet**: the blob that fleet published most recently.

| Piece | Where |
|---|---|
| pointer store | `<state>/blobs/latest.json`, shape `{ "<fleet_id>": { hash, bytes, published_at_ms, published_by } }` |
| advanced by | `putBlob`, together with the ownership record -- a publish that succeeded but did not advance the pointer would leave the fleet advertising a stale document |
| route | `GET /v1/fleet/blobs/latest`, scoped through the same `scopeBlobFleet` as the blobs themselves |
| tool | `w2m_memory {"action":"latest"}`, and `{"action":"pull","hash":"latest"}` |

**`hash: "latest"` is the ergonomic point**: a joining machine runs one call, and it is the form that survives a
teammate republishing. A stored hash goes stale; `latest` follows.

**Resolving a pointer does not weaken verification.** The re-hash in `pull` is unchanged, because a pointer is
metadata -- exactly the thing a relay is allowed to be wrong about -- while the hash is what the bytes must match.

### A pointer is a hint, not a guarantee

Eviction is oldest-first and can take the current document on a busy fleet. So `latest` may name a blob that no
longer exists, and a pull of it answers `404`. **That is the honest outcome**: keeping a document alive because it
is pointed at would make eviction depend on a second, unstated rule. The route says so in its own payload.

### The defect a test caught, recorded because it is easy to reintroduce

The first version of `advanceFleetLatest` skipped `fleetId === null`, reasoning that a fleetless device has no
fleet to advertise to. **That skipped the most common deployment.** On a relay with no fleet configured,
`scopeFleetId` returns `{fleetId: null, legacy: true}` -- and `null` there means **one shared scope**, the
pre-v0.7.7 behaviour that fleet scoping's own comment insists a migration must not change. The pointer was therefore
never written on an unclaimed relay, and `latest` answered `404` for every machine on the default single-relay
setup. **The feature worked nowhere it was most likely to be used**, and the test that asserted 200 is the only
reason this is a comment in the source rather than a bug report.

The genuinely fleetless case on a **claimed** relay never reaches that code: `scopeFleetId` refuses it outright, so
the blob is rejected before a pointer could exist.

### Verified

Four new tests in `test/relay.test.mjs` run against a real relay: the pointer advances on publish and follows the
newest one; it is scoped per fleet (B sees `404` while A sees its own); **the pointer survives eviction while the
pull does not** -- the pointer still names the removed blob, the payload says "hint, not a guarantee", and the read
answers `404` without resurrecting it; and a second fleet re-publishing identical bytes **cannot claim the pointer**.

Full suite **2360 tests, 2346 pass, 0 fail, 14 skip**. Pre-flight **GREEN, 15 of 15 checks**.

### NOT verified

The `latest` and `pull latest` tool actions **end to end** -- same gap as v1.0.7's publish/pull: they are
type-correct and lint-clean, but no test executes them, because that needs a profile with a `fleet-memory.md` and a
live relay.

### And still absent

Merge (#2). Two machines publishing produce two blobs, and the pointer names whichever published last -- **the
earlier document is not lost, it is merely no longer `latest`**. That visibility is the input merge needs, and
nothing yet says who wins when two machines assert different facts.

## [1.0.8] — 2026-10-17

**The fleet sync channel, both directions: a machine can publish its collective memory to the relay and another
machine in the same fleet can fetch it back by hash.**

> **Why 1.0.7 and 1.0.8 are both published, and what that records.** `pnpm publish 1.0.7` succeeded; a verification
> read a minute later answered `version not found: 1.0.7`, a retry answered
> `409 Cannot publish over previously staged version "1.0.7"`, and `npm stage list` reported nothing -- so 1.0.7 was
> concluded to have failed and 1.0.8 was cut. **The registry was simply lagging: both versions are published, and
> their contents are identical apart from the version string.** The 409 was the retry racing a publish that was
> still in flight, not evidence that nothing had been accepted.
>
> **The mistake worth keeping is the conclusion, not the retry.** A freshness read that disagrees with a successful
> write is evidence of lag, not of failure -- and the way to tell them apart is to wait and re-read, which is
> cheaper than re-cutting a release. 1.0.8 stands as the current version because it is already published and is the
> one `latest` names; 1.0.7 is deprecated pointing here rather than left to look like a distinct release.


**The fleet sync channel, both directions: a machine can publish its collective memory to the relay and another
machine in the same fleet can fetch it back by hash.**

### #1 is now a channel, not a backup

v1.0.6 shipped the storage layer and said plainly that it had no route and no caller. This release supplies both:

| Piece | Where |
|---|---|
| content-addressed store | `src/relay/persistence.mjs` — `putBlob`/`getBlob`, 8 MiB per blob, 256 per fleet, oldest-first eviction that never takes the last one |
| hash → fleet ownership | `<state>/blobs/index.json`, so a content-addressed store is *not* a shared one |
| two routes | `PUT`/`GET /v1/fleet/blobs/<sha256>` in `src/relay/server.mjs`, behind the same device-token gate as every other route |
| scoping | `state.scopeBlobFleet` reuses `scopeFleetId` — **the same rule task dispatch obeys**, not a second copy of it |
| caller | `w2m_memory` `action: "publish"` and `"pull"` |

**Why a content-addressed store does not contradict "the relay keeps only hashes".** It persists `stdout_sha256`
and never the text, and `src/agent/storage.mjs` records why: each machine's `memory.jsonl` is the only durable copy
of what a command printed. **That invariant is about the relay not interpreting content.** A blob keyed by its own
hash preserves it exactly — the relay still interprets nothing, and **the hash is what says the bytes are the
bytes**, as `stdout_sha256` does for a result. What is new is only that a hash the relay already holds can now have
its bytes fetched from the same place.

### The decisions worth recording

**The write verifies the key, and refuses rather than correcting.** A content-addressed store that accepts bytes
under a key they do not hash to is not content-addressed: the key stops being a claim, and every later reader's
verification becomes decorative. A mismatch is `422 BLOB_HASH_MISMATCH` and nothing is stored.

**Ownership is first-writer-wins.** A second fleet PUT-ing an identical blob does **not** take ownership of it.
Otherwise any fleet could claim another's blob by replaying the same bytes, which is the same failure as having no
index at all.

**A cross-fleet read is `404`, not `403`.** A distinguishable "not yours" tells a prober that this hash exists on
this relay. The reader cannot tell "never stored" from "another fleet's", deliberately.

**The pull side re-hashes what it receives.** A verification performed only by the party that could be wrong is not
a verification, so a reader that gets bytes hashing to something else raises `W2M_BAD_BLOB` rather than passing
them on.

### What is verified, and what is not

**Verified — executed:** four new tests in `test/relay.test.mjs` drive the real routes against a real relay:
store-and-return-unchanged; a mismatched key is refused (422) and leaves the key absent (404); one fleet cannot read
another's blob (404); an unauthenticated request is refused (401). Full suite **2356 tests, 2342 pass, 0 fail, 14
skip**; pre-flight **GREEN, 15 of 15 checks**.

**NOT verified: the `publish`/`pull` tool actions end to end.** They are type-correct and lint-clean, and their
failure paths are written, but **no test executes them** — they need a profile with a `fleet-memory.md` and a live
relay. They are marked unverified here rather than counted as working, which is the distinction this project keeps
having to restate.

**A known limit of the reader:** `pull` returns the blob as text and re-hashes it as UTF-8. That is exact for a
`fleet-memory.md`; it would not be for arbitrary binary content, and the channel does not claim to carry that.

### Not in this release

The trigger (#3) and merge semantics (#2) are deliberately absent. Publishing is a decision a machine makes, not
something that happens on join, and merge needs a conflict rule that has not been decided: two machines writing
different facts produce **two hashes**, and nothing yet says who wins. **Nothing is overwritten in the meantime —
that is the property #1 was built to provide.**

## [1.0.6] — 2026-10-17

**DSH-GPW now ships *findable*: installed with the package, present in the plugin list, and off until an operator
turns it on.**

### What v1.0.5 got wrong

It shipped the subpath export `@twinsearth/w2m-dsh-plugin/gpw` and no config row. **A plugin the composed tree does
not mention is a plugin the plugin manager cannot list** -- so "enable it manually" had **nothing to click**, and
the only way in was hand-editing a profile patch.

**An optional component nobody can find is not optional, it is absent.** That is the same distinction as the seven
written-but-unreachable modules in this repository, seen from the user's side instead of the code's.

### The shape that fixes it

The package's own bundle patch now carries a second entry:

    - id: dsh-gpw
      name: '@twinsearth/w2m-dsh-plugin/gpw'
      disabled: true
      config:
        maxPerWindow: 10
        windowMs: 60000
        minGapMs: 3000

**`disabled: true` is the load-bearing field.** The row exists, so the component appears; the toggle is off, so
nothing answers `approval/request`; and **flipping it in the UI is the whole enablement step** -- no file edit, no
restart of anything but the client.

**It stays in the same `insert:` list as the w2m row**, and that is still the correct form: this is an insert
because no earlier layer creates a `dsh-gpw` row. (A *bare* `- id:` patch aimed at a nonexistent row is skipped
silently -- the failure recorded in this file and in TROUBLESHOOTING 3.2.)

### The distinction the two releases now make

| | v1.0.5 | v1.0.6 |
|---|---|---|
| Installs with the package | yes | yes |
| Appears in the plugin manager | **no** | **yes** |
| Enabled by default | no | no |
| How you turn it on | hand-edit a profile patch | **click its toggle** |

**Not verified: that the toggle actually flips it on and that it then intercepts.** That needs a live host. The
observable evidence is its own startup line followed by its counted line --

    approval-ratelimit: active -- at most 10 auto-approvals per 60 s, at least 3000 ms apart, process-wide
    approval-ratelimit: N auto-approved, M deferred to the human

-- **because without the second line, "mounted and working" and "mounted and doing nothing" are the same picture**,
which is the failure this watchdog's own counters exist to prevent.

## [1.0.5] — 2026-10-17

**DSH-GPW ships as an optional sub-plugin, and the reason it never activated is fixed.**

### What DSH-GPW is

**Global Permission Watchdog.** It answers permission requests on the `approval/request` waterfall with a hard global
budget: **at most 10 auto-approvals per rolling 60 s, at least 3000 ms apart.** Past either limit it returns
`next()` -- *"no opinion"* -- so the request falls through to the human prompt **and waits**. It never refuses, and
it never changes what is being asked.

### Optional means optional, which decides where it lives

The package declares **one** `dsh.bundle.patch`, and that is what makes the w2m plugin mount itself on install. **A
second plugin in the same patch would mount for everyone**, and this one changes how permissions are answered -- that
is an operator's decision, not a default.

So it is exposed as `@twinsearth/w2m-dsh-plugin/gpw` and mounted by one explicit row:

    - insert:
        - id: dsh-gpw
          name: '@twinsearth/w2m-dsh-plugin/gpw'

**`insert:` is required and the reason is recorded in this package's own patch file**: no earlier layer creates a
`dsh-gpw` row, and a bare `- id:` patch aimed at a nonexistent row is **skipped silently**. Removing the row
disables it again.

**It is deliberately not re-exported from `lib/index.js`.** A permission-answering plugin must not arrive because
someone installed a fleet tool.

### The defect that kept it from ever activating

The standalone copy declared:

    export const inject = { required: ['approval'] };

**The host reads `inject` as an array of service names.** Measured across the shipped tree: **283 array-shaped
declarations, 0 object-shaped.** So the host took the object's *key* and waited for a service literally named
`required`:

    pending (waiting for service: required)

-- indefinitely, and the client reported the component as `等待依赖`. It is now `['approval']`, and `approval`
does exist: `@deepseek-ai/dsh-base`'s patch mounts `@deepseek-ai/dsh-user-approval` as id `approval`.

**The error message named its own cause**, which is why this took one measurement instead of an investigation: it
said `required`, and `required` is the key.

### What is verified, and what is not

**Verified:** `lib/gpw.js` loads; `name` is `dsh-gpw`; `inject` is an array; `apply` is a function;
`approval/request` and `allowed-once` both exist in the host (9 and 22 files respectively).

**Not verified: that it mounts and intercepts.** That needs a live host with the row added. The observable evidence
after a restart is its own startup line --

    approval-ratelimit: active -- at most 10 auto-approvals per 60 s, at least 3000 ms apart, process-wide

-- **and then the periodic counted line, without which "mounted and working" and "mounted and doing nothing" look
identical.** That distinction is the reason those counters exist.

## [1.0.4] — 2026-10-17

**The description described a different package, and it is the only thing many readers see.**

### Two numbers were wrong, and both were checkable

The text had been carried forward since an earlier release and said:

    ... eight DSH tools (replicate / split), nine aggregate verdicts and signed requests.

**Measured: eleven tools, six verdicts.** The tools are the `name: 'w2m_…'` registration sites in
`src/plugin/tools.mjs`; the verdicts are named in `src/relay/report.mjs:19-25` -- `consistent`, `divergent`,
`divergent-platform`, `failed`, `partial`, `unverifiable`. **Four coordination modes, not the two a
parenthetical named.**

### What mattered more than the numbers: it never mentioned joining

A reader finished that sentence knowing the plugin exists and **nothing about the step every new machine gets
wrong** -- which is the one this release's predecessor spent hours on. **A description that omits the join
requirement produces exactly the "I installed it and nothing happened" report.**

So the description now ends with it, as a flat fact: **"Joining needs a pairing code plus `autoStartAgent:
true`; installing alone does not join."**

### The replacement

    Run one project across your own Windows and macOS machines from a single DeepSeek account, through 11
    w2m_* tools. Four coordination modes (replicate, split, broadcast, pipeline) and six aggregate verdicts
    (consistent, divergent, divergent-platform, failed, partial, unverifiable). P2P hole punching by default,
    with a bundled relay, STUN responder and ledger fallback, so the fleet needs no third-party service.
    Joining needs a pairing code plus autoStartAgent: true; installing alone does not join.

**Exactly 500 characters, because registries truncate and a description cut mid-sentence is worse than a shorter
one.** The first candidate was 502; the trim removed two words and **was reported rather than applied silently**.
Both `package.json` and `plugin.json` carry it -- they previously disagreed, which is its own small defect: two
descriptions of one package.

**No code change.** Full suite 2352 in 89 files, 0 fail. Pre-flight GREEN with FIFTEEN checks.

## [1.0.3] — 2026-10-17

**The warning that predicted this failure now says what to do about it.**

### What was wrong with the old line

    w2m: no agent is running on this machine, so it is in no fleet and will receive no work.
         Set autoStartAgent: true to join (the fleet key is derived from the signed-in account),
         or run w2m-localside yourself and point it at the relay.

**Accurate, and insufficient.** It names **one** of the two things required and does not say *where* to set it.

**Measured on a real machine:** plugin installed, activated, **no error anywhere**, and
`device_token: null` with `autoStartAgent: false`. The operator's own summary was *"it installed but the machine
is not in the fleet"* -- **exactly what this warning predicts, and nothing in it resolved that.** The line was
written for the v0.8.5 failure mode and the operator still had to discover both steps.

### The guidance is now a procedure, and it is ordered

```
      This machine is NOT paired yet, so both steps below are required.
      To join, two things are needed:
        1. a one-time pairing code. `w2m-rabbit` prints it once, in its startup banner:
             [w2m-rabbit] listening on <url>  pairing code: PAIR-XXXXXXXX
           It lives in memory only and is never written to the state directory...
        2. `autoStartAgent: true` plus that code, on the `w2m` row that ALREADY EXISTS...
               - id: w2m
                 config:
                   autoStartAgent: true
                   pairingCode: PAIR-XXXXXXXX
           Do NOT add an `insert:` for it. An insert appends a SECOND entry with the same id, and the
           client then refuses to open -- measured on this project, not theorised.
```

**It states the current pairing state, because the two cases need different first steps.** An unpaired machine
must fetch a code; a paired one only has to turn the switch on, and **sending that machine after a code would send
it somewhere it has no business.** Verifying that branch required reading `device.json` and finding
`device_token: null`, which is exactly what the rendered warning then said.

**Why pairing cannot be automatic, stated where the operator will read it:** the relay's own header says *"the
pairing code is the only credential that grants admission"*, and **a plugin able to join unattended would be one
that lets any machine holding the package into the fleet.** So the fix is guidance, not auto-joining.

### A parameter I wrote into the text before checking that it exists

The first draft told the operator to use **`--print-pairing-code`**. **There is no such flag.** Measured from
`w2m-rabbit --help`, the real options are:

    --pairing-code <c>     Use a fixed pairing code instead of a generated one.
    --pair-rate-limit <n>  Pairing attempts per IP per minute. Default 5. 0 = off.

**And `--pairing-code` does the opposite of what I described**: it *chooses* a known code rather than printing an
existing one. The text now says that, **because a command in an error message is read as an instruction and is
followed.**

The warning was also **rendered and read** rather than assumed -- a warning nobody has printed is a warning whose
formatting is guesswork.

## [1.0.2] — 2026-10-16

**One missing line made the whole plugin fail to mount, and it had been missing since v0.41.0.**

### The defect

    JsonSchemaError: unsupported JSON schema:
      parameters.accept_block.additionalProperties must be explicitly true or false at authorError
        at parameterSchemaSpecToJsonSchema (dsh-tools/lib/index.js:803)
        at defineTool (dsh-tools/lib/index.js:848)
        at Object.apply (src/plugin/tools.mjs:5025)

`w2m_memory`'s `accept_block` was declared as `type: 'object'` **without `additionalProperties`**, and DSH's
compiler requires it to be explicit. **The throw happens while the tool is being defined, so the entire fiber fails
to mount** — the client shows the package as `异常`, **all eleven tools disappear**, and the message is visible
only if something gets far enough to print it.

**That single parameter is the whole failure.** Checked across the entire tool surface: **one `type: 'object'`
parameter exists in this file, and it was the one.**

### Verified against the real compiler, not the shim

`verify-installed.mjs` runs against an offline shim that checks shape only, **which is why it reported
`PASS: 11 tools registered` for every broken version**. The real `@deepseek-ai/dsh-tools` was extracted from
`app.asar` — 10,913 entries, preserving the `node_modules` layout so bare specifiers resolve — and the same call
was made against it both ways:

    WITHOUT additionalProperties -> THREW JsonSchemaError: ... must be explicitly true or false
    WITH    additionalProperties -> ACCEPTED

**Same error, same code path as the client reported.** That is the first measurement in this session taken from the
compiler that actually runs.

### `true`, not `false`

`verifyBlock()` and `acceptWithAuthority()` already validate the block's structure and its hash, **so the schema
is not the guard here**. A peer that adds a field outside the seven would be refused **for a reason that has nothing
to do with trust**, and refusing a legitimate block is the worse of the two errors.

### Why this took so long to find, stated plainly

**The error was invisible until the installer was used.** When the package was installed with `pnpm` and then
removed, the client failed *earlier*, with `cannot resolve profile bundle`, which names a resolution problem and
not a schema one. **Installing through the plugin manager took it far enough to reach `defineTool` and print the
real cause.**

**So the user's instinct was right in the way that mattered**: not that the official path behaves differently, but
that it is the path which gets far enough to report the truth. Four earlier rounds of diagnosis — a fabricated
incompatibility with the host, a mount-row duplicate, a release-notes defect, a runtime-discovery defect — were all
real, and **none of them was this**.

### The method that worked

I extracted the host's own compiler from `app.asar` and called it directly. **Every previous attempt had tested
against a shim, a clone, or an inference**, and each of those agreed with the broken declaration. **The only
measurement that disagreed was the one taken from the code that throws.**

## [1.0.1] — 2026-10-16

**The first stable release. Three defects fixed, two of them mine and one of them published 56 times.**

### The command allow-list could not admit the interpreter DSH itself runs on

Twelve end-to-end tests failed with `COMMAND_EXECUTABLE_PATH_MISMATCH`, and **the refusal was correct** —
the identity check was reading the wrong machine.

    bundled node : E:\DS\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
    PATH         : E:\Unity3D\Tuanjie Cowork\cli\bin\win32-x64\node.exe      <- a different program
    PATH contains the bundled directory : False

The tests dispatch `[process.execPath, '-e', …]` against an allow-list entry of the bare name `node`. **DSH runs
on the bundled interpreter and does not put its directory on PATH**, so the bare name resolved to an unrelated
`node.exe` shipped by another application, and an absolute path to the bundled copy was refused as "a different
file".

**Fixed by answering the right question.** `resolveCommand` still keeps PATH ahead of the bundled tree — a test
guards that precedence, and it is about *which file a name means*. The new `bundledExecutable()` answers a
different question: *is this path the bundled copy of that tool?* **The bundled copy of a tool is that tool**, so
identity holds, and **nothing is weakened**: it only ever returns files under `<deps>`, so
`E:\Temp\evil\node.exe` is still refused.

**The runtime is now discovered rather than assumed.** `dshDependenciesDir()` tried exactly one path,
`$DSH_HOME/dsh-runtimes/<runtime>/dependencies`, which stopped existing when the application moved its runtime
inside the bundle. It now tries the explicit override, then that documented layout, then **the directory implied
by `process.execPath`** — a bundled interpreter lives at `<deps>/node/bin/node`, so its own path states where
`<deps>` is. **That cannot go stale when the installation moves again.**

### 56 of 66 release scripts published v0.1.3's commit message under an unrelated title

Found because a test plan written against v0.60.0 reported its release notes as "highly duplicated" with several
earlier releases. **The scripts state the right intention and then read the wrong file:**

    /** The release notes reuse the commit message */
    const NOTES = fs.readFileSync('…\\commit-0103b.txt', 'utf8');          // v0.1.3's message
    name: 'v0.60.0 — approval index, fleet sync, service health, tiered storage',   // hardcoded

`scripts/github-release.mjs` **derives both fields from the repository's own record** — the title from the commit
subject, the body from the CHANGELOG entry — **so neither can be copied by accident.** It refuses to publish a
version with no CHANGELOG entry, and reads the release back after writing. **The five most-read releases
(v0.60.0, v0.59.0, v0.58.0, v0.57.1, v0.57.0) are corrected**, each verified by reading it back.

### My mount-row advice broke the client twice, and §3.2 withdraws it

**An installed plugin mounts itself**, from its own bundle patch — so adding a row to `cordis.patch.yml` inserts
a **second** entry with the same `id`, and the client stops opening. Measured: **0 rows before install, exactly 1
after, 2 with the manual row, 1 again once removed.**

### Also in this release

**Two client failures had one cause, and it was this repository's own advice: do not add a mount row.**

### The plugin mounts itself

`package.json` declares `dsh.bundle.patch`, so **the host composes an installed package from the patch shipped
inside the package**. Nothing needs to be written into the profile — and writing it anyway inserts a **second**
entry with the same `id`, which stops the client from opening.

**Measured on a throwaway profile**, because the desktop profile cannot be previewed (`rejectElectronProfile`)
and that is exactly where the failures happened:

| State | `id: w2m` rows |
|---|---|
| profile created, plugin not installed | 0 |
| **plugin installed, nothing else done** | **1** |
| a correctly written `insert:` row added as well | **2** ← the failure |
| that row removed | **1** |

**The symptom is worth stating precisely, because it is not a crash:** the client does not open, there is no
error message, and deleting `cordis.patch.yml` restores it immediately. **That is what pointed at configuration
rather than code.**

### §3.2, and why the old advice is withdrawn

The section now leads with the rule — **install, and change nothing else** — then covers the three ways an edit
goes wrong:

* **`insert:` is an append.** Appending a row whose `id` already exists is the failure. To change configuration,
  address the row the bundle patch created, as a non-insert patch.
* **`Add-Content` onto this file is always wrong.** It is a YAML list; a fresh profile ships `[]`, and a second
  document after it is a parse error. **The measured exception message is in the section**, because "failed to
  parse overlay" alone sends people looking at the wrong thing.
* **The desktop profile has no safe preview.** `--dump-config` composes and exits without starting anything, and
  it is the right tool — but the CLI refuses the desktop profile, so for that one the only protection is writing
  the row correctly. **Which in practice means not writing one.**

### What I got wrong, since the section exists because of it

I added the row to a live profile without a way to test it that did not involve the user's client, and the
backup went with the profile when it was reset. **The cost was two client failures and a profile reset.**

**I also formed a plausible hypothesis and disproved it before writing any of this**: I suspected
`Add-Content -Encoding utf8` had written a mid-file BOM. Measured on PowerShell 5.1 — a 45-byte file with the
BOM only at offset 0. **Not the cause, and recorded so it is not repeated.**

**The experiment that settled it took one command and started nothing**: `dsh --profile <probe> --dump-config`,
which prints the composed tree and exits. **It would have caught this before the first restart had I run it
first.**

**No code change and no test count change** — a documentation release. It is versioned rather than left
unreleased because the incorrect procedure was published in `TROUBLESHOOTING.md`, and a user following it would
break their client.

**56 of 66 release scripts published the wrong text, and this is the fix that makes it impossible to repeat.**

### The defect, found while checking someone else's test plan

A test plan written against v0.60.0 reported that its GitHub release notes were *"highly duplicated"* with
v0.59.0, v0.58.0 and several earlier releases, and concluded they were probably template-generated. **That
conclusion was right and the cause was mine:**

    // publish-0600-github.mjs
    /** The release notes reuse the commit message: it already states the cause, the fix and the evidence. */
    const NOTES = fs.readFileSync('E:\\GPT\\scripts\\commit-0103b.txt', 'utf8');   // <- v0.1.3's message
    name: 'v0.60.0 — approval index, fleet sync, service health, tiered storage',      // <- hardcoded

**The script states the right intention in its own comment and then reads the wrong file.** Measured: **56 of 66
`publish-*-github.mjs` scripts read that same stale file, and 57 carry that same title** -- four roadmap
keywords that describe none of those releases.

### What I got wrong twice while investigating

**First** I said the `health` module did not exist and that the test plan was testing a fiction. **It exists:**
`src/agent/health.mjs`, whose own header records the macOS mistake and its fix
(`darwin: ['/var/log', '/Library/Logs', '/tmp']`). **It was in the code and missing from my CHANGELOG, and I
read the CHANGELOG as if it were the record.** The test plan was more accurate than my denial of it.

**Second**, having been wrong, the honest correction is that the plan is right about `health` and wrong about
three counts, which are now measured rather than quoted: **89 suites (not 82), 2352 tests (not 2228), 15
pre-flight checks (not 12), and six aggregation verdicts (not nine)** -- `degraded`, `timeout` and
`cancelled` do not exist, so the three rows testing them would report false failures.

### The fix is a module, not another corrected copy

`scripts/github-release.mjs` **derives both fields from the repository's own record**: the title from the commit
subject, the body from the CHANGELOG entry for that version. **Neither is written by hand, so neither can be
copied by accident** -- which was the actual failure mode, since each release was a copy of the previous script
and the two constants that must change were the two easiest to forget.

**It refuses to publish when the CHANGELOG has no entry for the version.** A release whose body cannot be derived
is a release that would otherwise be published under the previous one's text, which is precisely what happened 56
times. **It also reads back after writing and compares**, because `PATCH` returning 200 is not evidence that the
field changed.

Verified: a version with no CHANGELOG entry is refused (exit 1); a version with one yields the commit subject as
its title and a 3024-character body (exit 0, dry run); the exported helpers split CHANGELOG sections correctly,
return null for an unknown version, and import without side effects.

**The token comes from `GITHUB_TOKEN` rather than being embedded**, which all 66 older scripts do.

### The five most-read releases are corrected

Titles and bodies rewritten from their own CHANGELOG entries, **each verified by reading the release back**
rather than by trusting the response:

| Release | Title now |
|---|---|
| v0.60.0 | `docs(troubleshooting) + feat(script): the lock rule, and an out-of-band session bound` |
| v0.59.0 | `fix(bin): every published bin can be imported without killing the importing process` |
| v0.58.0 | `feat(bridge): report what arrived instead of guessing what an image looks like` |
| v0.57.1 | `docs(bridge): correct a comment that implied a sequence the file does not have` |
| v0.57.0 | `feat(vision): an image path becomes text evidence, and the credential never touches argv` |

Each was 2044 characters -- one identical body -- before the repair.

**The remaining 51 are left as they are**, which is a decision rather than an oversight: they are old enough that
nobody reads them, and the module means the next release is correct without anyone remembering to check.

 format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.60.0] — 2026-10-16

**Two things learned from a client that would not start, neither of which was a crash in this plugin.**

### §3.1 in `TROUBLESHOOTING.md`: check the lock before you check the plugin

A launch that leaves **no process at all** is a different failure from one that starts and reports something, and
the existing §3 procedure will mislead anyone who skips that distinction — it assumes the application *ran*.

**The mechanism is one function in `@deepseek-ai/dsh-desktop`'s `lib/main.js`:**

```js
function claimDesktopSingleInstance(application, focusOwner) {
  if (!application.requestSingleInstanceLock()) {
    application.quit();          // no dialog, no error, no window
    return false;
  }
```

**A second launch is silently discarded while the first instance holds the lock.** Electron registers it against
the *application*, not a directory — which is why the two natural remedies both fail, and why the section now says
so before offering any plugin diagnosis:

| What was tried | Why it did nothing |
|---|---|
| disable third-party plugins before restarting | the new process quits at the lock, before plugin loading |
| reinstall the client (new folder, new exe) | a new directory does not release an application-scoped lock |

**Deleting `~/.dsh` fixed it — not because anything in it was corrupt, but because the deletion took down the
process still holding the lock.** The section now leads with the measurement that costs nothing:

```powershell
Get-Process -Name 'DeepSeek Harness' | Select-Object Id, StartTime
```

**Processes listed → it is the lock, end them and retry. Nothing listed → the failure really is pre-lock, and §3's
procedure applies.** The deleted directory carried session history and profile configuration; **`Stop-Process`
would have cost nothing.**

### `scripts/session-retention.mjs`: the store is bounded, out-of-band, as DSH says it must be

`@deepseek-ai/dsh-session-persistence`'s README, under *Known Limitations*:

> **No deletion or retention API** — pruning stored sessions is **out-of-band backend maintenance**.

**So this is not a workaround for a missing feature: the host states retention is the operator's job.** The
measurement that motivated it is that **one session reached 18.03 MiB of an 18.07 MiB store**, nothing bounds it,
and every start reads the store.

Three refusals are built in, and each is a deliberate limit rather than an omission:

* **The newest session of every workspace is never removed.** DSH writes to it, and *which* process is writing
  cannot be checked reliably from outside — so the rule is the one that needs no knowledge of the running
  process.
* **`--apply` is required.** The default prints the plan and exits 0. **A tool that removes conversation history
  shows what it will remove before it removes it.**
* **A directory that is not a session is reported, not touched**, because the layout is read from the filesystem
  rather than assumed.

**Verified against the real store:** at a 256 MiB cap it reports *"under the cap — nothing to remove"*; at a
1 MiB cap it plans two removals and leaves the 18 MiB live session alone.

**No test count change** — both additions are a document and a script, and the script is exercised by hand against
the store it bounds rather than by a fixture that would not resemble it.

## [0.59.0] — 2026-10-16

**Every published bin can now be imported without killing the importing process — measured, not reasoned about.**

### The defect

`package.json` publishes three CLIs as importable `exports` subpaths:

```json
"./rabbit":    "./bin/w2m-rabbit.mjs"
"./localside": "./bin/w2m-localside.mjs"
"./stun":      "./bin/w2m-stun.mjs"
```

**And those three had no import guard, so their top-level body ran on import.** Measured:

```
import .../bin/w2m-localside.mjs   ->  node exited with code 2
a statement placed after the import never ran
```

**A published entry point that terminates whichever process imports it.** The plugin's own client-bundle
documentation records that `exports['./client']` *"is what the host scans for"*, so the host reads that map —
**and `w2m-mcp.mjs` already carried this guard, which is why it was the one bin that behaved.**

The fix gives the other three the same guard rather than withdrawing the exports: **a subpath that is importable
and inert is strictly better than one that is neither.** All four are now inert on import (`58ms / 74ms / 5ms /
2ms`) and all four still run as programs (`--help` → exit 0 with the right banner).

### What this does **not** claim, and why that matters here

**This is not offered as the explanation for the client that would not start.** That was reported as *no process
at all on a double-click*, and that symptom has a different mechanism, read out of `lib/main.js`:

```js
function claimDesktopSingleInstance(application, focusOwner) {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }
```

**`application.quit()` — no dialog, no error, no window.** A second launch is silently discarded while the first
instance holds the lock, which explains all three observations: disabling third-party plugins did nothing (the
new process never reached plugin loading), **reinstalling the client did nothing (a new directory does not release
a lock registered against the application)**, and deleting `~/.dsh` worked — **because it took down the lock
holder.**

**A real defect, fixed; a different defect, responsible.** The two were adjacent in time, and conflating them
would have produced a changelog entry claiming a fix it cannot demonstrate.

### Three of my edits failed on the same mistake before the fourth worked

The guard had to be inserted where each file's executable body begins. **My first two markers were text I
predicted rather than read** — `await main()` does not exist in `w2m-rabbit.mjs`, and `const bound = await bind`
does not exist in `w2m-stun.mjs`. Then a `Select-Object -Skip` offset was **1-based** while the array index is
**0-based**, so the script refused both files by one line. **The fourth attempt anchored on the statements' own
text and succeeded on the first run.** That is the same lesson as the fabricated relay route and the malformed
PNG, and it is now the fifth time this session.

**No test count change** — the guards alter when the bodies run, not what they do, and all four entry points are
exercised by `scripts/check-entrypoints.mjs`.

## [0.58.0] — 2026-10-15

**The bridge now reports what it received instead of guessing what an image looks like.**

### Why this is a probe and not an image branch

`ITEM_TYPE` declares exactly one member:

```js
export const ITEM_TYPE = Object.freeze({ TEXT: 1 });
```

**The shape of every other item type is unrecorded in this repository** — no `image_item`, no sample payload, no
fixture. `ilink-protocol.mjs` documents only the text form. **So a download path written today would be a guess
about field names, and it would fail at the moment a real photograph arrived** — which is the worst possible time
to discover a wrong guess, because the person is waiting for their picture to be read.

**This is the discovery step.** `describeItems()` reports **key paths and value types, never values**, so one
photograph sent by a person answers the question the source cannot.

### Values are never recorded, and that is the point of the whole function

A message body is the user's content, and **a discovery aid that quietly wrote photographs into a log file would
be a worse defect than the one it exists to diagnose.** One assertion is dedicated to that: a distinctive
passphrase planted in a URL and a caption, and the check that neither appears in the output.

The walk is bounded — `maxKeys` and `maxDepth`, arrays described by length and first element, cycles reported
rather than followed — **so a surprising payload cannot bury the log it is being written to.**

### Every wrong guess this session was corrected by printing the thing

A fabricated relay route (`/v1/stats`, `/v1/status`), a malformed PNG reported as a credential failure, a count
typed from memory onto a CHANGELOG entry — **each was fixed by reading rather than predicting.** This applies that
method *before* the guess instead of after it, which is the only difference between this and the four previous
occasions.

### What is still not done, stated rather than implied

**The bridge still cannot read an image.** The `/v1`-style branch that downloads it does not exist, because the
field names are unknown. What exists now is the instrument that finds them: **send one photograph, and the log
says what the far end actually sends.**

**13 new tests, 0 failures**, and the existing bridge and tool-card suites still pass — the added `shape` field is
carried only on a non-text reply, so it means one thing. Full suite 2354 in 89 files. **Pre-flight GREEN.**

## [0.57.1] — 2026-10-15

**The vision status line now appears only on a bridge that actually starts — which it already did, for a reason
worth writing down.**

`visionStatus()` sits at the top of `main()`, and the configuration refusal runs at **module scope, before `main()`
is ever called**. So a bridge that refuses to start prints nothing about vision.

**I first described that as a bug and set out to move the check "after the refusal block".** Reading the file
showed the ordering was already right: **the refusal already names what is wrong, and a second complaint about
vision underneath it would bury the first.** The comment was corrected to say what the code does rather than to
describe a fix that was never needed.

**A no-behaviour-change release**, and the only reason it exists is that the comment previously implied a
sequence the file does not have.

## [0.57.0] — 2026-10-15

**An image path becomes text evidence: the vision subprocess, and the credential path that does not touch argv.**

### What this is, and what it deliberately is not

`src/chatops/vision.mjs` runs the vendored `vision.py` as a subprocess. **It is not the WeChat integration** —
the bridge still answers an image with a help message. The two halves are kept apart because each has a different
failure mode and can be verified alone, **and this half is verifiable today**: give it a real image and it either
returns text or a named reason.

**Verified against the real endpoint, on this machine:** a generated 32×32 red PNG, `glm-4v-plus`, **1.77 s**,
reply `"红色。"` — and `prompt_tokens` 64 → 2374, so the image genuinely reached the model rather than being
ignored.

### The credential never enters `argv`

`vision.py` resolves its key as `--api-key` > `VISION_API_KEY` > the provider's own variable — read out of its
own source, not assumed. **Passing it on the command line would put a live key into `ps` output and into any
argument logging**, so this module only ever sets it **in the child's environment**, and the caller supplies it
from a file.

**The settings file is a parser, not a shell.** No expansion, no quoting rules, no `export` prefix: a value of
`$HOME` stays the four characters `$HOME`. **A settings file that is half a shell is a shell**, and the point of
this one is that it is read rather than executed.

### An error message I wrote that collapsed three causes into one

My first probe of the credential printed
`==> refused; the key or the model name is not accepted` for **any** non-2xx response. The actual response was:

```
HTTP 400  code 1210  "图片输入格式/解析错误"
```

**That is an image-decoding failure — which is proof the credential was accepted**, because bigmodel answers
**401** for a bad key. **My hand-built base64 PNG was malformed, and I reported it as a credential problem.** One
conclusion for three different causes is the failure this repository keeps naming, and I committed it while
writing a file whose own header complains about that pattern.

The re-probe generates the PNG from `zlib.deflateSync` plus a hand-written CRC — **correct by construction** —
and splits the two questions: a text-only request isolates the key, and the image isolates the vision path. Both
returned 200.

### One ordering the code decided and the test got wrong

The module checks the image argument, then the script, then whether the image exists. My new assertion claimed a
non-existent image outranks a missing script — **it does not, and the code was right.** The assertion was
narrowed to the ordering that is actually guaranteed: **an empty argument is rejected before the installation is
consulted.**

**17 new tests, 0 failures**, and none of them needs a network or a key — every refusal path is asserted, and the
one thing not asserted is a real model answer, because a suite that needs a credential is a suite that skips
wherever the credential is absent.

## [0.56.0] — 2026-10-15

**The declared endpoint is now tested against the real binary, so a drifted port turns the pre-flight red.**

### The gap the sixteen transport tests left open

`mcp-http.test.mjs` drives `createRequestHandler` **in process**, with fake request and response objects. That
proves the framing, and it proves **nothing about the CLI path**: a wrong default port, a crash during startup,
an import cycle, or a `--http` flag that is never reached would all pass while `mcp.json` pointed at a dead URL.

**A wrong end of a declared address is not a unit-test-shaped bug.** It has to be dialled.

### What the new suite does differently

`test/mcp-http-live.test.mjs` **spawns `bin/w2m-mcp.mjs --http`** and speaks to **the URL read out of
`mcp.json`** — not a URL the test picks, because a healthy server on port 0 would prove nothing about `8766`.

It asserts the far end is reachable and speaking the protocol, and **deliberately does not assert a successful
tool result**: the relay needs an operator token the test does not carry, so **a `401` is the expected
outcome**. That refusal is *stronger* evidence than a mocked `200` — **it proves the request left this process,
crossed the binding, and was answered by the fleet's real relay**, which a mock could not distinguish from a
server that never dialled out.

**stdout is asserted empty.** The stdio binding owns stdout; if this path ever wrote a frame there, a client
launching both would see a corrupted stream and the symptom would be a hang rather than an error.

### Three levels of nesting, which is why this was worth checking

`pre-flight` → runs the declared suite as a child → which runs this suite → which spawns the server. **That
works**, and the run proved it rather than assuming it.

### The one failure it produced, and it was mine

The first run went red on `claims.test.mjs`: **`package.json` said 0.56.0 and the newest CHANGELOG entry said
0.55.0.** I bumped the version before writing the entry. **This project's own check caught my ordering mistake**
— which is the whole point of `claims` existing, and the second time this session that a version bump without an
entry has been the only red line in an otherwise green run.

**6 new tests, 0 failures.** Full suite 2324 in 87 files. **Pre-flight GREEN with FIFTEEN checks.**

## [0.55.0] — 2026-10-15

**A second transport binding — and `mcp.json` now declares both.**

### The same protocol, two bindings, and no logic shared between them

The MCP overview states it plainly: **"protocol semantics are identical on every transport. A transport is a
binding."** So `src/mcp/http-transport.mjs` contains **no protocol decisions** — it decodes a request, hands the
body to the same `handleMessage` the stdio binding uses, and encodes the reply. **Neither binding imports the
other.** The single command reaches the fleet over both.

### What revision `2026-07-28` removed, which made this smaller than expected

* **The GET stream endpoint is gone.** A bare `GET /mcp` gets **405 naming the revision**, not a 404 — a client
  written against the older revision should learn *why* rather than guess at the URL.
* **Protocol-level sessions are gone.** No `Mcp-Session-Id`, no session table, no state between requests. Two
  identical requests return identical bytes, and the test asserts it.

`GET /mcp?discover` still answers, **gated on an explicit parameter**: a bare GET is what the removed stream
client sends, and handing it a description document to parse as a stream would be worse than refusing it.

### The `Origin` rule is a MUST, and it is easy to skip

> **"Servers MUST validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks."**

A loopback MCP server is reachable by **any page the user's browser loads**, and a rebinding attack makes that
page same-origin. So a refused `Origin` gets **403 before the body is read** — asserted with an unparseable body,
because ordering is the property.

**A missing `Origin` is allowed, and that is a decision rather than an oversight**: the header constrains
*browsers*, an attacker's browser always sends one, and refusing an absent header would break every
command-line client while stopping no attack. The default bind is **127.0.0.1**, per the specification's SHOULD.

### `mcp.json` declares both, and one of them is not a subprocess

```json
"w2m-fleet":      { "type": "stdio",           "command": "node", "args": ["./bin/w2m-mcp.mjs"], "cwd": "${PLUGIN_ROOT}" },
"w2m-fleet-http": { "type": "streamable-http", "url": "http://127.0.0.1:8766/mcp" }
```

**The HTTP entry names a server that must be started separately** — `node bin/w2m-mcp.mjs --http` — because a
remote-transport entry has no `command` to launch. That is what the transport type means, and the alternative —
declaring only stdio — would leave an HTTP-only client with nothing to connect to. **The `cwd` is
`${PLUGIN_ROOT}` rather than a path, so the entry works wherever the package is installed**, and
`plugin-manifest-check.mjs` validates both entries against the schema's closed per-transport field sets.

### One assertion I wrote wrong, and the fix was the implementation

My discovery handler matched `GET /mcp` **exactly**, while the test sent `GET /mcp?discover=1`. **The test was
right and the code was wrong** — the two GETs are different callers with different needs, and telling them apart
by a parameter is honest where guessing at intent is not. Fixed the handler, not the test.

**16 new tests, 0 failures.** Full suite 2318 in 86 files. **Pre-flight GREEN with FIFTEEN checks.**

## [0.54.0] — 2026-10-15

**The fleet is published as an MCP server — read-only, and every declared route is checked against the relay's
own router.**

### Five tools, and nothing that can change anything

```
w2m_devices  -> /v1/devices
w2m_stats    -> /healthz
w2m_history  -> /v1/tasks
w2m_report   -> /v1/tasks/{id}/report
w2m_status   -> /v1/agents/{id}/status
```

**`w2m_run` is deliberately absent.** A server that hands fleet execution to any process able to start it gives
away the ability to run commands on every machine in the fleet — and this project has already learned that a
guard which is merely *named* well is not a guard: the `--dry-run` flag in `scripts/ilink-fleet-bridge.mjs`
**dispatched for real while its name promised otherwise**. So the first version exposes five reads, and a test
asserts by name that no mutating tool appears — **a later edit adding `w2m_run` has to delete an assertion rather
than quietly widen what the fleet exposes.**

### I invented two routes, and the check that catches that now exists

My first draft declared `/v1/stats` and `/v1/status`. **Neither exists.** The relay's complete GET surface is
`/healthz`, `/metrics`, `/v1/stream`, `/v1/devices`, `/v1/tasks`, `/v1/tasks/{id}`, `/v1/tasks/{id}/report` and
`/v1/agents/{id}/status`.

**A fabricated route does not fail loudly.** The relay answers 404, the MCP client reports a broken server, and
the bug is in this package — a failure that surfaces in somebody else's tool, at a time nobody connects to this
commit. So `scripts/mcp-check.mjs` **reads the routes back out of `src/relay/server.mjs` and compares them**, and
the pre-flight runs it as a fifteenth check. Verified by injection: adding `/v1/invented` turns it red and names
the route.

**Two routes needed canonicalising to compare at all** — the router carries `/v1/tasks/([^/]+)/report` where the
tool declares `/v1/tasks/{id}/report`. The first version of the check failed on two routes that *are* routed,
which is its own lesson: **a check that fails on correct input gets disabled.**

### Both protocol eras, because the deployed clients are on the older one

The current revision (`2026-07-28`) is **stateless** — version, identity and capabilities travel as per-request
`_meta`, and there is **no handshake**. Every earlier revision opens with `initialize`.

**A server implementing only the modern contract is unreachable from most deployed clients**, which is exactly
the population this exists to serve. So `initialize` is answered for legacy clients, `_meta` is honoured for
modern ones, and an unsupported version gets the `-32022` error **with the `supported` list**, as the
specification requires. `server/discover`, which the current revision demands of every server, is implemented.

**A notification is never answered** — JSON-RPC forbids it, and `notifications/initialized` is sent by every
legacy client, so getting that wrong breaks every connection.

### stdout carries protocol messages and nothing else

Over stdio a stray `console.log` corrupts the stream, and the symptom is a **hung client**, not a chatty server.
Every diagnostic in this file goes to stderr through one `log()`, and the test drives the real `serve()` loop
over in-memory streams rather than spawning a process — **because a test that needs a subprocess is skipped
wherever piped stdio is refused, which is exactly where a protocol regression must still be caught.**

### Four mistakes of mine, three of them the same mistake

* **`/v1/stats` and `/v1/status` were fabricated.** Read the router; do not write the route you expect.
* **`mcp-check.mjs` ran its whole check and called `process.exit` on import**, so the consuming suite reported
  **1 test instead of 25** with no failure named. **This is the third file in this project to need the same
  guarded-`main()` fix** — `skill-check.mjs` and `plugin-manifest-check.mjs` were the first two — and each one
  now carries the guard with a comment saying why.
* **I deleted a doc comment's closing `*/`**, which commented out `export const TOOLS` and produced
  `TOOLS is not defined`. **That is the fourth time in this project that an edit matched anchor text without
  reading the block containing it.**
* **One assertion failed three times for three different incidental reasons** — a sample value substituted
  where the builder applied a default, a `{id}` that `canonicalRoute` refuses to collapse, and an optional
  property left unset. **The fix was to narrow what it tests**: the property is *"this tool can reach the route
  it declares"*, and the query string is not part of that.

**25 new tests, 0 failures.** Full suite 2302 in 85 files. **Pre-flight GREEN with FIFTEEN checks.**

## [0.53.0] — 2026-10-15

**The shared-memory layer gets a suite, and it corrected three things this session had already "verified".**

### The layer was measured by hand; now it is measured by the suite

Field-level omission at level 0, the refusal of an unproducible ancestor, the level 0/70 difference — **all of
that was real evidence, produced through actual dispatches to an actual machine.** It was also **not
repeatable**: it lived in a session, not in the suite. **A measurement that cannot be re-run is a memory of a
measurement.**

`test/memory-layer.test.mjs` adds **22 assertions**, and the suite grew to 84 files.

### Three corrections, each of which the hand-run had got wrong

**1. `evidence` costs 50, not 70.**

```
FIELD_LEVELS = { subject: 0, body: 0, evidence: 50 }
```

A level-70 dispatch succeeded, and **70 was written down as the threshold.** It is not: 49 is refused and 50 is
allowed, and **50 is not arbitrary — it is the bottom of the `captain` band**, which is why the number is what
it is.

**2. `confidence` is an invariant, not a high-cost field.**

`NEVER_ACCEPTED.confidence` = *"a receiver does not adopt the sender's certainty (**invariant, not a
default**)"*. Level 90 is refused exactly as level 0 is, and there is no level that satisfies it. **The reason
string says "invariant" on purpose: a reader who thinks it is a threshold will try to raise it.**

**3. `FIELD_UNDECLARED` does not mean "forbidden", and the two APIs answer different questions.**

| call | question | `origin` / `observed_at` / `lineage` |
|---|---|---|
| `acceptField` | *may a receiver choose this?* | `FIELD_UNDECLARED` — no rule lets a receiver pick it |
| `acceptWithAuthority` | *what does this receiver keep?* | **present in `accepted`** — they are inherited |

**So `UNDECLARED` means "not a receiver's to choose", not "refused".** Reading it as a refusal would have the
receiver drop the ancestry that makes the block meaningful — and `INHERITED_FIELDS` plus
`RECEIVER_CHOOSABLE_FIELDS` partition the seven exactly, so neither list can change without the other.

### Four assertions of mine that were wrong, and the last one is the interesting one

* **`ancestry` takes a `Map`, not an array**, and returns `{chain, missing, cycle, depth}` — **there is no `ok`
  and no `code`.**
* **`MISSING_PARENT` is not an `ancestry` outcome.** `ancestry` **collects** gaps in `missing` — *"knowing how
  much of a history is absent is more useful than knowing that some of it is"* — while `acceptBlock` is what
  **refuses**, returning `accepted: null`.
* **`isDescendantOf` returns `{descendant, chain, missing, checked}`, not a boolean.** It returns more than a
  boolean because that is its point: *"a claim that descends from something this machine already thought is an
  **echo**, not corroboration, and **a fleet that cannot tell those apart will confidently agree with
  itself**."* A parent that is not held gives `descendant: false` — and my assertion had demanded `true`.
* **I could not construct a cycle, and that turned out to be the finding.** `blockHash` covers `lineage`, so
  rebuilding a block changes its hash and the edge no longer closes — **a real cycle would need a hash
  preimage.** The walk produces a *diamond* instead, and `CYCLE` is reachable **only** from a `have` map whose
  keys disagree with the blocks under them: a corrupted or hostile store, where **terminating is the point,
  because an unbounded walk on hostile input is a denial of service.**

**Three attempts at that test asserted a cycle the code was right not to report.** The fourth printed the
traversal instead of predicting it, which is the only one of the four that produced a fact.

## [0.52.0] — 2026-10-15

**Agent Plugins 1.0.0 manifests, validated against the published schemas — and the honest note about who
reads them.**

### What shipped

```
plugin.json    root manifest, Agent Plugins 1.0.0, $schema pinned to the canonical identifier
mcp.json       schema-valid with an EMPTY server map -- see below
skills/        unchanged; the four SKILL.md files were already the portable form
```

`scripts/plugin-manifest-check.mjs` validates both, `pre-flight` gained a fourteenth check, and
`test/agent-plugins.test.mjs` adds fourteen assertions across both manifests and the skills.

### The schemas were read, and the constraints are written out rather than fetched

`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and `.../mcp.schema.json` are both live, and the
rules come from them — including the `name` pattern `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`,
**which refuses `--` and `..` and which I would not have guessed.** They are **not fetched at check time**:
a validator that needs the network cannot run offline, and one that skips itself when the fetch fails reports
success for the case it could not measure.

**What this cannot check, stated rather than implied:** the schema's own description says *"the Agent Plugins
specification defines additional semantic and operational requirements."* Path containment, symlink
resolution, MCP transport support and the `PLUGIN_ROOT`/`PLUGIN_DATA` expansion rules are **not** expressible
here and **are not claimed**.

### `mcp.json` ships with zero servers, and that is the honest version

The request specified MCP as the unified calling protocol. **DSH has no MCP client.** Measured across all
8543 small code and config files in the application bundle: `plugin.json` 0, `mcp.json` 0, `agent-plugins` 0,
**and `mcpServers` 0 occurrences in host-owned code** — the 202 hits are third-party SDKs inside
`node_modules`, which support MCP without this host reading a config for it.

**And there is no MCP server in this package.** So the file is schema-valid with an empty map: a portable
client reads it and starts nothing, which is true. **The alternative — declaring a server that does not
exist — is a manifest that launches a failure**, and shipping that to satisfy a specification would be the
same mistake as advertising a capability the code lacks.

### The one rule that is not from a schema caught me immediately

`plugin.json`'s `version` must equal `package.json`'s. **On the validator's first run it failed: the manifest
said 0.52.0 and `package.json` still said 0.51.0.** That is the whole justification for the rule — DSH loads
plugins through `package.json#dsh` and a Cordis bundle patch, **so nothing in this host ever reads
`plugin.json`.** A manifest with no consumer has no way to notice it is stale.

**A file nobody reads is a file that cannot be wrong.** The schema check and the drift check are the only
things standing between this manifest and quiet decay.

### Four assertions that were wrong, mine

* **`frontmatter('---\nname: a\n')` returns `null`, not `{ data: undefined }`** — an unclosed block is not
  frontmatter, and my assertion demanded the shape the code does not return. **The code was right.**
* **I typed `disableModelInvoction`** in the rejected-spelling set. **A misspelled name in a rejection list
  is a name that is not rejected** — the exact failure the list exists to prevent.
* **I exported a contract object above the constants it read**, so importing the module threw
  `Cannot access 'PLUGIN_FIELDS' before initialization`.
* **I wrote the `implementations` Map entry as `['name']: () => …`** inside an array of pairs, matching an
  anchor line without reading the structure around it. **This is the third time in this project that an
  edit matched an anchor string instead of the block containing it.**

Both validators now export their rules and keep the CLI in `main()`, so **the suite asserts them without
spawning a child** — a test that needs a subprocess is skipped wherever piped stdio is refused, which is
exactly where a check must still run.

## [0.51.0] — 2026-10-15

**Four Agent Skills, written against the loader's real contract — and a gate that makes the contract matter.**

### The four skills

```
skills/
├── fleet-control/SKILL.md        the four modes, the nine verdicts, every refusal code
├── memory-sync/SKILL.md          field-level acceptance, omission versus null, ancestry
├── session-ref/SKILL.md          the dsh-session: codec, its three checks, its silent trap
└── resource-schedule/SKILL.md    lease states, the ~50s ceiling, what "expired" means
```

**Every rule in them was measured before it was written.** The refusal codes are the ones this session
actually produced, the ~50-second ceiling is one that was hit more than eight times, and the `dsh-session:`
section describes a codec whose three checks were read out of `@deepseek-ai/dsh-session-reference` — **including
the one that surprises people, where a payload that decodes correctly is still refused for not being
*canonical*.**

### The contract came from the loader, not from a specification

`parseSkillFile` reads **`name`** and **`description`**, tests the name against
`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, and **rejects three renamed spellings outright** —
`disableModelInvocation`, `modelInvocable`, `userInvocable` — in favour of the hyphenated forms. On any
failure it logs a warning and **returns**.

**That is the whole reason this ships with a gate.** A skill that violates the contract is not an error: it
simply never appears, the directory still looks shipped, and nothing is red. **It is a file whose only symptom
of being wrong is not being there.**

### New check: `agent skills`, and the twelfth became the thirteenth

`scripts/skill-check.mjs` mirrors the loader's rules, and `pre-flight` now runs it.

```
PASS  agent skills (frontmatter satisfies the loader, so no skill is silently dropped): 4 skill(s) satisfy the loader contract
pre-flight: 13 pass, 0 fail, 1 unverifiable (13/13 registered check(s) reported) -- GREEN
```

It is bound in **three** places — `DECLARED_CHECKS`, `GATE_INVENTORY` (five artifact rows: the validator and
the four `SKILL.md` files), and the implementation map — because this repository's own rule is that a
declared check with no artifact, or an artifact with no check, is red in both directions.

### Two mistakes of mine, both worth keeping visible

**The check reported `exit null` and nothing else.** The cause was `result.error` — an `EPERM` from
`spawnSync` under a `workspace-write` sandbox that had replaced the `danger-full-access` of earlier runs. **The
code was right and the environment was refusing.** But the diagnosis was bad on its own terms: **a check that
prints an exit status and drops the reason names nothing**, so the failure now says
`EPERM: spawnSync …` and the next reader does not have to rediscover the sandbox boundary.

**I edited the `implementations` Map into invalid syntax** — `['name']: () => …` inside an array of pairs —
because I matched an anchor line without reading the structure it sat in. **This is the same error shape as
the `accept_block` branch in 0.41.0, and it is twice now.**

**The skills ship** — `skills` is in `package.json#files` beside `docs`, so the four `SKILL.md` files are in
the tarball. **They load only when a host points `DSH_BUNDLED_SKILL_DIR` at the directory**, which is a host
setting rather than something the package can assert; the alternative roots are `<project>/.dsh/skills`,
`<project>/.agents/skills`, `<dshHome>/skills` and `~/.agents/skills`.

## [0.50.0] — 2026-10-15

**The matrix gains the two defects and the WeChat path — and the counts are read from the table, not typed.**

### What the matrix now records that it could not before

`docs/TEST-MATRIX.md` grows **two sections and eighteen rows**:

* **§十二 微信桥接** — twelve rows for the path this project had never executed: QR binding, the bridge
  reading the live channel, the permission refusal by name, `--ask` as the marker that keeps a sentence from
  being dispatched, and **the full WeChat → dispatch → verdict → WeChat round trip**.
* **缺陷** — six rows for what was found and changed. **修正时间 has content for the first time, because it is
  the column for things that were corrected**, and it was empty until now.

**Every one of the 18 can be traced to a command, an exit code, or a line of a log.** The two silent inputs,
the two dry runs that dispatched, the run with no reply because the bridge was stopped, and the token deleted
by a release — all of them are there with what produced them.

### The counts are now read from the table, and the reading is written down

```
79 行 = 52 通过 + 8 待执行 + 11 阻塞 + 1 跳过 + 2 证伪 + 5 失败(已修或已确认)
```

**This is the second time I have corrected these numbers, and the two corrections have the same cause.** In
0.46.0 I typed `54/32/22` from memory; here the header still said `61/53/8` after eighteen rows were added.
**Both times the fix was to read the table instead of recalling it**, so the equation is now stated in the
document beside the numbers, and a test-shaped check confirms the arithmetic against the rows.

### The one row that is `失败 → 未修`, and why it is the useful one

**`TC-DEF-006`: every release runs `Remove-Item dist`, which deletes `dist/ilink/ilink-login.json` — the
WeChat token.** I hit this myself ten minutes after binding the bot, and the symptom is
`no login at dist/ilink/ilink-login.json`, **which says nothing about a deletion.**

It is recorded as **unfixed** rather than quietly omitted, because **a matrix whose only unexecuted rows are
environmental stops being a list of things to do.** The fix is small — move the login file out of `dist/`, or
have the release step spare it — and it is not in this release because the honest state is that it is not
fixed yet.

**No new tests.** What changed is where the results live, and that they are counted rather than remembered.

## [0.49.0] — 2026-10-15

**Every message now gets an answer. Five inputs were being silently dropped, and two of the three input
types the request asked me to advertise are not supported.**

### What was silent, measured before it was changed

```
文字 /run node --version  → dispatch
文字 /run --ask 你好       → reply
文字 你好                  → ignore   why=not a /run line
图片 (type 2)             → ignore   why=not a text message
语音 (type 3)             → ignore   why=not a text message
空 item_list              → ignore   why=not a text message
```

**Five inputs, no answer.** A bot that reads messages and replies to none of them is
**indistinguishable from a bot that is broken**, and the operator's only move was to send the command again.

### The one silence that survived, and why it had to

`no sender` and `no context_token` still return `ignore`. **With no sender or no context token there is
nowhere to send an answer**, so returning `reply` would be a plan that lies about what the caller can do.
**That is the reason the vocabulary still contains `ignore` at all** — collapsing it into `reply` would have
made every plan look successful while nothing was sent.

### The request asked the help to advertise "text, voice and images". I refused two of the three.

`textOf` reads only `item type: 1` — **measured, not inferred: an image and a voice note both answer
`not a text message`.** So the help says:

> 支持：文字。中文可以。
> 不支持：语音、图片、文件、表情——它们只会得到这条帮助。

**A help text that promised a capability the bridge does not have would be read as a bug the first time
somebody sent a photo**, and the bug report would be about the bridge rather than about the promise.

### The three sections are asserted by heading

`【1】开关指令` · `【2】指令规则与格式` · `【3】参考与边界` — asserted by name rather than by "the text mentions
commands", because **a help text that loses a section still reads fine.**

Two of the seven new assertions are worth naming:

* **`--ask` is in the help.** It was reachable only by reading the source, which is the entire
  discoverability defect this section exists to close. If it ever leaves the help, the defect is back.
* **every `/run` example in the help is put through the real parser.** The help cannot drift into
  advertising syntax that is refused.

### The activation instruction, answered honestly

*"If refused, provide the activation instruction"* — and the honest answer is that **a chat window cannot
activate itself**. The help says the capabilities are granted by whoever starts the bridge, through
`W2M_CAPABILITIES`, and that a refusal names the missing capability. **Implying otherwise would have sent
the operator looking for a command that does not exist.**

**Three existing tests demanded `ignore` and now demand `reply`.** They were right about the rule — a typo
must never become a fleet execution — and wrong about how the rule is expressed. They were updated rather
than deleted, because **the old expectation is the record of what changed.**

**7 new tests, 0 failures.**

## [0.48.0] — 2026-10-15

**`--dry-run` dispatched. Two dry runs sent a command to five machines, and one made a real task.**

### The defect, measured before it was described

The bridge guarded exactly one thing under `--dry-run`: the **reply**. The dispatch ran unconditionally.

```
[15:13:57] dry run     : true
[15:15:00]   dispatched task 01M50231AYJYDD41WSPMS9PRM3
[15:15:50]   verdict for …: partial
```

**That is a real task record with five real leases, produced by a run whose flag promised nothing would
happen.** A rehearsal executed commands on production machines — and it was found by accident, while draining
a message queue, not by a test.

### Why the fix is "skip the dispatch" and not "rename the flag"

**This repository already fixes the meaning of the word.** `update-install`'s `dryRun` is asserted to **call no
package manager and write nothing**, and `auto-update`'s is asserted to **write nothing to the profile**. So a
second `dry-run` meaning "do the dangerous part anyway" is not a naming preference — **it is two flags with one
name and opposite meanings, and the bridge held the unsafe one.**

**Renaming would have left the flag. Aligning keeps the word and removes the hazard**, and a reader who knows
`dryRun` from anywhere else in this project is now already right about this one.

### Why the guard is a function in `lib`, not an `if` in the script

`scripts/` is **not in `package.json#files`**, so nothing there is covered by a test that ships. A safety
property expressed as one line inside an untested script is a property nobody re-checks. `dryRunPolicy` is
exported and asserted beside the wire shapes — **a script is not where a guard should live if the guard is the
point.**

The guard sits at the **top of the only function that reaches `fleet.run`**, not at its call site, because a
guard at the call site is one edit away from being bypassed by a second caller.

### A name collision that made my own test wrong

I asserted that `dryRun: 'true'` must not dispatch. **It does dispatch — the code was right and the test was
wrong**, and the cause is two different things sharing one word:

| | meaning |
|---|---|
| the CLI **flag** `--dry-run` | **present-means-true** (`argv.includes('--dry-run')`) |
| the **parameter** `dryRun` | **defaults to false**, which is what `update-install` means by it |

`dryRunPolicy` takes the parameter, and the script always hands it a boolean. The assertion is now the strict
one — **only `true` turns the dispatch off, so a future caller cannot open the path with a truthy value.**

**5 new tests, 0 failures.** One of them reads the script and asserts the guard appears **before** the only
call that can reach the fleet — because a test of the pure function alone would pass while the script still
dispatched, **which is precisely the shape of the original defect.**

## [0.47.0] — 2026-10-15

**Correcting my own counts: 0.46.0 said 54/32/22, the table says 61/53/8.**

0.46.0's entry claimed *"**54 rows** across twelve sections"*, *"**32 of 54** rows are executed; **22** are not"*.
**All three numbers were typed by hand, and all three were wrong.** Read from `docs/TEST-MATRIX.md`:

| | 0.46.0 said | the table says |
|---|---|---|
| rows | 54 | **61** |
| executed | 32 | **53** |
| not executed | 22 | **8 never run**, plus **11 blocked**, **1 skipped**, **2 refuted** |

### The cause is that I merged two words that are not the same

**`阻塞` means the command RAN and the environment stopped it. `待执行` means it never ran at all.** I collapsed
both into "not executed" — **and a count that merges two categories is wrong in both directions at once**: it
overstates what was never attempted and understates what was attempted and blocked.

**The matrix now marks `阻塞` as "the command executed" explicitly, and carries a note recording this mistake**,
because the distinction is the one a reader needs in order to tell "we have not tried" from "we tried and were
stopped".

### It is the same error the matrix itself documents, one level up

The matrix's own rule is that **a row's result may only be changed by re-running its `Instance` and reading the
output**, and that a count copied from an older plan becomes more true-looking each time it is copied. **I then
wrote the headline counts of the document from memory instead of reading the document.** The rule was in the
file I was writing.

**So the counts are no longer asserted anywhere by hand.** They are read from the table, and the reading is
recorded: `61 = 39 通过 + 8 待执行 + 11 阻塞 + 1 跳过 + 2 证伪`.

**No new tests.** What changed is three numbers and the reason they drifted.

## [0.46.0] — 2026-10-15

**The test matrix the plans asked for — with every row it could not earn left as `待执行`, and the reason named.**

### Two documents, and the split is the point

`docs/TEST-MATRIX.md` is the **master list**: 54 rows across twelve sections, each with a stable id, what it
checks, its result, a correction date, and the instance that produced the result.

`docs/TEST-LEDGER.md` is the **evidence**: the exact command, exit code and artifact behind each verdict, plus
the vocabulary the matrix refers to.

**The reference goes one way.** The matrix cites the ledger; the ledger never cites the matrix. A summary that
its own evidence cites is a summary that can no longer be checked against it.

### What the matrix refuses to do

**32 of 54 rows are executed; 22 are not, and none of the 22 says "通过".**

**A row may only be filled in from a run whose output was read.** Where a result would have to be inferred —
from a suite that covers the same code, from the implementation, from plausibility — the row stays `待执行`
**and names what would settle it.** Twelve rows cite suite coverage explicitly, labelled as *suite coverage*
rather than as a run of that item, because **"a suite covers this code" and "this item was executed" are
different claims and only one of them is a measurement of the item.**

The 22 unexecuted rows are **not 22 problems.** They collapse into **four blockers**, and two of them are one
command or one machine away:

| Blocker | Rows held | Release condition |
|---|---|---|
| only one executable machine online | 7 | the two `win-desktop` machines, silent since 2026-10-14 |
| the relay cannot be upgraded or restarted remotely | 4 | **one command on `jp-shared`** |
| no usable pairing code | 3 | a pairing experiment, which would disturb the fleet and needs consent |
| a real interruption or an external resource is required | 8 | a real update check; one row needs macOS or Linux |

### Three numbers the matrix now owns, because the plans kept repeating them

| the plans say | measured at v0.45.0 |
|---|---|
| 79 test suites | **82** |
| 2199 tests | **2228** |
| nine aggregate verdicts | **6** |

**A count that is copied from an older plan becomes more true-looking each time it is copied.** The matrix is
now the single place these are read from.

### Two rows are `证伪` rather than `失败`, and the distinction matters

`TC-AGG-003` and `TC-AGG-005` assert **`environmental`** and **nine states**. **Both names are absent from the
code** — the real verdict is `divergent-platform`, and there are six verdicts plus three non-verdict values.

A row marked `失败` would say *"the code is wrong."* These say *"the expectation is wrong"*, which is a
different repair. **A test asserting `environmental` would fail against correct code — the exact path by which
a real check gets disabled, because the runner looks broken rather than the expectation.**

**No new tests.** What changed is that the results now have a home, and the ones that have none say so.

## [0.45.0] — 2026-10-15

**The test plan's security cases, made executable — and the one case that had never been watched run.**

### A coverage gap with an error code and no test

`COMMAND_EXECUTABLE_RELATIVE_PATH` is declared in `allowed-commands.mjs` with a written rationale — *"it names
a different file in every working directory"*. **A grep across all 81 suites returned zero hits.** The refusal
path existed and **no test had ever watched it fire.**

That is the same class of defect as the three uncalled modules this project shipped: **present, documented, and
unobserved.** The difference is that a module has a suite and an error code does not. It now has one, and it
distinguishes the two refusals that are easy to confuse — **an entry that itself names a relative path is
refused as `EXECUTABLE_RELATIVE_PATH`, while a relative `argv[0]` against an absolute entry is merely
`NOT_ALLOWED`.**

### The plan asserted something the code does, and reading alone would not have settled it

The test plan claims `node --test --test-reporter=tap` is **allowed when an entry names it explicitly**, while
`node --test-reporter=tap` (no `--test`) is refused. The suite says the opposite of half of that —
`agent.test.mjs` is titled *"refuses --test-reporter and every other argument that makes node load code"*.

**Both are right, and the mechanism is the one the refusal's own message names:** the reparse refusal fires on
**trailing** arguments of a matched entry, and its remedy is *"an entry of its own"*. So:

* `['node','--test']` **refuses** `--test-reporter=tap` — verified;
* `['node','--test'], ['node','--test','--test-reporter=tap']` **allows** exactly that flag — verified;
* **and still refuses** `--test-reporter=file:///tmp/evil.mjs`, because the second entry pins one value rather
  than opening the flag — verified.

**The line between "a named flag" and "a flag" is the whole security property**, so all three are now asserted
rather than inferred from the refusal's wording.

### The plan's `environmental` state does not exist

`AGG-003` and the plan's nine-state table name **`environmental`**. The project implements
**`divergent-platform`** (`tools.mjs`, `report.mjs`, `fleet.mjs`). **A test asserting `environmental` would fail
against correct code** — the kind of error that gets a real check disabled, because the runner looks broken
rather than the expectation.

### My own error, and it was two errors in one run

Running every suite in **one process** with `--experimental-test-isolation=none` produced **41 failures**;
the project's own entry (`node --test --test-force-exit`, each suite isolated) produced **1**. The other 38 were
**global state from `mdns-discover`'s fetch stub leaking into `outbound-only`** — my harness, not the code.

The 1 real failure was also mine: I bumped the version to `0.45.0` and did not write the CHANGELOG entry, so
`claims` and `CHANGELOG shape` correctly went red. **Both are recorded because the first is the trap worth
naming: a test harness that is not the project's harness measures the harness.**

**10 new tests, 0 failures** by the project's own entry point.

## [0.44.0] — 2026-10-15

**A real dispatch proved the parameter does not yet travel — and the tests that make that checkable.**

### What the end-to-end attempt showed

`cwd_outside_project: true` was dispatched to MacMini with a `cwd_rel` pointing outside its project root.
**The answer was `refusal_reason: CWD_OUTSIDE_PROJECT`** — the guard firing exactly as if the escape had never
been asked for.

**That is the honest result, and it is not a bug in the change.** The relay serving the fleet started
`2026-10-14T13:53:14Z`, and MacMini was restarted *before* 0.43.0 was installed there:

| Component | On disk | In memory |
|---|---|---|
| the shared relay | 0.43.0 | **the code from before this change** |
| MacMini's agent | 0.43.0 | **the code from before this change** |

**So the new field had nowhere to travel through.** Neither process knew the name, so the relay dropped it on
the way in and the agent never saw it. **The refusal is what the old code correctly produces** — and it is also
the second time in two releases that a real dispatch was more informative than reading the code.

### Which is why this release is the tests rather than the feature

The parameter is copied by hand in **four** places, and each is a place it can be dropped:

1. the plugin's payload
2. `createTask`'s explicit task object
3. the `task.created` ledger row — **so a relay restart cannot forget a granted permission**
4. the offer handed to a machine

**This is the shape of the defect that produced the parameter in the first place:** `cwd_rel` was accepted,
normalized, hashed and stored, and then the guard's own refusal was **discarded** — it travelled most of the
way and stopped short, with nothing saying so. **The risk in adding a new field is that it travels the same
distance and stops at the same place.**

So the copies are now asserted against the real relay, and both directions are pinned, **including the
omission**: `false` writes `false` rather than vanishing, so **absence is never ambiguous**, and the check is
`=== true` rather than truthy, because the value arrives over the wire.

The ledger assertion is the one worth naming. A dispatch that runs, a relay that restarts, and a permission
that is **silently gone** would be the worst available failure — the same dispatch refused afterwards with
nothing visibly changed.

### Containment, re-asserted rather than assumed

`resolveProjectCwd`'s guarantee is unchanged: an escape is refused unless asked for, an absolute path is
refused however it is spelled, a sibling sharing a path prefix is refused, and **the escape is reported** as
`outside_project` so a result says where a command ran instead of leaving a reader to assume.

**12 new tests, 0 failures.**

## [0.43.0] — 2026-10-15

**A machine stuck in its own state directory — and the parameter that was accepted, hashed, and ignored.**

### What a deployment test on MacMini actually found

Running the project's own test plan against MacMini produced eight dispatches that all failed, and **none of
them failed for the reason the answers said.** The sequence, and what each answer meant:

| Dispatched | Answer | What it actually meant |
|---|---|---|
| `node --test --test-reporter=spec test/` | `COMMAND_REPARSING_ARGUMENT` | correct refusal — the flag is not on the allow-list |
| `bash -lc "…"` | `COMMAND_NOT_ALLOWED` | correct refusal |
| `node --test <files>` | `exit 1` | **the files were not found** — the test never ran |
| `cwd_rel: "local"` | `status: crashed`, `PATH_INVALID` | **the resolved directory did not exist** |

**`PATH_INVALID` is a warning about a missing EXECUTABLE, and it was reporting a missing DIRECTORY.** Nothing
in the answer said so. Establishing that took every one of those eight dispatches, and the cost was not the
dispatches — it was that **every one of them looked like a test failure.**

### The cause, and it is a configuration default rather than a bug

`bin/w2m-localside.mjs:152` is `const project = flags.project ?? process.cwd()`. A `localside` started
without `--project` takes **its own working directory** as the project root, and the packaged DSH starts it
from `~/.dsh/xclient`. So that machine could run **only inside `~/.dsh/xclient`** — and nothing about the
answer pointed at the cause.

### `cwd_rel` travelled, was hashed, was validated, and was never consumed

`w2m_run` has always accepted `cwd_rel`. The relay normalizes it, folds it into `command_hash`, and stores it
on the task. The agent **resolves** it through `resolveProjectCwd` — and then, when the resolution failed,
**logged a warning and ran anyway with the unvalidated relative path.**

**The guard computed its own refusal and discarded it.** That is worse than no guard, because the guard is
what a reader would cite as coverage.

### The escape is now named, opt-in, and reported

`resolveProjectCwd(root, cwdRel, { allowOutside })` — **`false` unless a caller asks, carried on the offer as
`cwd_outside_project`, and off for every value that is not exactly `true`**, since it arrives over the
wire. The resolved absolute directory is returned as `outside_project`, **so a result says where the command
ran instead of leaving a reader to assume.**

**This does not widen what may be RUN.** The command allow-list, the executable-path check and the
argument-reparse refusal all still apply — **and three of them were observed refusing correctly during this
same session.** It changes *where*, not *what*, and only when asked.

### A guard caught me, and the fix was the name rather than the guard

The parameter was first called `allow_cwd_outside_project`, and `tool-cards.test.mjs` failed on it:

> `w2m_run` declares `allow_cwd_outside_project`, which names an allow-list — **a tool that can set one of
> these widens what the fleet will do, and that decision belongs to an operator editing configuration on the
> machine itself, never to a model**

**It was right to fire, and it was firing on the name rather than the behaviour.** The parameter does not set
an allow-list: **it changes WHERE a command runs, not WHAT may run** — the command allow-list, the
executable-path check and the argument-reparse refusal all still apply, and three of them were observed
refusing in this same session.

**So the guard was left alone and the parameter was renamed** to `cwd_outside_project`. Relaxing a guard that
protects the fleet, in order to land a feature of my own, is the one move this project has consistently
refused — and **a guard that fires on a word is still a guard that made me justify the word.**

### What the session measured about the security controls

Four refusals, all correct, all from real dispatches:

* `COMMAND_NOT_ALLOWED` — `node -e` on a machine whose allow-list omits it, and `bash -lc`
* `COMMAND_REPARSING_ARGUMENT` — `node --test --test-reporter=spec` (a flag not declared) **and** an attempt
  to smuggle `--eval` behind `--test`, which the plugin caught as *re-parseable* rather than as unknown
* `COMMAND_EXECUTABLE_PATH_MISMATCH` — `/bin/sh` where the allow-list names `node`
* `PATH_INVALID` — the one refusal that was **not** a security control, and the one whose message misled

**12 new tests, 0 failures.**

## [0.42.0] — 2026-10-15

**The README catches up with 62 versions — and gathering the numbers found a defect that had survived all of them.**

### The progress section, in both languages

The README's newest version reference was **v0.4.0**, thirteen times, and its install command pinned a
**v0.6.3** tarball. **Thirty-four versions of work had no record in the file a newcomer reads first.**

There is now a **Progress** section (with a matching 进度 section) built from the CHANGELOG rather than from
memory: **62 versions since 0.8.0, 11 tools, 79 suites, 2199 tests, 12 pre-flight checks, 0 failures.** It
carries the three properties the project set out to have, the roadmap's **delivered / partial** state per
version, what the reachability work found, the measured-on-real-machines table, and an explicit **"this is not
1.0.0"**.

**The seven accepted orphans are listed with what would remove each one**, and the **three that are defects are
named as defects** rather than folded in with the four libraries — because the import graph cannot tell them
apart, and only a written reason can.

### `layer-check` printed "clean" and exited 1

Gathering the numbers meant running the checks and reading their output and their status side by side, and two
of them contradicted each other:

```
clean: every cross-layer edge is declared
exit=1
```

**The clean path called `process.exit(1)`.** Every reader that trusts the exit code — a shell, CI, a script,
`&&` — **read a passing check as a failing one.**

**The pre-flight never noticed, and the reason is the interesting part: its own step reads the PRINTED TEXT
rather than the status.** A check can therefore be wrong for a hundred versions while the gate over it stays
green. It now exits `0`, with the failure paths still distinct (`2` for a violation, `3` for unexplained), and
a regression test asserts **the status rather than the message** — because a test that read the message would
have passed against the broken version, which is exactly what happened.

### Also corrected

* the install instructions now say **how to verify you got the version you asked for**, because this
  repository's own profile installed from a pinned tarball and **fell 30+ versions behind**. A successful
  install and a current install are two different things.
* both language halves now name **`pnpm`** as the fallback where `npm` is absent — which is the case in the
  packaged DSH runtime this was tested against.
* one dead in-page anchor, from assuming GitHub's slugger keeps an em dash. It does not.

**2 new tests, 0 failures.**

## [0.41.0] — 2026-10-15

**`field-authority.mjs` has a caller. The correction from 0.29.0 lands, six versions after the claim.**

### What was wired, and the claim it settles

0.29.0's entry said *"the connection now exists."* **It existed inside that module and nowhere else** — the
0.36.0 classification reported the file as an **orphan**, and reading the tree rather than the changelog
confirmed it: `grep 'field-authority' src/` matched **comments and documentation only.**

`w2m_memory` now accepts a received CAT7 block **field by field, at the actor's authority level**, and writes it
as a row in the same JSONL the conclusions use — one store, one rotation, one answer to *"what does this machine
remember."* Measured, all six cases:

```
no level   ok=false  MEMORY_BLOCK_NO_AUTHORITY
level 0    ok=true   accepted=[subject,body] refused=[evidence]
level 70   ok=true   accepted=[subject,body,evidence]
tampered   ok=false  BLOCK_HASH_MISMATCH
no ancestor ok=false BLOCK_MISSING_PARENT
with ancestor ok=true accepted 3/3
```

**A refused field is OMITTED, not set to null** — v4.8.0's first falsifying test, now reachable through a tool.
**An unset level REFUSES rather than accepting the block whole**, because accepting whole is the exact behaviour
field-level acceptance was built to replace, and it would look like success. **A block naming an ancestor the
caller cannot produce is refused, never re-rooted**, because re-rooting turns an unverifiable history into no
history — which reads as a fresh, independent assertion. And **refusals are stored**, not discarded: what a
machine declined to believe is as much a part of its memory as what it took.

### The list policed itself, which is the part worth keeping

`field-authority` was removed from `scripts/accepted-orphans.mjs` **not by a decision to tidy up, but because
the gate went red.** Its stale-entry check fails when an accepted orphan stops being an orphan — so the moment
`tools.mjs` imported the file, the run demanded the acceptance be withdrawn. **Orphans: 8 → 7. Exports: 72 →
65.**

### My own error, and it is the eighth of this exact shape

I inserted the new branch by matching an **anchor string** and never checked **what block that string was
inside.** It landed inside `if (conclusionText !== null)`, so the feature only ran when the caller *also* passed
`record`. Six tests failed, and I diagnosed it by **guessing at return shapes twice before printing them** —
`verifyBlock` and `acceptWithAuthority` were both exactly what I had assumed, and the actual fault was a
scoping mistake three steps earlier.

**Two wrong hypotheses, then one printed value, then ten seconds to the answer.** That is the eighth time in
this span that printing would have been faster than predicting, and the note is here because the pattern has
now survived being written down seven times.

**6 new tests, 0 failures.**

## [0.40.0] — 2026-10-15

**The acceptance document, converged — and bound to the pre-flight so it cannot drift.**

### Three statuses, decided by a checkable rule

Every criterion now carries one of three values, and **the rule decides it rather than opinion**:

| Status | Test |
|---|---|
| **ENFORCED** | delete the thing and run `scripts/preflight.mjs`; it goes red |
| **MEASURED** | something checks and prints, and the run stays green |
| **UNVERIFIED** | nothing checks it, or the check's own documentation says it cannot see this |

**MEASURED is not ENFORCED, and §4 says so with the receipt:** the reachability classifier named **465
exports** and could not tell a defect from a library, so a gate built on it would have been disabled within a
week. **A check that cannot fail is a report.**

**17 criteria are ENFORCED**, including §1.5 — the orphan gate added in 0.39.0. **Six are MEASURED**, of which
two are the ones worth naming: **§1.6, because the classifier cannot classify**, and **§3.10, because
`field-authority` still has no production caller.** **Seven are UNVERIFIED**, and `4.7` is the widest of them —
**the plugin this machine runs is thirty versions behind the source under test**, so every source-level
conclusion about its runtime is void.

### The corrections, kept rather than tidied away

Seven claims were written down in this span, acted on, and later found wrong. **Four of the seven were a claim
about wiring or delivery that a single check disproved:**

* *"v4.8.0 shipped"* — the block and lineage are real; **the authority-driven half was never built.**
* *"the already-shipped rate limiter as its front door"* — **never built.**
* *"**the connection now exists**"* (CHANGELOG 0.29.0, of `field-authority`) — **it exists inside that module
  and nowhere else.**
* *"v4.10.0 shipped in 0.11.0"* — the falsifying tests **are** asserted, and **nothing routed a question to
  it** until 0.37.0.

**Two of the seven were corrected by the same instrument** — the reachability classifier, which was built
*because* the first two had happened, and which then found two more. **That is the only argument for a check
this project accepts: it found something the previous rounds had missed.**

### The document is now checked, because a parallel list is a second source of truth

`test/acceptance-doc.test.mjs` reads the pre-flight's own `DECLARED_CHECKS` and fails if the document names a
gate that does not exist, if any of the three statuses stops being defined, or if the corrections section is
emptied. **A criterion cannot quietly become unenforced while the file keeps claiming otherwise.**

### Three errors of mine, all in the test rather than the subject

* I demanded eight **exact** check names; the document sensibly uses short forms.
* I matched `gate` inside `approval-gate.mjs` and flagged **a filename as a gate**.
* I then demanded the document name `lint` and `mojibake` — **gates on the code's tidiness, not criteria for
  what 1.0.0 must prove.** The document was right not to list them. **A test asserting its own assumption is
  indistinguishable from a test asserting a property, until it fails.**

**6 new tests, 0 failures.**

## [0.39.0] — 2026-10-15

**The orphan gate: a module nothing reaches now fails the pre-flight unless a reason is written down.**

### What checking the remaining loops found — and it corrects a claim I made

0.36.0's classifier reported 86 closed loops and **could not say which were defects**, so it printed and
exited 0. This sorts them, and the result is uncomfortable and precise:

**Eight orphan modules, 72 exports, every one of them written in this span** — and **two were described as
delivered** while nothing ran them.

`approval-gate.mjs` **is** wired: `tools.mjs` imports it, constructs it, and calls `mayRaise` on the raise path.
**`field-authority.mjs` is not.** Reading the tree rather than my own changelog:

```
grep 'field-authority' src/  →  comments and documentation only. Nothing imports it.
```

**0.29.0 said "the connection now exists". It exists inside that module and nowhere else.** That is now
recorded as a correction in `scripts/accepted-orphans.mjs`, in the entry that keeps it on the list.

### A dead branch, found by the test that could not be written

I added **second-order reachability** so that a module reached *through* another could be called a library
rather than an orphan. The test for it failed, and the reason is arithmetic:

> a row is `closed-loop` **only when no source file imports anything from it at all** — which is exactly what
> the `sibling-imported` class already excludes. **So there is never a first-order importer for a second-order
> walk to start from**, and the library case **cannot arise**.

Measured: **72 orphan, 0 library, 14 cli** — and **the zero was a tautology, not a finding.** The library
bucket is removed rather than printed as a permanent zero, and `LOOP_KIND.LIBRARY_UNREACHABLE` records *why*
so the next reader does not re-derive the idea. **Being a library is a claim about intent, and the import
graph cannot carry it — so the claim is made where it can be checked.**

### `scripts/accepted-orphans.mjs`, and why a list rather than a rule

Each accepted orphan names a **reason**, and **what would remove it**. `library` is a design choice;
`interface-unrouted` **is the defect**, kept only because removing it needs a decision about *where* it should
be reached from.

The gate is `checkOrphans` in the pre-flight: **a closed loop is red unless its file is on that list.** The
eight known ones are decisions somebody made; **a ninth fails the run and forces the same conversation.**
A stale entry — one that names a file no longer an orphan — also fails, so the list cannot quietly claim a
problem that is gone.

Four of the eight are marked `interface-unrouted` and said so plainly: `health` (the sensor the user asked for
by name), `log-bounds` (the answer to the 40× log growth, shipped in 0.12.0 and called by nothing), `storage`,
and `field-authority`.

### My own error, the same one as two rounds ago

`await` in a **non-async callback**, caught by `node --check` — **the second time in this span.** The fix is
the same both times: import it up front rather than reaching for it where it is not allowed.

**13 new tests, 0 failures.**

## [0.38.0] — 2026-10-15

**A seven-phase council run on MacMini — real-machine evidence for the tool that had never touched one.**

0.37.0's `w2m_council` was the only substantial addition in this span that had **never run anywhere but this
laptop.** It now has a measurement, and the exit code came from the machine:

```
OK phases=7 outcome=ship dissent=1 reproduced=true      exit 0
```

Driven through `node -e` on MacMini against its own checkout at 0.37.0: the council was convened, roles
assigned, two arguments recorded, two weighted votes cast, the outcome fixed, the decision sealed, and the
sealed decision **read back after the council stopped being advanceable** — with its dissent, its reason, and a
`recount` that reproduced the outcome from the stored ballots. **Every one of those was asserted before the
process was allowed to exit `0`**, so this is not a "did it load" smoke test.

### The same run answered a question that had only been a hypothesis for four rounds

**v4.10.0's council works on MacMini because it reaches for nothing that machine lacks.** `council.mjs` imports
`node:crypto` and `./authority.mjs`, and neither needs `node_modules`. The eight suites that failed there in
0.32.0 therefore failed on **what their fixtures reach for**, not on the modules under test — **a measurement
now, where four earlier releases recorded a guess as a guess.**

It also sharpens the shape of that failure: a suite whose *subject* has no dependencies still fails if the
*suite* imports one, and **from an exit code alone the two are indistinguishable.**

### The sixth time I exceeded the ceiling

The update dispatch — download a release tarball and extract it — **expired**. Measured again, and the number
has not moved: the agent's lease survives roughly **50 seconds** (`heartbeatIntervalMs 10s × missedHeartbeats 2
+ leaseGraceMs 30s`), and an expired lease carries **no exit code at all**, so the work was lost rather than
reported as failed.

**What matters is what happened next:** rather than retrying the download, a **three-line probe** established
that the extraction had in fact completed — **the partial run had succeeded and only the report was lost.** A
retry would have spent another dispatch redoing finished work, and could have raced the `tar` it had left
half-written.

**No new tests.** What changed is a measurement, and a hypothesis that stopped being one.

## [0.37.0] — 2026-10-15

**`council.mjs` is wired. v4.10.0's committee governance is reachable, and its dissent arrives with its decision.**

0.36.0's reachability classification found `src/agent/council.mjs` as a **closed loop** — 275 lines with three
falsifying tests asserted by name, imported by **nothing but its own suite.** This is the eleventh tool and the
fix for the third module of that shape.

### Why the state lives outside the call

A council walks **seven phases across many calls**: `convene → frame → deliberate → vote → decide → record →
adjourn`. One that lived inside a single invocation **could never finish**, and the failure would look like
"the phases are wrong" rather than "the state was thrown away". `createCouncilSessions` holds it — the same
lesson the approval queue and the P2P runtime taught, applied a third time.

Two kinds of state, deliberately capped differently:

* a **live** council is scratch space. Losing one costs the work of returning to that phase, so the cap is
  generous (64) and eviction is **oldest-first**, so a reader can say which survives without reading code.
* a **decided** council is the artifact. `ROADMAP.md`'s third falsifying test is that *"a decision with
  recorded dissent is retrievable with the dissent"* — and **retrievable means after the council that produced
  it is gone.** So the decided cap is larger (256) and decisions outlive live eviction. Tested.

### One tool with an action, not seven tools

The seven phases are **a state machine over one object** and the machine already refuses an operation in the
wrong phase by name. Seven tools would let a model call the wrong one and learn the order from errors; one
tool reports `phase` and the whole `phases` list on **every** call, so the legal next move is visible rather
than inferred. A `CouncilRefusal` comes back as a **value** — `ok: false` with the phase and the list — not as
a throw, for the same reason.

**A tie is refused, not broken**, and the tool does not paper over it: a split council is the one case where
the council exists to escalate to a person.

Every read of a decision returns the **dissent with its reasons** and a **`recount`**, so the seal never has
to be taken on trust.

### My own error, and the fix is a pattern rather than a correction

My test helper reached the `deliberate` phase by **counting advances**, got the count wrong by one, and failed
with a `WRONG_PHASE` refusal that **read like a defect in the module**. Measured order:
`convene → frame → deliberate → …`, so `argue` needs **two** advances and not one. The helper now **names its
destination** — `advanceTo(council, 'deliberate')` — because **one that counts steps drifts silently when the
phase list grows, and one that names a destination cannot.**

28 tool-count assertions updated across nine files, the whole set that has caught this every time.

**13 new tests, 0 failures.**

## [0.36.0] — 2026-10-15

**The classification found a third closed loop — and it is `council.mjs`, which `ROADMAP.md` marks shipped.**

### What the classifier does that a regex cannot

468 findings against this repository, and the one real defect in them was invisible. Refining the pattern
cannot fix that: **the information is not in the name, it is in the shape of the import graph.**

The shape that identified the two known defects was — **one export, one importer, and that importer is the
test named after the module.** That is not a heuristic about naming; it is a statement about the graph: **a
module whose only importer is its own suite exists in a closed loop, and nothing in the program reaches it.**
The name is used only to decide whether the loop is *closed*.

Against this repository: **316 `sibling-imported`, 91 `closed-loop`, 61 `same-module`.**

**91 is not a defect count and the classifier says so**, in three tests that pin its own limits rather than
commenting on them: it cannot see a **dynamic import** (`await import('./x.mjs')` names no binding), and it
cannot see a module reached only because a **CLI entry point spawns it** — which is every file in `scripts/`,
and is why that number is large.

### `v4.10.0`'s council is BUILT, NOT ROUTED

`src/agent/council.mjs` is a closed loop: **275 lines implementing committee governance, imported by nothing
but its own suite.** `ROADMAP.md` marks v4.10.0 *shipped in 0.11.0*, and 0.30.0 verified its three falsifying
tests are asserted by name — **which they are.** What was never checked is whether anything routes a question
to it. **Same defect as `field-authority` and `approval-gate`, in a third module**, and the one the
reachability work existed to find. Recorded as **built, not routed**, and routing it needs a tool surface and
a session rather than a line of code.

### A duplicated limit, found by reading the file to check the first finding

`council.mjs` declared its own `export const AUTHORITY_MAX = 100` instead of importing the bound from
`authority.mjs`. **Two copies of a limit that nothing can keep in step, and the failure is silent**: raise the
real maximum and this module keeps refusing `101` while naming the wrong number as authoritative. It now
imports it, and `AUTHORITY_MAX` has exactly one literal definition in `src/`.

**Reading the file to check the wiring finding is how the constant surfaced** — the argument for investigating
a report rather than counting it.

**10 new tests, 0 failures.**

## [0.35.0] — 2026-10-15

**§1.5 measured at last: the reachability report, and the honest reason it is not a gate.**

`docs/1.0.0-ACCEPTANCE.md` §1.5 recorded that **nothing** measured whether an export is reachable. Three
mechanisms shipped in this span fully tested and completely uncalled — `field-authority.mjs`,
`approval-gate.mjs`, `createApprovalIndex` — and **a tested mechanism with no caller is indistinguishable from
a finished feature** by reading either the tests or the source.

`scripts/reachability-check.mjs` measures it.

### The first version was unusable, and the false positive that proved it

It asked *"which files mention this name"* and reported **378 findings**, almost all false. The clearest:
`deepEqual` from `src/relay/state.mjs`, which appeared to be named by **69 test files** — every one of them
calling `assert.deepEqual`. Whole-word matching cannot tell an imported binding from a coincidental name.

**An import is a statement about two things at once — a module and a name — so matching on the name alone
throws away half of what the source says.** The check now reads both and matches on the pair:

```
importedNames(text)  ->  module specifier -> imported names
resolveSpecifier()   ->  the file that specifier names, the way Node resolves it
```

### Why it exits 0, which is the part worth defending

Measured against this repository it names **465 exports**, and it **cannot tell three kinds apart**:

1. **the defect** — built, tested, never wired;
2. **a deliberate surface** — the plugin's entry points and re-exports;
3. **composition** — a capability reached only through another module's use.

Only the first is a finding, and no static name-and-import check separates them. **A check that fails on 465
things nobody will fix is a check that gets disabled within a week — and a disabled check is worse than none,
because it is cited as coverage.** So it prints, exits 0, and closes with *"READ THIS AS A LIST TO TRIAGE, NOT
A LIST OF BUGS."*

**§1.5 is therefore measured, not closed.** A defect of this class is now *visible*; nothing fails when one
appears. The tests build synthetic trees where ground truth is known, because asserting on the real 465 would
pin noise.

### Three of my own errors, and one of them is the lesson of this whole span

* My re-export exclusion looked for ` from ` **inside** the captured braces, so it never saw it —
  `export { X } from './y.mjs'` was counted as a definition. **The test failed because the code was wrong.**
* I expected `b` in an export list where the source says `b as bee`. The implementation was right.
* **I "fixed" that by sorting my own guessed array.** Sorting a wrong list does not make it measured — and
  that is the same mistake, in miniature, that this project has now paid for six times: **predicting what the
  output is instead of printing it.** The fix was to print it.

**16 new tests, 0 failures.**

## [0.34.0] — 2026-10-15

**`requireAuthorityLevel`: the policy that makes 分权限 real, and why it is a flag rather than a default.**

`docs/1.0.0-ACCEPTANCE.md` §3.11 recorded the gap plainly — the gate is **off unless configured**, so a
default install dispatches exactly as it did before the permission model existed, and **"off unless
configured" cannot be part of a 1.0.0 that claims 分权限.**

`requireAuthorityLevel: true` (or `W2M_REQUIRE_AUTHORITY_LEVEL`) closes it for a machine that asks. Measured,
the whole truth table:

| `requireAuthorityLevel` | level | result |
|---|---|---|
| off | unset | **starts**, gate unenforced |
| off | chosen | starts, gate enforced |
| **on** | **unset** | **refuses to start** — `AUTHORITY_CHOICE_NOT_CHOSEN` |
| **on** | **unusable** | **refuses to start** — `AUTHORITY_CHOICE_UNKNOWN` |
| on | chosen | starts, gate enforced |

A refusal names the four choices, so it is fixable from the message alone, and a machine that opted in says
so in `w2m_status` — a reader can tell "asked and answered" from "never asked".

### Why opt-in, which is a deliberate limit rather than a hedge

Refusing unconditionally would be the honest reading of *"a permission system that is off is untested in
production"* — and it would also **stop every machine running an earlier version the moment it upgraded**,
because none of them has a level. That trade is one silent failure for a loud outage, and **an outage is not
a security property.**

**So the gap is narrowed, not closed, and the document says so** rather than letting the flag's existence
imply otherwise. A fleet that never sets it is exactly as unenforced as before.

### `W2M_REQUIRE_AUTHORITY_LEVEL=0` means off

Asserted, because a truthiness test would read the string `"0"` as set-and-therefore-on and **refuse to start
a machine whose operator explicitly wrote zero.**

### My own errors, both of them syntax rather than logic

* I wrote `await` inside a **non-async arrow** passed to `assert.rejects`, which does not parse. `node --check`
  caught it immediately; the fix is to compute the state directory first, because making the arrow async would
  change what it does.
* I asserted refusal codes against the **message text**; the codes live on `error.reason_code`, which is the
  field a consumer branches on. **The code was correct and the assertion was looking in the wrong place** —
  now it pins the field.

**6 new tests, 0 failures.**

## [0.33.0] — 2026-10-15

**The authority level is chosen by name. Nobody types a number.**

`actorAuthorityLevel` is an integer in `0..100` whose four bands have names and gaps. Asking a person to type
it asks them to hold all of that in their head, and **getting it wrong fails silently**: `69` and `70` look
equally arbitrary and land in different bands, so a machine configured one point low **refuses a dispatch it
should have run and never says a threshold was the reason.**

`src/agent/authority-choice.mjs` turns the number into a choice:

| Choice | Level | What picking it permits |
|---|---|---|
| `ordinary` | **0** | create goals and session data within its own scope |
| `captain` | **50** | create team goals, manage team membership |
| `org_admin` | **70** | create organisation goals, register actors, set overrides |
| `system_admin` | **90** | create global goals, configure across organisations, override any lower constraint |

The options are **built from `AUTHORITY_BANDS`**, so a band added to the model appears here without anybody
remembering — and a band cannot be described in two places differently.

### A name resolves to its band FLOOR, and the consequence is stated

The floor is where the band's own description becomes true, and it is what `bandOf` answers with. Resolving to
a midpoint would mean **a choice labelled "captain" silently granting more than captain.**

The practical consequence is worth writing down because it decides what a machine may do: **`ordinary`
resolves to `0` and `dispatch_writing` costs `50`, so a machine whose operator picks "ordinary" cannot
dispatch a write at all** — it escalates and an approver must answer. Measured, all four:

```
ordinary     level   0  ->  write dispatch: needs_approval
captain      level  50  ->  write dispatch: allow
org_admin    level  70  ->  write dispatch: allow
system_admin level  90  ->  write dispatch: allow
```

### Two vocabularies, and two different callers

**A number is refused by the selector**, because a selector that also accepts integers is a text field with a
helpful hint and every reason above applies again. **A number is accepted by the config**, because a profile
patch written by an earlier version must keep loading — and breaking every existing machine on upgrade is a
worse failure than accepting a number from a file nobody is looking at. The two rules are stated in one place
and tested against each other, including that the selector refuses `'captain '` while the config trims it.

### A misconfigured level no longer degrades in silence

`w2m_status` now reports `actor_authority` — whether it resolved, from which vocabulary, and **why not when it
did not, with the four choices attached**. A level that failed to parse used to become `null`, which reads
exactly like a machine that never chose one, and **those two need opposite responses.**

### Three of my own errors

* I asserted `UNKNOWN` for the integer `70`; it is `NOT_A_STRING`, because the codes distinguish "a number was
  given" from "a string that did not match" — **on purpose, so a caller can message them differently.**
* I reused the selector's message in the config resolver, so a config author was told about names only while
  **that function's own contract promised numbers too.** The implementation was changed, not the test.
* My captain test asserted success and instead reached the network, because it installed no fetch stub. **That
  failure was the proof**: it did *not* throw `W2M_PERMISSION_*`. The assertion now checks the kind of failure
  rather than the absence of one, which is what the test was always about.

**18 new tests, 0 failures.**

## [0.32.0] — 2026-10-15

**Widening real-machine verification: eight suites tried, none passed, and the cause is a hypothesis.**

### What was measured

The eight suites dispatched to MacMini all returned **non-zero there while passing here**. The packed code
that reported this was at times ambiguous, so the run was repeated with a simpler encoding — **one bit per
suite, exit 0 or not** — and that is unambiguous: **the packed result was `0`, meaning no suite passed.**

### What was NOT measured, and is therefore not claimed

The likely cause is a **missing `node_modules` on that machine** — the suites import from `src/`, and some of
those modules reach for a dependency. **That was not established.** It is a hypothesis, and this release
records it as one. The acceptance document now says so in a row of its own rather than in a footnote.

### Five dispatches spent on a channel that carries eight bits

The attempts, in order, and what each one actually answered:

| Attempt | Question asked | What came back |
|---|---|---|
| 1 | four suites, two bits each (status + reason) | 8 bits, but the tail truncated — **unreadable** |
| 2 | eight suites, three bits each | 24 bits packed into 8 — **arithmetically impossible, and it returned 0** |
| 3 | re-read the saved outputs | the parse matched nothing, because it guessed Node's summary format |
| 4 | eight suites, one bit each | **`0` — no suite passed. Unambiguous.** |
| 5 | print the environment facts | ran to completion, **and stdout is not visible through a dispatch** |

**Every one of those was the same mistake**: asking a channel more than it carries, then reading the
truncation as an answer. `exit code` is one byte, and the correct instinct — already written into
`machine-test-packet.mjs` and ignored here — is to ask **one bit per suite and nothing else**.

`--inline` was added to that script so its loop can be delivered as a `node -e` one-liner, because a real
machine's allow-list **admits `node -e` and refuses `node scripts/…`**. The generated command is 486 characters
and self-checks locally. **Its stdout is still invisible through a dispatch**, which the docstring now says
plainly: the inline form is useful when the packed code is enough, and **when it is not, the answer is one
command run by a person rather than a cleverer encoding.**

### What is unchanged

**Two of the three decisions the user made are not in this release.** The authority-level *selector* — the
request that the level be **chosen rather than typed** — is not built, and the permission gate remains
**off by default**, which §3.11 of the acceptance draft still records as incompatible with claiming 分权限.

**No new tests.** The suites that exist all still pass; what changed is a measurement and a docstring.

## [0.31.0] — 2026-10-15

**The approval gate got a caller, and a draft acceptance definition for 1.0.0.**

### The defect this round started by finding, in the release that had just criticised it

`approval-gate.mjs` shipped in 0.30.0 with a full suite and **no caller** — which is exactly the shape of the
two defects 0.30.0 had just finished writing into `ROADMAP.md`. **Building a mechanism and wiring it are
separate acts**, and a mechanism with no caller cannot be told from a finished feature by reading either the
tests or the source.

It is now on the raise path, and the wiring is asserted rather than described: a real dispatch raises once,
the queue holds one request, a second raise is **refused by the front door before a request exists**, and the
queue still holds exactly one. Two more tests pin the asymmetry — reading the queue five times past any raise
budget, and settling the request — because a gate that also metered *those* would pass a flooding test and
quietly break the queue.

`approvalRaiseLimitPerMinute` is configurable so a host can set it and so a test can reach the refusal without
raising thirty requests first. Unset, the gate's own default governs.

### `docs/1.0.0-ACCEPTANCE.md` — a draft for objection

The goal names **分模块 / 分层级 / 分权限**, and a version number means nothing without a definition that can
fail. The draft lists 21 criteria across the three, each with **where it is checked and whether that check is
actually running**, under one rule: **a criterion nothing measures is not a criterion.**

Its two honest admissions are the point of writing it:

* **§1.5 — reachability is NOT checked.** Three mechanisms shipped fully tested and completely uncalled in
  this span. The `claims` suite catches *documentation* drift and **cannot** catch this, because the document
  and the code can agree while neither is reachable.
* **§3.11 — the permission gate is OFF by default.** An unset `actorAuthorityLevel` means `enforced: false`
  and no change, so **a default install dispatches exactly as it did before the permission model existed.**
  Treating unset as `0` would break every machine that never opted in, so the current behaviour is defensible
  — but **"off unless configured" cannot be part of a 1.0.0 that claims 分权限.** The draft puts the choice to
  a reader rather than resolving it: **require a level and refuse to start without one, or ship with the gate
  off and say so in the README.** Silence is the one option that is not defensible.

It also records what is **not** claimed: no scale statement (3 usable machines of 5), no restart durability for
the queue, no MacMini verification beyond the four suites measured in 0.28.0, and `P2P_PUNCH_FAILED` still
UNVERIFIED.

**2 new tests, 0 failures.**

## [0.30.0] — 2026-10-15

**The same ruler on the other two entries: v4.9.0 had the same defect, v4.10.0 did not.**

After 0.29.0 found that v4.8.0's *"driven by the authority model"* was a phrase rather than a mechanism, the
next two ROADMAP sentences were checked the same way rather than assumed sound.

| Entry | Claim | Verdict |
|---|---|---|
| v4.9.0 | cross-session pending-approval index | **real**, substantial |
| v4.9.0 | **"with the already-shipped rate limiter as its front door"** | **never built** |
| v4.10.0 | ordered phases, a phase cannot be skipped | **real**, asserted by name |
| v4.10.0 | weights reproducible from stored inputs | **real**, plus tamper detection |
| v4.10.0 | dissent retrievable *with* the decision | **real**, and the dissent is inside the seal |

Measured for the missing half: **`approval-index.mjs` imports `authority.mjs` and nothing else** — no
limiter, no window, no cooldown anywhere in the file — while the shipped `SlidingWindowRateLimiter` sat in
`relay/server.mjs` with **no approval caller**. Two entries, one defect, and the third entry was genuine:
**the pattern was not assumed, it was tested.**

### `src/agent/approval-gate.mjs`

**It limits raising and nothing else.** That asymmetry is the design:

* limiting the **view** would limit *knowing what is waiting*, which is the one thing the queue exists for;
* limiting **settling** would punish the supervisor clearing the backlog — a limit there is a limit on fixing
  the problem;
* **raising** is the surface, because the threat is not brute force but **queue flooding**: an agent in a
  retry loop can raise hundreds of requests and drown out the work that needs attention.

Two more decisions worth naming:

* **The key is an identity, not an address.** A fleet's agents frequently share a host, so an address-keyed
  budget would apply one allowance to everybody on it — refusing the well-behaved because a neighbour
  misbehaved. An anonymous caller gets a **shared named budget rather than none**, because *"no id, no key, no
  limit"* would make forgetting to identify yourself the way to escape the limit.
* **The default is not the pairing limit.** `DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE` is 5 because pairing is rare
  and a wrong guess is an attack; raising approvals is ordinary work done in bursts. Inheriting a number built
  for a different threat would have been the easy mistake.

It composes the shipped `SlidingWindowRateLimiter` rather than writing a second sliding window — the roadmap's
word was *"already-shipped"*, and two windows in one codebase are two chances to disagree about what a minute
is. A test asserts the composition.

The absence of `mayList` / `maySettle` / `mayDecide` is asserted **as an absence**, because their presence is
the defect and a test about flooding would never notice them.

### One error of mine

I looked for the "shared anonymous budget" wording on the **refusal**; it is on the **allow** branch, which is
where a caller learns which budget they are spending from. The implementation was right and the assertion was
in the wrong half — seventh time in this project, and the same remedy worked: measuring instead of predicting.

### The layer checker refused my first version, and it was right

Importing the limiter from `relay/server.mjs` made an **`agent` module depend on the `relay` layer**:

```
relay -> util is not in ALLOWED_EDGES (undeclared)   ← after the first fix attempt
agent -> relay                                        ← the original refusal
```

`agent` is rank 2 and `relay` is rank 3, so that edge **points up**. The tempting fix was to add
`['agent', 'relay']` to the allow-list, which would have **legalised an inversion**. The right fix was to
notice that `SlidingWindowRateLimiter` **never used anything from the relay** — it holds a `Map` and reads a
clock — so it belonged in `util` (rank 0, a leaf) all along.

The move cost nothing at runtime, and that is measured rather than assumed: **the relay's own construction
site already passed `limit` explicitly**, so the class's defaults had never been used. Its `limit` is now
**required** instead of defaulting to `DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE` — keeping that default would mean
this leaf importing a relay constant, **the same inversion one level down**.

Two edges are declared, both downward: `['agent', 'util']` and `['relay', 'util']`. The layer model is now
`clean: every cross-layer edge is declared`.

### Two more of my own errors

* `export { DEFAULT_WINDOW_MS as RATE_LIMIT_WINDOW_MS } from '...'` **re-exports without creating a local
  binding**, so the relay's constructor threw `RATE_LIMIT_WINDOW_MS is not defined` while the module's public
  surface looked perfectly correct. **106 tests failed at once**, which is how it was found.
* I looked for the "shared anonymous budget" wording on the refusal; it is on the allow branch.

**12 tests, 0 failures**, and 197 across the five affected suites.

## [0.29.0] — 2026-10-15

**v4.8.0 was half shipped, and the ROADMAP said otherwise. The missing half is now built.**

### What the check found

`ROADMAP.md` described v4.8.0 as *"a CAT7 seven-field cognitive block, **per-field acceptance driven by §2's
authority model**, and lineage"* and marked it **shipped in 0.9.9**. Reading the tree instead of the sentence:

| Claim | Verdict |
|---|---|
| CAT7 seven-field block | **real**, asserted |
| lineage, with a missing parent refused rather than re-rooted | **real**, asserted |
| a refused field *absent* from the stored block rather than null | **real**, asserted |
| **"driven by §2's authority model"** | **never built** |

Measured: **`src/agent/blocks.mjs` did not import `authority.mjs` at all**, and `defaultChoose` — the only
chooser that shipped — refused `confidence` by name and accepted everything else. **A roadmap sentence is a
claim, and this one was checkable in a single grep.** It stood for several releases because nothing tested the
sentence itself.

### `src/agent/field-authority.mjs`

Per-field acceptance now goes through `authority.evaluate`, so the two models cannot drift into different
notions of what a rule is. Three refusals apply in a fixed order:

1. **not a CAT7 field** — before any rule, because a rule cannot make a field exist;
2. **no declared rule** — refused, never granted and never escalated;
3. **the authority verdict** — `allow` accepts, anything else refuses with the model's own reason.

**A field with no declared rule is refused**, which is the same decision `authority.mjs` already states for
exemptions and `permission.mjs` states for capabilities. Three modules, one rule, because the failure mode is
identical: **a table that grants what it has not heard of grants whatever is added next.**

### The three inherited fields are deliberately undeclared, and that is not dead policy

Measured: the chooser is asked about `subject`, `body` and `evidence` — **never** `origin`, `observed_at` or
`lineage`, because `acceptBlock` copies the inherited three directly. A rule for them would read as policy
while doing nothing, so they are left out and `acceptField` reports them `UNDECLARED`. A test asserts a rule
can never be added for them by accident.

`confidence` is refused **at every level including `AUTHORITY_MAX`**, because if it were merely expensive a
system administrator would be *permitted by this model* to adopt the sender's own certainty about the
sender's own assertion.

### Four of my own errors, and how each surfaced

* I invented `scope_claim` and `meaning` as field names. **Neither exists** — the real seven are `origin`,
  `subject`, `body`, `evidence`, `confidence`, `observed_at`, `lineage`. My "undeclared field" test was
  therefore testing `NOT_A_FIELD` and passing for the wrong reason; the fields that are genuinely
  governed-but-undeclared are the three inherited ones.
* I asserted `accepted_fields` held only the receiver's two, when it also carries the three inherited ones.
* I asserted one chooser ruling per choosable field; there are **three, not four**, because `acceptBlock`
  hard-codes the `confidence` refusal and `continue`s **before** calling the chooser.
* `observed_at: 'T'` is not an ISO timestamp and `makeBlock` refused it — **the block layer was right and my
  probe was wrong**, which is the sixth time in this project that a failing test was the test's fault.

Every one of the four was found by **measuring the real behaviour** rather than by reading the source and
predicting it.

**17 tests, 0 failures.**

## [0.28.0] — 2026-10-15

**First real-machine verification of the recent work, and a tool that packs four answers into one exit code.**

### The measurement

The MacMini's checkout was updated to 0.27.0 and its own suites run there, with **the exit code produced by
that machine** as the evidence:

| Suite on MacMini | Result |
|---|---|
| `permission.test.mjs` | pass |
| `fleet-scale.test.mjs` | pass |
| `fleet-state.test.mjs` | pass |
| `crypto-blake2s.test.mjs` | pass |

Those four cover the code written in this span — the permission gate, the fleet arithmetic, the endpoint
reconciliation, and the crypto capability report. This is the goal's "verify on the real machine with exit
codes and artifacts" satisfied for that body of work, rather than inferred.

### `scripts/machine-test-packet.mjs`

A dispatch carries **one** exit code, so running four suites in one `node --test` answers only "did anything
fail". This packs **two bits per file** into a single byte: `10` passed, `01` failed, `00` absent, `11`
not measured. **`00` is distinguished from `01` on purpose** — "the file is not on this machine" is a
deployment finding, "the file ran and failed" is a code finding.

**Four dispatches were spent on this channel before the tool existed, two of them on my own misreadings:**

* a TAP parser matching `^ok ` that counted **nothing**, because Node indents its subtests. It returned
  `pass 0 fail 0` and I nearly read that as "no tests ran".
* a summary regex that matched nothing, so the exit code described **my parser** rather than the code under
  test.

Both were the same mistake in different clothes, and it is the mistake this project keeps making: **assuming
the shape of output instead of reading it.**

### Three defects in the tool itself, all caught by its own suite

* **The docstring claimed "zero is the all-clear", and that is false.** One passing file is `2`, four are
  `170`. **Zero means every file was ABSENT** — a total deployment failure the old claim would have had a
  reader take as a clean run. `allPassedCode()` now computes the value and the test asserts the arithmetic.
* **The guard against emitting `126`/`127` was never reached** by the inputs I guessed. Enumerating the whole
  two-bit space found the only two combinations that land on a shell-owned value
  (`[PASSED, WAITED, WAITED, FAILED]` and `[WAITED, WAITED, WAITED, FAILED]`).
* **The reassuring message was unreachable**, because it tested `code === 0` rather than the outcomes.
  `packOutcomes([])` returns `0`, so the one code that reads as success was attached to the one input that
  measured nothing.

### The budget, and the fifth time I hit the same ceiling

The first version took a 40-second timeout **per file** and ran four files: a 160-second worst case against
this fleet's **~50-second lease ceiling** (`heartbeatIntervalMs 10s × missedHeartbeats 2 + leaseGraceMs 30s`).
It **expired** on the real machine, and an expired lease carries **no exit code at all** — so the measurement
was lost rather than reported negative. That is the fifth time in this project that a dispatch was built
without respect for the ceiling.

The fix is a **total budget** (`DEFAULT_BUDGET_MS`, 30s) with a per-file cap, and files that miss their turn
are named `WAITED` rather than dropped — a packet that quietly omitted the last file would look like a clean
run of the ones it managed. A per-file timeout answers "is this file hung"; only a total budget answers "will
the answer survive the trip".

### What the real machine refused, which is a finding and not a bug

`node scripts/machine-test-packet.mjs ...` came back **`COMMAND_NOT_ALLOWED`**. The MacMini's allow-list
admits `node -e` and `node --test`; it does not admit an arbitrary script path, and the packet **spawns
`node --test` internally**, so it would be refused a second time. The tool is correct and tested; it needs an
allow-list entry to run there, and **that is a change nobody has made.**

**11 tests, 0 failures.**

## [0.27.0] — 2026-10-15

**A blocked fleet reports itself. The approval count is in `w2m_status`, and it arrives as a note.**

A queue visible only to someone who remembers to look at it is a queue that stays full, and **a fleet blocked
on approval looks exactly like an idle fleet.** `w2m_status` now carries an `approvals` block and, when
anything is waiting, a note placed **first** — ordering being the only emphasis a list of notes has:

> *"3 dispatch(es) are WAITING FOR AN APPROVER and will not run until one answers; read them with
> `w2m_approvals` (1 past their deadline); the oldest has been waiting 240s"*

### `constructed: false` is not `pending: 0`

A machine that has never tripped the permission gate should not be described as having an empty queue **as
though that were a measurement.** The block says which it is, and the note is emitted only for real pending
work.

### The whole chain, across three tools, asserted end to end

An ordinary actor (49) attempts a write → refused with `W2M_PERMISSION_NEEDS_APPROVAL` **carrying the queued
id** → `w2m_status` reports `pending: 1` and the blocking note **without being asked about approvals** → a
captain settles it → the signal clears.

### The default approver is the requester, and the index says so

The test discovered this rather than assuming it: a request records its subject as the machine's name, and an
approver who **defaults to that same name is the subject** — so `may_act` is false with
`APPROVAL_SELF_APPROVAL`. That is correct, and it is a real consequence of the defaults rather than a bug. The
test now names a distinct approver and **asserts the refusal first**, so the self-approval rule is pinned
rather than sidestepped.

### A payload silently dropped, caught by a test that found nothing

`W2MError` accepts only `code`, `message`, `hint`, `detail`, `cause` and `reason_code`. The first version
passed `approval_id` and `request` as **top-level options**, so they were **discarded without complaint** and
the refusal told a caller to await approval **with no way to name what they were waiting for.** They now
travel in `detail`, and the constructor's accepted keys are named in a comment beside the call.

Two of my own errors in this round were the same shape as the ones before it: a block hoisted into the **wrong
scope** (module level instead of inside `execute`, which `node --check` accepted because the name existed
*somewhere*), and a syntactic fix that put a statement **inside an object literal**. Both were caught by
running the suite, not by reading.

**1 new cross-tool test, 0 failures.**

## [0.26.0] — 2026-10-15

**`w2m_approvals`: the approval chain is reachable by an operator, not only by the suite.**

The tenth tool. `action: "list"` reads the queue, `approve` and `reject` settle one request by `approval_id`.
Until now the chain from 0.25.0 was **closed in code and testable end to end while no operator could reach
it**; this is the tool that opens it.

### Every row says whether *you* may act, and why not when you may not

A list filtered to what the caller may answer would be shorter and would **make the fleet look idle at the
moment it is most blocked.** `listFor` already returns each row with `may_act` and `why_not`; the tool passes
them through instead of hiding work above the caller's authority.

### `actor_level` is a parameter, and that is deliberate

The machine's own `actorAuthorityLevel` says what it may **dispatch as**. An approver's level is a fact about
the person answering, and a decision made on the dispatcher's level would let a machine approve its own
escalations. Passing it explicitly is what keeps `APPROVAL_SELF_APPROVAL` meaningful rather than incidental.

**Settling without a level is refused** (`W2M_APPROVAL_LEVEL`) rather than defaulted, so a decision is never
attributed to a level nobody supplied. Listing **without** a level still works and says so: `level_known:
false`, with a note explaining that the queue is visible but whether any of it is answerable is not known —
**knowing what is waiting does not require the authority to answer it, and a queue only its supervisors can
see is a queue that stays full.**

### The note on every settle, because a reader will assume otherwise

> *"the request is settled; the dispatch did not run and must be attempted again"*

Approval means the next attempt is allowed, not that anything already happened. A tool that settled quietly
would leave its caller waiting for a result that is never coming.

### Three defects of mine, all caught by the suite or by checking

* I called a `json(...)` helper **that does not exist in this file** — every tool returns `JSON.stringify(...)`.
  `node --check` passed, so only reading the surrounding code found it.
* I referenced `AUTHORITY_MAX` without importing it.
* I omitted `presentCall`, which `ALLOWED_DEF_KEYS` requires and which the registration-shape test pins. It now
  labels a list as a `read` and a settle as a `write`, because **calling a queue inspection a write would
  misrepresent the common case.**

Four tool-count assertions said "exactly nine" and named the nine; they now say ten and name the ten. The
comment beside one of them already recorded the lesson from a previous version — that a **count** was once the
wrong property and the **message** was the right one. This time the count *was* the property.

**7 new tests, 0 failures.**

## [0.25.0] — 2026-10-15

**The chain is closed: dispatch → gate → queue → decision. The plugin builds a queue, and an escalation is a real entry an approver can find.**

### The queue belongs to the plugin, not to the call

`apply()` now constructs **one** `createApprovalIndex()` for the plugin's lifetime, lazily. A queue built at
the call site would be **empty every time**, so a request raised by one dispatch could never be found by the
decision that answers it — **it would look wired and behave as if it were not.** Same reasoning as the P2P
runtime beside it: something that must outlive a single call belongs to the plugin.

### Measured, end to end, before it was written down

| Step | Result |
|---|---|
| an ordinary actor (49) asks to write | `needs_approval`, `enforced: true` |
| the request is raised | `ok`, id issued, `subjectLevel` **49** |
| a captain (50) lists the queue | `may_act: true`, `required_level: 50` |
| a peer (10) lists the same queue | **sees it**, `may_act: false`, `APPROVAL_INSUFFICIENT_AUTHORITY` |
| the captain settles it | `ok` |
| after settling | `approved`, **`subjectLevel` still 49** |
| the requester approves their own request | **`APPROVAL_SELF_APPROVAL`** |

The fourth row is the one worth naming: **a peer can see work that is above their authority and is not theirs
to answer.** A filtered list would make the fleet look idle at the moment it is most blocked.

### A queue that refuses is not a queue that needs approval

If `raiseApproval` fails, the dispatch is refused with **`W2M_PERMISSION_APPROVAL_NOT_RAISED`**, a different
code from `W2M_PERMISSION_NEEDS_APPROVAL`. A caller told "await approval" for a request that was never stored
would **wait forever for a decision nobody can make.**

### Still true, and stated rather than glossed

The dispatch still **does not run** when approval is required — an escalation is a request to be allowed, not
a permission. There is **no tool yet for an approver to settle a pending request**; `decide()` exists and is
exercised by the suite, and wiring it to a tool is the next step. So the chain is closed in code and testable
end to end, while remaining **unreachable by an operator in the running plugin.**

### My probe was wrong before the code was

The first end-to-end run threw on `listFor(...).requests.length`. `listFor` returns a **row array**, not an
object with a `requests` field. **The code was right; my assumption about a shape I had not read was wrong**
— the fifth time in this project, and the same failure as the parse-prefix mistake early on.

**3 new chain tests, 0 failures.**

## [0.24.0] — 2026-10-15

**The escalation reaches the approval index — and the bridge between them is where the defect would have been.**

Two shapes that look alike and are not:

| `approvalRequestFor()` produces | `index.register()` wants |
|---|---|
| `subject_level` (flat) | `subject: { id, level }` (nested) |
| `capability` | `action` |
| `task_id`, `requested_by` | `sessionKey`, `subject.id` |

A caller hand-mapping these at the call site would get it right once and wrong later, and **the failure would
be a request registered against the wrong subject — the one field the whole decision rests on.** So
`raiseApproval()` owns the mapping and lives beside the thing it maps from.

### It does not smooth anything over

`register()` refuses a subject level that is not an integer 0..100, and the adapter **passes the index's own
`reason_code` and `detail` through unchanged**. A bridge that substituted a default level to make registration
succeed would be **inventing the single fact the approver's decision rests on, and would look like success
while doing it.** Tested directly: a request whose level is `'captain'` is refused, and the queue stays empty.

The `approvalId` is **required from the caller, not generated here**, because an id invented at this layer
could not be correlated with whoever is waiting on the decision.

### The end-to-end property is asserted, not described

A real `createApprovalIndex()` is constructed in the suite and an escalation is raised into it: the request
appears in `index.all()`, `subjectLevel` survives the mapping as `49`, and after an approver at level 50
settles it, **the subject level is still 49** — settling must not rewrite it.

### Two of my own errors, both caught by the suite rather than by reading

* I asserted `INDEX_NO_SUBJECT_LEVEL`. The value is `APPROVAL_NO_SUBJECT_LEVEL` — **every code in
  `INDEX_REFUSAL` carries the `APPROVAL_` prefix.** The implementation was right and had passed the index's
  own code through faithfully, which is exactly what the test was there to check. The assertion now reads the
  value **out of the table** so it cannot drift again.
* The generator script's escape handling produced a stray `$` inside a template literal in a *failure message*,
  which threw at runtime rather than at parse time. Caught by running the suite, not by `node --check`.

### Still not wired to a live queue

`createApprovalIndex` has **no caller in the plugin** — it was built in 0.10.0 and is exported from
`approval-index.mjs` alone. This release makes the gate and the index meet **on a real object**, with an
end-to-end test, but no dispatch path yet constructs a queue. So `W2M_PERMISSION_NEEDS_APPROVAL` still
refuses rather than queuing, and it still says so.

**6 new tests, 0 failures.**

## [0.23.0] — 2026-10-15

**The gate is on the dispatch path. "分权限" now executes, and a machine that has not opted in behaves exactly as before.**

`src/plugin/tools.mjs` calls `gateDispatch()` immediately after the write-scope check — placed there so the
thing being graded is already known to be well-formed — and refuses the dispatch when the verdict is not
`allow`.

### `actorAuthorityLevel`, and why it is not shared config

Read from the plugin config, or `W2M_ACTOR_AUTHORITY` so a machine can be pointed at a level without editing a
profile. **Deliberately not part of `shared.values`**: this is a local statement about who is typing, and a
fleet-wide value would let one machine's level speak for another's operator.

**`null` is not `0`.** An unset level means there is no actor to judge, and the gate reports `enforced: false`
and changes nothing — which is why adding this cannot alter the behaviour of any machine that has not opted
in. A refusal for everyone who never configured a level would have been the easy implementation and the wrong
one.

### What a refusal looks like

Two distinct codes, because they need different responses:

| Code | When | What it means |
|---|---|---|
| `W2M_PERMISSION_DENIED` | verdict `deny` | the level is more than one band short, or the capability is undeclared |
| `W2M_PERMISSION_NEEDS_APPROVAL` | verdict `needs_approval` | the level is exactly one band short |

The `needs_approval` refusal **carries the approval request** that `approvalRequestFor()` built — subject
level, required level, capability, `auto_settleable` — and says plainly that it is refused rather than queued
**because no approval queue is wired to this call yet.** Refusing and saying why is honest; queueing a request
nothing reads would not be.

### A defect I introduced while wiring it, and how it surfaced

The first edit **corrupted the file**: the anchor for the config field matched only the first line of a
multi-line expression, so it cut `allowedCommands` off from its own `.filter().map().filter()` chain and left
the orphan chained onto my insertion. A second attempt then wrote literal backslashes into the source by
escaping backticks that did not need escaping.

Both were caught by `node --check` immediately, which is the argument for running it after every write rather
than after the batch. Neither reached a commit.

**120 tests across the tools, permission and entrypoint suites, 0 failures.**

## [0.22.0] — 2026-10-15

**The gate now grades a real dispatch, and connects to the approval queue.**

0.21.0 built the gate and admitted it had no caller. This release gives it one: `gateDispatch()` reads a
dispatch's **own** facts — `write` and a non-empty `write_scope`, both already in the payload — and grades it,
rather than asking the caller to name a capability. That distinction is the whole design: **a caller who must
name their own capability is a caller who can name the cheap one.**

### The unset level, which is the honest part

`tools.mjs` states plainly that **no parameter of any tool can widen what a machine will run**, and that there
is no way for a caller to set anything authority-shaped. So a plugin with no configured actor level has no
actor to judge. Two answers were available:

* treat an unset level as `0` — which would **refuse every writing dispatch on every machine that has not opted
  in**, breaking a working fleet to enforce a policy nobody asked for;
* treat it as **unenforced, and say so**.

This does the second, and `enforced` is the whole point: **a gate that reports `ALLOW` and a gate that reports
"not checked" must never look alike, because the first is a decision and the second is the absence of one.**
A test asserts exactly that — same verdict, different `enforced`, different `reason_code`.

### The escalation reaches the queue it was built for

`approvalRequestFor()` returns `null` for anything that is not `NEEDS_APPROVAL`, and otherwise produces a
request shaped for the cross-session approval index built in 0.10.0 — **the two features finally meet**, which
is the point: a permission gate and an approval queue that do not connect are two things that each look
finished and jointly do nothing.

The request carries the **subject level recorded now**, not left to be re-derived later, for the reason
0.10.0's index already states: an approver who could supply the subject level could lower it. A destructive
request is marked `auto_settleable: false` explicitly, rather than leaving the queue to infer it from a
capability name.

### A `write` with no scope is graded as the dearer capability

The dispatch path refuses that combination separately. Grading it cheap here would mean that if that check
ever moved, a request intending to write would be handed the read-only permission.

### A test of mine was wrong, again in the same direction

`gateDispatch({write: true}, 0)` was asserted to be `deny`; it is `needs_approval`, **because an ordinary
actor is exactly one band below captain and that is the documented behaviour.** The implementation was right.
This is the fourth time in this project that a failing test was the test's fault — and it is the argument for
testing refusals rather than only the happy path, because a wrong refusal fails loudly enough to be told apart
from a wrong acceptance.

**11 new tests, 0 failures.**

## [0.21.0] — 2026-10-15

**The capability table has a gate now, so it is a policy rather than a description of one.**

`scripts/layer-model.mjs` has declared since 0.12.0 what each operational capability costs in authority —
`read_fleet_state` at ordinary, `dispatch_writing` at captain, `publish_release` at org admin,
`write_config` at system admin — and **nothing consulted it**. A table nothing reads is true on the day it is
written and unenforced afterwards; that is the same failure this project already paid for with the layering,
where a prose description was quietly violated while nothing failed.

`src/agent/permission.mjs` compares the table against `authority.mjs`'s bands and returns one of three
verdicts. The interesting part is not `ALLOW`:

### The escalation window is exactly one band

`NEEDS_APPROVAL` is granted to an actor **one band below** the requirement and to nobody further down.
`DENY` covers everything else.

**Two bands below is refused rather than escalated**, and that is a security decision rather than a
convenience one: if any shortfall could be forwarded, an ordinary actor could request a system-admin action
and **the request itself would be the attack** — one inattentive approver away from a write to
`allowedCommands`. One band means an actor can ask for the next thing up and no more, which is what
"escalate to your supervisor" actually means.

### An undeclared capability is DENIED

Not `ALLOW`, which would make the table grant whatever is added next; not `NEEDS_APPROVAL`, which would make
it requestable. Either would turn an **omission** into a permission. `decide('teleport', 100)` refuses, because
authority answers *how much may this actor do*, not *is this a thing that exists*.

### A level nobody defined is refused rather than rounded

`50.5`, `-1`, `101`, `NaN` and `'50'` are all denied with the requirement still reported. Treating them as `0`
would silently downgrade an actor; treating them as high would silently promote one. Neither is a decision
this module is entitled to make.

### Nothing destructive settles itself

`mayAutoSettle()` returns false for any destructive capability **even on an `ALLOW` at maximum authority** —
the level answers "may this actor", not "should this happen now". A release published on a machine's own
judgement is a release nobody reviewed.

### The table is audited, not trusted

`auditCapabilities()` reports any entry **no band can reach**, because an unreachable capability reads as
policy while doing nothing — worse than an absent one, since it looks like a control.

**18 tests, 0 failures.** One property is asserted across the whole table rather than by example: for every
declared capability and every level from 0 to 100, a `NEEDS_APPROVAL` verdict implies the actor is exactly one
band below.

## [0.20.0] — 2026-10-15

**Version skew is refuted too, and the direct-path failure is now counted instead of read one at a time.**

### Third hypothesis, third refutation

The previous release established that this machine runs plugin **0.9.5** while the source tree is **0.19.0**,
and that the failing `P2P_PUNCH_FAILED` is raised by the plugin process. The natural next step was to suspect a
digest name that 0.9.5 used and later versions removed.

**Measured, and refuted:** reading `crypto.mjs`, `p2p.mjs` and `p2p-node.mjs` **at tag `v0.9.5`** through the
API shows the same two digest names the current tree uses — `blake2s256` and `sha256`. Then a search for
**dynamic** algorithm arguments (`createHash(variable)`) across `src/` found **none**: every `createHash` and
`createHmac` in this codebase is called with a string literal.

**So there is no call in this codebase that can produce `Digest method not supported`.** Three hypotheses have
now been measured and excluded — BLAKE2s, the wider primitive set, and version skew — and the cause remains
**UNVERIFIED**. What is *not* in doubt is where it is raised: the plugin process on this machine, running
0.9.5 while the source under study is 0.20.0.

### What this release delivers instead of a fourth guess

`p2pReasons()` and `classifyP2PReason()` turn the P2P reason strings into a **count**, because the finding that
matters was invisible in every individual report: **twelve of twelve tasks travelled by relay, and no aggregate
anywhere said so.**

* `relay_only_share` is the fleet's avoidable latency as one number, and it is **`null`** for an empty
  denominator — "no lease carried a p2p block" and "every lease failed" must not look alike.
* an unrecognised code is counted as `OTHER` **with the raw code travelling with it**, so a new refusal name
  is reported rather than swallowed.
* a missing reason is distinguished from a present one, because *"no reason recorded" is not "no failure"*.

### The version skew is still unresolved and still blocks diagnosis

The installed plugin is **0.9.5**; the source is **0.20.0**. Until they match, every source-level conclusion
about this machine's P2P behaviour is read from code that is not running. This needs a person: updating the
plugin installs files into the DSH profile, which is outside what this session changes on its own.

**7 new tests, 0 failures.**

## [0.19.0] — 2026-10-15

**The plugin this machine runs is 0.9.5. The source tree is 0.18.0. Every source-level conclusion about the P2P failure was read from code that may not have run.**

Measured, not inferred:

```
source    : 0.18.0
installed : 0.9.5   at ...\profiles\desktop\node_modules\@twinsearth\w2m-dsh-plugin
verdict   : installed 0.9.5 is 8995 rank(s) BEHIND the source 0.18.0
            -- source-level conclusions about this machine are void
```

Reading `p2p-node.mjs` established which call raises `P2P_PUNCH_FAILED`, and it is raised **by the plugin
process** — `tools.mjs:1463`, `node.dial(...)`, on the dispatching machine. That machine's plugin is **nine
versions behind the file that was being read.** Two rounds of crypto-capability work were therefore correct
about the code in this repository and only *possibly* correct about the code that failed.

### Two runtime facts were assumed, and only one held

| Assumption | Status |
|---|---|
| which node the plugin runs under | **holds** — the DSH process runs `dsh-primary-runtime/.../node.exe` v24.21.0, the same binary that was probed; the runtime was never the variable |
| which plugin version is loaded | **did not hold** — 0.9.5 installed against 0.18.0 of source |

The first was checked last and held; the second was never checked and did not. **A version skew is not a
detail to note — it is a reason every source-level conclusion is void**, and it should have been the first
thing measured rather than the last.

### The invariant is now a test

`test/installed-version.test.mjs` finds every plausible install location, compares numerically (because
`'0.9.0' > '0.10.0'` as strings, and `0.9.5` against `0.18.0` is exactly the case that would be got wrong),
and **reports the skew with both numbers** rather than failing an assertion nobody could act on. It also
refuses to compare what it cannot parse, and **says so when it finds no installed copy** — because passing by
absence is the same failure mode as an earlier skip guard in this repository, which passed for three rounds
while hiding a defect in the tooling rather than in the code.

### What is needed from a person

**The local DSH must load the current plugin** for P2P diagnosis to mean anything. Until it does, this
machine's `P2P_PUNCH_FAILED` comes from 0.9.5 and no reading of 0.19.0's source can explain it.

**8 tests, 0 failures.**

## [0.18.0] — 2026-10-15

**The whole handshake primitive set is present on both machines — so the P2P failure is not a missing algorithm.**

Two candidates for `P2P_PUNCH_FAILED: Digest method not supported` have now been **measured and excluded**:

| Candidate | Measurement | Verdict |
|---|---|---|
| BLAKE2s-256 | 32-byte digest on MacMini **and** here, on the same run that failed | **innocent** |
| every other primitive the handshake touches | `sha256`, `chacha20-poly1305` with a real AEAD round trip, `hkdfSync('sha256')`, `x25519`+`diffieHellman`, `ed25519` — all present on both | **innocent** |

The second row was answered by **one bit-encoded dispatch** that put eight questions to MacMini at once
(`exit_code: 255`, every bit set) rather than one question per round. That technique was already in this
repository and should have been the first move.

**What this changes:** the search moves off the runtime and onto the protocol, the session state, or the
transport. And it points somewhere specific — **`P2P_PUNCH_FAILED` is raised by the relay's own push, on the
machine that already has every primitive it needs.** The failing handshake is not on a peer missing an
algorithm; it is on a peer that has all of them.

`cryptoCapabilities()` now answers this question in one dispatch for any machine, and its suite asserts the
**count** — six primitives, six checks — because a capability report that silently checks four things reads as
complete.

**Honest status: the cause of `P2P_PUNCH_FAILED` remains UNVERIFIED**, and the 0 % direct share measured last
round is unchanged. What this release buys is that two hypotheses are dead and the next one costs one
dispatch to test.

## [0.17.0] — 2026-10-15

**BLAKE2s-256 is not the cause of `P2P_PUNCH_FAILED`, and a failure that names nothing costs a probe per guess.**

### The hypothesis, and its refutation

`P2P_PUNCH_FAILED: Digest method not supported` has been reproduced twice in production and never under
instrumentation. The obvious candidate was `createHash('blake2s256')` in `handshakeHash` — an algorithm that
some Node builds lack, whose absence produces exactly that string.

**Measured, and refuted:** both MacMini and this Windows host compute a 32-byte BLAKE2s-256 digest, on the
same run that reported the failure. `blake2s256` is available on both. **So the algorithm is not the cause**,
and the real cause remains **UNVERIFIED**.

### What changed anyway, because the failure's *shape* is the real defect

OpenSSL's message names **no algorithm, no caller and no host**. Establishing that BLAKE2s was innocent
therefore required probing each machine by hand, over a channel that carries one exit code — a round trip per
hypothesis. `handshakeHash` now:

* catches the unavailable case and throws `CRYPTO_BLAKE2S256_UNAVAILABLE` naming the algorithm, the runtime,
  and the fact that **it is a wire-protocol primitive which cannot be replaced with SHA-256** without breaking
  interoperability with every peer — so nobody "fixes" it by substituting an algorithm and silently splits the
  fleet;
* refuses a digest that is not 32 bytes (`CRYPTO_BLAKE2S256_WRONG_LENGTH`), because a truncated digest throws
  nowhere and would surface as an authentication failure far from its cause;
* exposes `blake2s256Support()` so a machine can answer the question about itself in one dispatch.

The wrapper is transparent on the happy path, and a test asserts it byte-for-byte against a direct
`createHash` call — if it changed the bytes, every peer would compute a different handshake.

### A defect in the fix itself, found before shipping

The first version called `getHashes()` without importing it, so `typeof getHashes === 'function'` was silently
`false` and the `advertised` flag would have been wrong forever. Caught by inspecting the import block rather
than by a test, which is the honest description of how it was caught.

### The 0 % direct share stands

Last round measured **12 of 12 tasks carried by the relay**, at RTT 354 ms (macmini) and 336 ms (ToFuture)
where jp-shared answers in 20 ms. This release does not improve that number; it makes the next attempt at
diagnosing it cheaper.

**10 new tests, 0 failures.**

## [0.16.0] — 2026-10-15

**A non-zero exit code is not a fleet failure, and this session conflated them repeatedly.**

Twelve real task reports were fetched one request at a time — the only correct input, since `w2m_history`
records current lease state rather than outcomes — and the measured result was **12 acting leases, 12 `done`,
0 expired, 0 refused**. Yet several runs in the same session produced no result at all. Both facts are true.

They are different failures, and the difference decides where a reader looks:

| Observation | What it means | Where the fault is |
|---|---|---|
| `exit_code: 70`, `lease_state: done` | **The command ran and reported 70.** The fleet worked. | the command |
| `exit_code: null`, `lease_state: expired` | **No result was ever produced.** | the machine, the lease, or the network |

`classifyLease()` and `isFleetFailure()` now encode that distinction, and **`exit_code` is the decisive field,
not the lease state** — a lease can be `done` while its command returned non-zero, which is a *successful
execution of a failing command*. `isFleetFailure` returns true only for the no-result case; a refusal is the
request being wrong, and an observer was never asked to act.

A rate that merged the two would report a healthy fleet as broken, or a broken one as healthy, depending on
which it happened to count.

### The measured fleet, this round

| Measure | Value | Note |
|---|---|---|
| acting leases | 12 of 12 | a bounded sample, fetched per task |
| expiry rate | **0.0 %** | 0 expired in the sample |
| refusal rate | **0.0 %** | 0 refused |
| direct share | **0.0 %** | **every task went by relay** |
| P2P delivery rate | **0.0 %** | no direct channel was ever established |
| fleet size | **3 usable of 5 paired** | two `win-desktop` silent ≈ 17.2 h |

**The 0 % direct share is the finding worth acting on**: not one task in the sample used a direct path, so the
entire fleet has been running on the relay at RTT **354 ms** (macmini) and **336 ms** (ToFuture) where
jp-shared answers in **20 ms**.

### Still not fixed

The two relay endpoints still disagree about whether the silent machines are online — `reconcile()` detects it
and says which to trust, but the disagreement itself needs a change on the relay, and this session has no shell
on that host.

**24 tests, 0 failures.**

## [0.15.0] — 2026-10-15

**The fleet is three machines, not five — and two relay endpoints disagree about it.**

### The measurement, which is the whole point of this release

`w2m_stats` and `w2m_devices` both answer "is this machine usable?" and **they do not agree**:

| Machine | `w2m_devices` | `w2m_stats` | silent for |
|---|---|---|---|
| jp-shared | online | online, RTT **6 ms** | 2.4 s |
| macmini | online | online, RTT **538 ms** | 4.4 s |
| ToFuture | online | online, RTT **122 ms** | 0 s |
| win-desktop ×2 | **online** | **offline, `silent`** | **61 384 s ≈ 17 h** |

**A fleet whose size is reported two ways is a fleet whose plans are wrong by a factor of 1.7** — and the
failure is silent, because both answers look authoritative. `src/agent/fleet-state.mjs` prefers `w2m_stats`
(it is the one carrying a *reason*), treats a listing without a heartbeat age as unverified, and
`reconcile()` reports **every machine the two endpoints disagree about** rather than picking one and staying
quiet.

### The second divergence, which would have flattered the fleet

`w2m_history` lists a `lease_states` map per task. **It is not the execution outcome.** Of forty tasks in the
sample, every one recorded macmini as `done` — while the session's own result envelopes included several
`expired` with no exit code at all. The map records the *current* lease state.

`historyIsOutcomeRecord()` returns `false` unconditionally with the reason, and its suite asserts on the
measured payload. The finding matters because of its direction: **a reliability measurement built on the
history listing would have shown a perfectly reliable fleet** — the most dangerous possible error in a module
whose whole purpose is to notice trouble.

The number to plan against is therefore **three usable machines**, and `readStats()` takes it from the
per-machine entries rather than from `counts.online`, while still reporting the relay's own claim rather than
hiding it.

### A fixture typo that invented a disagreement

Two tests failed because a machine id in a fixture was written `tob` where the payload says `tof` — so the
reconciler correctly reported a *third* machine claimed online but not usable. **The code was right and the
fixture was wrong**, which is the third time in this project that a failing test was the test's fault; the
argument for testing refusals is that they fail loudly enough to be told apart.

**16 tests, 0 failures.**

## [0.14.0] — 2026-10-15

**Fleet scale: the arithmetic the observations support, and the refusals where they support nothing.**

ROADMAP v4.11.0 names scale, defence and integration and deliberately does not plan them, on the grounds that
**a design that has not been measured at 50 cannot honestly specify 1,000**. This release does not specify
1,000. It provides the module that computes what a fleet's own task history can support, and refuses the rest.

### The limit that bounds everything, stated first

**This fleet has five machines.** No amount of cleverness turns five into fifty, and the number the ROADMAP
actually asks about — the agent count at which coordination collapses — is exactly the number this fleet
cannot observe. So `scaleOf()` returns `can_answer_collapse_point: false` as a **field**, not as a footnote,
and `extrapolate(5, 50)` refuses with a reason rather than producing a scaled number.

The refusal is the feature. A module that emitted a "scaling curve" from five points would be producing
**fiction with a decimal point on it**, which is worse than silence because it is quotable.

### What the fleet can answer, from `w2m_history` and `w2m_report`

| Measure | Why it is the one that matters |
|---|---|
| **lease expiry rate** | An expired lease is work that was assigned and **silently did not happen**. This is the coordination failure. |
| **refusal rate** | Counted separately, because a refusal is *the request* being wrong, not the fleet. Merging them points the reader at the wrong machine. |
| **transport mix** | Every task carried by the relay while a direct path existed is avoidable latency. |
| **fan-out vs machines online** | Participation against opportunity. |

### The refusals, which are most of the suite

`0/0` is the most misleading number this module could produce — it reads as a perfectly coordinated empty
fleet. So `expiry_rate`, `refusal_rate`, `direct_share` and `overhead_per_agent` all return **`null`** for an
empty denominator, and `overhead()` says *"the overhead of zero agents is not zero, it is undefined"*.

`ceilingFrom()` states one thing and denies another: *"at a fan-out of N, the lease expiry rate was X"*, with
`is_a_ceiling: false` and a note that a ceiling would need the rate measured **at several fan-outs and
trending**. That is the only honest form of the answer available.

Three defects found by the suite, all mine:

* the boundary rule contradicted its own comment — the test said *"at least a tenth"* while the code required
  *more than* a tenth. The boundary is now exclusive, deliberately: at exactly 10% a refusal costs nothing and
  an estimate costs credibility.
* a test expected a `null` entry in a machine list to be dropped. It should not be: a machine listed with no
  result **is an unknown outcome**, which is a real thing a relay response says.
* the same two mistakes, in the same file, in the same run — which is the argument for testing the refusals
  rather than only the arithmetic.

**19 tests, 0 failures.**

## [0.13.1] — 2026-10-15

**The macOS skip is removed, because the failure it was hiding did not exist.**

`test/log-bounds.test.mjs` was skipped on macOS for three rounds because it appeared to fail there with an
`AssertionError`. **It never failed.** The tooling that read its result was looking for a summary line
beginning `# fail 0`, and node v24 writes `fail 0` behind an information symbol instead — the same defect
fixed in 0.13.0. The "failure" was my parse error, re-reported as a suite result.

With the guard temporarily removed on MacMini and the corrected parser in place, the measured result was:

```
28 test(s), 0 failed          (read from stdout, info format)
```

**Seven `describe` blocks had been guarded. All seven are unguarded now, and the note explaining the skip is
replaced by a note explaining that there is nothing to skip.**

### What that cost, recorded so the shape is recognisable next time

Two rounds of probes, all of which correctly ruled out every filesystem hypothesis — the repository was
present, the module loaded, and `mkdirSync`, `mkdtempSync` and `writeFileSync` all succeeded. **The probing was
sound and the premise was not**: it had been derived from a parse failure, and the premise itself was never
measured. One command that printed the raw output would have shown the prefix immediately. It should have been
the first thing run rather than the last.

A guard added on a false premise is worse than no guard, because it converts "I cannot see the result" into a
permanent, plausible-looking exception — and it does so in the one place nobody looks again.

Windows: 28 tests, 28 pass, **0 skipped**.

## [0.13.0] — 2026-10-15

**The root cause of three rounds of confusion was a regex, and it was mine.**

Several rounds were spent believing a suite *failed on macOS*. It had not. The parser was looking for lines
beginning `# tests 17`. Node v24 writes them beginning `ℹ tests 17`:

```
ℹ tests 17        not        # tests 17
ℹ pass 17                    # pass 17
ℹ fail 0                     # fail 0
```

**The `#` form was an assumption that was never checked**, carried from the first script written in this
session to every one after it. The damage was worse than a misread count:

* suites that had **passed** were recorded as `UNREADABLE`;
* and then the absence of a `# fail` line, together with the absence of test *names* in the captured output,
  was read as **"the process crashed before printing anything"** — which pointed at module scope and sent an
  investigation somewhere the fault was not. Two rounds went into that, including a probe that correctly ruled
  out every file-system hypothesis, because the hypothesis being tested was derived from a bad premise.

`src/agent/test-report.mjs` now writes the contract down, parses both prefixes plus a bare form, reads
**both streams and says which one answered**, and reports its own format so a future change is *reported*
rather than silently tolerated. 13 tests, and the two that matter most are:

* the **real** v24 output parses (taken verbatim from a run, not invented);
* an unreadable report yields `verdict(...) === null`, **not `false`** — collapsing "could not read" into
  "failed" is the safer of the two wrong directions and was still wrong enough to waste rounds.

### The lesson, stated so it generalises

**I assumed the shape of a channel's output instead of measuring it** — the same error, from the same
channel, for the third time in this session (first the exit-code summary line, then the test names, now the
prefix). The technique that finally settled it was printing the raw output and looking at it, which took one
command and should have been the first.

`test/log-bounds.test.mjs` remains skipped on macOS. With a working parser the skip is no longer plausible as
a parse artefact, so the underlying assertion failure is still **UNVERIFIED** — but the reason it took so long
to see is now fixed and tested.

## [0.12.3] — 2026-10-15

**Correcting a wrong inference that 0.12.2 recorded as fact.**

0.12.2's note on the macOS failure said: *"no test name appears in the captured output, so the failure happens
before the per-test lines are printed — which points at module scope or a hook rather than a single
`it(...)`."* **That reasoning was wrong, and it is corrected here rather than quietly dropped.**

The claim rested on a probe that searched the captured output for twenty-seven test names and found none. A
later run searched for the same twenty-seven and also found none — **on a run that succeeded**. So on this
machine the test names do not appear in the output at all, and their absence said nothing about where the
failure was. The same mistaken inference was drawn from the same channel capability twice.

What is actually measured now, by a bit-encoded probe that asked six questions in **one** dispatch instead of
six:

| Question | Result |
|---|---|
| repository present | yes |
| `log-bounds.mjs` present | yes |
| `snapshot` is a function | yes |
| `methodFor` is a function | yes |
| the module import throws | **no** |
| `mkdirSync` / `mkdtempSync` / `writeFileSync` succeed | yes |

So the file operations and the module load are **fine** on that machine. The failure is a **plain assertion
inside some `it(...)`** — one of twenty-eight — and not a crash at module scope. The suite stays skipped on
macOS with that reason, unchanged in behaviour and now honest in its explanation.

The lesson is about the channel, not the test: **the remote output does not contain what I assumed it
contained**, and assuming its shape cost rounds twice. The probe that answers six questions per dispatch
should have been the first thing built, not the last.

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
