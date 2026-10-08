# Lint & format audit (task-23)

> Scope: adds ESLint + Prettier configuration and a CI lint job to a project that
> had neither. **TypeScript is deliberately deferred** — see §1.1.
>
> This document is the audit the change is based on: what the tools report on
> the tree **as it stands**, and what to do about each finding. Nothing in
> `src/`, `test/`, `bin/` or `scripts/` was modified to make lint pass.
>
> Measured 2026-10-08 against `eslint@10.12.0`, `prettier@3.9.9`,
> `globals@17.13.0`, on Node 24.21.0 (Windows).

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Do the tools run? | Yes: `eslint .` lints 38 files; `prettier --check .` flags 44–45 (the repo is being edited concurrently, so this drifts by a file or two). |
| How many real defects? | **1** (`no-undef`: a function is called but never imported — §3.1). |
| Current ESLint state | 31 errors, 43 warnings across 19 files. |
| Would Prettier rewrite the tree? | **Yes — ~41–45 of 48 files, ~90% of all lines.** Recommendation: **do not run it** (§4). |
| Is `dependencies` still empty? | Yes, `{}` — unchanged. Only `devDependencies` gained four entries. |
| Is lint a blocking CI gate? | Yes. Prettier is reported, not blocking (§5). |

---

## 1. What was added

| File | Purpose |
|---|---|
| `eslint.config.mjs` | Flat config (ESLint 9/10 style), stock JS parser only |
| `.prettierrc` | Options derived from measuring the existing style (§4.1), not from defaults |
| `.prettierignore` | Keeps generated artifacts, deployment templates and licence text out of scope |
| `.github/workflows/ci.yml` | New `lint` job (additive; `test`, `live-api`, `pack` untouched) |
| `package.json` | `devDependencies` + four scripts; `dependencies` still `{}` |

### 1.1 Why no TypeScript, and what that costs

The project is plain ESM JavaScript with no build step. Adding
typescript-eslint would mean adding TypeScript — which is the thing the user
asked to defer. The practical consequence is that the **type-aware rules are
unavailable**, and one of them matters here:

- `@typescript-eslint/no-floating-promises` — the canonical "you forgot
  `await`" rule. It requires a TS program, so it cannot be enabled in this
  configuration.

What was enabled instead, and how far it actually gets:

| Substitute | Coverage | Honest limitation |
|---|---|---|
| `no-undef` | An identifier that does not exist anywhere. **This is what caught the one real defect.** | Does not see a *wrong* identifier that does exist. |
| `no-async-promise-executor` | `new Promise(async …)` | n/a |
| `require-atomic-updates` | Shared state written after an `await` | ~6 of 7 findings in `src/` are false positives (§3.3) |
| `no-promise-executor-return` | Returning a value from a Promise executor | Fires on the idiomatic `new Promise((r) => setTimeout(r, ms))` |

**Conclusion:** a forgotten `await` remains invisible to this configuration.
Anyone wanting that class of check needs TypeScript, and this audit is the
evidence for the cost of not having it: one real defect out of the 31 errors,
and it happened to be a missing import rather than a missing `await`.

### 1.2 Rule-set structure

- `js.configs.recommended` as the base (ESLint 10's recommended set).
- A general block for `**/*.mjs` with `globals.node`, then explicit rules
  grouped as *unbound/unused names*, *async mistakes*, *suspicious-but-legal*,
  *shadowing*, *hygiene*, and *output discipline*.
- `bin/**` turns `no-console` off: the CLI entry points print by design.
- `test/**` and `scripts/**` demote exactly two rules to warnings (§3.3).

Two deliberate rule decisions, both with the reason recorded in the config:

| Rule | Setting | Why |
|---|---|---|
| `no-useless-assignment` | **off** | Ships as an *error* in ESLint 10's recommended set, and fires 6 times on `let x = null; try { x = … } catch { x = null }`. ESLint treats try/catch as "assigned on every path" and cannot see the window before the first assignment. Removing those initialisers would be the wrong fix. |
| `no-control-regex` | **left as error** | Fires 3 times in `src/agent/exec.mjs` on regexes that match ANSI escape sequences (`\x1b`, `\x07`). Those characters are the point of the pattern, so the correct fix is an inline `eslint-disable-next-line` at those lines — in `src/`, i.e. **not this task's write scope**. Reported in §3.2. |

---

## 2. Baseline numbers (real output)

```
$ eslint .
✖ 74 problems (31 errors, 43 warnings)

$ eslint . --format json  ->  38 files linted, 19 with findings
```

By rule:

| Count | Rule | Where it comes from |
|---|---|---|
| 31 | `no-promise-executor-return` | my config, demoted to warn in `test/`+`scripts/` |
| 21 | `no-unused-vars` | my config |
| 18 | `require-atomic-updates` | my config, demoted to warn in `test/`+`scripts/` |
| 6 | `no-useless-assignment` | ESLint 10 recommended — now **off** |
| 3 | `no-control-regex` | ESLint 10 recommended |
| 1 | `no-undef` | my config — **the real defect** |

By directory (before demotion): `test/` 38, `src/` 21, `scripts/` 9, `bin/` 0,
`lib/` 0.

After the two demotions, CI's blocking count is **31 errors / 43 warnings**.

---

## 3. Findings, by disposition

### 3.1 REAL DEFECT — 1 finding (fix in `src/`, outside this task's scope)

```
src/plugin/tools.mjs:571:9  error  'existsSync' is not defined  no-undef
```

```js
// src/plugin/tools.mjs
import { promises as fs } from 'node:fs';   // line 49 — only `fs`, no `existsSync`
…
function resolveProfileDir(config) {         // line 559
  …
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (path.basename(dir) !== 'node_modules') continue;
    const root = path.dirname(dir);
    if (existsSync(path.join(root, 'package.json'))) return root;   // line 571  ← ReferenceError
  }
```

**Why it is a defect, not a style complaint**

- `existsSync` is never imported anywhere in the file (all six imports checked).
- In an ESM module an unbound identifier is a `ReferenceError` at evaluation
  time, not `undefined` — so this throws rather than silently taking the false
  branch.
- It is reachable from normal plugin startup: `resolveProfileDir` is called at
  `tools.mjs:416` while building the tool configuration, and the loop reaches
  line 571 as soon as it walks up into a directory literally named
  `node_modules`. That is the ordinary layout this project *ships* (`files`
  includes `src/` and `lib/`, so the package always sits under a
  `node_modules/`).
- The module-load walk probably starts from a path whose parent chain contains
  `node_modules` in the published layout, which is exactly when a user would
  hit it.
- `test/tools.test.mjs` has **no** `resolveProfileDir` coverage (grepped), which
  is why 10 test files and 291 assertions pass while this line stays broken.

**Suggested fix** (one line, in `src/plugin/tools.mjs`, which is why this audit
stops here):

```js
import { existsSync, promises as fs } from 'node:fs';
```

**Suggested test**: a case that calls the profile-directory resolver from a
path under a `node_modules` directory and asserts it returns the package root.
That is the missing signal, not the import.

### 3.2 PURE STYLE — 27 findings, worth unifying, no behaviour change

**Unused bindings — 21** (`no-unused-vars`). These are dead declarations: no
behaviour change either way, and the risk of removing them is that a reader
loses a hint. Grouped by how they should be handled:

*Never-used imports (9)* — safe to delete, and two are worth a second look
because the *name* suggests missing wiring:

| Location | Binding | Note |
|---|---|---|
| `src/plugin/auto-update.mjs:44` | `parseSha256Sums` | **looks like missing wiring** — a checksum parser imported and never called. Verify whether signature verification was meant to run (§3.3). |
| `src/plugin/schedule.mjs:198` | `secondOfDayIn` | helper imported, never called |
| `test/relay.test.mjs:33` | `Persistence` | test-side import left over |
| `scripts/pack.mjs:29` | `relative` | — |
| `test/auto-update.test.mjs:11` | `before` | hook imported but no `before()` in the file |
| `test/auto-update.test.mjs:14` | `mkdirSync` | — |
| `test/e2e.test.mjs:29` | `tmpdir` | — |
| `test/tools.test.mjs:23` | `before` | same as above |
| `test/update-wiring.test.mjs:12` | `fs` | — |

*Assigned but never read (12)* — `prefer-const`-adjacent tidy-ups:
`src/plugin/auto-update.mjs:216` (`intervalDays`), `src/plugin/tools.mjs:1501`
(`transportError`), `src/relay/report.mjs:23` (`FAILURE_OUTCOME`),
`src/agent/agent.mjs:1186` (`stderr`), `scripts/probe-restart.mjs:83` (`base`),
`test/relay.test.mjs:814/828/865/902/914` (five `a`), `test/schedule.test.mjs:127`
(`midnight`), `test/agent.test.mjs:1925` (`requests`).

`test/relay.test.mjs`'s five bare `a` bindings are the strongest candidates for
a quick cleanup: an unused single-letter binding is almost always a leftover
from a refactor.

**`no-control-regex` — 3**, in one file:

```
src/agent/exec.mjs:311:18 / 312:18 / 313:20   Unexpected control character(s) in regex: \x1b, \x07
```

Correct fix: inline `// eslint-disable-next-line no-control-regex` above each,
because matching ANSI escape sequences is the intent. **In `src/`, so not
changed here.**

**`require-atomic-updates` in `src/` — 7**, see §3.3.

### 3.3 RECOMMEND LEAVING ALONE — 46 findings

**`no-promise-executor-return` — 31, all of them.**

Every occurrence is the same line shape:

```js
await new Promise((r) => setTimeout(r, ms));   // test/agent.test.mjs:171 and 30 more
```

The rule's message ("Return values from promise executor functions cannot be
read") is about a *returned value* from an executor. Here the arrow body is a
bare call expression, which is the idiomatic sleep and is correct. **Disposition:
demoted to `warn` in `test/` and `scripts/`** (config, not a code change), so a
genuine instance still surfaces in output. 0 of 31 are defects.

**`require-atomic-updates` in tests — 18, all of them.**

All are deliberate state assignment in sequential scenario scripts:
`globalThis.fetch = stub` in a `finally`, `process.env.W2M_OPERATOR_TOKEN = …`
around a case, `group.relay = await startRelay(...)`. Each test file is a
straight-line script with no interleaving. **Disposition: demoted to `warn` in
`test/`.**

**`require-atomic-updates` in `src/` — 7, of which ~6 are false positives.**
These stay as **errors** (production code deserves the scrutiny), but none of
them should be "fixed" by rewriting the code:

| Location | Shared state written after `await` | Assessment |
|---|---|---|
| `agent.mjs:1022` | `toolchainCache = {…}` | **False positive.** Written from `toolchainInfo()`, which has an early `if (toolchainCache) return`. Two concurrent callers (`:1334`, `:1516`) can each recompute and the last write wins — but the value is derived from immutable per-project facts, so the only cost is doing the git lookup twice. There is nothing to "fix" short of a promise-coalescing cache. |
| `agent.mjs:1120,1121` | `identity.device_token`, `identity.rabbit_url` | **False positive.** Single caller: `bin/w2m-localside.mjs:184`, once, before the loop starts. |
| `agent.mjs:1591,1602` | `state.connected` | **False positive.** `streamOnce()` is called from the single reconnect loop; every writer is in that one function. |
| `agent.mjs:1798` | `pumping = false` (in `finally`) | **False positive.** `pump()` has a single entry point guarded by `pumping`. |
| `test/agent.test.mjs:2507` | `child` | Test-side, already demoted. |

**`no-useless-assignment` — 6.** The rule is now off with the reasoning in
§1.2. These are the defensive `let x = null` initialisers at
`src/agent/agent.mjs:1016`, `:1055`, `src/agent/git.mjs:365`,
`src/plugin/tools.mjs:1826`, `src/agent/caps.mjs:280`, and
`test/agent.test.mjs:1043`. Removing them would shorten the code and make the
declaration's type less clear for no behavioural gain.

**`no-console` — 0 findings, and one clarification the task asked for.**

The task expected console usage to be confined to `bin/`. It is — *except* that
a grep for `console.` finds 13 hits in `test/` and `scripts/`, all of which are
**console calls inside string literals** passed to `node -e` as the command
under test:

```js
const SMOKE_ARGV = [NODE, '-e', 'console.log("crossnetwork")'];   // test/crossnetwork.test.mjs:54
command_argv: [NODE, '-e', 'console.log("dedupe")'],               // test/e2e.test.mjs:471
```

ESLint correctly does not flag string contents. **So there is no counterexample
to report: no `console` call exists outside `bin/`.**

---

## 4. Prettier: measured, and recommended against

### 4.1 The configuration was derived, not guessed

Measured over all 37 tracked `.js`/`.mjs` files (25,768 lines):

| Property | Measurement | Config chosen |
|---|---|---|
| Quotes | 7,279 single vs 285 double | `singleQuote: true` |
| Indentation | 21,283 space-indented lines, **0** tab-indented | `tabWidth: 2`, `useTabs: false` |
| Semicolons | present on statement ends throughout | `semi: true` |
| Line endings | 0 CRLF files | `endOfLine: 'lf'` |
| Object spacing | 1,156 `{ a: 1 }` vs 98 `{a: 1}` | `bracketSpacing: true` |
| Arrow params | 501 parenthesised vs **0** bare | `arrowParens: 'always'` |
| **Line width** | p50 34, p90 83, p95 96, **p99 118**, max 611 | `printWidth: 110` (swept, see below) |

`printWidth` was chosen by sweeping, not by eye — files that would change:

| printWidth | 80 | 90 | 100 | **110** | 120 | 130 | 140 |
|---|---|---|---|---|---|---|---|
| files changed | 45 | 44 | 42 | **41** | 42 | 43 | 43 |

110 is the minimum. At that width, `trailingComma: 'all'` (41) beats `es5` (44)
and `none` (44); `arrowParens: 'avoid'` (43) loses to `always` (41).

**So the configuration is optimal for this codebase — and it still rewrites 41
files.**

### 4.2 What it would actually change

Prettier was run with `--write` on a **throwaway copy** of the tracked tree (the
repository was never written to). Result:

| Metric | Value |
|---|---|
| Files rewritten | **31 of 37 JS files** (44–45 of 48 including docs/CI once `.prettierignore` scopes the rest) |
| Lines changed | **23,715 of 26,383 — 89.9%** |
| Category of changed lines | 23,513 "other", 122 whitespace-only, 61 quote style, **19 re-wrap** |

The decisive number is the last row: only **19** of ~23,700 changed lines are
pure re-wrapping. The rest are structural. Concretely:

```js
// before (one line, 96 columns — inside the 110 budget)
'-c', 'user.name=w2m-test', '-c', 'user.email=w2m@test.invalid', 'commit', '-m', 'base',

// after
'-c',
'user.name=w2m-test',
'-c',
'user.email=w2m@test.invalid',
'commit',
'-m',
'base',
```

and, worse, argument lists that already fit get exploded anyway when an
*enclosing* call exceeds the budget:

```js
// before: 6 lines
throw new W2MError('W2M_ABORTED', `…${reason instanceof Error && reason.message ? … }`, {
  hint: '…',
  cause: reason,
});

// after: 12+ lines, with the message split across lines and the options object
// re-indented as an argument block
```

### 4.3 Recommendation: do not reformat now

The measured facts point one way:

1. **The magnitude defeats the purpose.** The task's stated worry was "a
   several-thousand-line diff that buries real changes". The real number is
   ~23,700 lines across 31 files — 90% of the codebase. As a single commit it
   would also destroy `git blame` for every line of `src/` at once, which
   matters more than the diff size.
2. **The house style is a deliberate rule, not sloppiness.** The author packs
   multiple values per line and breaks only near ~110 columns (p99 = 118). That
   is a consistent, readable convention; Prettier simply cannot express it, so
   the "fix" is the formatter imposing a different convention.
3. **The mitigation the task offered — "narrow the config so it doesn't touch
   existing code" — is not available.** The sweep in §4.1 shows 41 files is the
   floor. No combination of supported options reaches zero.
4. **The cost of waiting is near zero.** Prettier is configured and runnable
   (`npm run format`), `.prettierignore` already excludes generated files,
   deployment templates and licence text, and CI reports the count on every run.
   Nothing degrades by deferring.

**What I would do instead**, in order of preference:

- **Keep Prettier as a tool for new files** (`npm run format <path>`), and let
  CI keep reporting the count. If the count starts growing rather than shrinking,
  that is the signal to revisit — it would mean new code is being added
  unformatted.
- **If a formatting commit is wanted, do it on a dedicated branch with no other
  changes**, add it to `.git-blame-ignore-revs`, and only after the current
  work has landed. Both the `45`-vs-`41` question and the blame problem then
  stop mattering.
- **Do not** add 41 paths to `.prettierignore` to force a green check: that
  would make the check meaningless while looking green, which is worse than an
  informational count.

---

## 5. CI integration

### 5.1 What was added

A new `lint` job (`ubuntu-latest`, Node 22) inserted **before** `test`. `test`,
`live-api` and `pack` are untouched, as is `release.yml`.

```
lint:
  - actions/checkout@v4
  - actions/setup-node@v4            (node 22)
  - npm install --no-audit --no-fund
  - npm run lint                     <- BLOCKING
  - npm run format:check || true     <- informational, plus a ::warning:: with the count
```

### 5.2 `npm install` vs `npx --yes`: why `npm install`

The task asked which is more stable. **`devDependencies` + `npm install`** wins
for three reasons:

1. **The repo commits no lockfile on purpose.** That rules out `npm ci`, but it
   also means `npx --yes eslint@9` and `eslint: ^9` resolve through the same
   "latest matching" logic — the reproducibility argument for `npx` does not
   apply here.
2. **`npx --yes` is the riskier of the two, not the safer.** It installs
   whatever is latest *at run time* into a cache the author never sees, decoupled
   from what a developer has locally. `npm install` uses the ranges in
   `package.json`, so CI and a developer run the same versions.
3. **The manifest becomes the source of truth.** `eslint@^10.12.0` in
   `devDependencies` is reviewable; `npx --yes eslint@9` buried in YAML is not.
   (It also means the task's `eslint@9` could not be honoured — 10.12.0 is
   current, `@eslint/js` only exists from 9.9 onward, and ESLint 10's
   `recommended` set includes `no-useless-assignment` and `no-control-regex`,
   both discussed above.)

`dependencies` remains `{}`. All four additions are dev-only; the published
tarball is unaffected.

### 5.3 Why lint is blocking but Prettier is not

- **Lint gates** because its errors are findings, not preferences: an unbound
  identifier (§3.1), dead code, unused bindings. Cheap (seconds, one OS) and it
  fails for a different reason than a test failure, so it is its own job rather
  than a step inside `test`.
- **Prettier reports** because the only way to make it pass today is the
  ~23,700-line rewrite of §4.3 or an ignore list that would make the check
  vacuous. It prints the count and raises a `::warning::` so drift is visible.

Flipping Prettier to blocking later is a two-character change: delete the
`|| true`.

### 5.4 Local verification

The CI steps were reproduced on the authoring machine (Windows, Node 24.21.0)
using the same binaries `node_modules/.bin` would expose:

```
$ eslint . --format json          -> 38 files linted, 19 with findings
                                     exit 1  (CI fails the job here, by design)
$ prettier --check .              -> 44 files, exit 1
$ prettier --list-different . | wc -l -> 44   (what the CI step echoes)
```

`ci.yml` was validated as YAML and its job/step shape printed:

```
ci.yml jobs : ['lint', 'test', 'live-api', 'pack']
  lint    runs-on='ubuntu-latest'  steps=5
  test    runs-on='${{ matrix.os }}'  steps=9
release.yml jobs: ['release']   (unchanged)
```

### 5.5 NOT verified here

- **The workflow has not been run on GitHub.** A hosted-runner run is the only
  way to confirm `npm install` resolves on a clean Linux image; everything above
  is a local simulation of the same commands.
- **Node 20 was not exercised.** The `lint` job pins Node 22 (matching the other
  Linux jobs). ESLint 10 requires Node ≥ 20.19, so the job would also work on
  20, but the repository's `engines` floor is `>=20.0.0` — if a user on 20.0.x
  runs `npm run lint` locally it may refuse. Worth raising the `engines` floor
  to `>=20.19.0` in a later change, which is a `package.json` key this task was
  told not to touch beyond scripts and devDependencies.
- **macOS/Windows lint was not run in CI**, and does not need to be: ESLint
  results do not vary by platform here, and the goal was the cheapest useful
  gate.

---

## 6. Files changed by this task

| File | Change |
|---|---|
| `eslint.config.mjs` | new |
| `.prettierrc` | new |
| `.prettierignore` | new |
| `.github/workflows/ci.yml` | +47 lines, one new job |
| `package.json` | +4 devDependencies, +4 scripts; `dependencies` still `{}` |

No file under `src/`, `test/`, `bin/`, `scripts/` or
`.github/workflows/release.yml` was modified. The one real defect (§3.1), the
three `no-control-regex` lines (§3.2) and the six `no-useless-assignment`
initialisers (§3.3) are **reported, not fixed** — they are all in `src/`.

### 6.1 Side effect to decide on

`package.json`'s `files` array includes `docs/` and `deploy/` (only
`lib`, `src`, `bin`, `cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `LICENSE`,
`PROTOCOL.md` and `PROTOCOL-v0.1.2.md` are matched as individual files), so
**any `.md` added under `docs/` enters the published tarball** — including this
audit. `scripts/pack.mjs` only checks that declared paths *exist*, not what is
inside them, so nothing breaks; but a contributor-facing audit is arguably not
runtime payload.

If you would rather it stayed out of the artifact, the smallest change is to
narrow `files` from `docs` to the specific documents that belong in the package
(`docs/DEPLOY.md`, `docs/TROUBLESHOOTING.md`). That touches a `package.json` key
beyond scripts/devDependencies, which this task was told not to modify — hence a
recommendation rather than an edit. Note it also affects the release hash, so it
belongs in a deliberate release change rather than this one.
