/**
 * The session files are READ, never written.
 *
 * The operator's rule is blunt: the plugin cannot, must not and does not inject anything into a DSH session. A comment
 * saying so is a promise; this file is the check. It scans the two modules that touch the session directory for any
 * write-shaped call, because "the panel needs the message to appear in the conversation too" is exactly the convenient
 * feature that would break the rule, and it would look harmless in review.
 *
 * The scan is deliberately narrow and literal: it names the APIs that can mutate a file and the ones that read it. A
 * module that needs another fs function must come here and say why.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WATCHED = [
  'src/plugin/session-watch.mjs',
  'src/plugin/fleet-chat-route.mjs',
];

/** APIs that can mutate a file or a directory. None of them may appear in the modules that read sessions. */
const MUTATING = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'createWriteStream', 'openSync', 'open', 'mkdir', 'mkdirSync',
  'renameSync', 'rename', 'unlinkSync', 'unlink', 'rmSync', 'rm',
  'truncateSync', 'truncate', 'copyFileSync', 'copyFile', 'chmodSync',
];

describe('the session transcript is read-only territory', () => {
  for (const rel of WATCHED) {
    it(rel + ' contains no file-mutating call', () => {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      // Strip comments so the prose explaining the rule cannot trip the scan on its own words.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const found = MUTATING.filter((api) => new RegExp('(^|[^.' + String.fromCharCode(92) + 'w])' + api + String.fromCharCode(92) + 'b').test(code));
      assert.deepEqual(
        found, [],
        rel + ' uses file-mutating API(s): ' + found.join(', ')
          + ' -- the plugin reads sessions and must never write them; if a new read path needs one of these, '
          + 'add it to MUTATING with a written reason instead of loosening this check',
      );
    });
  }
});

