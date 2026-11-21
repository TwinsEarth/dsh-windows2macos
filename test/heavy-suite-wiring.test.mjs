/**
 * Guard: the heavy real-system suites must stay wired.
 *
 * The release gate (`scripts.test`) deliberately excludes the seven heavyweight suites — they run real
 * relays, real UDP sockets, real git worktrees, real proxy shapes and real signing links, and a gate that
 * runs them on every bump would trade minutes for little signal that the cheap suites do not already give.
 *
 * That exclusion is acceptable only while they remain reachable from a named script. Nothing currently
 * fails if a refactor drops one of them from `test:e2e`/`test:all`: the file still exists, so a naive
 * "every test file exists" check stays green, and the only way to notice is that nobody runs it again.
 * That is exactly the failure this file prevents, and it is cheap: read `package.json`, assert membership.
 *
 * The guard is intentionally narrow. It does not demand the heavy suites run in CI here (they need a
 * Windows host with git and free ports); it asserts they are still *wired* so a human or CI job can run
 * them with one command.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

/** The seven heavyweight suites and every script that must keep naming them. */
const HEAVY = Object.freeze({
  'test/e2e.test.mjs': ['test:e2e', 'test:all'],
  'test/crossnetwork.test.mjs': ['test:e2e', 'test:all', 'test:crossnetwork'],
  'test/signing-e2e.test.mjs': ['test:e2e', 'test:all'],
  'test/outbound-only.test.mjs': ['test:e2e', 'test:all'],
  'test/recovery.test.mjs': ['test:e2e', 'test:all'],
  'test/pipeline-e2e.test.mjs': ['test:e2e', 'test:all'],
  'test/p2p-agent.test.mjs': ['test:e2e', 'test:all', 'test:p2p'],
});

/** One script's command line as a set of file arguments (it is a plain space-joined command). */
function refs(script) {
  const command = pkg.scripts?.[script];
  assert.equal(typeof command, 'string', `package.json is missing scripts["${script}"]`);
  return new Set(command.split(/\s+/));
}

describe('heavy suites stay wired', () => {
  for (const [file, scripts] of Object.entries(HEAVY)) {
    it(`${file} is reachable from ${scripts.join(' / ')}`, () => {
      assert.ok(existsSync(join(REPO, file)), `${file} does not exist, so no script can run it`);
      for (const script of scripts) {
        assert.ok(
          refs(script).has(file),
          `scripts["${script}"] no longer names ${file}; the suite still exists but nothing runs it`,
        );
      }
    });
  }

  it('the release gate still names every heavy suite it must NOT run, so the exclusion is explicit', () => {
    // The cheap gate is allowed to omit them; this asserts the omission is a decision, not an accident:
    // `test:all` must be the superset that DOES name them, and its command must be a valid script.
    const all = refs('test:all');
    for (const file of Object.keys(HEAVY)) {
      assert.ok(all.has(file), `test:all must be the superset that runs ${file}`);
    }
  });
});
