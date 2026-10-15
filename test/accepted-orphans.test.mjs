/**
 * The orphan gate: what makes a module an orphan, and why every accepted one carries a reason.
 *
 * Three modules shipped in this span fully tested and reachable by nothing, and two were **described as
 * delivered** while nothing ran them. The classifier that found them could not say which were defects, so it
 * printed and exited 0. This is the half that decides — and a gate is only worth having if its own failure
 * modes are pinned, so the tests below cover the two ways it can be wrong: **missing a new orphan**, and
 * **holding a stale acceptance**.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';

import { ACCEPTED_ORPHANS, REASON, acceptedPaths } from '../scripts/accepted-orphans.mjs';
import { CLASS, LOOP_KIND, classifyAll, reachedIndirectly } from '../scripts/reachability-classify.mjs';

const FIXTURE_ROOTS = [];

/** A throwaway tree in the repo-local fixture dir, so no path gains a `tmp` segment. */
function tree(files) {
  const root = mkdtempSync(join(process.cwd(), '.test-fixtures', 'orphan-'));
  FIXTURE_ROOTS.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

after(() => {
  for (const root of FIXTURE_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Leftovers are reported by the next pre-flight's lint step, which is the check that caught this once.
    }
  }
});

describe('orphan gate: second-order reachability is what separates a library from an orphan', () => {
  it('cannot tell a library from an orphan, and says why rather than printing a zero', () => {
    // The first version of this asserted that a module reached THROUGH another is called a library. That case
    // cannot arise: a row is \`closed-loop\` only when NO source file imports it, so there is never a
    // first-order importer for a second-order walk to start from. Asserted here so the dead idea stays dead.
    const root = tree({
      'src/lib.mjs': 'export function helper() {}\n',
      'src/mid.mjs': "import { helper } from './lib.mjs';\nexport const v = helper();\n",
      'test/lib.test.mjs': "import { helper } from '../src/lib.mjs';\n",
    });
    const { classified } = classifyAll({ root });
    const rows = classified.filter((f) => f.file === 'src/lib.mjs');
    // mid.mjs imports it, so it is not a closed loop at all -- it is sibling-imported.
    for (const r of rows) assert.equal(r.class, CLASS.SIBLING_IMPORTED, r.name);
    assert.equal(rows.some((r) => r.loop_kind === LOOP_KIND.LIBRARY), false);
    assert.ok(Object.values(LOOP_KIND).includes('library-unreachable'), 'the impossibility is named, not deleted');
  });

  it('calls a module nothing reaches an orphan', () => {
    const root = tree({
      'src/orphan.mjs': 'export function alone() {}\n',
      'test/orphan.test.mjs': "import { alone } from '../src/orphan.mjs';\n",
    });
    const { classified } = classifyAll({ root });
    for (const r of classified.filter((f) => f.file === 'src/orphan.mjs')) {
      assert.equal(r.loop_kind, LOOP_KIND.ORPHAN, r.name);
      assert.match(r.reach_detail, /no file in the program imports this module/);
    }
  });

  it('calls a script an orphan-free cli, because having no importer is its normal state', () => {
    // `scripts/*.mjs` are run, not imported. Counting them would make the number large and meaningless.
    const root = tree({
      'scripts/tool.mjs': 'export function helper() {}\n',
      'test/tool.test.mjs': "import { helper } from '../scripts/tool.mjs';\n",
    });
    const { classified } = classifyAll({ root });
    for (const r of classified.filter((f) => f.file === 'scripts/tool.mjs')) {
      assert.equal(r.loop_kind, LOOP_KIND.CLI, r.name);
    }
  });

  it('reports an unimported module as unreached rather than guessing', () => {
    const importers = new Map();
    const r = reachedIndirectly('src/lonely.mjs', importers, ['src/lonely.mjs']);
    assert.equal(r.reached, false);
    assert.equal(r.via, null);
    assert.match(r.detail, /no file in the program imports this module/);
  });

  it('reports a directly imported module as reached, and names the importer', () => {
    // The direct half of `reachedIndirectly` is live and worth pinning: it is what tells a caller whether a
    // file is imported by the PROGRAM rather than only by tests, and the name it returns is how a reader
    // checks the verdict instead of trusting it. The first version of the test above built a throwaway tree
    // for a function that takes a Map, so the tree was never read and the import went unused.
    const importers = new Map([['src/lib.mjs', ['test/lib.test.mjs', 'src/user.mjs']]]);
    const r = reachedIndirectly('src/lib.mjs', importers, ['src/lib.mjs', 'src/user.mjs']);
    assert.equal(r.reached, true);
    assert.equal(r.via, 'src/user.mjs', 'a test importer must not count as reaching it');
    assert.match(r.detail, /imported directly by src\/user\.mjs/);
  });

  it('does not count a test file as reaching the module', () => {
    const importers = new Map([['src/lib.mjs', ['test/lib.test.mjs']]]);
    const r = reachedIndirectly('src/lib.mjs', importers, ['src/lib.mjs']);
    assert.equal(r.reached, false, 'a suite importing it is the definition of a closed loop, not of reach');
  });
});

describe('orphan gate: the acceptance list is itself checkable', () => {
  it('names every accepted orphan by a real path shape', () => {
    for (const entry of ACCEPTED_ORPHANS) {
      assert.match(entry.file, /^(src|bin|scripts)\/.*\.mjs$/, entry.file);
    }
  });

  it('gives every entry a reason AND what would remove it', () => {
    // An accepted orphan with no stated exit is a permanent exception, and a permanent exception is how the
    // original problem happened. Both fields are required for that reason.
    for (const entry of ACCEPTED_ORPHANS) {
      assert.ok(Object.values(REASON).includes(entry.reason), `${entry.file} has an unknown reason ${entry.reason}`);
      assert.ok(typeof entry.why === 'string' && entry.why.length > 40, `${entry.file} needs a real reason`);
      assert.ok(typeof entry.removedBy === 'string' && entry.removedBy.length > 20, `${entry.file} needs a stated exit`);
    }
  });

  it('accepts nothing twice, so the list cannot claim a file is two things', () => {
    const paths = ACCEPTED_ORPHANS.map((e) => e.file);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(acceptedPaths().size, paths.length);
  });

  it('separates the two reasons, and does not pretend they are the same', () => {
    // `library` is a design choice and `interface-unrouted` is the defect. Both appear today; conflating them
    // would let a defect read as a decision.
    const reasons = new Set(ACCEPTED_ORPHANS.map((e) => e.reason));
    assert.ok(reasons.has(REASON.LIBRARY), 'some accepted modules are libraries');
    assert.ok(reasons.has(REASON.INTERFACE_UNROUTED), 'and some are the defect, kept only for lack of a decision');
  });

  it('no longer accepts field-authority, because 0.41.0 gave it a caller', () => {
    // The entry existed to record that 0.29.0 claimed a connection that did not exist. It was removed only
    // when `w2m_memory` started calling the module -- and the gate's own stale-entry check is what demanded
    // the edit. Asserting its ABSENCE here is what stops it being re-added out of habit.
    assert.equal(ACCEPTED_ORPHANS.some((e) => e.file === 'src/agent/field-authority.mjs'), false);
    const text = readFileSync(new URL('../scripts/accepted-orphans.mjs', import.meta.url), 'utf8');
    assert.match(text, /REMOVED in 0\.41\.0/, 'the removal is recorded, not merely applied');
    assert.match(text, /0\.29\.0 claimed this connection existed and it did\s*\n?\s*\* not/, 'and the wrong claim it corrects is still named');
  });
});
