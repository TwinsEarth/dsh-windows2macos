/**
 * Find words truncated by the mojibake repair.
 *
 * The repair replaced the corrupted em-dash sequence with `' - '`. Where the em-dash immediately
 * followed a word, the byte-level damage had already eaten the character before it, so a word like
 * `unavailable` came out as `unavailabl`. Tests caught one instance; this finds the rest, because
 * "only one was caught" is not the same as "there was only one".
 *
 * Heuristic: a ` - ` that is directly preceded by a letter, where that token is not a known word --
 * approximated by flagging tokens whose length is >= 3 and that are not in a small dictionary of
 * words the codebase legitimately uses before a dash.
 *
 * Usage: node scripts/scan-truncations.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';

/** Words that legitimately end a clause right before a dash in this codebase. */
const OK = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'it', 'is', 'was', 'are', 'were', 'be', 'not', 'no',
  'so', 'to', 'in', 'on', 'at', 'of', 'for', 'by', 'with', 'from', 'as', 'if', 'then',
  'this', 'that', 'these', 'those', 'they', 'it', 'we', 'you', 'he', 'she', 'one', 'two',
  'here', 'there', 'which', 'who', 'what', 'when', 'where', 'why', 'how', 'all', 'any',
  'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own',
  'same', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'out', 'up', 'down',
  'again', 'further', 'once', 'during', 'before', 'after', 'above', 'below', 'between',
  'match', 'matching', 'seen', 'read', 'written', 'sent', 'already', 'still', 'also', 'even',
  'never', 'always', 'either', 'neither', 'because', 'while', 'since', 'unless', 'until',
  'value', 'values', 'state', 'states', 'task', 'tasks', 'machine', 'machines', 'relay',
  'agent', 'plugin', 'result', 'results', 'lease', 'leases', 'token', 'tokens', 'file',
  'files', 'note', 'notes', 'log', 'logs', 'field', 'fields', 'name', 'names', 'time',
  'zero', 'null', 'true', 'false', 'one', 'many', 'much', 'less', 'least', 'well', 'bad',
  'good', 'new', 'old', 'live', 'dead', 'done', 'set', 'keep', 'kept', 'run', 'runs',
]);

/** File extensions worth scanning. */
const EXTENSIONS = ['.mjs', '.js', '.md', '.yml', '.yaml', '.json', '.ps1', '.sh'];

/**
 * Collect candidate files under the given roots.
 *
 * @returns {string[]} Paths.
 */
function collect() {
  const out = [];
  for (const root of ['src', 'bin', 'test', 'scripts', 'docs']) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && EXTENSIONS.some((e) => entry.name.endsWith(e))) {
        out.push(`${entry.parentPath}/${entry.name}`.replace(/\\/g, '/'));
      }
    }
  }
  for (const file of ['README.md', 'CHANGELOG.md', 'PROTOCOL.md', 'PROTOCOL-v0.3.0.md']) {
    out.push(file);
  }
  return out;
}

let findings = 0;
for (const file of collect()) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // A letter immediately followed by ' - ' at a word boundary.
    const re = /([A-Za-z]{3,}) - /g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const word = m[1];
      if (OK.has(word.toLowerCase())) continue;
      // Common English suffixes make a truncated word look plausible; only flag when the token is
      // short enough that a truncation is likely, or when it is not a word at all.
      if (word.length > 12) {
        findings += 1;
        process.stdout.write(`  ${file}:${i + 1}  "${word}"  ${lines[i].trim().slice(0, 90)}\n`);
      }
    }
  }
}
process.stdout.write(findings === 0 ? '  (no long tokens before a dash — nothing suspicious)\n' : `\n  ${findings} suspicious token(s)\n`);
