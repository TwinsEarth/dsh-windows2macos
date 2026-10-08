/**
 * Repair the mojibake left by an earlier PowerShell edit round-trip.
 *
 * What happened: `Get-Content`/`Set-Content` read a file as GBK and wrote it back as UTF-8, so every
 * non-ASCII character in the affected writes became a two-character sequence. An em-dash followed by
 * a `?` became two CJK characters; the section sign became one.
 *
 * Why repair at all: the damage landed inside error messages, tool descriptions and `w2m_status`
 * notes -- text a model and a human actually read. `鈥?` in an error message is a defect even though
 * every test still passed.
 *
 * Why ASCII punctuation instead of the original characters: the GBK round-trip is lossy across the
 * em-dash / en-dash / curly-quote family, so the original is not recoverable. ` - ` reads correctly
 * in any terminal, needs no encoding assumption, and cannot be silently re-corrupted by the next
 * tool that touches the file. The section sign is unambiguous and is restored exactly.
 *
 * Every pattern here is written as an escape sequence on purpose: a file that repairs encoding
 * damage must not itself depend on the console's encoding.
 *
 * Usage: node scripts/fix-mojibake.mjs [--write]
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

/** Corrupted sequences and their replacements. Escapes only -- see the header. */
const REPAIRS = [
  // The em-dash family followed by the explanatory `?` the writer emitted: U+9225 then '?'.
  ['\u9225\u003f', ' - '],
  // The same family where the trailing `?` did not survive.
  ['\u9225', ' - '],
  // The section sign: GBK 0xC2 0xA7 read as UTF-8 is U+6402.
  ['\u6402', '\u00a7'],
  // A lone replacement character means data was already destroyed; make it visible instead of
  // leaving an invisible marker in a message.
  ['\ufffd', '?'],
];

/** Directories whose JavaScript is scanned, plus standalone documents. */
const TARGETS = [
  'src',
  'bin',
  'test',
  'scripts',
  'docs',
  'README.md',
  'CHANGELOG.md',
  'PROTOCOL.md',
  'PROTOCOL-v0.1.2.md',
  'PROTOCOL-v0.3.0.md',
  'RELEASE-STATUS.md',
];

/** Extensions worth scanning. */
const EXTENSIONS = ['.mjs', '.js', '.md', '.yml', '.yaml', '.json', '.ps1', '.sh'];

/**
 * Expand the target list into file paths.
 *
 * @returns {string[]} Paths to scan.
 */
function collect() {
  const out = [];
  for (const target of TARGETS) {
    if (EXTENSIONS.some((e) => target.endsWith(e))) {
      out.push(target);
      continue;
    }
    let entries;
    try {
      entries = readdirSync(target, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (EXTENSIONS.some((e) => entry.name.endsWith(e))) out.push(`${entry.parentPath}/${entry.name}`.replace(/\\/g, '/'));
    }
  }
  return out;
}

const write = process.argv.includes('--write');
let touched = 0;
let total = 0;

for (const file of collect()) {
  // This script's own repair table is escapes by design; rewriting it would defeat that.
  if (file.endsWith('fix-mojibake.mjs')) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const before = text;
  let count = 0;
  for (const [bad, good] of REPAIRS) {
    const parts = text.split(bad);
    if (parts.length > 1) {
      count += parts.length - 1;
      text = parts.join(good);
    }
  }
  if (text === before) continue;
  touched += 1;
  total += count;
  process.stdout.write(`  ${file}: ${count}\n`);
  if (write) writeFileSync(file, text, 'utf8');
}

process.stdout.write(
  `\n${write ? 'repaired' : 'would repair'} ${total} sequence(s) in ${touched} file(s)\n`,
);
if (!write && total > 0) process.stdout.write('re-run with --write to apply\n');
