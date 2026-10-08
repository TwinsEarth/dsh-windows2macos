/**
 * Scan the repository for mojibake.
 *
 * The failure mode this catches: a PowerShell `Get-Content`/`Set-Content` round trip through a GBK
 * code page turns an em dash into a CJK sequence. It happened before, in user-visible error strings
 * and tool descriptions, and it is invisible in review because the bytes are valid UTF-8 -- they just
 * spell the wrong thing. Detection is cheap, so it runs in the gate list.
 *
 * Matches the specific sequences seen in practice plus the U+FFFD replacement character, rather than
 * flagging all non-ASCII: this project legitimately contains CJK in docs and in comments.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', '.w2m-update']);
const EXT = /\.(mjs|js|json|md|yml|yaml|sh|ps1)$/;

/**
 * Files that must contain the corrupt sequences on purpose.
 *
 * `fix-mojibake.mjs` is a repair table: its whole job is to hold what the corruption looks like, so
 * flagging it would mean the scanner can never pass. Exempting it by exact path -- rather than by a
 * pattern that could accidentally cover a real casualty -- keeps the exemption auditable.
 */
const EXEMPT = new Set(['scripts\\fix-mojibake.mjs', 'scripts/fix-mojibake.mjs']);

// The observed corruptions, plus U+FFFD.
const PATTERNS = [
  /\uFFFD/, // replacement character: an encode/decode round trip lost a byte
  /\u9426|\u9225|\u9514|\u60e7|\u93c2/, // the CJK sequences an em dash decaying into GBK produces
  /\u00e2\u20ac/, // e2 80 xx read as Latin-1: the classic UTF-8 em dash misread
  /\u00ef\u00bf\u00bd/,
];

/** Collect offending files. */
const found = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!EXT.test(entry.name)) continue;
    const normalized = path.replace(/\\/g, '/');
    if (EXEMPT.has(path) || EXEMPT.has(normalized)) continue;
    const text = readFileSync(path, 'utf8');
    const hits = new Set();
    for (const re of PATTERNS) {
      for (const m of text.matchAll(new RegExp(re.source, 'g'))) hits.add(m[0]);
    }
    if (hits.size > 0) found.push({ path, hits: [...hits] });
  }
}
walk('.');

if (found.length === 0) {
  process.stdout.write('  clean: no mojibake detected\n');
} else {
  for (const f of found) {
    const shown = f.hits.map((h) => JSON.stringify(h)).join(' ');
    process.stdout.write(`  ${f.path}: ${f.hits.length} distinct sequence(s): ${shown}\n`);
  }
  process.exitCode = 1;
}
