/**
 * The classifier: how a shape becomes evidence, and where the evidence stops.
 *
 * The whole reason this exists is that the raw report names **468 exports** against this repository and the
 * one real defect in it is invisible. So the tests here are about the **argument** the classifier makes, not
 * about a number: a closed loop is a module with one importer and that importer is its own test.
 *
 * The last describe block is the one that matters most — it pins the cases where the classifier is **wrong or
 * silent**, because a classifier whose limits are undocumented gets trusted past them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { after } from 'node:test';
import { join } from 'node:path';

import { CLASS, classifyAll, classifyReport, moduleStem } from '../scripts/reachability-classify.mjs';

/** Every fixture root this file made, removed when the file finishes -- see the after() below. */
const FIXTURE_ROOTS = [];

/** A throwaway tree, in the repo-local fixture dir so no path gains a `tmp` segment. */
function tree(files) {
  const root = mkdtempSync(join(process.cwd(), '.test-fixtures', 'classify-'));
  FIXTURE_ROOTS.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

const findingsFor = (root, file) => classifyAll({ root }).classified.filter((f) => f.file === file);

describe('classifier: a closed loop is the shape this project shipped three times', () => {
  it('calls a module whose only importer is its own test a closed loop', () => {
    // `field-authority.mjs` and `approval-gate.mjs`, reduced to their structure.
    const root = tree({
      'src/orphan.mjs': 'export function onlyExport() { return 1; }\n',
      'test/orphan.test.mjs': "import { onlyExport } from '../src/orphan.test-free.mjs';\nonlyExport();\n".replace('orphan.test-free', 'orphan'),
    });
    const [f] = findingsFor(root, 'src/orphan.mjs');
    assert.equal(f.class, CLASS.CLOSED_LOOP);
    assert.match(f.detail, /a test named after the module itself/);
    assert.match(f.detail, /no source file imports anything from/);
  });

  it('does not call it a loop when a source file imports anything from that module', () => {
    // Importing a DIFFERENT name still means the program reaches the file, which is composition rather than a
    // closed loop -- and telling those apart is the only reason this classifier is more than a regex.
    const root = tree({
      'src/mod.mjs': 'export function reached() { return 1; }\nexport function onlyTestsUse() { return 2; }\n',
      'src/user.mjs': "import { reached } from './mod.mjs';\nexport const v = reached();\n",
      'test/mod.test.mjs': "import { onlyTestsUse } from '../src/mod.mjs';\n",
    });
    const [f] = findingsFor(root, 'src/mod.mjs');
    assert.equal(f.class, CLASS.SIBLING_IMPORTED);
    assert.match(f.detail, /import from this module/);
  });

  it('does not call it a loop when the importer is a test NOT named after the module', () => {
    // The name is used only to decide whether the loop is CLOSED. Without that, every export a test happens to
    // import would be called a defect.
    const root = tree({
      'src/thing.mjs': 'export function onlyExport() { return 1; }\n',
      'test/something-else.test.mjs': "import { onlyExport } from '../src/thing.mjs';\n",
    });
    const [f] = findingsFor(root, 'src/thing.mjs');
    assert.equal(f.class, CLASS.UNNAMED);
    assert.match(f.detail, /the shape proves nothing/);
  });

  it('names the module stem the way the file names it', () => {
    assert.equal(moduleStem('src/agent/council.mjs'), 'council');
    assert.equal(moduleStem('test/council.test.mjs'), 'council');
    assert.equal(moduleStem('scripts/fleet-sync.mjs'), 'fleet-sync');
    assert.equal(moduleStem('test/fleet-sync.test.mjs'), 'fleet-sync');
  });
});

describe('classifier: the report puts the findings where a reader looks first', () => {
  it('counts every class and lists the loops under a heading, not in a flat list', () => {
    const root = tree({
      'src/orphan.mjs': 'export function onlyExport() { return 1; }\n',
      'test/orphan.test.mjs': "import { onlyExport } from '../src/orphan.mjs';\n",
    });
    const { classified } = classifyAll({ root });
    const text = classifyReport(classified);
    assert.match(text, /tests-only exports : 1/);
    assert.match(text, /1 CLOSED LOOP\(S\)/);
    assert.match(text, /src\/orphan\.mjs/);
  });

  it('says so plainly when there are no loops, rather than printing an empty section', () => {
    const root = tree({
      'src/a.mjs': 'export const v = 1;\n',
      'src/b.mjs': "import { v } from './a.mjs';\nexport const w = v;\n",
      'test/a.test.mjs': "import { v } from '../src/a.mjs';\n",
    });
    const text = classifyReport(classifyAll({ root }).classified);
    assert.match(text, /no closed loops/);
    assert.doesNotMatch(text, /CLOSED LOOP\(S\)/);
  });

  it('states the loop\u2019s meaning in the report, so a reader need not know the project history', () => {
    const root = tree({
      'src/o.mjs': 'export function x() {}\n',
      'test/o.test.mjs': "import { x } from '../src/o.mjs';\n",
    });
    const text = classifyReport(classifyAll({ root }).classified);
    assert.match(text, /built, tested, and reachable by nothing but its own suite/);
    assert.match(text, /so a reader can disagree with them rather than having to trust a count/);
  });
});

describe('classifier: where it is WRONG or silent, which is the part a reader must know', () => {
  it('cannot see a module reached through a dynamic import', () => {
    // Stated as a test rather than a comment because it is a real limit: `await import('./x.mjs')` names no
    // binding, and nothing here reads it. A module used that way is reported as a closed loop and IS not one.
    const root = tree({
      'src/dyn.mjs': 'export function reachedDynamically() {}\n',
      'src/loader.mjs': "export async function load() { return import('./dyn.mjs'); }\n",
      'test/dyn.test.mjs': "import { reachedDynamically } from '../src/dyn.mjs';\n",
    });
    const [f] = findingsFor(root, 'src/dyn.mjs');
    assert.equal(f.class, CLASS.CLOSED_LOOP, 'a dynamic import is invisible to this check -- the limitation is pinned, not hidden');
  });

  it('cannot see a module reached only by a CLI entry point that spawns it', () => {
    // `scripts/machine-test-packet.mjs` is run as a program, so nothing imports it. Every such script is
    // reported, which is why the real report names so many -- and why the class count is not a defect count.
    const root = tree({
      'scripts/tool.mjs': 'export function helper() {}\n',
      'bin/cli.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync('node', ['scripts/tool.mjs']);\n",
      'test/tool.test.mjs': "import { helper } from '../scripts/tool.mjs';\n",
    });
    const [f] = findingsFor(root, 'scripts/tool.mjs');
    assert.equal(f.class, CLASS.CLOSED_LOOP, 'a spawned script has no importer, so it is always reported');
  });

  it('reports nothing for an export a source file imports, however the test also names it', () => {
    const root = tree({
      'src/both.mjs': 'export function shared() {}\n',
      'src/user.mjs': "import { shared } from './both.mjs';\n",
      'test/both.test.mjs': "import { shared } from '../src/both.mjs';\n",
    });
    assert.deepEqual(findingsFor(root, 'src/both.mjs'), []);
  });
});

/**
 * Remove the fixture trees this file made.
 *
 * Not tidiness. Leaving them behind made the NEXT pre-flight's lint step walk orphaned empty `.mjs` files and
 * report **11 errors** on files that were no longer under test -- so a test's own litter failed a gate one run
 * later, in a check with no visible connection to the suite that caused it.
 */
after(() => {
  for (const root of FIXTURE_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A fixture that cannot be removed must not turn into a test failure; the next run will report the
      // leftover through lint, which is the check that caught this in the first place.
    }
  }
});
