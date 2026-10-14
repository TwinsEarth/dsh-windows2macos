/**
 * The claims <-> artifact gate: our own published claims, checked against the artifact.
 *
 * WHY THIS FILE EXISTS
 *
 * A README drifts from the code one sentence at a time, and no existing suite notices, because
 * every suite tests the code. This one tests the *documents*: the tool names a user is told to
 * call, the tarball URL a user is told to install, and the version a user is told they are
 * getting. If a claim and the artifact disagree, this file fails and names both sides.
 *
 * WHAT IS MEASURED, AND WHAT IS MERELY PARSED
 *
 * The registered tool set is **measured**: `lib/tools.js` -- the exact specifier
 * `cordis.patch.yml` mounts, and the one `scripts/verify-installed.mjs` imports -- is imported and
 * `apply()` is driven against a stub tools registry. The names read out of the registry are the
 * ground truth; the names in `README.md` / `CHANGELOG.md` are parsed and checked against it, never
 * the other way round. A test that compared two documents to each other would pass on a repo where
 * both are wrong.
 *
 * The document scan is deliberately shape-based rather than negation-based. A token is read as a
 * tool name unless it is *being used as a metric identifier*: immediately followed by a label set
 * (`w2m_rtt_ms{machine}`) or by an operator (`w2m_rtt_stale == 0`). That rule comes from the repo's
 * own metrics documentation (`src/relay/metrics.mjs`), where `w2m_rtt_ms` is written in exactly
 * those two shapes -- and it is falsifiable: writing a real tool name in those shapes would take
 * that name out of the scan, and no exemption list is maintained here to hide drift.
 *
 * THE GATES' OWN CLAIMS
 *
 * This file also measures the release machinery itself, in sections 4 onwards: the document contract
 * is imported from `scripts/preflight.mjs` (one implementation, two callers) and asserted against the
 * tree in both directions; the suite lists of `ci.yml` / `release.yml` are read against
 * `package.json#scripts`; the compat workflow's verdict program is extracted from `compat.yml` and run
 * over reporter-shaped TAP captures; the two accepted lists (an UNVERIFIABLE reason, a skipped
 * assertion) are exercised in the direction they must accept and the direction they must refuse; the
 * declared check plan is compared with the gate inventory; and the tool-name scan covers every shipped
 * document, not only the README. Every rule there is exercised both ways: a gate built to stop "a claim
 * nothing checks" is a set of claims itself, and several of its own were unchecked when this section
 * was written.
 *
 * THE NETWORK HALF, STATED PLAINLY
 *
 * One claim cannot be checked offline at all: that the tarball URL in the install instructions
 * exists as a GitHub Release asset. The local half of that claim (the tag names a version, the
 * filename names the same version, the release exists, a withdrawn version is not advertised) runs
 * unconditionally. The remote half follows the convention already documented in `README.md` and
 * used by `test/update-source.test.mjs`: opt in with `W2M_NETWORK_TESTS=1`, opt out with
 * `W2M_SKIP_NETWORK_TESTS=1`, and **skip loudly** in either case -- naming the URL it could not
 * reach and how to run it -- because a check that silently passes is worse than no check.
 *
 * Run it:
 *   node --test --test-force-exit test/claims.test.mjs
 *   W2M_NETWORK_TESTS=1 node --test --test-force-exit test/claims.test.mjs   # incl. the asset check
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
// The release contract, imported rather than restated: one implementation of "what a shipped
// artifact must carry", measured here and by scripts/preflight.mjs. A second copy of these rules
// could disagree with the first, and then there would be two answers and no way to choose.
import {
  ACCEPTED_SKIPS,
  ACCEPTED_UNVERIFIABLE,
  ALLOWED_MANIFEST_DIFFERENCES,
  DECLARED_CHECKS,
  DOCUMENT_EXCLUSIONS,
  GATE_INVENTORY,
  GATING_WORKFLOWS,
  PACKER_ALWAYS,
  claimsCountsVerdict,
  classifySkips,
  classifyUnverifiable,
  documentContract,
  gateInventoryAnalysis,
  loaderGateTriggerProblems,
  manifestDifferences,
  packageFilesExpansion,
  tapSkips,
  treeDocuments,
  workflowSuiteCoverage,
} from '../scripts/preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST_DIR = join(ROOT, 'dist');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Repo files, read once. A missing file is a hard failure, not an empty string. */
const PACKAGE_JSON = JSON.parse(read('package.json'));
const DOCS = {
  'README.md': read('README.md'),
  'CHANGELOG.md': read('CHANGELOG.md'),
};

/**
 * Identifiers that share our `w2m_` prefix but are **not** tools, because the artifact itself
 * exports them as metrics. Read from the metrics module rather than hardcoded, so this exemption
 * cannot be widened silently: if `metrics.mjs` stops naming one, the exemption disappears and the
 * document mentioning it fails the check below.
 */
let METRIC_IDS = [];
try {
  METRIC_IDS = Array.from(new Set(read('src/relay/metrics.mjs').match(/\bw2m_[a-z][a-z0-9_]*/g) ?? []));
} catch {
  METRIC_IDS = [];
}

const REPO = 'TwinsEarth/dsh-windows2macos';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

// ---------------------------------------------------------------------------------------------
// The measured side: drive the real plugin entry and read the registry
// ---------------------------------------------------------------------------------------------

/**
 * A stand-in for cordis' Context, faithful only where the plugin's registration path is observed.
 *
 * `scripts/verify-installed.mjs` uses a `get: () => undefined` stub, which is honest for services
 * that are genuinely absent while `apply()` runs. It is not faithful for *methods on the context*:
 * the v0.5.4 loader failure was `ctx.inject(...)` on a fiber that never declared the service, so a
 * stub without `inject` would either crash for the wrong reason or (if faked) hide that class of
 * failure entirely. `inject` is therefore recorded, and the record is asserted below.
 */
function createStubContext() {
  const registered = [];
  const warnings = [];
  const injected = [];
  const base = {
    tools: { register: (definition) => registered.push(definition) },
    logger: {
      info: (m) => warnings.push(`info: ${m}`),
      warn: (m) => warnings.push(`warn: ${m}`),
      error: (m) => warnings.push(`error: ${m}`),
      debug: (m) => warnings.push(`debug: ${m}`),
    },
    inject: (names) => {
      injected.push(...(Array.isArray(names) ? names : [names]));
      return () => {};
    },
    get: () => undefined,
  };
  // Anything else the registration path may touch (ctx.effect, ctx.on, ctx.set, ...) resolves to a
  // no-op that returns a disposer, so an unrelated service is not mistaken for a broken tool set.
  const ctx = new Proxy(base, {
    get: (target, key) => {
      if (key in target) return target[key];
      return () => () => {};
    },
  });
  return { ctx, registered, warnings, injected };
}

const { ctx, registered, warnings, injected } = createStubContext();
const PLUGIN = await import(pathToFileURL(join(ROOT, 'lib', 'tools.js')).href);
await PLUGIN.apply(ctx, {
  rabbitUrl: 'http://127.0.0.1:8787',
  stateDir: join(ROOT, 'test', '.claims-state'),
});

/** What the artifact says it needs before it is mounted. */
const DECLARED_INJECT = Array.isArray(PLUGIN.inject) ? PLUGIN.inject : [];
/** In-process `ctx.inject([...])` calls made during registration. */
const IN_PROCESS_INJECT = Array.from(new Set(injected));

/** The measured set: what the artifact actually registers. */
const REGISTERED = registered.map((d) => d.name).sort();

// ---------------------------------------------------------------------------------------------
// The claimed side: tool names and tool counts read out of the documents
// ---------------------------------------------------------------------------------------------

/**
 * Tool-name candidates in a document.
 *
 * Boundaries, and why each one is there:
 *   - before: not a word character, not an underscore, not a slash, not a hyphen -- so the tail of a
 *     path or of `x-w2m_run` is not read as a tool. **A backtick must NOT be excluded here**: the
 *     documents write every tool name as `` `w2m_run` ``, so forbidding a preceding backtick makes
 *     the scan find nothing at all and the check pass on an empty set. Measured, after it did
 *     exactly that.
 *   - the token itself is lowercase, like every tool we register;
 *   - after: not another word character, not `=`, not `{` (a label set) -- the shapes the same
 *     prefix takes when it is used as a metric identifier in `CHANGELOG.md`. A trailing
 *     `(?!\s*==)` lookahead would be the natural way to catch `w2m_rtt_stale == 0`, and it is
 *     deliberately **not** used: `\s*` backtracks to zero width, so it matches anyway -- measured.
 *     Excluding metrics by name (see `METRIC_IDS`) is explicit and testable; excluding them by
 *     regex shape, it turns out, is neither.
 */
const TOOL_TOKEN = /(?<![\w_/-])w2m_[a-z][a-z0-9_]*(?![\w={])/g;

function toolNamesIn(text) {
  const names = new Set();
  for (const [match] of text.matchAll(TOOL_TOKEN)) {
    if (METRIC_IDS.includes(match)) continue;
    names.add(match);
  }
  return names;
}

/** `eight` -> `8`, so a count claim written as a word is checked the same way as a digit one. */
const WORD_NUMBERS = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
]);

const NUMBER = '([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
/** "eight tools registered", "eight tools register" */
const COUNT_CLAIM_A = new RegExp(`\\b${NUMBER}\\s+tools?\\s+register(?:s|ed)?\\b`, 'gi');
/** "registers 5 tools", "register 5 tools" -- the same claim from the other side of the verb. */
const COUNT_CLAIM_B = new RegExp(`\\bregister(?:s|ed)?\\s+${NUMBER}\\s+tools?\\b`, 'gi');

/** Every "the plugin has N tools" claim, with the file and line it was read from. */
function countClaimsIn(name, text) {
  const claims = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of [COUNT_CLAIM_A, COUNT_CLAIM_B]) {
      for (const match of line.matchAll(pattern)) {
        const raw = (match[1] ?? '').toLowerCase();
        const count = WORD_NUMBERS.has(raw) ? WORD_NUMBERS.get(raw) : Number(raw);
        claims.push({ file: name, line: index + 1, count, text: match[0].trim() });
      }
    }
  });
  return claims;
}

// ---------------------------------------------------------------------------------------------
// The claimed side: versions, from package.json and the CHANGELOG's own headings
// ---------------------------------------------------------------------------------------------

const CHANGELOG_HEADING = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/;
const CHANGELOG_HEADING_LINE = /^##\s+\[?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\]?/;

/** The CHANGELOG as sections, so "is this version withdrawn?" is answered from its own section. */
function changelogSections() {
  const lines = DOCS['CHANGELOG.md'].split(/\r?\n/);
  const sections = [];
  let current = null;
  lines.forEach((line, index) => {
    const heading = line.match(CHANGELOG_HEADING);
    if (heading && CHANGELOG_HEADING_LINE.test(line)) {
      if (current) sections.push(current);
      current = { version: heading[1], line: index + 1, body: [] };
      return;
    }
    if (current) current.body.push(line);
  });
  if (current) sections.push(current);
  return sections.map((s) => ({ ...s, body: s.body.join('\n') }));
}

const SECTIONS = changelogSections();

/**
 * A version the CHANGELOG itself tells the reader not to install.
 *
 * Read from the section's own opening only -- the heading line plus the first few lines after it --
 * because a section body legitimately *discusses* an earlier broken release. The v0.5.5 section ends
 * with "0.5.4 remains DO NOT INSTALL", which is a sentence about 0.5.4; scanning the whole body would
 * apply it to 0.5.5 and then refuse to let the fixed version ship, which is the opposite of what
 * this gate is for.
 */
function isWithdrawn(section) {
  const opening = [section.heading, ...section.body.split('\n').slice(0, 3)].join('\n');
  return /DO NOT INSTALL|withdrawn|not installable/i.test(opening);
}

const WITHDRAWN = new Set(SECTIONS.filter(isWithdrawn).map((s) => s.version));

// ---------------------------------------------------------------------------------------------
// The claimed side: tarball URLs, and the version each one names
// ---------------------------------------------------------------------------------------------

const RELEASE_URL =
  /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/releases\/download\/[^\s`)"'<>]+/g;

/** Every release-download URL in the documents, with file and line. */
function releaseUrls() {
  const found = [];
  for (const [file, text] of Object.entries(DOCS)) {
    text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(RELEASE_URL)) {
        found.push({ file, line: index + 1, url: match[0] });
      }
    });
  }
  return found;
}

const RELEASE_URLS = releaseUrls();

// ---------------------------------------------------------------------------------------------
// Helpers for the network half
// ---------------------------------------------------------------------------------------------

const NETWORK_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.W2M_NETWORK_TESTS ?? '').trim().toLowerCase(),
);
const NETWORK_FORCED_OFF = process.env.W2M_SKIP_NETWORK_TESTS === '1';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.W2M_UPDATE_TOKEN ?? null;

async function fetchWithTimeout(url, { token = null, method = 'GET', timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'w2m-claims-test',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================================
// 1. The registered set is the artifact's, and it is the set the docs describe
// =============================================================================================

describe('registered tool set (measured from lib/tools.js)', () => {
  test('the plugin entry applies and registers tools', () => {
    assert.ok(
      REGISTERED.length > 0,
      `apply() registered nothing. Warnings collected: ${JSON.stringify(warnings, null, 2)}`,
    );
    assert.equal(
      new Set(REGISTERED).size,
      REGISTERED.length,
      `the same tool name was registered twice: ${REGISTERED.join(', ')}`,
    );
    for (const name of REGISTERED) {
      assert.match(
        name,
        /^w2m_[a-z][a-z0-9_]*$/,
        `registered tool "${name}" does not follow the w2m_* naming rule`,
      );
    }
    // `scripts/verify-installed.mjs` is the documented gate for this exact count. If it is edited
    // without this file, that is a real disagreement worth failing on.
    assert.equal(
      REGISTERED.length,
      9,
      `verify-installed.mjs asserts 9 tools; the artifact registers ${REGISTERED.length}`,
    );
  });

  test('the inject export is what the source declares, and both mount points resolve to it', (t) => {
    // `inject` is the list the mounting machinery reads *before* calling `apply()`. The v0.5.4
    // failure was a service read inside the entry with no inject declaration anywhere, so the two
    // claims worth measuring are that this export traces to exactly one definition, and that both
    // mount points land on it.
    //
    // NOT asserted, deliberately: that `inject` lists every service the entry touches. The v0.5.5 fix
    // for that failure reads `connection` inside `ctx.inject(['connection'], ...)`, which registers
    // the dependency dynamically and must stay *out* of this static list -- `connection` is genuinely
    // absent while `apply()` runs in the real composition. Requiring it here would demand the broken
    // shape back.
    assert.deepEqual(
      DECLARED_INJECT,
      ['tools'],
      `the artifact declares inject ${JSON.stringify(DECLARED_INJECT)}; the source declares ['tools']`,
    );
    // `tools` arrives through that export, performed by the framework; a stub cannot witness it and
    // the registration count above is the evidence that it happened. The dynamic half -- any
    // `ctx.inject([...])` the entry makes for itself, which is what the v0.5.5 fix added for
    // `connection` -- is reported so the two mechanisms cannot be confused for one another.
    t.diagnostic(
      `declared inject: ${JSON.stringify(DECLARED_INJECT)}; ` +
        `dynamic ctx.inject during registration: ${JSON.stringify(IN_PROCESS_INJECT)}`,
    );
  });

  test('every in-tree mount point registers the same set', async () => {
    // `cordis.patch.yml` mounts the package root; `verify-installed.mjs` mounts `lib/tools.js`.
    // Both are claimed to be the same plugin, so both are measured rather than trusted.
    const stub = createStubContext();
    const root = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
    await root.apply(stub.ctx, {
      rabbitUrl: 'http://127.0.0.1:8787',
      stateDir: join(ROOT, 'test', '.claims-state'),
    });
    assert.deepEqual(
      stub.registered.map((d) => d.name).sort(),
      REGISTERED,
      'the package root and lib/tools.js register different tools; cordis.patch.yml mounts the root',
    );
  });
});

describe('claims in README.md and CHANGELOG.md', () => {
  test('every w2m_* tool named in the documents is registered', () => {
    assert.ok(
      METRIC_IDS.length > 0,
      'src/relay/metrics.mjs named no w2m_* metric, so this check cannot tell a metric identifier ' +
        'from a tool name. Fix the read above rather than deleting this assertion: without it the ' +
        'exemption set silently becomes empty and the check below starts reporting metrics as tools.',
    );
    const offenders = [];
    for (const [file, text] of Object.entries(DOCS)) {
      for (const name of toolNamesIn(text)) {
        if (!REGISTERED.includes(name)) offenders.push(`${file}: "${name}" is not registered`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `documented tool names with no implementation:\n  ${offenders.join('\n  ')}\n` +
        `registered: ${REGISTERED.join(', ')}\n` +
        `exempt as metrics (from src/relay/metrics.mjs): ${METRIC_IDS.join(', ')}`,
    );
  });

  test('every "N tools registered" claim in README.md equals the measured count', () => {
    // README only, and deliberately: a CHANGELOG entry saying "the two new tools take the count from
    // six to eight" is a fact about *that release*, and stays true forever. The README is the one
    // document that is a claim about the artifact as it stands now, so it is the one that has to
    // agree with the registry.
    const claims = countClaimsIn('README.md', DOCS['README.md']);
    assert.ok(
      claims.length > 0,
      'no "N tools registered" claim was found in README.md; the artifact\'s tool count is now ' +
        'unstated in the document that describes it',
    );
    const wrong = claims
      .filter((c) => c.count !== REGISTERED.length)
      .map((c) => `${c.file}:${c.line}: "${c.text}" but ${REGISTERED.length} tools are registered`);
    assert.deepEqual(wrong, [], `the documents contradict the artifact:\n  ${wrong.join('\n  ')}`);
  });

  test('the documents name no tool twice under two spellings', () => {
    // A cheap typo guard: a documented name that is a one-character edit of a registered one.
    const near = [];
    for (const [file, text] of Object.entries(DOCS)) {
      for (const name of toolNamesIn(text)) {
        if (REGISTERED.includes(name)) continue;
        for (const real of REGISTERED) {
          if (Math.abs(real.length - name.length) <= 1 && levenshtein(real, name) <= 1) {
            near.push(`${file}: "${name}" looks like a typo of "${real}"`);
          }
        }
      }
    }
    assert.deepEqual(near, [], `near-miss tool names in the documents:\n  ${near.join('\n  ')}`);
  });
});

/** One-line edit distance, enough for the typo guard above. */
function levenshtein(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}

// =============================================================================================
// 2. The version claims
// =============================================================================================

describe('version claims', () => {
  test('package.json matches the newest CHANGELOG entry', () => {
    assert.ok(
      SECTIONS.length > 0,
      'the CHANGELOG names no version; the heading format or the file has changed',
    );
    const newest = SECTIONS[0];
    assert.equal(
      PACKAGE_JSON.version,
      newest.version,
      `package.json says ${PACKAGE_JSON.version}, but the newest CHANGELOG entry (line ${newest.line}) says ` +
        `${newest.version}. One of them is the release; the other is not.`,
    );
  });

  test('the CHANGELOG is in descending version order', () => {
    const versions = SECTIONS.map((s) => s.version);
    const sorted = [...versions].sort(compareVersions).reverse();
    assert.deepEqual(
      versions,
      sorted,
      'CHANGELOG entries are out of order, so "newest" is not the first one',
    );
  });

  test('a version the CHANGELOG tells users not to install is not the installed version', () => {
    assert.ok(WITHDRAWN.size > 0, 'expected at least one withdrawn version to be marked in the CHANGELOG');
    assert.ok(
      !WITHDRAWN.has(PACKAGE_JSON.version),
      `package.json ships ${PACKAGE_JSON.version}, which the CHANGELOG marks DO NOT INSTALL`,
    );
  });
});

function compareVersions(a, b) {
  const parse = (v) => v.split('-')[0].split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// =============================================================================================
// 2b. The bundle patch: the row that decides whether any of this loads at all
// =============================================================================================

/**
 * The `name:` of the row the bundle patch inserts, read without a YAML parser.
 *
 * A YAML parser would be a third-party dependency in a package whose whole selling point is zero
 * of them, so the shape this check depends on is pinned instead: a top-level `- insert:` list whose
 * entries carry `name:`. Both are asserted below, so a restructure of the file fails the gate
 * rather than silently emptying this scan.
 *
 * The path is read from `package.json#dsh.bundle.patch` and not written out by hand. It used to be
 * the literal `cordis.patch.yml`, which meant the one field that says *which* file mounts the plugin
 * was read by nothing: repointing it at a file that does not exist left every gate green while the
 * shipped package mounted no patch at all.
 */
const INSERT_LIST = /(^|\n)- insert:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/;
const INSERTED_NAME = /^[ \t]+name:[ \t]*['"]?([^'"\r\n#]+?)['"]?[ \t]*$/m;

const PATCH_REL = typeof PACKAGE_JSON.dsh?.bundle?.patch === 'string' ? PACKAGE_JSON.dsh.bundle.patch : null;
const PATCH_TEXT = PATCH_REL !== null && existsSync(join(ROOT, PATCH_REL)) ? read(PATCH_REL) : null;
const patchInsert = PATCH_TEXT === null ? null : PATCH_TEXT.match(INSERT_LIST);
const patchRowName = patchInsert ? (patchInsert[2].match(INSERTED_NAME)?.[1] ?? null) : null;

/** `files` entries that must never appear in the released tree. */
const FORBIDDEN_IN_RELEASE = ['test', 'scripts', 'node_modules', '.github', '.git'];

/** Read a gzipped tarball with zlib + 512-byte tar headers: no dependency, no extraction. */
function tarEntries(buffer) {
  const buf = gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const name = buf.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    if (name === '') {
      offset += 512;
      continue;
    }
    const sizeText = buf
      .toString('utf8', offset + 124, offset + 136)
      .replace(/\0.*$/, '')
      .trim();
    const size = parseInt(sizeText || '0', 8);
    entries.push(name);
    offset += 512 + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
  }
  return entries;
}

describe('the bundle patch (cordis.patch.yml)', () => {
  test('dsh.bundle.patch names a file that exists, that ships, and that is the file read here', () => {
    // The field is the only place that says which patch file mounts the plugin, and until this test
    // existed nothing read it: `dsh.bundle.patch` could name a file that is not in the tree (or not in
    // `files`) and every gate stayed green while the installed package mounted nothing.
    assert.equal(
      typeof PACKAGE_JSON.dsh?.bundle?.patch,
      'string',
      `package.json#dsh.bundle.patch is ${JSON.stringify(PACKAGE_JSON.dsh?.bundle?.patch)}; without a ` +
        'string here nothing says which patch file the bundle mounts',
    );
    assert.notEqual(PATCH_REL.trim(), '', 'package.json#dsh.bundle.patch is empty');
    assert.ok(
      existsSync(join(ROOT, PATCH_REL)),
      `package.json#dsh.bundle.patch names ${PATCH_REL}, which does not exist in the tree; the mounted ` +
        'bundle patch would be missing at install time and nothing else in this repository reads the field',
    );
    assert.ok(
      PATCH_TEXT !== null,
      `this suite could not read ${PATCH_REL}, so the assertions below would pass over no text at all`,
    );
    const shipped = packageFilesExpansion(ROOT, PACKAGE_JSON.files);
    const rel = PATCH_REL.replace(/^\.\//, '');
    assert.ok(
      shipped.includes(rel),
      `${PATCH_REL} is mounted by dsh.bundle.patch and package.json#files does not ship it, so the ` +
        `tarball would carry a manifest pointing at a file it does not contain. files[] expansion ` +
        `holds ${shipped.length} path(s); ${rel} is not one of them.`,
    );
  });

  test('the patch inserts a row, and reading it did not silently find nothing', () => {
    assert.ok(patchInsert, 'no `- insert:` list found in cordis.patch.yml; the scan itself has drifted');
    assert.ok(
      patchRowName !== null,
      'the inserted row carries no `name:`, so nothing would be mounted and no tool would exist',
    );
  });

  test('the row names the package, not a subpath', () => {
    // The v0.5.4 failure: a `/tools` row resolves to no package.json, so `dsh.client` is never read
    // and the client half is never composed -- while the host half looks healthy. A row that is not
    // exactly the package name is the defect, whatever else the file says.
    assert.equal(
      patchRowName,
      PACKAGE_JSON.name,
      `the bundle patch mounts "${patchRowName}" but the package is "${PACKAGE_JSON.name}"`,
    );
    // A scoped name legitimately contains one slash (`@scope/name`); a *subpath* import is what has
    // more than one, and it is a subpath specifier that the client-module scan cannot resolve.
    const slashes = (patchRowName.match(/\//g) ?? []).length;
    assert.equal(
      slashes,
      1,
      `the bundle patch names "${patchRowName}", which has ${slashes} slashes: that is a subpath ` +
        `import, not a package specifier, and a client package is identified by its specifier`,
    );
    assert.ok(
      PACKAGE_JSON.exports?.['.'] !== undefined,
      'package.json exports no "." entry, so the mounted package name resolves to nothing',
    );
  });

  test('the file is not the empty-list placeholder and stays a mapping at the top level', () => {
    // A profile's *fresh* `cordis.patch.yml` is the placeholder `[]`, and appending a block to that
    // produces invalid YAML -- one bad row takes the whole profile down. This file is what ships,
    // so it is checked rather than assumed.
    assert.notEqual(
      PATCH_TEXT.trim(),
      '[]',
      'cordis.patch.yml is the empty-list placeholder; appending to it produces invalid YAML',
    );
    assert.match(
      PATCH_TEXT,
      /(^|\n)- insert:/,
      'cordis.patch.yml has no top-level `- insert:` list, so the shipped patch would not compose a row',
    );
  });
});

describe('the release tree', () => {
  test('every document in the tree is declared as shipped or excluded with a reason', () => {
    // The headline rule. `files[]` may not be both the thing that is checked and the thing that says
    // what to check: the previous version of this suite asserted only that the paths `files[]` names
    // exist, so dropping `CHANGELOG.md`, `docs`, `TROUBLESHOOTING.md`, `SECURITY.md`,
    // `CONTRIBUTING.md` and the `PROTOCOL*.md` documents from `files[]` left 22 claims green over a
    // tarball that no longer carried any of them. v0.5.6 shipped exactly that package.
    const contract = documentContract({ root: ROOT, files: PACKAGE_JSON.files });
    assert.ok(
      contract.documents.length > 0,
      'the document scan found no document in the tree, so this assertion would pass over an empty ' +
        'set; the scan itself has drifted',
    );
    for (const name of ['README.md', 'CHANGELOG.md']) {
      assert.ok(
        contract.documents.includes(name),
        `the document scan no longer sees ${name}. That file is the reason this check exists ` +
          `(v0.5.6 shipped without its own changelog), so a scan that stopped finding it would make ` +
          `every assertion below meaningless. It found: ${contract.documents.join(', ')}`,
      );
    }
    assert.deepEqual(
      contract.problems,
      [],
      `the tree and package.json#files disagree about what this package carries:\n  ${contract.problems.join('\n  ')}`,
    );
    assert.equal(
      contract.shipped.length + contract.excluded.length,
      contract.documents.length,
      `every tree document must be accounted for: ${contract.counts}`,
    );
    assert.equal(
      contract.excluded.length,
      DOCUMENT_EXCLUSIONS.length,
      `every declared exclusion must correspond to a document in the tree: ${contract.counts}`,
    );
  });

  test('the document rule refuses the v0.5.6 defect, and it is not satisfiable by editing files[]', () => {
    // The falsifying direction, run against the same code path the check above uses: with `files`
    // emptied, every document must be reported as unaccounted for. If this assertion ever fails, the
    // check above has become circular again and is worth nothing.
    const contract = documentContract({ root: ROOT, files: [] });
    assert.ok(
      contract.problems.length > 0,
      'with an empty files[], the contract reported no problem at all -- it is comparing the shipped ' +
        'set to itself again',
    );
    assert.ok(
      contract.undeclared.includes('CHANGELOG.md'),
      `CHANGELOG.md must be reported as unaccounted for; the problems were: ${contract.problems.join(' ')}`,
    );
    assert.ok(
      contract.undeclared.some((rel) => rel.startsWith('docs/')),
      `the documents under docs/ must be reported as unaccounted for; got: ${contract.undeclared.join(', ')}`,
    );
    // `README.md`, `package.json` and `LICENSE` are added by the packer whether or not `files` names
    // them, so the shipped set is not empty even then. Measured, after an earlier version of this
    // assertion said otherwise and failed on the truth.
    assert.deepEqual(
      contract.shipped.filter((rel) => !PACKER_ALWAYS.includes(rel)),
      [],
      `files[] was empty, so nothing outside the packer's always-shipped set may count as shipped: ` +
        `${contract.shipped.join(', ')}`,
    );
    assert.ok(
      !contract.shipped.includes('CHANGELOG.md'),
      'CHANGELOG.md counted as shipped although files[] did not name it',
    );
  });

  test('the document rule refuses a reasonless exclusion, a stale row and a self-contradicting one', () => {
    const long = 'a reason of sufficient length to be a reason rather than a shrug';
    const reasonless = documentContract({
      root: ROOT,
      files: PACKAGE_JSON.files,
      exclusions: [{ path: 'RELEASE-STATUS.md', reason: '' }],
    });
    assert.ok(
      reasonless.problems.some((p) => p.includes('no usable reason')),
      `an exclusion with no reason must be refused; got: ${reasonless.problems.join(' ')}`,
    );
    const stale = documentContract({
      root: ROOT,
      files: PACKAGE_JSON.files,
      exclusions: [{ path: 'docs/NOT-A-FILE.md', reason: long }],
    });
    assert.ok(
      stale.problems.some((p) => p.includes('stale')),
      `an exclusion naming a file that is not in the tree must be refused; got: ${stale.problems.join(' ')}`,
    );
    // The path used for the contradiction is read from the manifest's own expansion rather than named
    // here: a hand-written path makes this assertion depend on the artifact being healthy, so it fails
    // for the wrong reason on a tree whose `files[]` is broken -- which is exactly when the rule it is
    // testing matters.
    const declaredDocument = packageFilesExpansion(ROOT, PACKAGE_JSON.files).find((rel) => rel.endsWith('.md'));
    assert.ok(
      declaredDocument !== undefined,
      'no declared document was found in files[] to build the contradiction case from, so this ' +
        'assertion cannot measure anything',
    );
    const contradictory = documentContract({
      root: ROOT,
      files: PACKAGE_JSON.files,
      exclusions: [{ path: declaredDocument, reason: long }],
    });
    assert.ok(
      contradictory.problems.some((p) => p.includes('both declared')),
      `a path both declared and excluded must be refused; got: ${contradictory.problems.join(' ')}`,
    );
  });

  test('the manifest comparison notices a lost field, not only a different version', () => {
    // The falsifying direction for the packed-manifest comparison: `engines`, `disclosure` and
    // `peerDependencies` removed, version untouched. A `version`-only comparison passes this.
    const tree = PACKAGE_JSON;
    const stripped = JSON.parse(JSON.stringify(tree));
    delete stripped.engines;
    delete stripped.disclosure;
    delete stripped.peerDependencies;
    const drift = manifestDifferences(tree, stripped);
    for (const field of ['engines', 'disclosure', 'peerDependencies']) {
      assert.ok(
        drift.some((line) => line.startsWith(`${field}:`)),
        `${field} was removed from the packed manifest and the comparison did not report it: ${drift.join('; ')}`,
      );
    }
    assert.deepEqual(
      manifestDifferences(tree, JSON.parse(JSON.stringify(tree))),
      [],
      'an identical manifest must produce no differences at all, or the check cries wolf on every run',
    );
    assert.deepEqual(
      manifestDifferences(tree, stripped, ['engines', 'disclosure', 'peerDependencies']),
      [],
      'the allow-list parameter is not honoured, so a future packer that must rewrite a field has no ' +
        'way to say so in one place',
    );
  });

  test('every path package.json declares as shipped exists', () => {
    const missing = (PACKAGE_JSON.files ?? []).filter((entry) => !existsSync(join(ROOT, entry)));
    assert.deepEqual(
      missing,
      [],
      `package.json declares files that are not in the tree:\n  ${missing.join('\n  ')}`,
    );
  });

  test('no directory that must never ship is declared as shipped', () => {
    const declared = (PACKAGE_JSON.files ?? []).map((e) => e.replace(/^\.\//, '').replace(/\/.*$/, ''));
    const bad = declared.filter((entry) => FORBIDDEN_IN_RELEASE.includes(entry));
    assert.deepEqual(bad, [], `package.json would ship ${bad.join(', ')}, which must never be in a release`);
  });

  test('the dist/ tarball, when present, matches package.json and carries nothing forbidden', (t) => {
    if (!existsSync(DIST_DIR)) {
      t.skip(`no ${relative(ROOT, DIST_DIR)}/ in this checkout: the packed tree was not verified here`);
      return;
    }
    const tarballs = readdirSync(DIST_DIR).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      t.skip(`no .tgz in ${relative(ROOT, DIST_DIR)}/: nothing to verify, and nothing is claimed about it`);
      return;
    }
    for (const file of tarballs) {
      const entries = tarEntries(readFileSync(join(DIST_DIR, file)));
      assert.ok(entries.length > 0, `${file} listed no entries; the tar scan itself has drifted`);

      const forbidden = entries.filter((n) =>
        FORBIDDEN_IN_RELEASE.some((dir) => n === `package/${dir}` || n.startsWith(`package/${dir}/`)),
      );
      assert.deepEqual(
        forbidden,
        [],
        `${file} ships ${forbidden.length} forbidden path(s):\n  ${forbidden.slice(0, 20).join('\n  ')}`,
      );

      const packedJson = entries.find((n) => n === 'package/package.json');
      assert.ok(packedJson, `${file} contains no package/package.json`);
    }
  });

  test('the packed package.json is the tree manifest, field for field', (t) => {
    if (!existsSync(DIST_DIR)) {
      t.skip(`no ${relative(ROOT, DIST_DIR)}/ in this checkout: no packed manifest to compare`);
      return;
    }
    const tarballs = readdirSync(DIST_DIR).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      t.skip(`no .tgz in ${relative(ROOT, DIST_DIR)}/: no packed manifest to compare`);
      return;
    }
    for (const file of tarballs) {
      const packed = tarballManifest(join(DIST_DIR, file));
      assert.ok(packed !== null, `${file} contains no package/package.json, so it declares nothing`);
      assert.equal(
        packed.version,
        PACKAGE_JSON.version,
        `${file} packs version ${packed.version} while the tree is ${PACKAGE_JSON.version}; "which artifact did ` +
          `you install?" would have two answers`,
      );
      // The whole manifest, not only its version. A `version`-only comparison is satisfied by a
      // packed manifest that has lost `engines`, `disclosure` or `peerDependencies`, which is a
      // different package wearing the same number.
      const drift = manifestDifferences(PACKAGE_JSON, packed);
      assert.deepEqual(
        drift,
        [],
        `${file} packs a manifest that is not the tree's (${drift.length} field(s)):\n  ${drift.join('\n  ')}` +
          `\nfields allowed to differ: ${ALLOWED_MANIFEST_DIFFERENCES.length === 0 ? 'none' : ALLOWED_MANIFEST_DIFFERENCES.join(', ')}`,
      );
    }
  });

  test('the dist/ tarball carries every declared document and nothing excluded', (t) => {
    if (!existsSync(DIST_DIR)) {
      t.skip(`no ${relative(ROOT, DIST_DIR)}/ in this checkout: no packed tree to measure`);
      return;
    }
    const tarballs = readdirSync(DIST_DIR).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      t.skip(`no .tgz in ${relative(ROOT, DIST_DIR)}/: nothing is claimed about a tarball that is not here`);
      return;
    }
    const contract = documentContract({ root: ROOT, files: PACKAGE_JSON.files });
    assert.deepEqual(
      contract.problems,
      [],
      `the tree and package.json#files disagree about what ships:\n  ${contract.problems.join('\n  ')}`,
    );
    for (const file of tarballs) {
      const present = new Set(
        tarEntries(readFileSync(join(DIST_DIR, file))).map((name) => name.replace(/^package\//, '')),
      );
      const missing = contract.shipped.filter((rel) => !present.has(rel));
      assert.deepEqual(
        missing,
        [],
        `${file} is missing ${missing.length} document(s) the tree carries and files[] declares:\n  ${missing.join('\n  ')}`,
      );
      const smuggled = contract.excluded.filter((rel) => present.has(rel));
      assert.deepEqual(
        smuggled,
        [],
        `${file} carries ${smuggled.length} document(s) excluded with a reason in scripts/preflight.mjs:\n  ${smuggled.join('\n  ')}`,
      );
    }
  });
});

/** The parsed `package/package.json` inside a tarball, without extracting anything to disk. */
function tarballManifest(file) {
  const buf = gunzipSync(readFileSync(file));
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const name = buf.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    if (name === '') {
      offset += 512;
      continue;
    }
    const size = parseInt(
      buf
        .toString('utf8', offset + 124, offset + 136)
        .replace(/\0.*$/, '')
        .trim() || '0',
      8,
    );
    if (name === 'package/package.json') {
      return JSON.parse(buf.toString('utf8', offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Repo-relative path, for messages that a reader has to be able to act on. */
function relative(from, to) {
  return to.startsWith(from) ? to.slice(from.length).replace(/^[\\/]/, '') : to;
}

// =============================================================================================
// 3. The tarball claims: local half (always), remote half (loud skip unless asked for)
// =============================================================================================

/** `v0.4.6` + `twinsearth-w2m-dsh-plugin-0.4.6.tgz` parsed out of one install URL. */
function parseReleaseUrl(entry) {
  const url = entry.url;
  const rest = url.startsWith(DOWNLOAD_PREFIX) ? url.slice(DOWNLOAD_PREFIX.length) : null;
  if (rest === null) return { ...entry, ok: false, why: `not a ${REPO} release-download URL` };
  const [tag, asset, ...extra] = rest.split('/');
  if (!asset || extra.length > 0) return { ...entry, ok: false, why: `malformed release path "${rest}"` };
  const tagVersion = tag.startsWith('v') ? tag.slice(1) : null;
  const assetMatch = asset.match(/^twinsearth-w2m-dsh-plugin-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/);
  return {
    ...entry,
    ok: true,
    tag,
    tagVersion,
    asset,
    assetVersion: assetMatch ? assetMatch[1] : null,
  };
}

const PARSED_URLS = RELEASE_URLS.map(parseReleaseUrl);

describe('release tarball claims (checked locally)', () => {
  test('the documents point at at least one release tarball', () => {
    assert.ok(
      PARSED_URLS.length > 0,
      'no GitHub release-download URL was found in README.md or CHANGELOG.md; either the install ' +
        'instructions lost their tarball form, or this scan has drifted from them',
    );
  });

  test('every documented tarball URL is a well-formed install URL', () => {
    const bad = PARSED_URLS.filter((u) => !u.ok).map((u) => `${u.file}:${u.line}: ${u.why} -- ${u.url}`);
    assert.deepEqual(bad, [], `malformed install URLs:\n  ${bad.join('\n  ')}`);
  });

  test('the tag, the filename and the version inside it all agree', () => {
    const bad = [];
    for (const u of PARSED_URLS.filter((x) => x.ok)) {
      if (u.tagVersion === null) bad.push(`${u.file}:${u.line}: tag "${u.tag}" is not a v-prefixed version`);
      if (u.assetVersion === null)
        bad.push(`${u.file}:${u.line}: asset "${u.asset}" is not <name>-<version>.tgz`);
      if (u.tagVersion !== null && u.assetVersion !== null && u.tagVersion !== u.assetVersion) {
        bad.push(
          `${u.file}:${u.line}: tag ${u.tag} carries ${u.asset}, so a user installs ${u.assetVersion} while the URL says ${u.tagVersion}`,
        );
      }
    }
    assert.deepEqual(bad, [], `install URLs that name two different versions:\n  ${bad.join('\n  ')}`);
  });

  test('a documented tarball for a withdrawn version is labelled as withdrawn', () => {
    const bad = [];
    for (const u of PARSED_URLS.filter((x) => x.ok && x.tagVersion)) {
      if (!WITHDRAWN.has(u.tagVersion)) continue;
      // The URL itself is expected to sit in a DO NOT INSTALL context; the surrounding text is the
      // only place that context can live, so it is checked rather than assumed.
      const text = DOCS[u.file];
      const lines = text.split(/\r?\n/);
      const window = lines.slice(Math.max(0, u.line - 12), u.line + 12).join('\n');
      if (!/DO NOT INSTALL|not installable|withdrawn/i.test(window)) {
        bad.push(`${u.file}:${u.line}: offers v${u.tagVersion}, which is withdrawn, with no warning nearby`);
      }
    }
    assert.deepEqual(bad, [], `withdrawn versions offered as installs:\n  ${bad.join('\n  ')}`);
  });

  test('every documented version has a CHANGELOG entry', () => {
    const known = new Set(SECTIONS.map((s) => s.version));
    const bad = PARSED_URLS.filter((u) => u.ok && u.tagVersion && !known.has(u.tagVersion)).map(
      (u) => `${u.file}:${u.line}: v${u.tagVersion} has no CHANGELOG section`,
    );
    assert.deepEqual(bad, [], `documented installs with no recorded history:\n  ${bad.join('\n  ')}`);
  });
});

describe('release tarball claims (GitHub Release assets)', () => {
  test('every documented tarball exists as a release asset', async (t) => {
    const wanted = Array.from(
      new Map(
        PARSED_URLS.filter(
          (u) => u.ok && u.tagVersion && u.assetVersion && u.tagVersion === u.assetVersion,
        ).map((u) => [`${u.tag}/${u.asset}`, u]),
      ).values(),
    ).sort((a, b) => (a.tag < b.tag ? -1 : 1));

    if (NETWORK_FORCED_OFF) {
      t.skip(
        `W2M_SKIP_NETWORK_TESTS=1: could not reach ${DOWNLOAD_PREFIX} -- ` +
          `${wanted.length} release asset(s) unverified (${wanted.map((w) => w.tag).join(', ')}). ` +
          `The local half of this claim ran; re-run without the flag or with W2M_NETWORK_TESTS=1`,
      );
      return;
    }
    if (!NETWORK_ENABLED) {
      t.skip(
        `network check not enabled: could not reach ${DOWNLOAD_PREFIX} for ${wanted.map((w) => w.tag).join(', ')}. ` +
          `Run with W2M_NETWORK_TESTS=1 (a GITHUB_TOKEN / GH_TOKEN is used when present). ` +
          `The local URL-shape half of this claim ran unconditionally.`,
      );
      return;
    }

    // One API call answers every version at once; a transport failure falls back to a HEAD request
    // per asset, which is the cheapest honest way to distinguish "gone" from "unreachable".
    const apiUrl = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
    const unreachable = [];
    let assetsByTag = null;
    try {
      const response = await fetchWithTimeout(apiUrl, { token: GITHUB_TOKEN, timeoutMs: 30_000 });
      if (response.ok) {
        const releases = await response.json();
        assetsByTag = new Map(
          releases.map((r) => [r.tag_name, new Set((r.assets ?? []).map((a) => a.name))]),
        );
      } else {
        unreachable.push(`${apiUrl} -> HTTP ${response.status}`);
      }
    } catch (error) {
      unreachable.push(`${apiUrl} -> ${error?.message ?? String(error)}`);
    }

    const missing = [];
    for (const entry of wanted) {
      if (assetsByTag) {
        const assets = assetsByTag.get(entry.tag);
        if (assets === undefined)
          missing.push(`${entry.file}:${entry.line}: release ${entry.tag} does not exist`);
        else if (!assets.has(entry.asset)) {
          missing.push(
            `${entry.file}:${entry.line}: release ${entry.tag} has no asset ${entry.asset} (has: ${[...assets].join(', ')})`,
          );
        }
        continue;
      }
      const url = `${DOWNLOAD_PREFIX}${entry.tag}/${entry.asset}`;
      try {
        const response = await fetchWithTimeout(url, { method: 'HEAD', timeoutMs: 20_000 });
        if (response.status === 404) {
          missing.push(`${entry.file}:${entry.line}: HTTP 404 for ${url}`);
        } else if (!response.ok) {
          unreachable.push(`${url} -> HTTP ${response.status}`);
        }
      } catch (error) {
        unreachable.push(`${url} -> ${error?.message ?? String(error)}`);
      }
    }

    // A confirmed absence fails, always: that is the drift this check exists for.
    assert.deepEqual(missing, [], `documented installs that do not exist:\n  ${missing.join('\n  ')}`);

    // An unreachable host is an environmental fact, not a defect -- but it is reported loudly,
    // naming every URL that could not be reached, and never silently passed.
    if (unreachable.length > 0) {
      t.diagnostic(
        `UNREACHABLE: could not verify ${unreachable.length} of ${wanted.length} release asset(s) -- ` +
          `${unreachable.join('; ')}. Nothing here says the assets are missing; it says this environment ` +
          `could not ask GitHub. Re-run on a networked host.`,
      );
    }

    const verified = wanted.filter(() => missing.length === 0 && unreachable.length === 0);
    if (verified.length !== wanted.length) {
      t.diagnostic(
        `verified ${wanted.length - unreachable.length}/${wanted.length} documented tarball(s) against ` +
          `GitHub Release assets${GITHUB_TOKEN ? ' (authenticated)' : ' (unauthenticated API)'}`,
      );
    }
  });
});

// =============================================================================================
// 4. The gates' own claims, exercised in both directions
//
// A gate built to stop "a claim nothing checks" is itself a set of claims, and the review that
// produced this section found three of them unchecked: a pre-flight that accepted a claims suite
// which had executed **zero** claims, workflows whose suite lists were maintained by hand beside the
// one in `package.json` (six suites ran in no workflow at all), and a compat verdict program that
// accepted an un-evaluated page assertion for a reason that was a property of the *artifact* rather
// than of the runner.
//
// Each rule below is exercised in the direction it must accept and in the direction it must refuse,
// because a rule that has never been seen to refuse anything is indistinguishable from a rule that
// cannot refuse anything. The philosophy is the one `checkLedgerCatchesSilence()` already applies to
// the pre-flight's own ledger: measure the checker, not only what it checks.
// =============================================================================================

/**
 * A heredoc'd program out of a workflow file, dedented exactly as GitHub hands the block to a shell.
 *
 * The extraction is asserted rather than best-effort: if the workflow stops carrying the program it
 * claims to run, this function throws and the suite says so, instead of quietly testing a copy of a
 * program nobody runs any more.
 *
 * @param {string} workflowText
 * @param {string} target the file name the heredoc writes, e.g. `verify-tap.mjs`
 * @returns {string}
 */
function workflowHeredoc(workflowText, target) {
  const lines = workflowText.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(
    (line) => line.includes('cat > ') && line.includes(target) && /<<'?JS'?/.test(line),
  );
  assert.ok(
    start >= 0,
    `no heredoc writing ${target} was found in the workflow; this suite can no longer prove that the ` +
      'workflow runs the program whose behaviour it asserts',
  );
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*JS\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  assert.ok(end > start, `the heredoc writing ${target} has no terminating JS marker`);
  const body = lines.slice(start + 1, end);
  const indents = body.filter((line) => line.trim() !== '').map((line) => line.match(/^[ \t]*/)[0].length);
  const strip = Math.min(...indents);
  return body.map((line) => line.slice(strip)).join('\n');
}

/** The assertions `test/loader-entry.test.mjs` declares, read the way the verdict program reads them. */
const LOADER_TITLES = [
  ...read('test/loader-entry.test.mjs').matchAll(/^[ \t]*(?:it|test)\(\s*'((?:[^'\\]|\\.)*)'/gm),
].map((match) => match[1]);

/**
 * A TAP capture, built from the titles the suite really declares.
 *
 * The shape is the reporter's own: `E:\Temp`-measured captures from
 * `node --test --test-reporter=tap test/loader-entry.test.mjs` render each result as
 * `<indent>ok N - <full name>` (with ` # SKIP <reason>` when skipped) inside a `# Subtest:` block,
 * followed by the `# tests/# pass/# skipped` tally lines. Only the result lines and the tallies are
 * reproduced here, which is everything the verdict program reads.
 *
 * @param {Array<{title: string, ok?: boolean, skip?: string|null}>} rows
 * @returns {string}
 */
function tapCapture(rows) {
  const lines = ['TAP version 13', '# Subtest: loader entry: the packed artifact, mounted by the real Loader'];
  rows.forEach((row, index) => {
    const directive = row.skip ? ` # SKIP ${row.skip}` : '';
    lines.push(`    ${row.ok === false ? 'not ok' : 'ok'} ${index + 1} - ${row.title}${directive}`);
  });
  lines.push(`    1..${rows.length}`);
  lines.push('ok 1 - loader entry: the packed artifact, mounted by the real Loader');
  lines.push(`# tests ${rows.length}`);
  lines.push('# suites 1');
  lines.push(`# pass ${rows.filter((row) => row.ok !== false && !row.skip).length}`);
  lines.push(`# fail ${rows.filter((row) => row.ok === false).length}`);
  lines.push('# cancelled 0');
  lines.push(`# skipped ${rows.filter((row) => row.skip).length}`);
  lines.push('# todo 0');
  lines.push('# duration_ms 12.3');
  return `${lines.join('\n')}\n`;
}

/** All the deterministic assertions present and passing. */
const GREEN_ROWS = () => LOADER_TITLES.map((title) => ({ title, ok: true, skip: null }));

const HONEST_NO_BROWSER_REASON =
  'no Chromium-based browser found (set W2M_DSH_BROWSER to one); tried: /usr/bin/google-chrome, ' +
  '/usr/bin/chromium, /usr/bin/chromium-browser, /usr/bin/microsoft-edge';

describe('the workflow suite wiring (one source of truth for the suite list)', () => {
  test('the two gating workflows run every suite package.json#scripts.test declares', () => {
    const coverage = workflowSuiteCoverage({
      root: ROOT,
      workflows: GATING_WORKFLOWS,
      scripts: PACKAGE_JSON.scripts,
    });
    assert.ok(
      coverage.releaseSuite.length > 0,
      'package.json#scripts.test names no suite, so this assertion would pass over nothing',
    );
    assert.deepEqual(
      coverage.problems,
      [],
      `the workflows and package.json#scripts.test disagree:\n  ${coverage.problems.join('\n  ')}`,
    );
    for (const entry of coverage.perWorkflow) {
      const missing = coverage.releaseSuite.filter((file) => !entry.covered.has(file));
      assert.deepEqual(
        missing,
        [],
        `${entry.workflow} runs ${entry.covered.size} suite(s) but not all ${coverage.releaseSuite.length} ` +
          `declared by scripts.test; missing: ${missing.join(', ')}`,
      );
      assert.ok(
        entry.covered.size >= coverage.releaseSuite.length,
        `${entry.workflow} covers fewer suites (${entry.covered.size}) than scripts.test declares`,
      );
    }
  });

  test('a workflow that hand-lists a suite set is refused, and told why', () => {
    // The v0.5.9 shape of both gating workflows, in miniature: two paths on one `node --test` line.
    const stale = workflowSuiteCoverage({
      root: ROOT,
      workflows: [
        {
          name: 'ci.yml',
          text: 'jobs:\n  test:\n    steps:\n      - run: node --test --test-force-exit test/relay.test.mjs test/broadcast.test.mjs\n',
        },
      ],
      scripts: PACKAGE_JSON.scripts,
    });
    assert.ok(
      stale.problems.some((problem) => problem.includes('hand-lists 2 suite paths')),
      `a hand-maintained suite list must be refused; got: ${stale.problems.join(' | ')}`,
    );
    assert.ok(
      stale.problems.some((problem) => problem.includes('runs 2 of the')),
      `the missing coverage must be named; got: ${stale.problems.join(' | ')}`,
    );
    assert.ok(
      stale.problems.some((problem) => problem.includes('run in no workflow')),
      `suites that run nowhere must be named; got: ${stale.problems.join(' | ')}`,
    );
  });

  test('a suite named by a script that no workflow runs is refused', () => {
    // S4's shape: a new suite file named only by `test:all`. It exists, a script names it, the pre-flight
    // prints "37 named by at least one npm script" -- and nothing ever runs it. The release-gating list is
    // `scripts.test`, and a suite outside it has to be *run by a workflow* or be reported as not gating.
    const scripts = {
      ...PACKAGE_JSON.scripts,
      'test:all': `${PACKAGE_JSON.scripts['test:all']} test/a-brand-new-suite.test.mjs`,
    };
    const coverage = workflowSuiteCoverage({
      root: ROOT,
      workflows: GATING_WORKFLOWS,
      scripts,
    });
    assert.ok(
      coverage.namedByAnyScript.includes('test/a-brand-new-suite.test.mjs'),
      'the synthetic suite is not in the script-named set, so this test measures nothing',
    );
    assert.ok(
      coverage.problems.some((problem) => problem.includes('run in no workflow')),
      `a suite no workflow runs must be refused; got: ${coverage.problems.join(' | ') || '(no problems)'}`,
    );
    assert.ok(
      coverage.problems.some((problem) => problem.includes('a-brand-new-suite')),
      `the refusal must name the suite; got: ${coverage.problems.join(' | ')}`,
    );
  });

  test('what the workflows run follows scripts.test: add a suite and it runs, remove one and it stops', () => {
    // The proof that the wiring is a derivation rather than a second list. A suite added to
    // `scripts.test` appears in what `ci.yml` runs with no edit to ci.yml, because ci.yml runs
    // `npm test`; a suite removed from `scripts.test` stops being run for the same reason. This is
    // the measurement the review asked for, kept where it runs on every push.
    const scripts = PACKAGE_JSON.scripts;
    const files = [...String(scripts.test).matchAll(/\S+\.test\.mjs/g)].map((match) => match[0]);
    assert.ok(files.length > 0, 'scripts.test names no suite, so this measurement has nothing to vary');

    const added = {
      ...scripts,
      test: `node --test --test-force-exit ${[...files, 'test/e2e.test.mjs'].join(' ')}`,
    };
    const withAdded = workflowSuiteCoverage({ root: ROOT, workflows: ['ci.yml'], scripts: added });
    assert.ok(
      withAdded.perWorkflow[0].covered.has('test/e2e.test.mjs'),
      'a suite added to scripts.test is not covered by ci.yml, so the workflow list is maintained ' +
        'somewhere other than the script',
    );

    const removed = {
      ...scripts,
      test: `node --test --test-force-exit ${files
        .filter((file) => !file.endsWith('claims.test.mjs'))
        .join(' ')}`,
    };
    const withRemoved = workflowSuiteCoverage({ root: ROOT, workflows: ['ci.yml'], scripts: removed });
    assert.ok(
      !withRemoved.perWorkflow[0].covered.has('test/claims.test.mjs'),
      'a suite removed from scripts.test is still reported as run by ci.yml, so the coverage reading ' +
        'does not follow the script',
    );
    assert.ok(
      withRemoved.problems.some((problem) => problem.includes('claims.test.mjs')),
      `removing the claims suite from scripts.test must be reported somewhere: ${withRemoved.problems.join(' | ')}`,
    );
  });
});

describe('the claims-count guard (a suite that executed nothing is a failure)', () => {
  test('zero executed claims is refused, and a real run of this suite is accepted', () => {
    // The defect: a run in which every top-level `describe` was skipped printed
    // "0 claim(s) checked, 0 pass, 0 skip" and the pre-flight counted it as a PASS.
    const nothing = claimsCountsVerdict({ tests: 0, pass: 0, fail: 0, skipped: 0 });
    assert.equal(nothing.ok, false, 'a suite that executed zero claims must not produce a pass');
    assert.match(
      nothing.reason,
      /0 claim\(s\) executed/,
      `the refusal must name the count; got: ${nothing.reason}`,
    );
    assert.equal(
      claimsCountsVerdict({ tests: null, pass: null, fail: null, skipped: null }).ok,
      false,
      'a run with no readable count must not produce a pass',
    );
    assert.equal(
      claimsCountsVerdict({ tests: 22, pass: 0, fail: 0, skipped: 22 }).ok,
      false,
      'a run in which every collected claim skipped has measured nothing',
    );
    const real = claimsCountsVerdict({ tests: 22, pass: 21, fail: 0, skipped: 1 });
    assert.equal(real.ok, true, `this suite's own shape must be accepted; got: ${real.reason}`);
  });
});

describe('the compat verdict program (skipped, failed or missing is a failure)', () => {
  const PROGRAM = workflowHeredoc(read('.github/workflows/compat.yml'), 'verify-tap.mjs');
  const PAGE_TITLE = LOADER_TITLES.find((title) => title.includes('boots the profile'));

  /**
   * Run the workflow's own verdict program over a capture, in a throwaway directory.
   *
   * @param {{capture: string, browser: string, extraTitle?: string}} input `extraTitle` appends an
   *   assertion to the copy of the suite the program reads, which is how "somebody added a test" is
   *   simulated without touching the repository.
   * @returns {{status: number, output: string}}
   */
  function runVerdictProgram({ capture, browser, extraTitle }) {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-verdict-'));
    try {
      const program = join(dir, 'verify-tap.mjs');
      writeFileSync(program, PROGRAM);
      writeFileSync(join(dir, 'capture.tap'), capture);
      writeFileSync(join(dir, 'exit'), '0\n');
      let testFile = join(ROOT, 'test', 'loader-entry.test.mjs');
      if (extraTitle !== undefined) {
        testFile = join(dir, 'loader-entry.extra.mjs');
        writeFileSync(testFile, `${read('test/loader-entry.test.mjs')}\n  it('${extraTitle}', () => {});\n`);
      }
      const result = spawnSync(process.execPath, [program], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TAP_FILE: join(dir, 'capture.tap'),
          TEST_EXIT_FILE: join(dir, 'exit'),
          W2M_DSH_BROWSER: browser,
          W2M_COMPAT_TEST_FILE: testFile,
          GITHUB_STEP_SUMMARY: '',
        },
      });
      return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('the program exercised here is the program the workflow runs', () => {
    assert.ok(
      PROGRAM.includes('ACCEPTED_UNVERIFIABLE') && PROGRAM.includes('DETERMINISTIC'),
      'the extracted program does not look like the verdict program; the workflow was restructured ' +
        'and this suite is now measuring something else',
    );
    assert.ok(LOADER_TITLES.length >= 10, `the suite declares only ${LOADER_TITLES.length} assertion(s)`);
    assert.ok(PAGE_TITLE !== undefined, 'no assertion in the suite mentions booting the profile');
  });

  test('the honest no-browser skip is accepted, and a fully passing capture passes', () => {
    const honest = runVerdictProgram({
      capture: tapCapture([
        ...GREEN_ROWS().slice(0, 9),
        { title: PAGE_TITLE, ok: true, skip: HONEST_NO_BROWSER_REASON },
      ]),
      browser: '',
    });
    assert.equal(
      honest.status,
      0,
      `the legitimate case -- no browser on the runner, page half skipped for that reason -- must ` +
        `still pass:\n${honest.output}`,
    );
    assert.match(honest.output, /Accepted reason `no-browser`/, honest.output);
    assert.match(honest.output, /### compat \/ mount-and-boot: UNVERIFIABLE/, honest.output);

    const everything = runVerdictProgram({
      capture: tapCapture(GREEN_ROWS()),
      browser: '/usr/bin/google-chrome',
    });
    assert.equal(everything.status, 0, `a capture in which every assertion ran and passed must pass:\n${everything.output}`);
    assert.match(everything.output, /### compat \/ mount-and-boot: PASS/, everything.output);
  });

  test('a page skip whose reason is about the artifact is refused, not accepted as no-browser', () => {
    // The reproduced defect, verbatim in shape: the runner has no browser, and the page assertion
    // skipped because the *composition* had no page to open. The old program keyed the accepted
    // reason on the environment (`BROWSER === '' ? 'no-browser' : 'unknown'`) and exited 0.
    const refused = runVerdictProgram({
      capture: tapCapture([
        ...GREEN_ROWS().slice(0, 9),
        { title: PAGE_TITLE, ok: true, skip: 'the Web app did not boot, so there was no page to open' },
      ]),
      browser: '',
    });
    assert.notEqual(refused.status, 0, `a skip for a reason about our own artifact must fail:\n${refused.output}`);
    assert.doesNotMatch(
      refused.output,
      /Accepted reason/,
      `nothing may be reported as an accepted reason here:\n${refused.output}`,
    );
    assert.match(refused.output, /was SKIPPED \(the Web app did not boot/, refused.output);
  });

  test('an assertion added to the suite that skips is refused without editing the program', () => {
    const extra = 'a brand new assertion added this week';
    const refused = runVerdictProgram({
      capture: tapCapture([
        ...GREEN_ROWS().slice(0, 9),
        { title: PAGE_TITLE, ok: true, skip: HONEST_NO_BROWSER_REASON },
        { title: extra, ok: true, skip: 'not today' },
      ]),
      browser: '',
      extraTitle: extra,
    });
    assert.notEqual(refused.status, 0, `an eleventh assertion that skips must fail:\n${refused.output}`);
    assert.match(refused.output, /a brand new assertion added this week/, refused.output);
  });

  test('an assertion the suite declares but the capture never ran is refused', () => {
    const extra = 'an assertion that never produced a result line';
    const refused = runVerdictProgram({
      // The capture holds only the ten real assertions; the suite (the copy the program reads)
      // declares eleven. Nothing in the capture is skipped or failed, so only the declared-versus-run
      // comparison can notice.
      capture: tapCapture([
        ...GREEN_ROWS().slice(0, 9),
        { title: PAGE_TITLE, ok: true, skip: HONEST_NO_BROWSER_REASON },
      ]),
      browser: '',
      extraTitle: extra,
    });
    assert.notEqual(refused.status, 0, `an assertion with no result line must fail:\n${refused.output}`);
    assert.match(refused.output, /holds no result line for it/, refused.output);
  });

  test('a deterministic assertion that skips cannot borrow the page half’s accepted reason', () => {
    const refused = runVerdictProgram({
      capture: tapCapture([
        ...GREEN_ROWS().slice(0, 8),
        { title: LOADER_TITLES[8], ok: true, skip: HONEST_NO_BROWSER_REASON },
        { title: PAGE_TITLE, ok: true, skip: HONEST_NO_BROWSER_REASON },
      ]),
      browser: '',
    });
    assert.notEqual(
      refused.status,
      0,
      `the accepted reason covers the page half only; a deterministic assertion that skipped must fail:\n${refused.output}`,
    );
  });
});

describe('the loader gate’s triggers (the seat oracle must not stop running)', () => {
  test('compat.yml runs on pull requests and on release tags', () => {
    const text = read('.github/workflows/compat.yml');
    assert.deepEqual(
      loaderGateTriggerProblems(text),
      [],
      'the loader gate must run on every pull request and on every `v*` tag: it is the only place the ' +
        'packed artifact is mounted by the real Loader and its page booted by the real shell, and that ' +
        'page boot is the only assertion the client seat has that is not made against our own copy of it',
    );
  });

  test('a workflow that stopped running on tags is refused, naming what is lost', () => {
    const stripped = read('.github/workflows/compat.yml').replace(/\n\s+tags: \['v\*'\]/, '');
    const problems = loaderGateTriggerProblems(stripped);
    assert.equal(problems.length, 1, `a missing tag trigger must be refused: ${problems.join(' | ') || '(none)'}`);
    assert.match(problems[0], /does not run on `v\*` tags/, problems[0]);
    const noPr = loaderGateTriggerProblems(
      read('.github/workflows/compat.yml').replace(/^[ \t]*pull_request:.*$/m, ''),
    );
    assert.equal(noPr.length, 1, `a missing pull-request trigger must be refused: ${noPr.join(' | ') || '(none)'}`);
    assert.match(noPr[0], /pull requests/, noPr[0]);
  });
});

describe('the accepted lists (what this repository agrees not to measure)', () => {
  test('an UNVERIFIABLE for a reason nobody accepted is refused, and the accepted host reason is not', () => {
    const refused = classifyUnverifiable([
      {
        name: 'lint (0 errors required)',
        verdict: { status: 'UNVERIFIABLE', reason: 'INSTRUMENT: a plausible-sounding excuse' },
      },
    ]);
    assert.equal(
      refused.accepted.length,
      0,
      `an unaccepted reason must not be accepted: ${refused.accepted.map((row) => row.name).join(', ')}`,
    );
    assert.deepEqual(
      refused.refused.map((row) => row.name),
      ['lint (0 errors required)'],
      'a check that cannot measure something must be refused unless its reason is on the accepted list',
    );

    const host = ACCEPTED_UNVERIFIABLE[0];
    const accepted = classifyUnverifiable([
      {
        name: host.appliesTo,
        verdict: {
          status: 'UNVERIFIABLE',
          reason:
            "this host's DSH_HOME (C:\\Users\\somebody\\.dsh) contains no dsh-runtimes/; the bundle carries the runtime elsewhere",
        },
      },
    ]);
    assert.deepEqual(
      accepted.accepted.map((row) => row.entry.key),
      [host.key],
      `the one accepted reason must still be accepted: ${JSON.stringify(accepted.refused)}`,
    );
    assert.equal(accepted.refused.length, 0);
  });

  test('a skip whose reason is not on the accepted list is refused, and the per-entry cap holds', () => {
    const unaccepted = classifySkips([
      { suite: 'some suite', name: 'an assertion nobody thought about', reason: 'not today' },
    ]);
    assert.equal(
      unaccepted.problems.length,
      1,
      `an unaccepted skip must be refused: ${unaccepted.problems.join(' | ') || '(none)'}`,
    );
    assert.match(unaccepted.problems[0], /an assertion nobody thought about/, unaccepted.problems[0]);

    const entry = ACCEPTED_SKIPS[0];
    const loaderSkip = (index) => ({
      suite: 'loader entry: the packed artifact, mounted by the real Loader',
      name: `assertion ${index}`,
      reason: 'no DeepSeek Harness installation found to drive the real Loader; set W2M_DSH_RUNTIME (tried: nothing)',
    });
    const overCap = classifySkips(Array.from({ length: entry.maxCount + 1 }, (_, index) => loaderSkip(index + 1)));
    assert.equal(
      overCap.problems.length,
      1,
      `a skip count above the accepted cap must be reported: ${overCap.problems.join(' | ') || '(none)'}`,
    );
    assert.match(overCap.problems[0], /accepts at most/, overCap.problems[0]);
    const atCap = classifySkips(Array.from({ length: entry.maxCount }, (_, index) => loaderSkip(index + 1)));
    assert.deepEqual(atCap.problems, [], `exactly the accepted number of skips must pass: ${atCap.problems.join(' | ')}`);
  });

  test('a skip is attributed to the suite that encloses it, and its reason is read from its own line', () => {
    // The shape is the TAP reporter's own: a `# Subtest:` line per suite and per assertion, then the
    // result line carrying the SKIP directive.
    const capture = [
      'TAP version 13',
      '# Subtest: outer suite',
      '    # Subtest: a passing assertion',
      '    ok 1 - a passing assertion',
      '    # Subtest: a skipped assertion',
      '    ok 2 - a skipped assertion # SKIP the reason this repository has to accept',
      '    1..2',
      'ok 1 - outer suite',
    ].join('\n');
    const skips = tapSkips(capture);
    assert.deepEqual(
      skips,
      [
        {
          suite: 'outer suite',
          name: 'a skipped assertion',
          reason: 'the reason this repository has to accept',
        },
      ],
      `the skip census must name the suite, the assertion and the reason: ${JSON.stringify(skips)}`,
    );
    assert.deepEqual(tapSkips('TAP version 13\n# tests 0\n'), [], 'a capture with no skips must produce no skips');
  });
});

describe('the check plan and the gate inventory (a deleted check is a finding)', () => {
  test('the declared plan, the inventory and the implementations agree', () => {
    assert.ok(DECLARED_CHECKS.length >= 11, `only ${DECLARED_CHECKS.length} check(s) are declared`);
    assert.equal(
      new Set(DECLARED_CHECKS).size,
      DECLARED_CHECKS.length,
      'a check name is declared twice, so the ledger count would double-count it',
    );
    const analysis = gateInventoryAnalysis(DECLARED_CHECKS);
    assert.deepEqual(
      analysis.missingArtifacts,
      [],
      `the inventory names files that are not in the tree: ${analysis.missingArtifacts.join(', ')}`,
    );
    assert.deepEqual(analysis.problems, [], `the plan and the inventory disagree:\n  ${analysis.problems.join('\n  ')}`);
    for (const row of GATE_INVENTORY) {
      assert.ok(
        DECLARED_CHECKS.includes(row.checkedBy),
        `the inventory binds the ${row.artifact} to "${row.checkedBy}", which is not a declared check`,
      );
    }
  });

  test('removing one check leaves its artifact unmeasured, and the analysis says so', () => {
    const withoutClaims = DECLARED_CHECKS.filter(
      (name) => name !== 'claims (test/claims.test.mjs, reused not reimplemented)',
    );
    const analysis = gateInventoryAnalysis(withoutClaims);
    assert.ok(
      analysis.problems.some((problem) => problem.includes('claims suite')),
      `deleting the claims check must leave the claims suite unmeasured; got: ${analysis.problems.join(' | ') || '(no problems)'}`,
    );
  });
});

describe('the documentation scan covers every shipped document, in both directions', () => {
  test('every registered tool is named in README.md', () => {
    const readme = DOCS['README.md'];
    const named = (text, name) => new RegExp(`(?<![\\w_/-])${name}(?![\\w={])`).test(text);
    const missing = REGISTERED.filter((name) => !named(readme, name));
    assert.deepEqual(
      missing,
      [],
      `README.md does not name ${missing.length} registered tool(s): ${missing.join(', ')}. The README is ` +
        'the document that describes the artifact as it stands; a tool that disappears from it fails ' +
        'nothing else.',
    );
    // The falsifying direction: with one tool name replaced, the same scan must report it. Without this,
    // the assertion above could be satisfied by a regex that matches everything.
    const damaged = readme.split(REGISTERED[0]).join('w2m_somethingelse');
    assert.deepEqual(
      REGISTERED.filter((name) => !named(damaged, name)),
      [REGISTERED[0]],
      'the scan does not notice a tool removed from the README, so it is not measuring the README',
    );
  });

  test('every tool name in every shipped document is a registered tool', () => {
    const documents = treeDocuments(ROOT);
    assert.ok(documents.length >= 10, `the tree holds only ${documents.length} document(s); the scan has drifted`);
    const offenders = [];
    for (const rel of documents) {
      for (const name of toolNamesIn(read(rel))) {
        if (!REGISTERED.includes(name)) offenders.push(`${rel}: "${name}" is not registered`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `shipped documents name tools that do not exist:\n  ${offenders.join('\n  ')}\n` +
        `registered: ${REGISTERED.join(', ')}\n` +
        `exempt as metrics (from src/relay/metrics.mjs): ${METRIC_IDS.join(', ')}`,
    );
  });
});
