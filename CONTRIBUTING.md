# Contributing

One page. Everything here is a rule you can check, not a preference — if a line in this document
cannot be verified by reading the diff, it does not belong here.

## Setup

```bash
git clone https://github.com/TwinsEarth/dsh-windows2macos
cd dsh-windows2macos
npm install            # dev tools only: eslint, prettier, globals
node --version         # must satisfy package.json engines: >=20.19.0
```

There are **no runtime dependencies** — `dependencies` in `package.json` is `{}` and stays that way.
Adding one is a design change, not a convenience, and it will be refused. `@deepseek-ai/dsh-tools` is
an optional peer: the plugin imports it when DSH provides it and falls back to a small offline shim
when it does not, so the suites run with no Harness installed.

## The commands

```bash
# The unit suites (what scripts.test runs), and everything including e2e
node --test --test-force-exit test/relay.test.mjs test/broadcast.test.mjs test/agent.test.mjs
npm test
npm run test:all

# One suite while you work
node --test --test-force-exit test/claims.test.mjs

# Lint: must be 0 errors, and 0 warnings
node node_modules/eslint/bin/eslint.js .

# Entry points import: lib/tools.js and lib/index.js, the specifiers a profile mounts
node scripts/check-entrypoints.mjs

# The installed copy registers its tools (point it at a profile's node_modules copy)
node scripts/verify-installed.mjs <path-to-installed-package>
```

`scripts/check-entrypoints.mjs` proves the entry points **import**. It does not prove the loader
**composes** them — those are different failures, and the second one shipped once (v0.5.4: the entry
failed inside the real Loader and every tool disappeared while `verify-installed.mjs` passed). When
your change touches mounting, exports, `cordis.patch.yml` or the client half, run
`test/loader-entry.test.mjs` too: it installs the packed tarball with `dsh plugin add` into a
throwaway profile under a throwaway `DSH_HOME` and boots it with the real `runProfile`.

## Conventions

Each line is checkable against a diff.

1. **Zero runtime dependencies.** `dependencies === {}` in `package.json`. Node built-ins only.
2. **Argv execution, never a shell string.** A command is an array of arguments passed to
   `spawn`/`execFile` with no shell. No `exec`, no `shell: true`, no string interpolation into a
   command line. This is what makes the allow-list meaningful: a shell would re-parse the argv the
   allow-list just approved.
3. **One named constant per network bound.** Every timeout, port, retry count, size limit and
   interval is a named `const` in one place, exported if a test needs it. A literal `5000` in a
   request call is a review comment.
4. **A failure carries a reason code, not a boolean.** `{ ok: false, code: 'W2M_UNREACHABLE', ... }`
   or a thrown error with `code` — never `false`, never `null`, never a bare string. `undefined` may
   mean "absent"; it may not mean "failed".
5. **Commit format: `<type>: <one line>`.** Types: `feat`, `fix`, `docs`, `test`, `chore`, `perf`,
   `refactor`, `build`, `ci`. One line, imperative, no trailing period; put the argument for the
   change in the body, not in the subject.
6. **Docs changes are code changes.** If a claim in `README.md`, `PROTOCOL.md` or a deploy guide is
   now false, fix it in the same PR. `test/claims.test.mjs` gates the machine-checkable subset.
7. **A test that would pass against a broken artifact is not evidence.** See below.
8. **Say what you verified, and how.** In the PR: what was run live, what was covered by a test, and
   what is not verified at all. "Not verified" is an acceptable answer; an implied verification is
   not.

## Rule 7, in full: prefer the real runtime to a stand-in

This project learned it the hard way. The v0.5.4 loader failure was invisible to **every** existing
test, because those tests drove the plugin with a plain-object context where reading an undeclared
service property merely yields `undefined`. The real Loader throws instead. The fake was more
forgiving than the runtime, so the suite was green while the shipped artifact broke the application.

Therefore:

- **Drive the real thing when the real thing is reachable.** The entry points, the packed tarball,
  the real Loader, a real pnpm install into a throwaway profile, the real `fetch` against a local
  server. `test/loader-entry.test.mjs` exists precisely to pay this cost once.
- **When a stand-in is unavoidable, prove it in both directions.** A fix is not demonstrated by a
  green test alone. Take the broken artifact, keep it, and show the new test **fails** against it —
  then show it passes against the fix. `test/loader-entry.test.mjs` does this: 6/6 pass on the fixed
  tree and 6/6 fail against the preserved v0.5.4 tarball, on the exact loader error.
- **Make the fake stricter than the runtime, never more forgiving.** If your stub silently accepts
  something the runtime throws on, the test is measuring your stub.
- **A skip must be loud and must name what it could not reach.** A test that quietly returns when a
  probe is missing is worse than no test: it reports confidence it does not have. Say which probe you
  tried and how to enable it.
- **Fix a claim's drift at its source.** If a document, a count or a version is wrong, correct it
  rather than exempting it in the test that caught it. An exemption list is where a gate goes to die.

## Pull requests

1. **Branch** off `main`; do not commit to `main`.
2. **Keep it one idea.** A rename plus a behaviour change plus a doc rewrite is three PRs.
3. **Run before you push**, and paste the real output into the PR:

   ```bash
   npm test
   node node_modules/eslint/bin/eslint.js .
   node scripts/check-entrypoints.mjs
   ```

4. **Describe verification, not effort.** The PR body answers: what changed, what proves it, what is
   not proven, and which commands you ran with their result counts.
5. **Add a CHANGELOG entry** under the version you are working on, in the existing style. A behaviour
   change with no CHANGELOG line will be sent back.
6. **Reviewers check the conventions list above**, line by line, against the diff. Expect to be asked
   "which constant?", "which code?", "what did you run?".
7. **A version that must not be installed gets marked.** If a release is broken after publication,
   add `DO NOT INSTALL` to its CHANGELOG entry, in its own section, and say why. `test/claims.test.mjs`
   reads that marker: it refuses to let the current version be one the CHANGELOG tells users not to
   install.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md) for the private
channel and what to include.
