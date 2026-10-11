/**
 * Release pre-flight: the gate that runs *before* a version bump.
 *
 * WHY THIS FILE EXISTS
 *
 * In one hour this repository published three versions, each fixing a defect the previous one
 * introduced: v0.5.6 shipped without its own two documents in the package and without its new suites
 * wired into `test`/`test:all`/`verify`; v0.5.7 fixed that, but the CHANGELOG was out of order;
 * v0.5.8 fixed the order and a mojibake in a packed file. Every one of those defects was found
 * **after** the tag was pushed, by a gate that already existed and was simply never run before the
 * release. The process had no pre-flight of its own. A gate nobody runs before publishing is not a
 * gate; it is a post-mortem.
 *
 * So this script is the release process, in the order a release needs it:
 *
 *   1. assert that the gate itself ran            (9 checks, each with a named result)
 *   2. lint: 0 errors
 *   3. mojibake scan: clean over the whole tree
 *   4. the suite declared in package.json#scripts.test
 *   5. pack, then assert against the *packed tarball* -- not the tree
 *   6. the claims that need the tree and the documents (test/claims.test.mjs)
 *   7. a summary line naming counts and the verdict
 *
 * THE RULE THAT MATTERS MOST: A CHECK THAT PRODUCES NO RESULT IS A FAILURE.
 *
 * This comes from a study of a project whose self-authored gate once reported success while
 * executing zero checks, because a group name was double-encoded and the selector matched nothing.
 * "The gate ran" is itself a claim, so it is checked twice over: `run()` counts the results it
 * collected and compares that to the number of registered checks, and the ledger is then *exercised*
 * by `checkLedgerCatchesSilence()`, which feeds it a silent check, a throwing check and an honest one
 * and requires FAIL/FAIL/PASS. A check that returns nothing, or throws before returning, is recorded
 * as a FAIL naming itself -- never silently dropped, never counted as a pass. A PASS also carries the
 * measurement it is based on, because "PASS" with no number is indistinguishable from "PASS" with no
 * work.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 *
 * Nothing here touches git, tags, pushes or the network. This is a *local* pre-flight: it decides
 * whether the tree is fit to bump. The one network-dependent claim in this repository (that the
 * published tarball assets exist on GitHub) is out of scope on purpose, and `test/claims.test.mjs`
 * reports it as a loud skip naming the URL it could not reach -- see UNVERIFIABLE below.
 *
 * UNVERIFIABLE
 *
 * A check may report UNVERIFIABLE instead of PASS or FAIL only when it cannot be measured *here*
 * (a missing host prerequisite, an absent optional tool). An UNVERIFIABLE result does **not** fail
 * the run -- a pre-flight that is permanently red on its author's own machine for an environmental
 * reason is a gate people learn to ignore -- but it is printed in the same block as the verdict, it
 * is counted, and it names the exact thing that could not be measured. It never counts as a pass:
 * "I could not check" and "I checked and it is fine" are different sentences, and this script keeps
 * them different.
 *
 * Usage:
 *   node scripts/preflight.mjs
 *
 * Exit code: 0 when every check PASSed (UNVERIFIABLE allowed, and reported), 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ESLINT = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

/** The package under test, read once. A manifest that will not parse is a hard stop. */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Wall-clock ceiling for the declared suite. Measured at ~150 s on the release machine. */
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
/** Wall-clock ceiling for everything else; all of it is local and fast. */
const SHORT_TIMEOUT_MS = 5 * 60 * 1000;
/** Where the shipped tarball is written. `test/claims.test.mjs` reads this directory too. */
const DIST_DIR = join(ROOT, 'dist');

/* --------------------------------------------------------------------------------------------- */
/* Result plumbing: three verdicts, and "no verdict" is not one of them                           */
/* --------------------------------------------------------------------------------------------- */

/** @typedef {{status: 'PASS'|'FAIL'|'UNVERIFIABLE', reason: string, note?: string}} Verdict */

const pass = (reason, note) => ({ status: 'PASS', reason, note });
const fail = (reason, note) => ({ status: 'FAIL', reason, note });
const unverifiable = (reason, note) => ({ status: 'UNVERIFIABLE', reason, note });

const ICON = { PASS: 'PASS  ', FAIL: 'FAIL  ', UNVERIFIABLE: 'UNVERIF' };

/**
 * Run every registered check, in order.
 *
 * The load-bearing part is the count comparison at the end. A check whose return value is lost --
 * because a group selector matched nothing, because a refactor dropped the `return`, because a
 * promise was not awaited -- shows up here as a FAIL that names the check, rather than as one fewer
 * line of output that nobody notices.
 *
 * @param {Array<{name: string, run: () => Promise<Verdict>|Verdict}>} checks
 * @param {{silent?: boolean}} [options] `silent` suppresses the per-check lines; the ledger and the
 *   count assertion are unchanged. Used only by the self-test below.
 * @returns {Promise<{results: Array<{name: string, verdict: Verdict}>, missing: string[]}>}
 */
async function run(checks, options = {}) {
  const results = [];
  for (const check of checks) {
    let verdict = null;
    try {
      const returned = await check.run();
      // Only a returned verdict counts as *produced*. Anything else -- `undefined`, a bare string, a
      // resolved promise with no value -- is coerced into a FAIL below, and the ledger records that it
      // was coerced, so "this check failed" and "this check never reported" cannot be confused for one
      // another. That distinction is the whole reason this file exists; the first version of it lost
      // the distinction and the self-test caught it.
      if (returned && typeof returned.status === 'string') verdict = returned;
    } catch (error) {
      verdict = fail(`threw before reporting: ${error?.stack ?? String(error)}`);
      results.push({ name: check.name, verdict, produced: false });
      if (!options.silent) printVerdict(check.name, verdict);
      continue;
    }

    const produced = verdict !== null;
    if (!produced) {
      verdict = fail(
        `produced no result at all (got ${JSON.stringify(verdict)}). A check that cannot report a ` +
          'verdict is treated as failed, because "no result" and "fine" must never look alike.',
      );
    }
    results.push({ name: check.name, verdict, produced });
    if (!options.silent) printVerdict(check.name, verdict);
  }

  // The assertion that the gate ran: every registered check must have *produced* exactly one verdict.
  const counted = new Map();
  for (const { name, produced } of results) {
    if (produced) counted.set(name, (counted.get(name) ?? 0) + 1);
  }
  const missing = checks
    .filter((c) => counted.get(c.name) !== 1)
    .map((c) => `${c.name} (${counted.get(c.name) ?? 0} result(s), expected exactly 1)`);
  if (checks.length !== results.length) {
    missing.push(
      `the collector registered ${checks.length} check(s) but collected ${results.length} result(s)`,
    );
  }
  if (missing.length > 0) {
    if (!options.silent) {
      for (const name of missing) {
        process.stdout.write(`  FAIL    preflight self-assertion: no result from ${name}\n`);
      }
    }
    results.push({
      name: 'preflight self-assertion (every check reported)',
      verdict: fail(`${missing.length} check(s) produced no result: ${missing.join('; ')}`),
    });
  }
  return { results, missing };
}

/** One check's line, plus its note indented underneath. */
function printVerdict(name, verdict) {
  process.stdout.write(`  ${ICON[verdict.status] ?? 'FAIL  '}  ${name}: ${verdict.reason}\n`);
  if (verdict.note) {
    for (const noteLine of String(verdict.note).split('\n')) {
      process.stdout.write(`          ${noteLine}\n`);
    }
  }
}

/**
 * Check the checker: run the real ledger over checks that are deliberately silent, and require it to
 * notice.
 *
 * The rule this file is built around -- a check that produces no result is a failure -- is itself only
 * a claim until something falsifies it. So the ledger is exercised once per run against three
 * synthetic checks: one that returns nothing (the double-encoded group selector, in miniature), one
 * that throws, and one that passes. The requirement is exact: the silent and the throwing check must
 * each have produced a FAIL, the honest check a PASS, and the run's own `missing` list must be
 * non-empty. If a future refactor makes the ledger forgiving -- the classic way a self-authored gate
 * starts reporting success while executing nothing -- this check goes red instead.
 */
async function checkLedgerCatchesSilence() {
  const probe = await run(
    [
      { name: 'selftest: a check that returns no result', run: () => undefined },
      { name: 'selftest: a check that throws', run: () => { throw new Error('deliberate'); } },
      { name: 'selftest: an honest check', run: () => pass('this one reported') },
    ],
    { silent: true },
  );

  const status = (name) => probe.results.find((r) => r.name === name)?.verdict.status ?? '(no result)';
  const silentStatus = status('selftest: a check that returns no result');
  const throwStatus = status('selftest: a check that throws');
  const honestStatus = status('selftest: an honest check');
  const ledgerStatus = status('preflight self-assertion (every check reported)');

  const problems = [];
  if (silentStatus !== 'FAIL') problems.push(`a check returning nothing was recorded as ${silentStatus}`);
  if (throwStatus !== 'FAIL') problems.push(`a check that threw was recorded as ${throwStatus}`);
  if (honestStatus !== 'PASS') problems.push(`an honest check was recorded as ${honestStatus}`);
  if (ledgerStatus !== 'FAIL') problems.push(`the run-level self-assertion was recorded as ${ledgerStatus}`);
  if (probe.missing.length !== 2) {
    problems.push(`the missing list held ${probe.missing.length} entr(ies), expected 2: ${probe.missing.join('; ')}`);
  }

  const detail =
    `silent->${silentStatus}, throwing->${throwStatus}, honest->${honestStatus}, ` +
    `run self-assertion->${ledgerStatus}, missing=${probe.missing.length}`;
  if (problems.length > 0) {
    return fail(`the ledger did not catch a check that reports nothing: ${problems.join('; ')}`, detail);
  }
  return pass('a silent check, a throwing check and an honest one were classified FAIL/FAIL/PASS', detail);
}

/* --------------------------------------------------------------------------------------------- */
/* Process helper                                                                                 */
/* --------------------------------------------------------------------------------------------- */

/**
 * Run one child process and capture its output.
 *
 * `spawnSync` with an argv array and `shell: false`: no shell string is ever built from a filename.
 *
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, error: Error|null, command: string}}
 */
function child(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? SHORT_TIMEOUT_MS,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
    command: `${label}: ${command} ${args.join(' ')}`,
  };
}

/** The tail of a child's output, for a reason string a human can act on. */
function tail(result, lines = 8) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const all = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return all.slice(-lines).join('\n');
}

/* --------------------------------------------------------------------------------------------- */
/* Test-suite plumbing: the script is the source of truth, and its wiring is checked              */
/* --------------------------------------------------------------------------------------------- */

/** Every token in a script's command line that looks like a test file. */
function scriptTestFiles(scriptText) {
  return (scriptText.match(/\S+\.test\.mjs/g) ?? []).map((t) => t.replace(/^\.\//, ''));
}

/**
 * Check 4a: the wiring itself.
 *
 * The command in `package.json#scripts.test` is a *claim* that those suites are the release suite.
 * Two ways that claim goes quietly false, both measured in this repository:
 *
 *   * a path in the script does not exist -- v0.5.7's edit wired the new suites in and dropped a
 *     space, producing `test/claims.test.mjstest/fleet-target.test.mjs`. `node --test` exits 1 on a
 *     missing path, but *only if someone runs it*; the defect shipped.
 *   * a suite exists and is named by no script at all -- `test/p2p-crypto.test.mjs` (33 tests) was
 *     in that state. A test that never runs protects nothing, which is precisely the defect v0.5.7's
 *     own release note identified in someone else's repository.
 */
function checkTestWiring() {
  const scripts = MANIFEST.scripts ?? {};
  const declared = new Map();
  for (const [name, text] of Object.entries(scripts)) {
    for (const file of scriptTestFiles(String(text))) {
      if (!declared.has(file)) declared.set(file, []);
      declared.get(file).push(name);
    }
  }

  const onDisk = readdirSync(join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => `test/${f}`)
    .sort();

  const missingOnDisk = [...declared.keys()].filter((f) => !existsSync(join(ROOT, f))).sort();
  const neverRun = onDisk.filter((f) => !declared.has(f));

  const counts =
    `test/*.test.mjs on disk: ${onDisk.length}; named by at least one npm script: ` +
    `${onDisk.length - neverRun.length}; distinct paths named: ${declared.size}; ` +
    `paths named but absent: ${missingOnDisk.length}`;

  if (missingOnDisk.length > 0) {
    return fail(
      `${missingOnDisk.length} path(s) named by an npm script do not exist: ${missingOnDisk.join(', ')}. ` +
        'A command line that names a missing file is a suite that does not run.',
      counts,
    );
  }
  if (neverRun.length > 0) {
    return fail(
      `${neverRun.length} suite(s) exist but no npm script names them: ${neverRun.join(', ')}. ` +
        'A test that does not run protects nothing.',
      counts,
    );
  }
  return pass('every suite on disk is named by a script, and every path named exists', counts);
}

/** Parse the `node --test` spec-reporter summary. */
function parseTestCounts(stdout) {
  const pick = (label) => {
    const match = stdout.match(new RegExp(`^\\u2139 ${label} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    skipped: pick('skipped'),
  };
}

/**
 * Delete tarballs in `dist/` that name a version other than the tree's, and say which.
 *
 * `test/claims.test.mjs` asserts that *every* `.tgz` in `dist/` names the tree's version, so a tarball
 * left behind by the previous release turns that suite red the moment the version is bumped. It is
 * also how "which file did you publish?" gets two answers. Called before the suite (so the assertion
 * measures the current version, not last release's artifact) and again after packing.
 *
 * @returns {string[]} The filenames removed.
 */
function clearStaleDistArtifacts() {
  if (!existsSync(DIST_DIR)) return [];
  const current = `twinsearth-w2m-dsh-plugin-${MANIFEST.version}.tgz`;
  const stale = readdirSync(DIST_DIR)
    .filter((f) => f.endsWith('.tgz') && f !== current)
    .sort();
  for (const name of stale) rmSync(join(DIST_DIR, name), { force: true });
  return stale;
}

/**
 * Check 4b: run the declared suite.
 *
 * The file list is taken from `package.json#scripts.test` itself rather than restated here, so a
 * suite added to the release suite is run by the pre-flight with no second edit. The argv is built
 * by hand (`process.execPath` + `--test`) instead of by shelling out to the package manager: the
 * same files, but the exit status and the counts stay ours to read.
 *
 * @param {{env: Record<string,string>, note: string}} suiteEnv Environment shaping from
 *   `prepareSuiteEnv()`, applied to the child and reported alongside the verdict either way.
 */
function checkTestSuite(suiteEnv) {
  const text = String(MANIFEST.scripts?.test ?? '');
  if (text === '') return fail('package.json declares no scripts.test, so there is no declared suite');

  const files = scriptTestFiles(text);
  if (files.length === 0) return fail('scripts.test names no *.test.mjs file; the declared suite is empty');
  for (const file of files) {
    if (!existsSync(join(ROOT, file))) return fail(`scripts.test names a path that does not exist: ${file}`);
  }

  // Make `dist/` coherent with the tree *before* the suite runs, because `test/claims.test.mjs` asserts
  // that every tarball in `dist/` names the tree's version. Right after a version bump, `dist/` still
  // holds the previous release's artifact and that assertion fails -- correctly, and with a message
  // about an artifact nobody intended to ship. `dist/` is generated output; the pack step later in
  // this run rebuilds it at the current version, and before the bump the rebuild is a no-op.
  const removed = clearStaleDistArtifacts();

  const started = Date.now();
  const result = child('test', process.execPath, ['--test', '--test-force-exit', ...files], {
    timeoutMs: TEST_TIMEOUT_MS,
    env: suiteEnv.env,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const counts = parseTestCounts(result.stdout);

  // Both directions are required. The exit status is the runner's verdict; the counts prove the
  // runner was pointed at something, which is the difference between "0 tests, 0 failures" and green.
  if (counts.tests === null || counts.tests === 0) {
    return fail(
      `the runner reported no test count, so nothing can be said about whether the suite ran. ` +
        `${result.command} exited ${result.status}`,
      tail(result),
    );
  }
  if (!result.ok || (counts.fail ?? 0) > 0) {
    return fail(
      `${counts.fail ?? '?'} of ${counts.tests} test(s) failed via scripts.test (exit ${result.status})`,
      tail(result, 25),
    );
  }
  return pass(
    `${counts.tests} test(s) in ${files.length} file(s): ${counts.pass} pass, ${counts.fail} fail, ` +
      `${counts.skipped} skip, ${seconds}s`,
    `declared by package.json#scripts.test\n${suiteEnv.note}\nfiles: ${files.join(' ')}` +
      (removed.length > 0
        ? `\nremoved ${removed.length} stale tarball(s) from dist/ before the run, so the tarball ` +
          `assertions measured ${MANIFEST.version}: ${removed.join(', ')}`
        : ''),
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Tarball plumbing: written here, read here, never extracted with a dependency                   */
/* --------------------------------------------------------------------------------------------- */

const BLOCK = 512;

/**
 * Read a gzipped tarball into entries, with the bytes of regular files.
 *
 * The packer (`scripts/pack.mjs`) writes ustar headers with a fixed 512-byte layout, so this reader
 * needs exactly that: name (100) + prefix (155) for paths over 100 bytes, the octal size at 124, and
 * the type flag at 156. Nothing is extracted to disk by this function.
 *
 * @param {Buffer} gz
 * @returns {Array<{name: string, type: string, data: Buffer|null}>}
 */
function tarEntries(gz) {
  const buf = gunzipSync(gz);
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const name = buf.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    if (name === '') {
      offset += BLOCK;
      continue;
    }
    const prefix = buf.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/, '');
    const size = parseInt(
      buf
        .toString('utf8', offset + 124, offset + 136)
        .replace(/\0.*$/, '')
        .trim() || '0',
      8,
    );
    const type = buf.toString('utf8', offset + 156, offset + 157);
    const dataLength = Number.isFinite(size) ? size : 0;
    const full = prefix === '' ? name : `${prefix}/${name}`;
    entries.push({
      name: full,
      type,
      data: type === '0' || type === '\0' ? buf.subarray(offset + BLOCK, offset + BLOCK + dataLength) : null,
    });
    offset += BLOCK + Math.ceil(dataLength / BLOCK) * BLOCK;
  }
  return entries;
}

/** Every file the `files` globs expand to in the tree, as package-relative POSIX paths. */
function expectedPackedFiles() {
  const collected = [];
  const walk = (abs, rel) => {
    const info = statSync(abs);
    if (info.isDirectory()) {
      for (const childName of readdirSync(abs).sort()) {
        walk(join(abs, childName), `${rel}/${childName}`);
      }
      return;
    }
    if (info.isFile()) collected.push(rel);
  };
  for (const entry of MANIFEST.files ?? []) {
    const abs = join(ROOT, entry);
    if (existsSync(abs)) walk(abs, entry.replace(/^\.\//, ''));
  }
  // The packer always adds these when present, whether or not `files` names them.
  for (const name of ['package.json', 'README.md', 'LICENSE']) {
    const rel = name;
    if (existsSync(join(ROOT, name)) && !collected.includes(rel)) collected.push(rel);
  }
  return collected.sort();
}

/** The condition a packed path must never satisfy. */
const FORBIDDEN = [
  { label: 'node_modules', test: (p) => p === 'node_modules' || p.startsWith('node_modules/') },
  { label: 'test/', test: (p) => p === 'test' || p.startsWith('test/') },
  { label: 'scripts/', test: (p) => p === 'scripts' || p.startsWith('scripts/') },
  { label: '.git', test: (p) => p === '.git' || p.startsWith('.git/') },
  { label: '*.proof-backup', test: (p) => p.endsWith('.proof-backup') },
  { label: '*.orig', test: (p) => p.endsWith('.orig') },
  { label: '*.bak', test: (p) => p.endsWith('.bak') },
  { label: '.github/', test: (p) => p === '.github' || p.startsWith('.github/') },
];

/**
 * Write the packed files to a directory so the *packed copy* can be executed -- not the tree.
 *
 * Every path is rejected unless it stays inside the destination. The packer cannot emit such an
 * entry today; the check exists so that a future change to the packer cannot turn this reader into
 * a write-anywhere primitive.
 */
function extract(entries, destination) {
  const skipped = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('package/')) {
      skipped.push(`${entry.name} (outside package/)`);
      continue;
    }
    const rel = entry.name.slice('package/'.length);
    const parts = rel.split('/');
    if (rel === '' || rel.includes('\0') || parts.some((p) => p === '..' || p === '') || /^[A-Za-z]:/.test(rel)) {
      skipped.push(`${entry.name} (unsafe path)`);
      continue;
    }
    const target = resolve(destination, rel.split('/').join(sep));
    if (!target.startsWith(resolve(destination) + sep)) {
      skipped.push(`${entry.name} (escapes the destination)`);
      continue;
    }
    if (entry.data === null) {
      skipped.push(`${entry.name} (not a regular file)`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  return skipped;
}

/* --------------------------------------------------------------------------------------------- */
/* The checks                                                                                     */
/* --------------------------------------------------------------------------------------------- */

/**
 * The environment the declared suite runs in.
 *
 * `test/agent.test.mjs` asserts a claim about the *artifact's* resolver contract: PATH first, then
 * `%DSH_HOME%/dsh-runtimes/<runtime>/dependencies` (`src/agent/resolve.mjs`, `DSH_RUNTIME_RELATIVE`).
 * On this host that directory does not exist -- the application bundle carries the runtime at
 * `E:\DS\resources\runtime\primary-runtime\dependencies` instead -- so the probe honestly reports no
 * bundled python and the suite fails for a reason that is about the host's packaging, not about the
 * code under release. The suite therefore runs against a throwaway home containing exactly the
 * layout the resolver documents, and BOTH facts are printed: which home was used, and what this host
 * actually has (as a named, non-blocking UNVERIFIABLE). A simulated layout that is not announced is
 * worse than no check at all.
 */
function prepareSuiteEnv() {
  const home = join(tmpdir(), 'w2m-preflight-dsh-home');
  const runtimes = join(home, 'dsh-runtimes');
  const runtime = join(runtimes, 'dsh-primary-runtime');
  const hostHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '~', '.dsh');
  const candidates = [
    process.env.W2M_PREFLIGHT_RUNTIME_DIR,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DSH', 'runtime', 'primary-runtime'),
    'E:\\DS\\resources\\runtime\\primary-runtime',
  ].filter(Boolean);
  const source = candidates.find((dir) => existsSync(join(dir, 'dependencies'))) ?? null;

  let shaped = false;
  let why = 'no bundled runtime layout was found on this machine to shape a home from';
  if (source !== null) {
    try {
      // Rebuild from scratch each run: a junction left by a previous run makes `mklink` fail, and a
      // pre-flight that silently stops shaping the environment after its first success is exactly the
      // kind of quiet drift this script exists to prevent.
      rmSync(runtime, { recursive: true, force: true });
      mkdirSync(runtimes, { recursive: true });
      const link = spawnSync(
        process.platform === 'win32' ? 'cmd' : 'ln',
        process.platform === 'win32' ? ['/c', 'mklink', '/J', runtime, source] : ['-sfn', source, runtime],
        { encoding: 'utf8', shell: false },
      );
      shaped = existsSync(join(runtime, 'dependencies'));
      if (!shaped) why = `could not link ${runtime} -> ${source}: ${(link.stderr ?? '').trim() || `exit ${link.status}`}`;
    } catch (error) {
      shaped = false;
      why = `could not link ${runtime} -> ${source}: ${error?.message ?? String(error)}`;
    }
  }

  return {
    env: shaped ? { DSH_HOME: home } : {},
    note: shaped
      ? `DSH_HOME for the suite: ${home} (throwaway, built for this run); ` +
        `dsh-runtimes/dsh-primary-runtime -> ${source}`
      : `DSH_HOME for the suite: the host environment -- ${why}`,
    shaped,
    home,
    source,
    hostReason:
      `this host's DSH_HOME (${hostHome}) contains no dsh-runtimes/; the application bundle carries the ` +
      `runtime at ${source ?? 'E:\\DS\\resources\\runtime\\primary-runtime'}\\dependencies instead; the ` +
      'resolver expects DSH_RUNTIME_RELATIVE = dsh-runtimes/dsh-primary-runtime/dependencies ' +
      '(src/agent/resolve.mjs), so probeCaps() honestly finds no bundled python on this host. ' +
      (shaped
        ? `The suite is therefore run against the throwaway home above, so this environmental fact does ` +
          'not masquerade as a failure of the artifact. That home is NOT this machine: a PASS from the ' +
          'suite says the resolver honours its documented layout, not that the host has it.'
        : `No throwaway home could be built (${why}), so the suite ran against the host and its claim ` +
          'about the bundled runtime was measured against whatever this host actually has.'),
  };
}

/** Step 1's own precondition, stated as a check: the lint entry point is really there. */
function checkGateInventory() {
  const lintPresent = existsSync(ESLINT);
  const scannerPresent = existsSync(join(ROOT, 'scripts', 'scan-mojibake.mjs'));
  const packerPresent = existsSync(join(ROOT, 'scripts', 'pack.mjs'));
  const installerProbe = existsSync(join(ROOT, 'scripts', 'verify-installed.mjs'));
  const claimsPresent = existsSync(join(ROOT, 'test', 'claims.test.mjs'));

  const problems = [];
  if (!lintPresent) problems.push(`eslint entry point missing: ${ESLINT}`);
  if (!scannerPresent) problems.push('scripts/scan-mojibake.mjs missing');
  if (!packerPresent) problems.push('scripts/pack.mjs missing');
  if (!installerProbe) problems.push('scripts/verify-installed.mjs missing');
  if (!claimsPresent) problems.push('test/claims.test.mjs missing');

  const inventory =
    `eslint=${lintPresent ? 'present' : 'MISSING'}; scan-mojibake=${scannerPresent ? 'present' : 'MISSING'}; ` +
    `pack=${packerPresent ? 'present' : 'MISSING'}; verify-installed=${installerProbe ? 'present' : 'MISSING'}; ` +
    `claims=${claimsPresent ? 'present' : 'MISSING'}`;

  if (problems.length > 0) {
    return fail(`a gate this pre-flight depends on is not on disk: ${problems.join('; ')}`, inventory);
  }
  return pass('every gate this pre-flight delegates to exists on disk', inventory);
}

function checkLint() {
  if (!existsSync(ESLINT)) return fail(`no eslint at ${ESLINT}; run npm install (dev tools only)`);
  const result = child('lint', process.execPath, [ESLINT, '.'], { timeoutMs: TEST_TIMEOUT_MS });
  const summary = result.stdout.match(/(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  const errors = summary ? Number(summary[2]) : null;
  const warnings = summary ? Number(summary[3]) : null;

  if (!summary) {
    return fail(
      `eslint printed no problem summary, so the run cannot be read (exit ${result.status}). ` +
        'An unreadable gate result is not a pass.',
      tail(result),
    );
  }
  if (errors !== 0 || !result.ok) {
    return fail(`${errors} lint error(s) (${warnings} warning(s))`, tail(result, 20));
  }
  return pass(`0 errors, ${warnings} warnings`, `eslint: ${ESLINT}`);
}

function checkMojibake() {
  const scanner = join(ROOT, 'scripts', 'scan-mojibake.mjs');
  if (!existsSync(scanner)) return fail(`no scanner at ${scanner}`);
  const result = child('mojibake', process.execPath, [scanner]);
  const clean = /clean: no mojibake detected/.test(result.stdout);
  if (!result.ok || !clean) {
    return fail(
      `the scanner reported mojibake (exit ${result.status}); every offending file is named below`,
      tail(result, 20),
    );
  }
  // The scanner's own success text is required as well as its exit code: a run that produced no
  // output at all would otherwise be read as "found nothing".
  return pass('clean over the whole tree (exit 0 and the scanner said so)', result.stdout.trim());
}

function checkPackAndTarball() {
  const packer = join(ROOT, 'scripts', 'pack.mjs');
  if (!existsSync(packer)) return fail(`no packer at ${packer}`);

  const staging = mkdtempSync(join(tmpdir(), 'w2m-preflight-pack-'));
  try {
    // Pack into `dist/`, the directory the release artifact is taken from, and check that directory
    // against the tarball just built. Writing the artifact into the tree is deliberate: a pre-flight
    // that verifies a tarball nobody ships has verified the wrong file. `dist/` is generated output
    // and is gitignored, so this adds no tracked change.
    mkdirSync(DIST_DIR, { recursive: true });
    const distTarball = join(DIST_DIR, `twinsearth-w2m-dsh-plugin-${MANIFEST.version}.tgz`);
    const first = child('pack', process.execPath, [packer, '--out', DIST_DIR], { timeoutMs: TEST_TIMEOUT_MS });
    if (!first.ok) return fail(`scripts/pack.mjs failed (exit ${first.status})`, tail(first, 20));
    if (!existsSync(distTarball)) {
      return fail(
        `the packer wrote no twinsearth-w2m-dsh-plugin-${MANIFEST.version}.tgz into dist/; the artifact ` +
          'under test is not the artifact that was packed',
        tail(first, 20),
      );
    }

    // A second, independent pack of the same sources must produce the same bytes. This is what makes
    // a published sha256 a statement about the sources rather than about when the command ran.
    const second = child('pack', process.execPath, [packer, '--out', staging, '--check', distTarball]);
    if (!second.ok) return fail('packing the same sources twice produced different bytes', tail(second, 20));

    const gz = readFileSync(distTarball);
    const entries = tarEntries(gz);
    if (entries.length === 0) return fail('the packed tarball listed no entries; the tar reader has drifted');

    const packedNames = entries.filter((e) => e.data !== null).map((e) => e.name);
    // Strip the npm layout prefix by *length*, not with `replace(/^package\//, '')`. The two agree on
    // every path this packer can emit, but the prefix is a fixed eight bytes and saying so removes the
    // question; an earlier draft of this file stripped a literal `package` and turned the entry
    // `package/package.json` into `.json`, which made the "files[] complete" check report a missing
    // file that was present. Measured, and the reason this reads the way it does.
    const packedRel = new Set(packedNames.map((n) => n.slice('package/'.length)));

    // (a) every path package.json#files names is inside the tarball
    const expected = expectedPackedFiles();
    const missing = expected.filter((rel) => !packedRel.has(rel));
    if (missing.length > 0) {
      return fail(
        `${missing.length} path(s) from package.json#files are absent from the packed tarball: ` +
          `${missing.join(', ')}`,
        `packed ${packedNames.length} file(s); expected ${expected.length}`,
      );
    }

    // (b) the packed manifest is the tree's manifest
    const manifestEntry = entries.find((e) => e.name === 'package/package.json');
    if (!manifestEntry || manifestEntry.data === null) {
      return fail('the tarball contains no package/package.json, so it declares nothing');
    }
    const packedManifest = JSON.parse(manifestEntry.data.toString('utf8'));
    if (packedManifest.version !== MANIFEST.version) {
      return fail(
        `the packed package.json says ${packedManifest.version} while the tree says ${MANIFEST.version}; ` +
          '"which artifact did you install?" would have two answers',
      );
    }

    // (c) nothing forbidden is inside it
    const forbidden = [];
    for (const rel of packedRel) {
      for (const rule of FORBIDDEN) {
        if (rule.test(rel)) forbidden.push(`${rel} (${rule.label})`);
      }
    }
    if (forbidden.length > 0) {
      return fail(
        `the packed tarball carries ${forbidden.length} forbidden path(s): ${forbidden.slice(0, 10).join(', ')}`,
      );
    }

    // (d) the packed copy registers the eight tools -- executed from the extracted tarball, not the tree
    const extracted = join(staging, 'extracted');
    mkdirSync(extracted, { recursive: true });
    const skipped = extract(entries, extracted);
    if (skipped.length > 0) return fail(`refused to extract ${skipped.length} tarball entry(ies): ${skipped.join(', ')}`);

    const probe = join(ROOT, 'scripts', 'verify-installed.mjs');
    if (!existsSync(probe)) return fail(`no installed-copy probe at ${probe}`);
    // `extracted` is already the package root: the tarball's `package/` prefix is stripped on the way
    // out, exactly as npm strips it on install. Pointing the probe one level deeper finds no
    // `lib/tools.js`, which is a bug in this call and not a fact about the artifact.
    const verified = child('verify-installed', process.execPath, [probe, extracted]);
    if (!verified.ok) {
      return fail(
        'scripts/verify-installed.mjs reported the packed copy does not register its eight tools',
        tail(verified, 20),
      );
    }
    // `verify-installed.mjs` already compares the registered names to its own expected list and exits
    // non-zero on a mismatch. The count is parsed as well, and asserted here, because "the probe exited
    // 0" and "the probe registered eight tools" are different measurements and only the second one is
    // the claim this check makes; a probe edited to exit 0 early would satisfy the first.
    const toolCount = Number(verified.stdout.match(/registered\s*:\s*(\d+)/)?.[1] ?? NaN);
    if (toolCount !== 8) {
      return fail(
        `the packed copy registered ${Number.isNaN(toolCount) ? 'an unreadable number of' : toolCount} tool(s), ` +
          `not the eight this package documents`,
        tail(verified, 20),
      );
    }

    // (e) dist/ holds one tarball and it is the one just verified.
    const stale = clearStaleDistArtifacts();

    const sha256 = createHash('sha256').update(gz).digest('hex');
    return pass(
      `${packedNames.length} file(s) packed, byte-identical on a second pack; files[] complete; ` +
        `version ${packedManifest.version}; no forbidden path; ${toolCount} tools ` +
        'registered from the packed copy',
      `sha256 ${sha256}\nartifact: ${distTarball}` +
        (stale.length > 0 ? `\nremoved ${stale.length} stale tarball(s) from dist/: ${stale.join(', ')}` : ''),
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The claims that need the tree and the documents, run from the suite that already owns them. */
function checkClaims() {
  const file = join(ROOT, 'test', 'claims.test.mjs');
  if (!existsSync(file)) return fail(`no ${file}; the version and bundle-patch claims would go unchecked`);
  // Called rather than reimplemented: test/claims.test.mjs already measures the registered tool set
  // against the documents, the version against the newest CHANGELOG entry, the CHANGELOG's order,
  // the withdrawn-version rule, the bundle patch row, and the tarball URLs. A second copy of those
  // rules here could disagree with it, and then there would be two answers and no way to choose.
  const result = child('claims', process.execPath, ['--test', '--test-force-exit', 'test/claims.test.mjs']);
  const counts = parseTestCounts(result.stdout);
  if (!result.ok || (counts.fail ?? 0) > 0) {
    return fail(
      `test/claims.test.mjs failed (exit ${result.status}): ${counts.fail ?? '?'} of ${counts.tests ?? '?'} ` +
        'assertion(s) disagree with the artifact or the documents',
      tail(result, 30),
    );
  }
  const skippedNote =
    (counts.skipped ?? 0) > 0
      ? `\n${counts.skipped} claim(s) skipped in that suite; its skips name the URL or path they could ` +
        'not reach, and are the only part of this pre-flight that is network-dependent'
      : '';
  return pass(
    `${counts.tests ?? '?'} claim(s) checked, ${counts.pass ?? '?'} pass, ${counts.skipped ?? 0} skip ` +
      '(version agreement + bundle patch row included)',
    `reused test/claims.test.mjs, not reimplemented${skippedNote}`,
  );
}

/**
 * The documents' own structure, which is what bit v0.5.7 and v0.5.8.
 *
 * `test/claims.test.mjs` covers the version *agreement*; it cannot cover the shape of the file,
 * because a prepend script that anchors on a version heading produces a file that is still in
 * descending version order while the title and the introduction have been pushed into the middle of
 * the document. That is exactly what had happened: `# Changelog` sat at line 21 of CHANGELOG.md, below
 * the v0.5.8 entry, and `test/claims.test.mjs` was perfectly happy with it. So the shape is asserted
 * here, and the title-versus-newest-entry line is the one that catches it.
 */
function checkChangelogShape() {
  const path = join(ROOT, 'CHANGELOG.md');
  if (!existsSync(path)) return fail('CHANGELOG.md is missing');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);

  const titleLine = lines.findIndex((l) => /^#\s+Changelog\s*$/.test(l)) + 1;
  const firstVersionLine = lines.findIndex((l) => /^##\s+\[?\d+\.\d+\.\d+/.test(l)) + 1;
  const introLine = lines.findIndex((l) => /All notable changes to this project/.test(l)) + 1;
  const versions = [];
  lines.forEach((line, index) => {
    const heading = line.match(/^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/);
    if (heading) versions.push({ version: heading[1], line: index + 1 });
  });

  if (versions.length === 0) return fail('no `## <version>` heading was found; the format has changed');
  if (titleLine === 0) return fail('no `# Changelog` title line was found');
  if (firstVersionLine === 0) return fail('no version heading was found');

  const problems = [];
  if (titleLine > firstVersionLine) {
    problems.push(
      `the \`# Changelog\` title is at line ${titleLine}, below the newest version heading at line ` +
        `${firstVersionLine}: an entry was prepended above the document's own header`,
    );
  }
  // The introduction belongs between the title and the newest entry. It is only a defect when it sits
  // *above* the title, which is the signature of an entry that landed on top of the document header:
  // an earlier version of this check flagged the correct layout and was wrong, measured.
  if (introLine !== 0 && introLine < titleLine) {
    problems.push(
      `the introduction is at line ${introLine}, above the \`# Changelog\` title at line ${titleLine}: ` +
        'the header block is no longer at the top of the document',
    );
  }
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
  if (versions.some((v, i) => v.version !== sorted[i].version)) {
    problems.push(
      `entries are not in descending order: ${versions
        .slice(0, 6)
        .map((v) => `${v.version}@${v.line}`)
        .join(' > ')}`,
    );
  }
  if (versions[0].version !== MANIFEST.version) {
    problems.push(
      `the newest entry is ${versions[0].version} (line ${versions[0].line}) but package.json is ` +
        `${MANIFEST.version}`,
    );
  }

  const shape =
    `title line ${titleLine}; newest version ${versions[0].version} at line ${firstVersionLine}; ` +
    `${versions.length} entr(ies) newest-first`;
  if (problems.length > 0) return fail(problems.join('; '), shape);
  return pass('the title and introduction are above the newest entry, and entries run newest-first', shape);
}

/** Numeric dotted-version comparison, pre-release suffix compared as text. */
function compareVersions(a, b) {
  const parse = (v) => v.split('-')[0].split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return String(a).localeCompare(String(b));
}

/* --------------------------------------------------------------------------------------------- */
/* The run                                                                                        */
/* --------------------------------------------------------------------------------------------- */

const SUITE_ENV = prepareSuiteEnv();

const CHECKS = [
  { name: 'gate inventory (the gates this pre-flight delegates to exist)', run: checkGateInventory },
  { name: 'ledger self-test (a check that reports nothing is a failure)', run: checkLedgerCatchesSilence },
  { name: 'test wiring (every suite on disk is named by a script, every named path exists)', run: checkTestWiring },
  { name: 'lint (0 errors required)', run: checkLint },
  { name: 'mojibake scan (whole tree)', run: checkMojibake },
  { name: 'declared suite (package.json#scripts.test)', run: () => checkTestSuite(SUITE_ENV) },
  { name: 'packed tarball (files[] complete, version, forbidden paths, 8 tools from the pack)', run: checkPackAndTarball },
  { name: 'claims (test/claims.test.mjs, reused not reimplemented)', run: checkClaims },
  { name: 'CHANGELOG shape (title above the newest entry, newest-first)', run: checkChangelogShape },
];

process.stdout.write(`w2m pre-flight for ${MANIFEST.name} ${MANIFEST.version} (${ROOT})\n`);
process.stdout.write(`  checks registered: ${CHECKS.length}\n`);
process.stdout.write(`  ${SUITE_ENV.note}\n`);
process.stdout.write('\n');

const { results } = await run(CHECKS);
// The host observation is recorded as a named, non-blocking UNVERIFIABLE whenever the suite had to be
// run against a shaped home: the suite's PASS is then a statement about the resolver's documented
// layout, and this line keeps the reader from mistaking it for a statement about this machine.
const hostEnv = [
  { name: 'host bundled-runtime layout (this machine, not the suite env)', verdict: unverifiable(SUITE_ENV.hostReason) },
];
const all = [...results, ...hostEnv];

const failed = all.filter((r) => r.verdict.status === 'FAIL');
const unverified = all.filter((r) => r.verdict.status === 'UNVERIFIABLE');
const passed = all.filter((r) => r.verdict.status === 'PASS');

process.stdout.write('\n');
for (const { name, verdict } of unverified) {
  process.stdout.write(`  UNVERIF  ${name}: ${verdict.reason}\n`);
  if (verdict.note) process.stdout.write(`          ${verdict.note}\n`);
}
process.stdout.write('\n');

process.stdout.write(
  `pre-flight: ${passed.length} pass, ${failed.length} fail, ${unverified.length} unverifiable ` +
    `(${results.length}/${CHECKS.length} registered check(s) reported, plus ${hostEnv.length} host ` +
    `observation(s)) -- ${failed.length > 0 ? 'RED, do not bump' : 'GREEN, cleared to bump'}\n`,
);
if (unverified.length > 0) {
  process.stdout.write(
    '  note: UNVERIFIABLE is not a pass. Those checks could not be measured here; the reason above ' +
      'names what was missing.\n',
  );
}
process.exit(failed.length > 0 ? 1 : 0);
