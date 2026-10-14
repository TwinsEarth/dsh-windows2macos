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
 *   1. assert that the gate itself ran            (11 checks, each with a named result)
 *   2. the wiring: every suite on disk is named by a script, every path a script names exists, and
 *      each workflow's suite list is *derived* from package.json rather than hand-maintained
 *   3. lint: 0 errors
 *   4. mojibake scan: clean over the whole tree
 *   5. the suite declared in package.json#scripts.test
 *   6. pack, then assert the tarball against an expectation derived from the **tree**
 *   7. the claims that need the tree and the documents (test/claims.test.mjs)
 *   8. a summary line naming counts and the verdict
 *
 * WHY STEP 6 SAYS "TREE" AND NOT "files[]"
 *
 * The first version of the "files[] complete" check expanded `package.json#files` itself and then
 * compared that expansion to the packed tarball. Both sides of the comparison came from the same
 * list, so the check could not fail: delete `CHANGELOG.md`, `docs`, `TROUBLESHOOTING.md`,
 * `SECURITY.md`, `CONTRIBUTING.md` and the `PROTOCOL*.md` documents from `files[]`, leave the files
 * where they are, and the check still printed PASS -- with the words "files[] complete" in the
 * sentence -- over a tarball that had lost its documents. That is v0.5.6's defect (a package missing
 * its own documents) wearing the name of the gate built to prevent it.
 *
 * The expectation is therefore derived from the tree (see "The release contract" below) and can only
 * be satisfied by declaring a document as shipped or by naming it as excluded **with a reason**. The
 * one list a defect could previously hide in is now the list the check is measured against.
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
 * (a missing host prerequisite, an absent optional tool) -- and only for a reason on
 * `ACCEPTED_UNVERIFIABLE` below, which lives in this repository, in the diff, with its justification.
 * A reason that is not on that list is converted to a FAIL naming the check and the reason.
 *
 * That last sentence is the rule this file learned from its own review, and it replaces an earlier
 * one that read "an UNVERIFIABLE result does **not** fail the run". That rule was an unguarded escape
 * hatch: switching a check's PASS to `unverifiable('INSTRUMENT: ...')` produced "0 pass, 0 fail,
 * 2 unverifiable -- GREEN, cleared to bump", which is a gate that has decided in advance to accept
 * its own inability to measure anything. `compat.yml` states and enforces the opposite rule for a
 * skipped page assertion; the pre-flight now applies the same discipline to itself. UNVERIFIABLE
 * still never counts as a pass: "I could not check" and "I checked and it is fine" stay different
 * sentences, and the first one now has to be one of the sentences this repository has agreed to.
 *
 * Usage:
 *   node scripts/preflight.mjs
 *
 * Exit code: 0 when every check PASSed (an accepted UNVERIFIABLE is allowed and reported), 1
 * otherwise -- including when a check reported UNVERIFIABLE for a reason nobody accepted.
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
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  // The number of *registered* checks that produced a verdict. The self-assertion row above is a
  // result of the ledger, not a registered check, and counting it in the numerator is how this
  // script came to print "(4/3 registered check(s) reported)" in a failing run.
  const reported = checks.filter((check) => counted.get(check.name) === 1).length;
  return { results, missing, reported };
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
  if (probe.reported !== 1) {
    problems.push(
      `the run reported ${probe.reported} of 3 registered check(s) as having produced a verdict, expected ` +
        'exactly 1: the count in the summary must be a count of registered checks, not of result rows',
    );
  }

  // The second escape hatch, exercised the same way: UNVERIFIABLE is only allowed for a reason this
  // repository has accepted, and the classification has to say so for both directions.
  const classification = classifyUnverifiable([
    { name: 'selftest: an unaccepted unverifiable', verdict: unverifiable('INSTRUMENT: a plausible-sounding excuse') },
    { name: 'host bundled-runtime layout (this machine, not the suite env)', verdict: unverifiable("this host's DSH_HOME (C:\\nope) contains no dsh-runtimes/; the rest of the reason does not matter") },
    { name: 'selftest: a passing check', verdict: pass('this one passed') },
  ]);
  const refusedNames = classification.refused.map((row) => row.name);
  const acceptedNames = classification.accepted.map((row) => row.name);
  if (refusedNames.length !== 1 || refusedNames[0] !== 'selftest: an unaccepted unverifiable') {
    problems.push(
      `an UNVERIFIABLE with an unaccepted reason was not refused (refused: ${refusedNames.join(', ') || 'nothing'})`,
    );
  }
  if (acceptedNames.length !== 1 || acceptedNames[0] !== 'host bundled-runtime layout (this machine, not the suite env)') {
    problems.push(`the accepted host-layout reason was not accepted (accepted: ${acceptedNames.join(', ') || 'nothing'})`);
  }

  const detail =
    `silent->${silentStatus}, throwing->${throwStatus}, honest->${honestStatus}, ` +
    `run self-assertion->${ledgerStatus}, missing=${probe.missing.length}, reported=${probe.reported}/3, ` +
    `unaccepted-UNVERIFIABLE->refused, accepted-UNVERIFIABLE->allowed`;
  if (problems.length > 0) {
    return fail(`the ledger did not catch a check that reports nothing: ${problems.join('; ')}`, detail);
  }
  return pass(
    'a silent check, a throwing check and an honest one were classified FAIL/FAIL/PASS; an ' +
      'UNVERIFIABLE for an unaccepted reason was refused and the accepted one was allowed',
    detail,
  );
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
/* The release contract: what a shipped artifact must carry, derived from the TREE                 */
/* --------------------------------------------------------------------------------------------- */

/**
 * The one rule this whole section exists for: **the shipped set may not describe itself**.
 *
 * A check that builds its expectation by expanding `package.json#files` and then compares that
 * expansion to the tarball is satisfied by editing either side of its own comparison. It cannot
 * report the defect it is named after. (Measured: dropping `CHANGELOG.md`, `docs`,
 * `TROUBLESHOOTING.md`, `SECURITY.md`, `CONTRIBUTING.md` and the `PROTOCOL*.md` documents from
 * `files[]` left every gate green over a tarball that no longer carried them.)
 *
 * So the expectation is derived from the tree -- every root `*.md`, every file under `docs/`, and
 * every path the manifest itself points at -- and each item must be either shipped or named as
 * excluded, in this file, with a reason. `test/claims.test.mjs` imports the same functions, so the
 * rule has exactly one implementation and both callers are measured against it.
 */

/** Directories whose every file is a document this package documents itself with. */
export const DOCUMENT_DIRECTORIES = ['docs'];

/**
 * Documents in the tree that are deliberately NOT shipped, each with the reason a reviewer reads.
 *
 * This list is the **only** way a document may be absent from the tarball. It is deliberately not a
 * field of `package.json`: the point of the exercise is that the shipped set must not be able to
 * describe itself into completeness, so each exception lives next to the rule it bends, in the diff,
 * in words. Removing a row turns the check red; adding a document to the tree without a row turns it
 * red too.
 */
export const DOCUMENT_EXCLUSIONS = [
  {
    path: 'RELEASE-STATUS.md',
    reason:
      'an internal release-status log (Chinese), last updated for v0.4.2 -- five releases stale. It ' +
      'records past release actions for the maintainer and makes no claim about the shipped ' +
      'artifact, so it is not part of the documentation set the package ships.',
  },
];

/** Below this many characters a "reason" is a shrug, not a reason. */
const MIN_REASON_LENGTH = 40;

/**
 * Every file this package documents itself with, read from the tree. Never from `files[]`.
 *
 * Root `*.md` and everything under `DOCUMENT_DIRECTORIES`; not recursive over the whole repository,
 * because `src/**` and `deploy/**` carry module-level notes that ship (or do not) with their own
 * directory entry and are not part of the package's document set.
 *
 * @param {string} root
 * @returns {string[]} package-relative POSIX paths, sorted.
 */
export function treeDocuments(root) {
  const documents = [];
  for (const name of readdirSync(root).sort()) {
    const abs = join(root, name);
    if (name.toLowerCase().endsWith('.md') && statSync(abs).isFile()) documents.push(name);
  }
  for (const directory of DOCUMENT_DIRECTORIES) {
    const abs = join(root, directory);
    if (!existsSync(abs)) continue;
    const walk = (dirAbs, rel) => {
      for (const child of readdirSync(dirAbs).sort()) {
        const childAbs = join(dirAbs, child);
        const info = statSync(childAbs);
        if (info.isDirectory()) walk(childAbs, `${rel}/${child}`);
        else if (info.isFile()) documents.push(`${rel}/${child}`);
      }
    };
    walk(abs, directory);
  }
  return documents.sort();
}

/**
 * Mirror of `ALWAYS` in `scripts/pack.mjs`, which the packer adds whether or not `files` names them.
 *
 * Kept here rather than imported because that file is a script, not a module; the packing check
 * asserts every one of these is in the tarball, so a change to the packer's list is a red line in
 * this file rather than a silent difference in what ships.
 */
export const PACKER_ALWAYS = ['package.json', 'README.md', 'LICENSE'];

/**
 * Every file the `files` globs expand to in the tree, as package-relative POSIX paths.
 *
 * This is the *declared* side. Nothing here may be used as the expectation for what a release must
 * carry -- that is `documentContract()` and `requiredShippedEntries()`, both derived from the tree.
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {string[]}
 */
export function packageFilesExpansion(root, files) {
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
  for (const entry of files ?? []) {
    const abs = join(root, entry);
    if (existsSync(abs)) walk(abs, entry.replace(/^\.\//, ''));
  }
  for (const name of PACKER_ALWAYS) {
    if (existsSync(join(root, name)) && !collected.includes(name)) collected.push(name);
  }
  return collected.sort();
}

/**
 * The tree-to-tarball ledger for documents: which documents exist, which are shipped, which are
 * excluded with a reason, and every problem that makes one of those answers unusable.
 *
 * @param {{root: string, files: string[], exclusions?: Array<{path: string, reason: string}>}} input
 * @returns {{documents: string[], shipped: string[], excluded: string[], undeclared: string[],
 *   problems: string[], counts: string}}
 */
export function documentContract({ root, files, exclusions = DOCUMENT_EXCLUSIONS }) {
  const documents = treeDocuments(root);
  const declared = new Set(packageFilesExpansion(root, files));
  const problems = [];
  const rows = new Map();

  for (const row of exclusions) {
    const path = typeof row?.path === 'string' ? row.path : '';
    if (path === '') {
      problems.push('an exclusion row names no path, so it excuses everything and nothing');
      continue;
    }
    if (rows.has(path)) problems.push(`two exclusion rows name ${path}`);
    rows.set(path, row);
    const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      problems.push(
        `the exclusion of ${path} gives no usable reason (${reason.length} character(s), ${MIN_REASON_LENGTH} ` +
          'required): an exclusion without a stated reason is an omission with paperwork',
      );
    }
    if (!existsSync(join(root, path))) {
      problems.push(
        `the exclusion of ${path} is stale: there is no such file in the tree, so the row excuses ` +
          'nothing and hides the next document that takes its name',
      );
    }
    if (declared.has(path)) {
      problems.push(
        `${path} is both declared in package.json#files and listed as excluded; one of the two is a ` +
          'mistake and this check will not guess which',
      );
    }
  }

  const shipped = [];
  const undeclared = [];
  for (const document of documents) {
    if (declared.has(document)) shipped.push(document);
    else if (!rows.has(document)) undeclared.push(document);
  }
  if (undeclared.length > 0) {
    problems.push(
      `${undeclared.length} document(s) in the tree are neither declared in package.json#files nor ` +
        `named in DOCUMENT_EXCLUSIONS with a reason: ${undeclared.join(', ')}. Add each to "files" or ` +
        'to the exclusion list in scripts/preflight.mjs -- a document nobody decided about is the ' +
        'v0.5.6 defect (a package missing its own documents).',
    );
  }

  const excluded = [...rows.keys()].filter((path) => !declared.has(path)).sort();
  const counts =
    `tree documents: ${documents.length}; shipped: ${shipped.length}; excluded with a reason: ` +
    `${excluded.length} (${excluded.join(', ') || 'none'}); neither: ${undeclared.length}`;
  return { documents, shipped, excluded, undeclared, problems, counts };
}

/**
 * Paths the manifest itself points at, which therefore must be inside the tarball: an entry point
 * that does not ship resolves to nothing on the user's machine, and `dsh.bundle.patch` that does not
 * ship means the plugin never mounts.
 *
 * Read from `main`, `exports`, `bin` and `dsh.bundle.patch` -- i.e. from the fields that must agree
 * with reality for the package to be loadable at all, not from `files`.
 *
 * @param {object} manifest
 * @returns {Array<{field: string, path: string}>}
 */
export function requiredShippedEntries(manifest) {
  const required = [];
  const add = (field, value, { relative = false } = {}) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    if (relative && !value.startsWith('./')) return;
    const path = value.replace(/^\.\//, '');
    if (path.startsWith('node:') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return;
    required.push({ field, path });
  };
  add('main', manifest.main);
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    add(`exports["${subpath}"]`, target, { relative: true });
  }
  for (const [name, target] of Object.entries(manifest.bin ?? {})) add(`bin["${name}"]`, target);
  add('dsh.bundle.patch', manifest.dsh?.bundle?.patch);
  return required;
}

/**
 * Manifest fields allowed to differ between the tree and the packed copy. **None**, and that is a
 * measurement rather than a hope: `scripts/pack.mjs` packs `package.json`'s bytes verbatim, so a
 * single differing field means the published manifest is not the manifest that was reviewed -- which
 * is how a release loses `engines`, `disclosure` or `peerDependencies` while "the packed manifest is
 * the tree's manifest" stays green on a `version`-only comparison.
 *
 * The list stays as a parameter so that a future packer which must rewrite a field has exactly one
 * place to say so, in the diff, with a reason -- instead of the comparison being loosened globally.
 */
export const ALLOWED_MANIFEST_DIFFERENCES = [];

/**
 * Every difference between two manifest-shaped values, as `path: tree=X packed=Y` lines.
 *
 * @param {unknown} tree
 * @param {unknown} packed
 * @param {string[]} allowed top-level fields that may differ (see ALLOWED_MANIFEST_DIFFERENCES).
 * @returns {string[]}
 */
export function manifestDifferences(tree, packed, allowed = ALLOWED_MANIFEST_DIFFERENCES) {
  const show = (value) => (value === undefined ? '(absent)' : JSON.stringify(value));
  const differences = [];
  const walk = (a, b, path) => {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        differences.push(`${path}: tree=${show(a)} packed=${show(b)}`);
        return;
      }
      if (a.length !== b.length) {
        differences.push(`${path}: tree has ${a.length} entr(ies), packed has ${b.length}`);
      }
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    const objectLike = (value) => value !== null && typeof value === 'object';
    if (objectLike(a) && objectLike(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) walk(a[key], b[key], path === '' ? key : `${path}.${key}`);
      return;
    }
    if (!Object.is(a, b)) differences.push(`${path}: tree=${show(a)} packed=${show(b)}`);
  };
  walk(tree, packed, '');
  // A difference line reads `path: tree=... packed=...`, so an allowed top-level field covers every
  // line whose path is that field or something under it. (Measured: an earlier version compared the
  // whole line to the field name and therefore filtered nothing at all -- the suite's own
  // falsifying assertion caught it.)
  return differences.filter(
    (line) =>
      !allowed.some(
        (field) => line.startsWith(`${field}:`) || line.startsWith(`${field}.`) || line.startsWith(`${field}[`),
      ),
  );
}

/**
 * The two workflows that gate a push to `main` and a tag, and therefore must run the suite the
 * release declares. Named explicitly, and the check reports it as a problem when one of them is
 * missing, so a rename cannot quietly take a gate with it.
 *
 * `compat.yml` is deliberately not on this list: its `mount-and-boot` job is a targeted single-suite
 * gate whose own TAP verdict program decides it (and its other two jobs run no suite at all), and
 * `ci.yml`'s `live-api` job is documented in that file as non-blocking.
 */
export const GATING_WORKFLOWS = ['ci.yml', 'release.yml'];

/**
 * Every `run:` scalar in a workflow file, as text.
 *
 * A deliberately crude YAML read: this file must not grow a YAML dependency, and the shape it
 * depends on -- `run:` followed by an inline command or a block scalar -- is asserted by the check
 * that uses it (a workflow whose suite list cannot be read is a failure, not an empty list).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function workflowRunBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([ \t]*)(?:-[ \t]+)?run:[ \t]*(.*)$/.exec(lines[i]);
    if (match === null) continue;
    const [, indent, inline] = match;
    const value = inline.trim();
    if (value !== '' && !/^[|>][-+]?$/.test(value)) {
      blocks.push(value);
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === '') {
        body.push('');
        continue;
      }
      const deeper = /^([ \t]*)\S/.exec(lines[j]);
      if (deeper === null || deeper[1].length <= indent.length) break;
      body.push(lines[j]);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

/**
 * The loader gate must keep running on the two occasions that matter: every pull request, and every
 * release tag.
 *
 * `compat.yml`'s `mount-and-boot` job is the only place in this repository where the packed artifact is
 * mounted by the *real* Loader, activated through the real client-module system, and -- with a browser
 * -- booted as a page that the real shell accepts. That last assertion is the only oracle the client
 * *seat* has: `lib/client.js`, `test/client-bundle.test.mjs` and `test/loader-entry.test.mjs` each
 * carry the seat literal `conversation.input.left`, and the activation helper mounts a stand-in slot
 * registry that records whatever key the entry injects, so a consistent three-way rename in this
 * repository would satisfy all three of our own copies while the shell disagreed. The seat table lives
 * in the shell (the helper says so: "the seat service the shell provides from its seed table") and is
 * not reachable from a checkout -- measured: no file in the installed tree at
 * `resources/app.asar/dsh` contains the literal. The page boot therefore cannot be replaced by a
 * cheaper check, and it must not quietly stop running.
 *
 * Pure, on the workflow text, so both directions can be exercised.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function loaderGateTriggerProblems(text) {
  const problems = [];
  const head = String(text).split(/\r?\njobs:/)[0] ?? '';
  if (!/pull_request:/.test(head)) {
    problems.push(
      'compat.yml does not run on pull requests, so the packed artifact is never mounted by the real ' +
        'Loader before it is merged',
    );
  }
  if (!/tags:\s*\[[^\]]*v\*/.test(head)) {
    problems.push(
      'compat.yml does not run on `v*` tags, so a release can be published without the one gate that ' +
        'mounts the packed artifact in a real Loader and boots its page. That page boot is the only ' +
        'assertion in this repository made against the real shell rather than against our own copy of it',
    );
  }
  return problems;
}

/**
 * Which suites each workflow runs, and how that follows from `package.json#scripts`.
 *
 * This is what stops the suite list from being maintained twice. A workflow that runs `npm test`
 * runs whatever `scripts.test` names *today*; a workflow that hand-lists twenty-three paths runs
 * those twenty-three forever, which is how six suites that exist, are in `scripts.test`, and were
 * named by a script came to run in no workflow at all -- while release.yml carried a comment saying
 * "a new suite is invisible to the release gate until it is added here ... that has bitten this
 * project once already".
 *
 * @param {{root: string, workflows: Array<string|{name: string, text: string}>, scripts: object}} input
 *   `workflows` entries are either a file name under `.github/workflows/`, or `{name, text}` so a
 *   synthetic workflow can be measured against the same rule (this is what the claims suite does).
 * @returns {{perWorkflow: Array<{workflow: string, covered: Map<string,string>, literal: string[],
 *   invocations: string[]}>, releaseSuite: string[], namedByAnyScript: string[], problems: string[]}}
 */
export function workflowSuiteCoverage({ root, workflows, scripts }) {
  const namedByAnyScript = new Set();
  for (const text of Object.values(scripts ?? {})) {
    for (const file of scriptTestFiles(String(text))) namedByAnyScript.add(file);
  }

  const perWorkflow = [];
  const problems = [];

  for (const entry of workflows) {
    const name = typeof entry === 'string' ? entry : entry.name;
    let text = null;
    if (typeof entry === 'string') {
      const file = join(root, '.github', 'workflows', name);
      if (!existsSync(file)) {
        problems.push(`.github/workflows/${name} does not exist, so the suites it runs cannot be read`);
        continue;
      }
      text = readFileSync(file, 'utf8');
    } else {
      text = entry.text;
    }

    const covered = new Map();
    const literal = new Set();
    const invocations = [];
    /** `covered` is filled first-wins, so the report names the plainest reason a suite runs. */
    const cover = (file, how) => {
      if (!covered.has(file)) covered.set(file, how);
    };

    for (const block of workflowRunBlocks(text)) {
      for (const line of block.split('\n')) {
        if (!/\bnode\s+--test\b/.test(line)) continue;
        const paths = scriptTestFiles(line);
        for (const file of paths) {
          literal.add(file);
          cover(file, `${name} names it directly`);
        }
        if (paths.length >= 2) {
          problems.push(
            `${name} hand-lists ${paths.length} suite paths on one \`node --test\` line (${paths
              .slice(0, 3)
              .join(', ')}${paths.length > 3 ? ', ...' : ''}). A list maintained beside ` +
              'package.json#scripts.test goes stale the first time a suite is added: run the script ' +
              '(`npm test`, `npm run test:e2e`) instead, or name a single suite.',
          );
        }
      }

      for (const match of block.matchAll(/\bnpm\s+(?:run\s+)?([A-Za-z0-9:_.-]+)/g)) {
        const scriptName = match[1];
        if (typeof scripts?.[scriptName] !== 'string') continue;
        const how = `npm ${scriptName === 'test' ? 'test' : `run ${scriptName}`}`;
        invocations.push(how);
        for (const file of scriptTestFiles(scripts[scriptName])) cover(file, how);
      }

      if (/\bnode\s+scripts\/preflight\.mjs\b/.test(block) && typeof scripts?.test === 'string') {
        // The pre-flight runs `scripts.test` as its "declared suite" check, which is exactly what
        // `scripts/preflight.mjs`'s checkTestSuite() asserts in every run -- so a workflow that
        // invokes it does run the release suite. If that ever stops being true, the pre-flight's own
        // declared-suite check goes red on the same run, so this is not a claim without a checker.
        invocations.push('scripts/preflight.mjs (runs package.json#scripts.test)');
        for (const file of scriptTestFiles(scripts.test)) {
          cover(file, 'scripts/preflight.mjs (runs package.json#scripts.test)');
        }
      }
    }

    perWorkflow.push({
      workflow: name,
      covered,
      literal: [...literal].sort(),
      invocations: [...new Set(invocations)],
    });
  }

  const releaseSuite = scriptTestFiles(String(scripts?.test ?? ''));
  if (releaseSuite.length === 0) {
    problems.push(
      'package.json#scripts.test names no suite, so "the release suite runs in CI" cannot be measured',
    );
  }

  for (const gating of GATING_WORKFLOWS) {
    const entry = perWorkflow.find((p) => p.workflow === gating);
    if (entry === undefined) continue; // already reported as missing above
    const missing = releaseSuite.filter((file) => !entry.covered.has(file));
    if (missing.length > 0) {
      problems.push(
        `.github/workflows/${gating} runs ${releaseSuite.length - missing.length} of the ` +
          `${releaseSuite.length} suite(s) declared by package.json#scripts.test; missing: ` +
          `${missing.join(', ')}. A version bump with no CHANGELOG entry, which the claims suite ` +
          'catches, must be caught by something automatic.',
      );
    }
  }

  const union = new Set();
  for (const entry of perWorkflow) for (const file of entry.covered.keys()) union.add(file);
  const orphaned = [...namedByAnyScript].sort().filter((file) => !union.has(file));
  if (orphaned.length > 0) {
    problems.push(
      `${orphaned.length} suite(s) are named by an npm script and run in no workflow: ` +
        `${orphaned.join(', ')}. A test that does not run protects nothing.`,
    );
  }

  const absent = [];
  for (const entry of perWorkflow) {
    for (const file of entry.literal) {
      if (!existsSync(join(root, file))) absent.push(`${entry.workflow} names ${file}, which does not exist`);
    }
  }
  if (absent.length > 0) problems.push(...absent);

  return { perWorkflow, releaseSuite, namedByAnyScript: [...namedByAnyScript].sort(), problems };
}

/* --------------------------------------------------------------------------------------------- */
/* The two accepted lists: what this repository agrees not to measure, and why                     */
/* --------------------------------------------------------------------------------------------- */

/**
 * THE ACCEPTED-UNVERIFIABLE LIST.
 *
 * An UNVERIFIABLE check is a hole in the evidence, and a hole nobody has to justify is an escape
 * hatch. Each entry names the check it applies to, the pattern its *reason* must match, and why this
 * repository accepts that hole. A reason that matches nothing here is turned into a FAIL by
 * `classifyUnverifiable()`.
 *
 * One entry today, and it is the one thing this machine genuinely cannot measure: the layout of the
 * *host's own* bundled runtime. That is a fact about the machine, not about the artifact, and
 * pretending otherwise would be the more expensive mistake.
 */
export const ACCEPTED_UNVERIFIABLE = [
  {
    key: 'host-runtime-layout',
    appliesTo: 'host bundled-runtime layout (this machine, not the suite env)',
    match: /^this host's DSH_HOME \((?:.|\n)*\) contains no dsh-runtimes\//,
    why:
      'the host\'s own bundled-runtime layout is a property of the machine, not of the artifact; the ' +
      'suite is run against a throwaway home that has the documented layout, and this row is the ' +
      'honest record of what the machine itself has',
  },
];

/**
 * Split a run's UNVERIFIABLE rows into the accepted ones and the refused ones.
 *
 * @param {Array<{name: string, verdict: {status: string, reason: string, note?: string}}>} rows
 * @param {Array<object>} accepted
 * @returns {{accepted: Array<{name: string, entry: object}>, refused: Array<{name: string, reason: string, note?: string}>}}
 */
export function classifyUnverifiable(rows, accepted = ACCEPTED_UNVERIFIABLE) {
  const acceptedRows = [];
  const refused = [];
  for (const row of rows) {
    if (row.verdict?.status !== 'UNVERIFIABLE') continue;
    const entry = accepted.find(
      (candidate) =>
        (candidate.appliesTo === undefined || candidate.appliesTo === row.name) &&
        candidate.match.test(row.verdict.reason),
    );
    if (entry === undefined) refused.push({ name: row.name, reason: row.verdict.reason, note: row.verdict.note });
    else acceptedRows.push({ name: row.name, entry });
  }
  return { accepted: acceptedRows, refused };
}

/**
 * THE ACCEPTED-SKIP LIST.
 *
 * A skipped assertion is a claim that did not run. The declared suite contributes fourteen of them
 * on a developer's machine, ten of those being the whole loader gate -- so "clean, N skips" was a
 * sentence in which the strongest assertion set in the repository never ran, and the count itself
 * drifted between runs with no way to see which assertion had moved.
 *
 * Each entry is keyed on the *enclosing suite* and on the skip's own reason, and caps how many times
 * it may happen: a cap that is exceeded means an assertion was added, removed or started skipping,
 * and that is a question for a human rather than a number to recompute. A skip matching nothing here
 * is a FAIL naming the suite, the assertion and the reason.
 *
 * `platforms`, when present, names the hosts on which that skip is accepted, and every
 * platform-conditional assertion carries it. `test/agent.test.mjs` holds the pair that makes the
 * reason plain: `caps.case_sensitive_fs === false` and `caps.exec_bit === false` are facts about
 * NTFS, and the 0600 permission assertion in the same file is a fact about a POSIX filesystem, so
 * each of them skips where it cannot be measured. The pre-flight runs on both kinds of host -- a
 * human runs it on Windows, `ci.yml`'s `preflight` job and `release.yml` run it on ubuntu-latest --
 * so both directions need an entry, and without the qualifier each entry would also excuse the same
 * reason on the host where the assertion *should* have run. On a host outside the list the skip is
 * refused by name rather than silently accepted, which is the difference between a symmetry and a
 * blanket exemption.
 */
export const ACCEPTED_SKIPS = [
  {
    key: 'no-loader-installation',
    suite: /^loader entry: the packed artifact/,
    match: /^no DeepSeek Harness installation found to drive the real Loader\b/,
    maxCount: 10,
    why:
      'test/loader-entry.test.mjs drives a real DSH installation; on a machine without one every ' +
      'assertion in that single suite skips, and .github/workflows/compat.yml is where it runs ' +
      'against a pinned host instead',
  },
  {
    key: 'network-half-not-enabled',
    suite: /^release tarball claims \(GitHub Release assets\)$/,
    match: /^network check not enabled: could not reach https:\/\/github\.com\//,
    maxCount: 1,
    why: 'the one network-dependent claim in test/claims.test.mjs; run it with W2M_NETWORK_TESTS=1',
  },
  {
    key: 'network-half-forced-off',
    suite: /^release tarball claims \(GitHub Release assets\)$/,
    match: /^W2M_SKIP_NETWORK_TESTS=1:/,
    maxCount: 1,
    why: 'the same claim, with the network explicitly disabled by the operator',
  },
  {
    key: 'live-github-api-not-enabled',
    suite: /^real GitHub API \(network\)$/,
    match: /^explicitly skipped: set W2M_NETWORK_TESTS=1/,
    maxCount: 1,
    why:
      'test/update-source.test.mjs\'s live API case; ci.yml runs it with the workflow token in a ' +
      'non-blocking job, and the mocked coverage of the same paths always runs',
  },
  {
    key: 'ntfs-has-no-posix-bits',
    suite: /^identity: device\.json$/,
    match: /^NTFS has no POSIX bits/,
    maxCount: 1,
    platforms: ['win32'],
    why: 'a 0600 permission assertion that only a POSIX filesystem can evaluate; it runs on the macOS and Linux legs of ci.yml',
  },
  {
    key: 'windows-is-not-a-posix-shell',
    suite: /^executable resolution/,
    match: /^a POSIX shell script is not a Windows executable/,
    maxCount: 1,
    platforms: ['win32'],
    why: 'a bundled-tool resolution probe that needs a POSIX shell script; it runs on the macOS and Linux legs of ci.yml',
  },
  {
    key: 'posix-has-no-windows-filesystem',
    suite: /^capability probing$/,
    match: /^windows-only expectation$/,
    maxCount: 1,
    platforms: ['darwin', 'linux'],
    why:
      'the mirror image of ntfs-has-no-posix-bits, in the other direction: test/agent.test.mjs asserts ' +
      'that caps.case_sensitive_fs is false and caps.exec_bit is false, which are facts about NTFS, so on ' +
      'a POSIX host there is nothing to measure and the assertion skips there. It runs on the windows-latest ' +
      'legs of ci.yml. This entry exists because the pre-flight runs on ubuntu-latest (ci.yml\'s preflight ' +
      'job, and release.yml before it publishes), and `platforms` is what keeps the acceptance from ' +
      'becoming a blanket one: on win32 the same reason is refused, because there the assertion should ' +
      'have run and a skip is the defect rather than the environment.',
  },
  {
    key: 'no-runtime-pnpm',
    suite: /^update-install: real pnpm against a throwaway profile$/,
    match: /^runtime pnpm not found$/,
    maxCount: 2,
    why:
      'those two assertions install this package with the pnpm that ships *inside a DSH runtime*: ' +
      'src/plugin/update-install.mjs resolves it as $DSH_HOME/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.mjs, ' +
      'or as $W2M_PNPM. A CI runner has no DSH installation, so the suite\'s own precondition is absent -- ' +
      'the same fact as the accepted "no-loader-installation" skip, which is why this entry carries no ' +
      '`platforms`: Windows runners lack it exactly as Linux ones do, and qualifying it by platform would ' +
      'say something false. It runs on every host that has the runtime, and prepareSuiteEnv()\'s shaped ' +
      'throwaway home is what supplies one on an authoring machine, so on this machine the assertions run ' +
      'and this entry is inert. The cap of 2 is the bound: a third skip in that describe fails the check, ' +
      'and this reason on a host that *does* have a runtime would be a defect in resolution, not an ' +
      'environment fact. The alternative -- building a synthetic runtime in CI, as compat.yml does for the ' +
      'loader gate -- would exercise the installer against a pnpm fetched from npm instead of the one the ' +
      'Desktop ships, which is a weaker claim about the artifact plus a network dependency in the release ' +
      'gate, so it is a deliberate non-choice rather than an oversight.',
  },
];

/**
 * Every skip in a TAP capture, with the suite that encloses it and the reason it gave.
 *
 * The nesting is read rather than guessed: `node --test`'s TAP reporter emits `# Subtest: <name>`
 * lines with increasing indentation, and a result row belongs to the nearest subtest that encloses
 * it. (Measured against a real capture: a skipped assertion is printed as
 * `    # Subtest: <test name>` followed by `    ok N - <test name> # SKIP <reason>`, and the suite
 * that encloses it is the `# Subtest:` line above it at a lower indentation.)
 *
 * @param {string} text
 * @returns {Array<{suite: string, name: string, reason: string}>}
 */
export function tapSkips(text) {
  const stack = [];
  const skips = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const subtest = /^([ \t]*)# Subtest: (.*)$/.exec(line);
    if (subtest !== null) {
      const indent = subtest[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: subtest[2].trim() });
      continue;
    }
    const row = /^([ \t]*)(?:not ok|ok) \d+ - (.*)$/.exec(line);
    if (row === null) continue;
    const skip = / # skip ?(.*)$/i.exec(row[2]);
    if (skip === null) continue;
    const indent = row[1].length;
    const enclosing = [...stack].reverse().find((frame) => frame.indent < indent);
    skips.push({
      suite: enclosing?.name ?? '(no enclosing suite name in the capture)',
      name: row[2].slice(0, skip.index).trim(),
      reason: skip[1].trim(),
    });
  }
  return skips;
}

/**
 * Classify every skip in a run against `ACCEPTED_SKIPS`.
 *
 * `host` is a parameter rather than a read of `process.platform` inside the loop so that the
 * platform qualification of an entry can be exercised on any machine: `classifySkips(skips, accepted,
 * 'linux')` and `... , 'win32'` are the two directions of the pair in `test/agent.test.mjs`, and both
 * are measurable from Windows. A rule that can only be exercised on one of the hosts it is about is a
 * rule nobody reviews.
 *
 * @param {Array<{suite: string, name: string, reason: string}>} skips
 * @param {Array<object>} accepted
 * @param {string} [host] The platform the skip is being judged on.
 * @returns {{problems: string[], counts: Map<string, number>, lines: string[]}}
 */
export function classifySkips(skips, accepted = ACCEPTED_SKIPS, host = process.platform) {
  const problems = [];
  const counts = new Map();
  const lines = [];
  /** An entry applies here when it names no platform, or names this one. */
  const appliesHere = (row) => row.platforms === undefined || row.platforms.includes(host);
  for (const skip of skips) {
    const entry = accepted.find(
      (row) => appliesHere(row) && row.suite.test(skip.suite) && row.match.test(skip.reason),
    );
    if (entry === undefined) {
      // Name the near miss. An entry that matches this skip's suite and reason but is qualified to
      // other platforms means the assertion skipped on the host where it was supposed to run -- which
      // is a defect here, and not "a reason this repository has not thought about".
      const elsewhere = accepted.find(
        (row) => !appliesHere(row) && row.suite.test(skip.suite) && row.match.test(skip.reason),
      );
      if (elsewhere !== undefined) {
        problems.push(
          `"${skip.suite} > ${skip.name}" was SKIPPED on ${host} with a reason this repository accepts ` +
            `only on ${elsewhere.platforms.join(', ')}: ${skip.reason === '' ? '(no reason given)' : skip.reason}. ` +
            `On ${host} that assertion is expected to run (${elsewhere.why}), so its skip is the finding.`,
        );
        continue;
      }
      problems.push(
        `"${skip.suite} > ${skip.name}" was SKIPPED and its reason is not on the accepted list: ` +
          `${skip.reason === '' ? '(no reason given)' : skip.reason}. An assertion that did not run is a ` +
          'hole in this run: make it run, or add a justified entry to ACCEPTED_SKIPS in ' +
          'scripts/preflight.mjs.',
      );
      continue;
    }
    const seen = (counts.get(entry.key) ?? 0) + 1;
    counts.set(entry.key, seen);
    if (seen > entry.maxCount) {
      problems.push(
        `the accepted skip "${entry.key}" happened ${seen} time(s) and this repository accepts at ` +
          `most ${entry.maxCount} (${entry.why}). Either an assertion was added that also skips, or one ` +
          'that used to run now skips; both are questions for a human, not a number to raise.',
      );
    }
    lines.push(`  ${entry.key}: ${skip.suite} > ${skip.name} -- ${skip.reason}`);
  }
  return { problems, counts, lines };
}

/**
 * The plan: every check this pre-flight runs, by name, in the order it runs them.
 *
 * Exported because it is a *claim about the gate*, and a claim nothing checks is what this file is
 * about. Three independent lists now describe the same run -- this plan, the implementations bound to
 * each name in `main()`, and `GATE_INVENTORY` (which binds each repository artifact to the check that
 * measures it) -- and `test/claims.test.mjs` asserts that they agree. Deleting a check therefore
 * requires three coordinated edits rather than one: removing it from the run throws (no implementation
 * bound), removing it from this plan leaves an artifact with no measuring check, and removing both
 * from here and from the inventory is a deliberate edit that only review can catch -- the honest limit
 * of what a file can assert about itself.
 */
export const DECLARED_CHECKS = [
  'gate inventory (every gate exists and is bound to the registered check that measures it)',
  'ledger self-test (silence and an unaccepted UNVERIFIABLE are both failures)',
  'test wiring (every suite on disk is named by a script; the release suite and the rest are reported)',
  'workflow wiring (ci.yml and release.yml run the suite scripts.test declares)',
  'entry points (scripts/check-entrypoints.mjs)',
  'lint (0 errors required)',
  'mojibake scan (whole tree, plus a positive control)',
  'declared suite (package.json#scripts.test, skips itemized)',
  'packed tarball (tree-derived documents + entry points, whole manifest, forbidden paths, 8 tools from the pack)',
  'claims (test/claims.test.mjs, reused not reimplemented)',
  'CHANGELOG shape (title above the newest entry, newest-first)',
];

/**
 * The gate inventory: which repository artifact each check is the measurement of.
 *
 * `checkGateInventory()` used to assert that five files exist, and nothing else -- so a check could be
 * deleted together with its function and the run stayed green (`checks registered: 8 ... 8 pass,
 * 0 fail`) while the inventory line still printed `claims=present`. A file existing is not a
 * measurement of it.
 *
 * So every row below binds an artifact to the *name* of the check that measures it, and the check
 * enforces the relation in both directions: every named check must be registered, and every
 * registered check must be named by some row. Deleting a check makes its artifact unmeasured (red);
 * deleting a row leaves a check that measures nothing declared (red). Deleting both is a deliberate
 * edit that only review can catch -- and it is a visible diff, which is the honest limit of what a
 * file can assert about itself.
 */
export const GATE_INVENTORY = [
  { artifact: 'eslint entry point', path: 'node_modules/eslint/bin/eslint.js', checkedBy: 'lint (0 errors required)' },
  { artifact: 'mojibake scanner', path: 'scripts/scan-mojibake.mjs', checkedBy: 'mojibake scan (whole tree, plus a positive control)' },
  { artifact: 'entry-point check', path: 'scripts/check-entrypoints.mjs', checkedBy: 'entry points (scripts/check-entrypoints.mjs)' },
  { artifact: 'packer', path: 'scripts/pack.mjs', checkedBy: 'packed tarball (tree-derived documents + entry points, whole manifest, forbidden paths, 8 tools from the pack)' },
  { artifact: 'installed-copy probe', path: 'scripts/verify-installed.mjs', checkedBy: 'packed tarball (tree-derived documents + entry points, whole manifest, forbidden paths, 8 tools from the pack)' },
  { artifact: 'claims suite', path: 'test/claims.test.mjs', checkedBy: 'claims (test/claims.test.mjs, reused not reimplemented)' },
  { artifact: 'declared suite list', path: 'package.json', checkedBy: 'declared suite (package.json#scripts.test, skips itemized)' },
  { artifact: 'test wiring', path: 'test', checkedBy: 'test wiring (every suite on disk is named by a script; the release suite and the rest are reported)' },
  { artifact: 'gating workflows', path: '.github/workflows/release.yml', checkedBy: 'workflow wiring (ci.yml and release.yml run the suite scripts.test declares)' },
  { artifact: 'compiled CHANGELOG', path: 'CHANGELOG.md', checkedBy: 'CHANGELOG shape (title above the newest entry, newest-first)' },
  { artifact: 'pre-flight ledger', path: 'scripts/preflight.mjs', checkedBy: 'ledger self-test (silence and an unaccepted UNVERIFIABLE are both failures)' },
  { artifact: 'gate inventory (this table)', path: 'scripts/preflight.mjs', checkedBy: 'gate inventory (every gate exists and is bound to the registered check that measures it)' },
];

/**
 * The verdict on a claims-suite run's counts. Zero executed claims is a FAIL naming the count.
 *
 * `checkTestSuite()` has guarded `counts.tests === 0` since it was written; `checkClaims()` did not,
 * so a run in which every claim was skipped (a `describe` made conditional on the wrong thing, a
 * selector that matched nothing) printed "0 claim(s) checked, 0 pass, 0 skip" and counted as a PASS.
 * That is verbatim the failure mode this file's own header exists to prevent.
 *
 * Pure, and exported, so the refusal can be exercised in both directions by a test rather than
 * asserted in a comment.
 *
 * @param {{tests: number|null, pass: number|null, skipped?: number|null}} counts
 * @returns {{ok: boolean, reason: string}}
 */
export function claimsCountsVerdict(counts) {
  const tests = counts?.tests ?? null;
  const pass = counts?.pass ?? null;
  const skipped = counts?.skipped ?? 0;
  if (tests === null) {
    return {
      ok: false,
      reason:
        'the runner printed no test count at all, so whether the claims executed cannot be read ' +
        'from its output',
    };
  }
  if (tests === 0) {
    return {
      ok: false,
      reason:
        `0 claim(s) executed (tests=0, pass=${pass ?? 0}, skip=${skipped}). Zero executed claims is a ` +
        'failure, not a pass: it is what a skipped describe, a renamed group or a selector that ' +
        'matched nothing looks like from here.',
    };
  }
  if ((pass ?? 0) === 0) {
    return {
      ok: false,
      reason:
        `${tests} claim(s) were collected and not one of them passed (pass=0, skip=${skipped}); a ` +
        'suite whose every assertion skipped has measured nothing',
    };
  }
  return { ok: true, reason: `${tests} claim(s) executed, ${pass} pass, ${skipped} skip` };
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
  // Named by a script, but not by the one script that gates a release. Reported rather than failed:
  // `test:e2e` is a legitimate second list of slow suites, and the workflow check that follows
  // requires every suite here to actually run in a workflow, so "named somewhere" cannot become an
  // excuse for "run nowhere".
  const releaseSuite = new Set(scriptTestFiles(String(scripts.test ?? '')));
  const notReleaseGating = onDisk.filter((f) => declared.has(f) && !releaseSuite.has(f));

  const counts =
    `test/*.test.mjs on disk: ${onDisk.length}; declared by package.json#scripts.test (the release ` +
    `suite): ${releaseSuite.size}; named by another script: ${notReleaseGating.length}; ` +
    `distinct paths named: ${declared.size}; paths named but absent: ${missingOnDisk.length}`;
  const elsewhere =
    notReleaseGating.length === 0
      ? 'no suite is named by a script other than scripts.test'
      : `not in the release suite, and reported so that this is a decision rather than an oversight:\n` +
        notReleaseGating.map((f) => `  ${f}  <- ${declared.get(f).join(', ')}`).join('\n');

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
  return pass(
    `every suite on disk is named by a script (${releaseSuite.size} by scripts.test, ` +
      `${notReleaseGating.length} by another script) and every path named exists`,
    `${counts}\n${elsewhere}`,
  );
}

/**
 * Check 4a': the workflows run the suite the repository declares, rather than a copy of the list.
 *
 * `scripts.test` is one source of truth only if the things that gate a release read it. Both
 * `ci.yml` and `release.yml` used to carry their own hand-written list of twenty-three paths, and
 * both were stale in the same way: six suites that exist, are named by `scripts.test`, and pass on a
 * developer's machine ran in no workflow at all. `release.yml` even carried a comment naming this
 * exact defect class ("a new suite is invisible to the release gate until it is added here ... that
 * has bitten this project once already") and was still stale, which is the honest measure of how
 * much a comment is worth next to a list.
 *
 * So the requirement is structural: the gating workflows must cover every suite `scripts.test`
 * declares -- which `npm test` and `node scripts/preflight.mjs` do *by construction*, and a
 * hand-maintained list does not -- and every suite named by any npm script must run in some
 * workflow.
 */
function checkTestGatingWorkflows() {
  const workflowsDir = join(ROOT, '.github', 'workflows');
  if (!existsSync(workflowsDir)) return fail(`no ${workflowsDir}; there are no workflows to measure`);
  const workflows = readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
  if (workflows.length === 0) return fail(`${workflowsDir} holds no workflow file`);

  const coverage = workflowSuiteCoverage({
    root: ROOT,
    workflows,
    scripts: MANIFEST.scripts ?? {},
  });
  // The loader gate's own triggers, which is what keeps the seat oracle (see
  // loaderGateTriggerProblems) in the release path.
  const compatFile = join(ROOT, '.github', 'workflows', 'compat.yml');
  if (existsSync(compatFile)) {
    coverage.problems.push(...loaderGateTriggerProblems(readFileSync(compatFile, 'utf8')));
  }

  const report = coverage.perWorkflow
    .map(
      (entry) =>
        `${entry.workflow}: ${entry.covered.size} suite(s), via ` +
        `${entry.invocations.length > 0 ? entry.invocations.join(' + ') : 'nothing this check can read'}` +
        (entry.literal.length > 0 ? `; names ${entry.literal.length} path(s) directly` : ''),
    )
    .join('\n');
  const detail =
    `${report}\nrelease suite (package.json#scripts.test): ${coverage.releaseSuite.length} suite(s); ` +
    `gating workflows required to cover it: ${GATING_WORKFLOWS.join(', ')}`;

  if (coverage.releaseSuite.length === 0) {
    return fail('package.json#scripts.test names no suite, so there is nothing to require of a workflow', detail);
  }
  if (coverage.problems.length > 0) {
    return fail(coverage.problems.join(' '), detail);
  }
  return pass(
    `${GATING_WORKFLOWS.join(' and ')} each run all ${coverage.releaseSuite.length} suite(s) declared by ` +
      `package.json#scripts.test, every script-named suite runs in a workflow, and no workflow ` +
      'hand-lists a suite set',
    detail,
  );
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

  // The spec reporter keeps printing the human-readable run; a second reporter writes the same run to
  // a TAP file, because a *skipped* assertion is invisible in the counts alone ("14 skip" says nothing
  // about which claim did not run) and the names and reasons are what this check has to report.
  // `--test-reporter-destination` is Node 20+, and `engines` in package.json declares >= 20.19.0; if a
  // node without it ever runs this file, the check fails loudly with the child's own "bad option"
  // output rather than passing over an unreadable capture.
  const capture = mkdtempSync(join(tmpdir(), 'w2m-preflight-tap-'));
  const tapFile = join(capture, 'suite.tap');
  const started = Date.now();
  const result = child(
    'test',
    process.execPath,
    [
      '--test',
      '--test-force-exit',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=tap',
      `--test-reporter-destination=${tapFile}`,
      ...files,
    ],
    { timeoutMs: TEST_TIMEOUT_MS, env: suiteEnv.env },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const counts = parseTestCounts(result.stdout);

  let skipReport = '';
  try {
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

    const skipped = (counts.skipped ?? 0) > 0;
    const tapExists = existsSync(tapFile);
    if (!tapExists && skipped) {
      return fail(
        `the run reported ${counts.skipped} skipped test(s) and wrote no TAP capture to ${tapFile}, so ` +
          'which claim did not run cannot be named. The TAP reporter flags ' +
          '(--test-reporter=tap --test-reporter-destination=...) are what makes a skip auditable.',
        tail(result, 15),
      );
    }
    if (tapExists) {
      const skips = tapSkips(readFileSync(tapFile, 'utf8'));
      const classified = classifySkips(skips);
      if (classified.problems.length > 0) {
        return fail(classified.problems.join(' '), `skips in this run:\n${classified.lines.join('\n') || '  (none)'}`);
      }
      if ((counts.skipped ?? 0) !== skips.length) {
        return fail(
          `the runner's summary says ${counts.skipped ?? 0} skip(s) and the TAP capture holds ` +
            `${skips.length} skipped result line(s); the tally and the lines must agree before either ` +
            'can be believed, or a skip can hide between them',
          `capture: ${tapFile}`,
        );
      }
      skipReport =
        skips.length === 0
          ? 'no assertion skipped in this run'
          : `${skips.length} skip(s), each on the accepted list, named here:\n${classified.lines.join('\n')}`;
    } else {
      skipReport = 'no TAP capture was written by this node, and the run reported no skips';
    }

    return pass(
      `${counts.tests} test(s) in ${files.length} file(s): ${counts.pass} pass, ${counts.fail} fail, ` +
        `${counts.skipped} skip, ${seconds}s`,
      `declared by package.json#scripts.test\n${suiteEnv.note}\n${skipReport}\nfiles: ${files.join(' ')}` +
        (removed.length > 0
          ? `\nremoved ${removed.length} stale tarball(s) from dist/ before the run, so the tarball ` +
            `assertions measured ${MANIFEST.version}: ${removed.join(', ')}`
          : ''),
    );
  } finally {
    rmSync(capture, { recursive: true, force: true });
  }
}

/**
 * The entry points, measured by the gate ci.yml already runs for them.
 *
 * `scripts/check-entrypoints.mjs` was in the CI workflow and in nothing else: not in this pre-flight's
 * inventory and not in the suite, which is the same "a gate nobody runs before publishing" shape this
 * file exists to end. It is called rather than reimplemented, and both its exit status and its own
 * success line are required -- a probe edited to exit 0 early would satisfy only the first.
 */
function checkEntryPoints() {
  const file = join(ROOT, 'scripts', 'check-entrypoints.mjs');
  if (!existsSync(file)) return fail(`no ${file}; the two published entry points would go unimported`);
  const result = child('check-entrypoints', process.execPath, [file], { timeoutMs: SHORT_TIMEOUT_MS });
  if (!result.ok || !/ALL ENTRY POINTS OK/.test(result.stdout)) {
    return fail(
      `scripts/check-entrypoints.mjs reported a failure (exit ${result.status}, success line ` +
        `${/ALL ENTRY POINTS OK/.test(result.stdout) ? 'present' : 'absent'})`,
      tail(result, 20),
    );
  }
  const passed = (result.stdout.match(/^\s+PASS\s/gm) ?? []).length;
  if (passed === 0) {
    return fail(
      'scripts/check-entrypoints.mjs exited 0 without printing a single PASS line, so "the entry ' +
        'points import" is not what its exit status measured',
      tail(result, 10),
    );
  }
  return pass(`${passed} entry point assertion(s) passed (exit 0 and its own success line)`, result.stdout.trim());
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

/**
 * The inventory relation, as a pure function so both the check and a test can ask the question.
 *
 * @param {string[]} registered the names of the checks about to run.
 * @returns {{missingArtifacts: string[], unbound: string[], problems: string[]}}
 */
export function gateInventoryAnalysis(registered) {
  const missingArtifacts = [];
  const problems = [];
  for (const row of GATE_INVENTORY) {
    if (!existsSync(join(ROOT, row.path))) {
      missingArtifacts.push(`${row.artifact} (${row.path})`);
      continue;
    }
    if (!registered.includes(row.checkedBy)) {
      problems.push(
        `the ${row.artifact} (${row.path}) is declared to be measured by "${row.checkedBy}", which is ` +
          'not a registered check in this run: the artifact exists and nothing measures it',
      );
    }
  }
  const unbound = registered.filter((name) => !GATE_INVENTORY.some((row) => row.checkedBy === name));
  if (unbound.length > 0) {
    problems.push(
      `${unbound.length} registered check(s) measure no artifact this repository declares: ` +
        `${unbound.join(', ')}. Either the check is redundant or GATE_INVENTORY in scripts/preflight.mjs ` +
        'is out of date; a check that measures nothing declared is a check nobody can review.',
    );
  }
  return { missingArtifacts, unbound, problems };
}

/**
 * Step 1's own precondition, stated as a check: every gate this pre-flight delegates to exists, and
 * every one of them is the measurement of a registered check.
 *
 * The second half is the one that earns its keep. Asserting that a file exists says nothing about
 * whether anything reads it: the previous version of this check printed `claims=present` in a run
 * whose claims check had been deleted, because "present" was the whole claim. The relation is now
 * enforced in both directions against `GATE_INVENTORY`.
 *
 * @param {string[]} registered the names of the checks the ledger is about to run.
 */
function checkGateInventory(registered) {
  const { missingArtifacts, unbound, problems } = gateInventoryAnalysis(registered);

  const inventory =
    `${GATE_INVENTORY.length} artifact(s) inventoried; ${registered.length} registered check(s); ` +
    `${unbound.length} unbound\n` +
    GATE_INVENTORY.map((row) => `  ${row.artifact}: ${row.path} -> ${row.checkedBy}`).join('\n');

  if (missingArtifacts.length > 0) {
    return fail(
      `a gate this pre-flight delegates to is not on disk: ${missingArtifacts.join('; ')}`,
      inventory,
    );
  }
  if (problems.length > 0) {
    return fail(problems.join(' '), inventory);
  }
  return pass(
    `every artifact this pre-flight delegates to exists and is bound to the registered check that ` +
      'measures it, in both directions',
    inventory,
  );
}

/**
 * The mojibake scan, with a positive control.
 *
 * The scanner (`scripts/scan-mojibake.mjs`) walks the current directory and prints
 * `clean: no mojibake detected`, which is also what it prints when it walked *nothing*. A gate whose
 * success text is identical in the two cases is not a measurement, so the scanner is first pointed at
 * a throwaway directory holding exactly one deliberately corrupted file: it must find it, name it and
 * exit non-zero. Only then is its "clean" over the tree worth reading.
 */
function checkMojibake() {
  const scanner = join(ROOT, 'scripts', 'scan-mojibake.mjs');
  if (!existsSync(scanner)) return fail(`no scanner at ${scanner}`);

  const control = mkdtempSync(join(tmpdir(), 'w2m-mojibake-control-'));
  try {
    const victim = join(control, 'corrupted.mjs');
    // U+FFFD, written as bytes rather than as a string literal, so this file's own bytes cannot be
    // mistaken for an accident and read the same way by the scanner as the control.
    writeFileSync(victim, Buffer.concat([Buffer.from('export const x = "'), Buffer.from([0xef, 0xbf, 0xbd]), Buffer.from('";\n')]));
    const positive = child('mojibake-control', process.execPath, [scanner], { cwd: control });
    if (positive.ok || !/corrupted\.mjs/.test(positive.stdout)) {
      return fail(
        'the scanner did not report a file containing the replacement character, so its "clean" ' +
          `verdict over the tree cannot be read as a measurement (exit ${positive.status})`,
        tail(positive, 10),
      );
    }

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
    return pass(
      'clean over the whole tree (exit 0 and the scanner said so), and the same scanner named a ' +
        'deliberately corrupted control file',
      `positive control: 1 file, 1 hit, named and exit ${positive.status}\n${result.stdout.trim()}`,
    );
  } finally {
    rmSync(control, { recursive: true, force: true });
  }
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

function checkPackAndTarball() {
  const packer = join(ROOT, 'scripts', 'pack.mjs');
  if (!existsSync(packer)) return fail(`no packer at ${packer}`);

  // (a0) the tree's own documents, asserted against the tree -- before the tarball is even read.
  // This is the part that cannot be satisfied by editing `files[]`, because the expectation does not
  // come from `files[]`.
  const contract = documentContract({ root: ROOT, files: MANIFEST.files });
  if (contract.documents.length === 0) {
    return fail(
      'the document scan found no document in the tree at all, so "every document ships" would pass ' +
        'over an empty set; the scan itself has drifted',
      contract.counts,
    );
  }
  if (contract.problems.length > 0) {
    return fail(
      `the tree and package.json#files disagree about what this package carries: ${contract.problems.join(' ')}`,
      contract.counts,
    );
  }

  const patchField = MANIFEST.dsh?.bundle?.patch;
  if (typeof patchField !== 'string' || patchField.trim() === '') {
    return fail(
      'package.json#dsh.bundle.patch is absent or empty, so nothing says which patch file mounts the ' +
        'plugin; a bundle whose patch field points nowhere mounts nothing',
    );
  }
  const required = requiredShippedEntries(MANIFEST);
  if (required.length === 0) {
    return fail('the manifest names no entry point at all (main, exports, bin, dsh.bundle.patch)');
  }
  // The path a field names must exist before anything is packed: `dsh.bundle.patch` pointing at a
  // file that is not there used to pass every gate, because nothing read the field.
  const dangling = required.filter(({ path }) => !existsSync(join(ROOT, path)));
  if (dangling.length > 0) {
    return fail(
      `${dangling.length} path(s) the manifest names are not in the tree: ` +
        `${dangling.map(({ field, path }) => `${field} -> ${path}`).join('; ')}. A field that names a ` +
        'missing file is read by nothing until a user mounts the package.',
      `${required.length} manifest-declared path(s) checked, including dsh.bundle.patch -> ${patchField}`,
    );
  }

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

    // (a) the tarball, asserted against the TREE-derived expectation. Four directions, and the first
    // two are the ones the previous version of this check structurally could not see:
    //    a1 every document the tree carries is inside the tarball
    //    a2 no document excluded with a reason is inside it anyway
    //    a3 every path `files` names is inside it (the declared side, still worth asserting)
    //    a4 every path the manifest's own entry-point fields name ships
    const missingDocuments = contract.shipped.filter((rel) => !packedRel.has(rel));
    if (missingDocuments.length > 0) {
      return fail(
        `${missingDocuments.length} document(s) the tree carries and package.json#files declares are ` +
          `absent from the packed tarball: ${missingDocuments.join(', ')}`,
        `packed ${packedNames.length} file(s)\n${contract.counts}`,
      );
    }

    const smuggled = contract.excluded.filter((rel) => packedRel.has(rel));
    if (smuggled.length > 0) {
      return fail(
        `${smuggled.length} document(s) are excluded with a reason in scripts/preflight.mjs and are in ` +
          `the packed tarball anyway: ${smuggled.join(', ')}. Either the exclusion is wrong or the ` +
          'packer is adding files nothing declares.',
      );
    }

    const expected = packageFilesExpansion(ROOT, MANIFEST.files);
    const missing = expected.filter((rel) => !packedRel.has(rel));
    if (missing.length > 0) {
      return fail(
        `${missing.length} path(s) from package.json#files are absent from the packed tarball: ` +
          `${missing.join(', ')}`,
        `packed ${packedNames.length} file(s); expected ${expected.length}`,
      );
    }

    const entryProblems = [];
    for (const { field, path } of required) {
      const abs = join(ROOT, path);
      if (statSync(abs).isDirectory()) {
        const prefix = `${path.replace(/\/$/, '')}/`;
        if (![...packedRel].some((rel) => rel.startsWith(prefix))) {
          entryProblems.push(`${field} -> ${path} (a directory) contributes no packed file`);
        }
      } else if (!packedRel.has(path)) {
        entryProblems.push(`${field} -> ${path} is not in the packed tarball`);
      }
    }
    if (entryProblems.length > 0) {
      return fail(
        `${entryProblems.length} path(s) the manifest names do not ship: ${entryProblems.join('; ')}. An ` +
          'entry point that is not in the tarball resolves to nothing on the machine that installs it.',
        `packed ${packedNames.length} file(s)\n${required
          .map(({ field, path }) => `  ${field} -> ${path}`)
          .join('\n')}`,
      );
    }

    // (b) the packed manifest IS the tree's manifest -- the whole of it, not just its version.
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
    const drift = manifestDifferences(MANIFEST, packedManifest);
    if (drift.length > 0) {
      return fail(
        `the packed package.json differs from the tree's in ${drift.length} field(s): ${drift
          .slice(0, 8)
          .join('; ')}${drift.length > 8 ? `; and ${drift.length - 8} more` : ''}. A packed manifest ` +
          'that is not the tree\'s manifest can lose `engines`, `disclosure` or `peerDependencies` ' +
          'while still naming the right version.',
        `compared every field; allowed to differ: ` +
          `${ALLOWED_MANIFEST_DIFFERENCES.length === 0 ? 'nothing' : ALLOWED_MANIFEST_DIFFERENCES.join(', ')}`,
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

    // (d) the packed copy registers the nine tools -- executed from the extracted tarball, not the tree
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
        'scripts/verify-installed.mjs reported the packed copy does not register its nine tools',
        tail(verified, 20),
      );
    }
    // `verify-installed.mjs` already compares the registered names to its own expected list and exits
    // non-zero on a mismatch. The count is parsed as well, and asserted here, because "the probe exited
    // 0" and "the probe registered nine tools" are different measurements and only the second one is
    // the claim this check makes; a probe edited to exit 0 early would satisfy the first.
    const toolCount = Number(verified.stdout.match(/registered\s*:\s*(\d+)/)?.[1] ?? NaN);
    if (toolCount !== 9) {
      return fail(
        `the packed copy registered ${Number.isNaN(toolCount) ? 'an unreadable number of' : toolCount} tool(s), ` +
          `not the nine this package documents`,
        tail(verified, 20),
      );
    }

    // (e) dist/ holds one tarball and it is the one just verified.
    const stale = clearStaleDistArtifacts();

    const sha256 = createHash('sha256').update(gz).digest('hex');
    return pass(
      `${packedNames.length} file(s) packed, byte-identical on a second pack; ` +
        `${contract.shipped.length}/${contract.documents.length} tree document(s) shipped, ` +
        `${contract.excluded.length} excluded with a reason; the manifest is the tree's, field for ` +
        `field; all ${required.length} manifest-declared path(s) shipped; version ` +
        `${packedManifest.version}; no forbidden path; ${toolCount} tools registered from the packed copy`,
      `sha256 ${sha256}\nartifact: ${distTarball}\n${contract.counts}` +
        (contract.excluded.length > 0
          ? `\nexcluded documents and why: ${contract.excluded
              .map((path) => `${path} (see DOCUMENT_EXCLUSIONS in scripts/preflight.mjs)`)
              .join(', ')}`
          : '') +
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
  // the withdrawn-version rule, the bundle patch row, the release tree against the tree-derived
  // document contract, and the tarball URLs. A second copy of those rules here could disagree with
  // it, and then there would be two answers and no way to choose.
  // The reporter is pinned, exactly as checkTestSuite() pins it, and for the same reason: the counts
  // below are read out of stdout, and node's *default* reporter is not a promise this file can keep.
  // Measured: the same command prints the spec reporter's summary under node 24 and TAP's `# tests 48`
  // under node 22 when stdout is a pipe -- which is what a CI runner is. This check therefore read no
  // count at all on the version the workflows run, and reported "the runner printed no test count at
  // all" for a suite that had passed, while every local run on node 24 was green. A gate whose reading
  // depends on the runtime's default output format is a difference that only shows up where it matters.
  const result = child('claims', process.execPath, [
    '--test',
    '--test-force-exit',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    'test/claims.test.mjs',
  ]);
  const counts = parseTestCounts(result.stdout);
  // "0 claim(s) checked, 0 pass, 0 skip" is not a pass. A suite in which every claim was skipped --
  // a `describe` made conditional on the wrong thing, a group renamed, a selector that matched
  // nothing -- produces exactly that line and a zero exit status, and this check used to accept it.
  // checkTestSuite() has guarded the same shape since it was written; this is the same guard.
  const executed = claimsCountsVerdict(counts);
  if (!executed.ok) {
    return fail(
      `test/claims.test.mjs produced no usable verdict (exit ${result.status}): ${executed.reason}`,
      tail(result, 30),
    );
  }
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
    `${counts.tests} claim(s) checked, ${counts.pass} pass, ${counts.skipped ?? 0} skip ` +
      '(version agreement + bundle patch row + release tree included)',
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

/**
 * The pre-flight, as one function.
 *
 * Everything lives inside `main()`, and `main()` runs only when this file *is* the entry point.
 * `test/claims.test.mjs` imports the release contract from this module -- one implementation of the
 * rule, two callers -- and an import that started a whole pre-flight (a throwaway DSH_HOME, a
 * tarball, a thousand tests) would make that reuse impossible. The guard is therefore load-bearing,
 * and it refuses to be silent: a file named `preflight.mjs` that was executed but did not match this
 * module's own path exits non-zero rather than printing nothing and looking like a pass.
 */
async function main() {
  const suiteEnv = prepareSuiteEnv();

  // Name -> implementation, keyed by the names in DECLARED_CHECKS. A declared name with no
  // implementation is a hard error (see the map lookup below), never a silently missing check.
  const implementations = new Map([
    [
      'gate inventory (every gate exists and is bound to the registered check that measures it)',
      () => checkGateInventory(DECLARED_CHECKS),
    ],
    [
      'ledger self-test (silence and an unaccepted UNVERIFIABLE are both failures)',
      checkLedgerCatchesSilence,
    ],
    [
      'test wiring (every suite on disk is named by a script; the release suite and the rest are reported)',
      checkTestWiring,
    ],
    [
      'workflow wiring (ci.yml and release.yml run the suite scripts.test declares)',
      checkTestGatingWorkflows,
    ],
    ['entry points (scripts/check-entrypoints.mjs)', checkEntryPoints],
    ['lint (0 errors required)', checkLint],
    ['mojibake scan (whole tree, plus a positive control)', checkMojibake],
    ['declared suite (package.json#scripts.test, skips itemized)', () => checkTestSuite(suiteEnv)],
    [
      'packed tarball (tree-derived documents + entry points, whole manifest, forbidden paths, 8 tools from the pack)',
      checkPackAndTarball,
    ],
    ['claims (test/claims.test.mjs, reused not reimplemented)', checkClaims],
    ['CHANGELOG shape (title above the newest entry, newest-first)', checkChangelogShape],
  ]);

  const checks = DECLARED_CHECKS.map((name) => {
    const run = implementations.get(name);
    if (run === undefined) {
      throw new Error(
        `scripts/preflight.mjs declares the check "${name}" and binds no implementation to it; a ` +
          'declared check that cannot run is a hole in the gate, not a check to skip',
      );
    }
    return { name, run };
  });
  const unboundImplementations = [...implementations.keys()].filter((name) => !DECLARED_CHECKS.includes(name));
  if (unboundImplementations.length > 0) {
    throw new Error(
      `scripts/preflight.mjs binds implementation(s) for check(s) that DECLARED_CHECKS does not ` +
        `declare: ${unboundImplementations.join(', ')}`,
    );
  }

  process.stdout.write(`w2m pre-flight for ${MANIFEST.name} ${MANIFEST.version} (${ROOT})\n`);
  process.stdout.write(`  checks registered: ${checks.length}\n`);
  process.stdout.write(`  ${suiteEnv.note}\n`);
  process.stdout.write('\n');

  const { results, reported } = await run(checks);
  // The host observation is recorded as a named, non-blocking UNVERIFIABLE whenever the suite had to
  // be run against a shaped home: the suite's PASS is then a statement about the resolver's documented
  // layout, and this line keeps the reader from mistaking it for a statement about this machine.
  const hostEnv = [
    { name: 'host bundled-runtime layout (this machine, not the suite env)', verdict: unverifiable(suiteEnv.hostReason) },
  ];
  const all = [...results, ...hostEnv];

  // An UNVERIFIABLE for a reason this repository has not accepted is a FAIL. Without this, switching
  // any check's PASS to `unverifiable('...')` turns the whole gate green while measuring nothing.
  const unverifiableVerdict = classifyUnverifiable(all);
  const refused = unverifiableVerdict.refused.map((row) => ({
    name: `${row.name} (UNVERIFIABLE refused)`,
    verdict: fail(
      `reported UNVERIFIABLE for a reason that is not on ACCEPTED_UNVERIFIABLE: ${row.reason}. A check ` +
        'that cannot measure something must say what it could not measure in terms this repository ' +
        'has agreed to accept, or fail.',
      row.note,
    ),
  }));

  const failed = [...all.filter((r) => r.verdict.status === 'FAIL'), ...refused];
  const unverified = all.filter((r) => r.verdict.status === 'UNVERIFIABLE' && !refused.some((r2) => r2.name.startsWith(r.name)));
  const passed = all.filter((r) => r.verdict.status === 'PASS');

  process.stdout.write('\n');
  for (const { name, verdict } of failed.filter((r) => r.name.endsWith('(UNVERIFIABLE refused)'))) {
    process.stdout.write(`  FAIL    ${name}: ${verdict.reason}\n`);
    if (verdict.note) process.stdout.write(`          ${verdict.note}\n`);
  }
  for (const { name, verdict } of unverified) {
    process.stdout.write(`  UNVERIF  ${name}: ${verdict.reason}\n`);
    if (verdict.note) process.stdout.write(`          ${verdict.note}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write(
    `pre-flight: ${passed.length} pass, ${failed.length} fail, ${unverified.length} unverifiable ` +
      `(${reported}/${checks.length} registered check(s) reported, plus ${hostEnv.length} host ` +
      `observation(s)) -- ${failed.length > 0 ? 'RED, do not bump' : 'GREEN, cleared to bump'}\n`,
  );
  if (unverified.length > 0) {
    process.stdout.write(
      '  note: UNVERIFIABLE is not a pass. Those checks could not be measured here; the reason above ' +
        'names what was missing, and it is on the accepted list in scripts/preflight.mjs.\n',
    );
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

/** Is `a` the same path as `b`, on a filesystem that may not care about case? */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const SELF = fileURLToPath(import.meta.url);
const INVOKED = process.argv[1] === undefined ? '' : resolve(process.argv[1]);

if (INVOKED !== '' && samePath(INVOKED, SELF)) {
  await main();
} else if (basename(INVOKED) === basename(SELF)) {
  process.stderr.write(
    `preflight: refusing to exit silently. ${INVOKED} was executed but resolves to a different file ` +
      `than this module (${SELF}), so no check ran. A gate that prints nothing and exits 0 is the ` +
      'failure this file exists to prevent.\n',
  );
  process.exit(1);
}
