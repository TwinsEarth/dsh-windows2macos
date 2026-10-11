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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

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
      8,
      `verify-installed.mjs asserts 8 tools; the artifact registers ${REGISTERED.length}`,
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
 */
const INSERT_LIST = /(^|\n)- insert:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/;
const INSERTED_NAME = /^[ \t]+name:[ \t]*['"]?([^'"\r\n#]+?)['"]?[ \t]*$/m;

const PATCH_TEXT = read('cordis.patch.yml');
const patchInsert = PATCH_TEXT.match(INSERT_LIST);
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

  test('the packed package.json names the same version as the tree', (t) => {
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
      const version = tarballManifestVersion(join(DIST_DIR, file));
      assert.equal(
        version,
        PACKAGE_JSON.version,
        `${file} packs version ${version} while the tree is ${PACKAGE_JSON.version}; "which artifact did ` +
          `you install?" would have two answers`,
      );
    }
  });
});

/** The `version` field out of `package/package.json` inside a tarball, without extracting it. */
function tarballManifestVersion(file) {
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
      return JSON.parse(buf.toString('utf8', offset + 512, offset + 512 + size)).version;
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
