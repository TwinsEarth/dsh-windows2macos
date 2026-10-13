# Handoff — where this stands, and what to do next

Written at the point of switching development from the Windows machine to the Mac. Everything here
is **committed and pushed**; nothing depends on the machine that wrote it.

---

## The Mac is reachable by exactly one path

Discovered the hard way — four blind attempts failed first, each diagnosed by encoding state into
an **exit code**, because `unverifiable` tasks do not return their stdout and that is the only
readable channel from that machine:

| target | from the Mac |
|---|---|
| `raw.githubusercontent.com` | ❌ |
| `github.com` release tarball | ❌ |
| `http://202.182.123.154:8899/pub` | ❌ |
| `http://202.182.123.154:8787` | ❌ |
| **`http://geefish.cn/pub/...`** | ✅ **the only one** |

Port 80, behind the nginx that already fronts the relay. A `location ^~ /pub/` was added to that
same server block, so releases travel the one path already proven to work. The nginx change is
tested with `nginx -t` **before** loading and restores its backup on any failure, because a broken
config there takes the whole fleet down, not just a download.

## Updating the Mac

```bash
curl -fsSL http://geefish.cn/pub/mac-self-update.mjs -o ~/w2m-self-update.mjs
curl -fsSL http://geefish.cn/pub/w2m-0.8.2.tgz -o ~/w2m-0.8.2.tgz
node ~/w2m-self-update.mjs --tarball ~/w2m-0.8.2.tgz \
  --sha256 8ff593845612a4699c11c03ab22bbd81afa02f93b865d2e444badc8b62cfb60a
```

`--sha256` is not optional in spirit: the supervisor **refuses** a tarball whose checksum differs,
before it touches anything.

The supervisor is **detached** on purpose — it has to survive the DSH it restarts. Seven steps,
ordered so the previous state is restorable **without the network**: verify the checksum, back up in
place, check the staged tree for its entry point, swap, restart, self-check, and **roll back
automatically** on failure. Every step is appended to `~/w2m-self-update-report.json` as it happens,
so a process killed mid-way still says where it stopped.

---

## Current version, everywhere

| machine | version |
|---|---|
| Windows | 0.8.1 |
| **Linux relay host** | **0.8.2** |
| **Mac** | **0.8.0 — needs the update above** |
| npm | 0.8.0 |
| GitHub | v0.8.0 released; 0.8.1 and 0.8.2 committed, **no release tag yet** |

---

## What was fixed, and the bug that is now closed

**The reported bug:** a new PC signed into the same DeepSeek account did not join the same fleet.

**The cause, traced rather than guessed** — four gaps stacked:

1. the plugin computed its SN, derived `fleet` from the account code, **logged it, and never used
   it for anything**;
2. nothing called `/v1/pair`;
3. `autoStartAgent` defaults to **false**;
4. and even with an agent, membership needed a **human-typed one-time pairing code**.

So *"same account joins the same fleet automatically"* was a requirement with **no code path**.

**Why the obvious fix would have been wrong:** using `accountCode` as the credential. It is
`sha256(userId)` truncated to **32 bits** — documented as fine for *grouping*, brute-forceable as a
*secret*. The bug was a **conflation: a grouping identifier doing duty as a secret.**

**The fix** derives the secret from what same-account machines share and outsiders cannot obtain —
the ability to read `userId`:

```
fleetKey = HMAC-SHA256(userId, "w2m-fleet-v1")     256 bits
fleetId  = SHA-256(fleetKey)                       what the relay groups by
```

**Presenting the key is the proof.** The relay *computes* a fleet id from the key rather than
believing a claimed one, so a device can only land in the fleet whose key it holds. No
trust-on-first-use, no operator configuration, no account lookup, nothing to forge — and a device
without the key forms a different, empty fleet rather than joining someone else's.

This also removes the deployment problem recorded in v0.7.9: **`--fleet` no longer needs an operator
to compute and hand-carry a 32-bit code**, because the relay needs to know *nothing* about any
account.

**Verified end to end:** an agent given **only** `--fleet-key`, against a relay with **no fleet of
its own**, pairs and lands in the account-derived fleet (`d5bb1b9ddf3faad4`, `source=fleet_key`).

### The bug that would have made it work exactly once

`resolve()` returned early when an SN was already stored and never read the account at all. Right
for the SN — it must not be regenerated, or every restart looks like a new device — and **wrong for
the key**: a machine has a stored SN from its *second* start onward, so it would have derived a key
once and never again.

**The auto-join would have worked on a machine's first boot and silently stopped afterwards** — the
hardest kind of bug to see, because it works when you test it. Found by asking what the stored-SN
path actually does, not by reading the happy path.

---

## What is wired, and the one thing that is not

| piece | state |
|---|---|
| `account.mjs` derives the key on **every** resolve, both paths | ✅ |
| `index.mjs` exposes it as `fleetKey` (the key, never the account id) | ✅ |
| `agent.mjs` `pair(code, userId, fleetKey)` | ✅ |
| `w2m-localside --fleet-key` | ✅ |
| relay derives the fleet from the key | ✅ |
| **the plugin spawns the agent and passes its key** | ❌ **not wired** |

**So with the default configuration a new PC still will not auto-join.** The mechanism is complete
and verified; the plugin does not yet start the agent or hand it the key. Until that lands, either:

```bash
w2m-localside --rabbit http://geefish.cn --fleet-key <KEY> --project <dir> --name <name> --state <dir>
```

or set `autoStartAgent` and wire the key through.

**This is the next task.** It is also the last one: after it, installing the plugin and signing into
the same account is the whole of the user-facing procedure.

---

## Traps this codebase has already fallen into — worth knowing before editing

Each of these cost a debugging round, and most were **silent**:

* **A presence check reads `undefined` as "provided".** `createILinkChannel` passed
  `{ fetch: undefined }` and threw on mount (v0.7.0). The same shape appears in the pairing body:
  an absent code must be an **absent key**, not a `null` one.
* **An anchor in a `patch` file is an assertion, not a rename.** A mismatched `name:` makes the
  Loader skip the whole patch *silently*.
* **`statSync` on an injected path defeats the injection.** The secrets guard called it
  unconditionally, so an injected reader was never reached and the scan reported **zero findings
  across zero files** — a guard that is silently off.
* **`createHmac('sha256', Buffer.alloc(0))` is not `createHash('sha256')`.** A signature over the
  wrong bytes verifies nowhere and says nothing about why.
* **A test that hard-codes a rule name measures the name, not the behaviour** — renaming broke it.
* **`login` confirms as `confirmed`, not `scaned`.** Waiting on `scaned` misses the token entirely.
* **The relay needs two credentials.** The operator token dispatches; the **device token** reads the
  verdict. Supplying one gives a *confident wrong answer* — `判定：unknown` — rather than an error.

## Reading the Mac without stdout

Exit codes are the only channel. Encode state into them and probe:

```js
// on the Mac, via node -e
process.exit(tgzSize < 700000 ? 10 : sup.done ? (sup.ok ? 0 : 13) : 12);
```

## Ground rules that have held

* `deploy/server/` holds the units **as the live host runs them**; the deploy script's step order
  *is* the safety argument.
* `/var/lib/w2m/rabbit/` — `operator-token.txt` and the ledger — **must never be committed**.
  `.gitignore` refuses the paths; `scripts/scan-for-secrets.mjs` reads the **content** of every
  tracked file, because a `.gitignore` refuses a path while the ways a credential escapes are
  pasting one into a source file, a fixture, or an example.
* **A deploy cannot be an outage.** The relay runs **unscoped**, so its four devices keep working.
  Scoping it requires an account code and a re-pair of every device.
* **Never publish to npm without the token**, and rotate it: it has been pasted into a chat log.
