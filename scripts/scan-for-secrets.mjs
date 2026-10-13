/**
 * Refuse to commit anything that looks like a live credential (v0.7.12).
 *
 * ## Why a scanner rather than a `.gitignore` entry
 *
 * `.gitignore` stops a file being added **by path**. It cannot stop a token that was pasted into a
 * source file, copied into a fixture, or written into a markdown example — and every one of those
 * has happened in this project's history. The relay's state directory is the one the operator named
 * as "must never be open-sourced", and it contains an **operator token** that is full control of
 * the fleet.
 *
 * So this is the second layer: it reads what is actually **tracked** and refuses on content, not on
 * location. That is the property — *no tracked file contains a live credential* — and it is what
 * the accompanying test pins.
 *
 * ## Two severities, because a scanner that cries wolf gets switched off
 *
 *   * **BLOCK** — a real credential shape: a token file's contents, a private key, a bearer token
 *     with enough entropy to be live. These stop a release.
 *   * **REVIEW** — a shape that *might* be a credential and is usually not: a long hex string, a
 *     high-entropy assignment. Reported, never fatal, because a scanner whose false positives block
 *     releases is a scanner someone deletes.
 *
 * The entropy check is deliberately crude. A precise one would need to know each format; the cost of
 * a crude one is a few `REVIEW` lines, and the cost of none is a leaked fleet.
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const SEVERITY = Object.freeze({ BLOCK: 'block', REVIEW: 'review' });

/**
 * Paths that must never be tracked, whatever they contain.
 *
 * Matched against the tracked path, so a directory anywhere in the tree is caught.
 */
export const FORBIDDEN_PATHS = Object.freeze([
  /(^|\/)operator-token\.txt$/,
  /(^|\/)device\.json$/,
  /(^|\/)ilink-login\.json$/,
  /(^|\/)ilink-cursor\.txt$/,
  /(^|\/)credentials\.ya?ml$/,
  /(^|\/)\.credentials\.ya?ml$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /(^|\/)rabbit\//,
  /(^|\/)\.w2m\//,
  /(^|\/)state\//,
]);

/** Content shapes that stop a release. */
export const SECRET_CONTENT = Object.freeze([
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
  /**
   * `operator[_-]?token` covered snake and kebab but **not camelCase**, and this project writes
   * `operatorToken` — so the guard had a hole exactly where the value it protects is spelled. The
   * probe that found it is in the test.
   */
  { name: 'operator token in an assignment', re: /\boperator[_-]?[Tt]oken\b\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/ },
  { name: 'device token in an assignment', re: /\bdevice[_-]?[Tt]oken\b\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/ },
  { name: 'iLink bot token in an assignment', re: /\bbot[_-]?[Tt]oken\b\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
]);

/**
 * Words that mark a value as a deliberate placeholder rather than a credential.
 *
 * This exists because the alternative — exempting the files that tripped it — would have switched
 * the guard off exactly where it matters least and looked like a fix. A test that asserts *"the
 * token must never escape"* has to contain a token-shaped string to do its job, and it says
 * `SUPERSECRET` or `LEAK-CANARY` precisely so a human knows it is not real.
 *
 * Matched **case-insensitively**, which is the opposite of what a first version did. The reasoning
 * for case-sensitivity was that a lowercase `secret` in ordinary prose would suppress a finding —
 * but the marker is looked for in a narrow window around a value that already matched a credential
 * *shape*, so prose cannot reach it, while `SUPERSECRETtokenvalue` (lowercase `secret`) was being
 * reported as a real leak.
 */
export const PLACEHOLDER_MARKERS = Object.freeze([
  'supersecret',
  'fake',
  'dummy',
  'example',
  'placeholder',
  'notareal',
  'not-a-real',
  'redacted',
  'xxxx',
  'changeme',
  'canary',
  'leak',
  'for-tests',
  'for tests',
  'fortests',
  'insecure',
  'hardcoded',
  'sample',
]);

/**
 * A private key inside `test/` is a fixture, because a TLS test has to have one.
 *
 * Narrower than it looks: the exemption is only for the **key-material** rules, only under `test/`,
 * and everything else in those files is still scanned. A real key committed to `src/` or `deploy/`
 * is still blocking, which is where a real one would appear.
 */
export const KEY_FIXTURE_PATHS = Object.freeze([/(^|\/)test\//, /(^|\/)scripts\/e2e\//]);

/**
 * A credential-shaped value that is plainly a **name**, not a token.
 *
 * `'p2p-crypto-operator'` and `'operator-token-for-tests'` are what a fixture is called; a real
 * token is base64 or hex and is not pronounceable.
 *
 * Two revisions were needed, both caught by tests rather than by reading:
 *
 *   1. requiring only lower-case let `'aaaa…'` (32 repeated letters) count as a name, excusing a
 *      genuinely token-shaped value;
 *   2. requiring only `[a-z]` in the segments rejected `'p2p-crypto-operator'`, because the digit in
 *      `p2p` is not a letter — and digits are exactly what names use (`p2p`, `sha256`) while
 *      random credentials avoid them in runs.
 *
 * So: **at least two hyphen-separated segments**, each alphanumeric, with letters present. A
 * credential is a single unbroken run, which is the property being tested.
 */
const LOOKS_LIKE_A_NAME = /^[a-z0-9]+(-[a-z0-9]+)+$/;

/** The window around a match in which a placeholder marker is looked for. */
const MARKER_WINDOW = 120;

/**
 * Whether a matched value declares itself a placeholder.
 *
 * Looks at the text immediately around the match, not the whole file: a file-wide check would let
 * one `FAKE` anywhere suppress every real finding in it.
 */
function isPlaceholder(text, index, matchLength) {
  const from = Math.max(0, index - MARKER_WINDOW);
  const to = Math.min(text.length, index + matchLength + MARKER_WINDOW);
  const window = text.slice(from, to).toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => window.includes(marker));
}

/** Content shapes worth a look, never fatal. */
export const SUSPICIOUS_CONTENT = Object.freeze([
  { name: 'a long hex string', re: /\b[0-9a-f]{64,}\b/i },
  { name: 'a high-entropy assignment', re: /\b(secret|password|passwd|token|api[_-]?key)\b\s*[:=]\s*["'][^"']{16,}["']/i },
]);

/** Files whose content is *expected* to match these shapes, because they are about them. */
export const SCANNER_EXEMPT = Object.freeze([
  // This file lists the patterns, so it necessarily contains them.
  /(^|\/)scripts\/scan-for-secrets\.mjs$/,
  // The signing module documents the header names and a sample `v1=<hex>` shape.
  /(^|\/)src\/chatops\/device-signing\.mjs$/,
  // Tests assert that these patterns are *detected*, so they contain examples.
  /(^|\/)test\/secrets-guard\.test\.mjs$/,
]);

const isExempt = (path) => SCANNER_EXEMPT.some((re) => re.test(path));
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/**
 * Scan one file's content.
 *
 * @param {object} input
 * @param {string} input.path Repo-relative path.
 * @param {string|Buffer} input.content
 */
export function scanContent({ path, content }) {
  const findings = [];
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');

  for (const rule of FORBIDDEN_PATHS) {
    if (rule.test(path)) {
      findings.push({ severity: SEVERITY.BLOCK, path, rule: 'forbidden path', detail: `matches ${rule}` });
    }
  }
  if (isExempt(path)) return findings;

  const fixture = KEY_FIXTURE_PATHS.some((re) => re.test(path));

  for (const rule of SECRET_CONTENT) {
    const m = rule.re.exec(text);
    if (!m) continue;
    // A key fixture under test/ is a fixture: a TLS test cannot exist without one.
    if (rule.name === 'private key block' && fixture) continue;
    // A value that says `SUPERSECRET` is telling the truth about itself.
    if (isPlaceholder(text, m.index, m[0].length)) continue;
    // A value that is only lower-case words is a name a fixture was given, not a token.
    const literal = /["']([^"']+)["']/.exec(m[0])?.[1];
    if (typeof literal === 'string' && LOOKS_LIKE_A_NAME.test(literal)) continue;
    findings.push({
      severity: SEVERITY.BLOCK,
      path,
      rule: rule.name,
      // The match is NOT included: a scanner that prints the secret has moved it, not protected it.
      detail: `matched at offset ${m.index}`,
    });
  }
  for (const rule of SUSPICIOUS_CONTENT) {
    const m = rule.re.exec(text);
    if (m && !isPlaceholder(text, m.index, m[0].length)) {
      findings.push({ severity: SEVERITY.REVIEW, path, rule: rule.name, detail: `matched at offset ${m.index}` });
    }
  }
  return findings;
}

/** Scan a list of tracked files from a working tree. */
export function scanTree({ root, paths, readFile = null }) {
  const findings = [];
  /**
   * `statSync` is only consulted when this module is doing its own reading.
   *
   * A test caught the earlier version calling it unconditionally: with an injected `readFile`, the
   * stat hit the **real** filesystem for a path that existed only in the test, threw, and the
   * `catch` below swallowed it — so the injected reader was never reached and the scan silently
   * reported nothing. That is the same silent-off failure as passing a relative path, and both were
   * found by the same test.
   */
  const read = readFile ?? ((p) => readFileSync(p));
  for (const rel of paths) {
    const abs = `${root}/${rel}`;
    try {
      if (readFile === null && statSync(abs).isDirectory()) continue;
      const buf = read(abs);
      if (isBinary(buf)) continue;
      findings.push(...scanContent({ path: rel, content: buf }));
    } catch {
      // An unreadable file is not a finding: a deleted-but-tracked path would otherwise fail a
      // release, and the property under test is about content.
    }
  }
  return findings;
}

/** The tracked paths of a git working tree. */
export function trackedPaths({ root, git = 'git' }) {
  const out = execFileSync(git, ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((p) => p !== '');
}

export const blocking = (findings) => findings.filter((f) => f.severity === SEVERITY.BLOCK);
export const reviews = (findings) => findings.filter((f) => f.severity === SEVERITY.REVIEW);

/** CLI: exit non-zero when something blocking is tracked, so a release step can gate on it. */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('scan-for-secrets.mjs')) {
  const root = process.argv[2] ?? process.cwd();
  const findings = scanTree({ root, paths: trackedPaths({ root }) });
  const bad = blocking(findings);
  const soft = reviews(findings);
  for (const f of bad) console.log(`BLOCK  ${f.path}: ${f.rule} (${f.detail})`);
  for (const f of soft) console.log(`review ${f.path}: ${f.rule} (${f.detail})`);
  console.log(`\n${bad.length} blocking, ${soft.length} for review, across ${trackedPaths({ root }).length} tracked files.`);
  process.exit(bad.length > 0 ? 1 : 0);
}
