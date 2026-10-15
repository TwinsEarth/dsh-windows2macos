/**
 * Layer-model suite: the refusals, and the one invariant about the real tree.
 *
 * What these protect, said once: `layer-model.mjs` is an **allow-list**, and an allow-list is only worth
 * having if an undeclared dependency fails loudly. So the bulk of this file constructs edges that must be
 * refused — an upward edge, an undeclared edge, an edge involving something that is not a layer at all — and
 * asserts each is caught *and distinguished*, because "two layers are wired wrongly" and "a file is in the
 * wrong place" need different fixes.
 *
 * The last block runs against the real source tree. It is the test that fails when somebody adds an import
 * without declaring it, which is the entire point of the model existing as data.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_EDGES,
  AUTHORITY_BANDS,
  CAPABILITIES,
  LAYERS,
  LAYER_NAMES,
  checkEdges,
  isDestructive,
  permissionFor,
  rankOf,
} from '../scripts/layer-model.mjs';
import { buildGraph } from '../scripts/layer-check.mjs';

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

describe('layer model: the declared shape is internally coherent', () => {
  it('has a unique name and rank for every layer', () => {
    const names = LAYERS.map((l) => l.name);
    assert.equal(new Set(names).size, names.length, 'layer names must be unique');
    assert.equal(LAYER_NAMES.length, LAYERS.length);
  });

  it('declares only edges between layers that exist', () => {
    // A typo in an allow-list entry is invisible otherwise: it simply never matches, and the edge it was
    // meant to permit is refused forever with no explanation.
    for (const [from, to] of ALLOWED_EDGES) {
      assert.notEqual(rankOf(from), null, `${from} must be a declared layer`);
      assert.notEqual(rankOf(to), null, `${to} must be a declared layer`);
    }
  });

  it('never allows an edge that points upward', () => {
    // The direction rule, asserted over the whole allow-list rather than one entry: an allow-list that
    // contradicted the rank order would make the rank order decorative.
    for (const [from, to] of ALLOWED_EDGES) {
      assert.ok(rankOf(from) >= rankOf(to), `${from}(${rankOf(from)}) -> ${to}(${rankOf(to)}) points upward`);
    }
  });

  it('has no duplicate allow-list entries', () => {
    const keys = ALLOWED_EDGES.map(([a, b]) => `${a} -> ${b}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('layer model: undeclared edges are refused, and the reason is specific', () => {
  it('accepts a declared edge', () => {
    const r = checkEdges([{ from: 'plugin', to: 'agent', count: 2, example: 'plugin/tools.mjs' }]);
    assert.equal(r.ok, true);
    assert.equal(r.violations.length, 0);
    assert.equal(r.allowed.length, 1);
  });

  it('refuses an edge that is simply not declared', () => {
    // `plugin -> chatops` does not exist today. If somebody adds it, this is what must happen.
    const r = checkEdges([{ from: 'plugin', to: 'chatops', count: 1, example: 'plugin/tools.mjs' }]);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].from, 'plugin');
    assert.match(r.violations[0].reason, /not in ALLOWED_EDGES/);
  });

  it('names an upward edge as upward rather than as merely undeclared', () => {
    // The two need different fixes: upward means the dependency is wrong in principle, undeclared might just
    // mean the allow-list is out of date.
    const r = checkEdges([{ from: 'chatops', to: 'plugin', count: 3, example: 'chatops/run-command.mjs' }]);
    assert.equal(r.ok, false);
    assert.match(r.violations[0].reason, /upward/);
    assert.equal(r.violations[0].from_rank, 1);
    assert.equal(r.violations[0].to_rank, 4);
  });

  it('separates a non-layer from a rank violation', () => {
    // A file in the wrong place is a different problem from two layers wired wrongly, and reporting them
    // alike would send the reader to the wrong file.
    const r = checkEdges([{ from: 'agent', to: 'not-a-layer', count: 1, example: 'agent/agent.mjs' }]);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 0, 'this is not a rank violation');
    assert.equal(r.unexplained.length, 1);
    assert.match(r.unexplained[0].reason, /not a declared layer/);
  });

  it('reports every bad edge rather than stopping at the first', () => {
    // A checker that reports one problem per run makes cleanup a sequence of runs.
    const r = checkEdges([
      { from: 'plugin', to: 'chatops', count: 1, example: 'a' },
      { from: 'chatops', to: 'plugin', count: 1, example: 'b' },
      { from: 'agent', to: 'nowhere', count: 1, example: 'c' },
    ]);
    assert.equal(r.violations.length, 2);
    assert.equal(r.unexplained.length, 1);
    assert.equal(r.ok, false);
  });

  it('is clean on an empty edge set, so a graph with no cross-layer edges is not an error', () => {
    const r = checkEdges([]);
    assert.equal(r.ok, true);
  });
});

describe('layer model: the ranks describe the tree that exists', () => {
  it('places the plugin surface above the agent it drives', () => {
    assert.ok(rankOf('plugin') > rankOf('agent'));
    assert.ok(rankOf('relay') > rankOf('chatops'));
  });

  it('places both leaves at the bottom, where nothing depends on them in turn', () => {
    assert.equal(rankOf('util'), 0);
    assert.equal(rankOf('shared'), 0);
    for (const [from, to] of ALLOWED_EDGES) {
      assert.ok(rankOf(to) >= 0);
      if (to === 'util' || to === 'shared') assert.ok(rankOf(from) > 0, `${from} depending on a leaf must be above it`);
    }
  });
});

describe('layer model: permissions are declared, and an unknown one is not assumed safe', () => {
  it('returns the declared minimum authority for a known capability', () => {
    assert.equal(permissionFor('read_fleet_state'), AUTHORITY_BANDS.ORDINARY);
    assert.equal(permissionFor('dispatch_writing'), AUTHORITY_BANDS.CAPTAIN);
    assert.equal(permissionFor('write_config'), AUTHORITY_BANDS.SYSTEM_ADMIN);
  });

  it('returns null for an undeclared capability rather than a default', () => {
    // A permission table that answers "allowed" for anything it has not heard of is a table that grants
    // whatever is added next. Null forces the caller to decide.
    assert.equal(permissionFor('teleport'), null);
    assert.equal(permissionFor(''), null);
    assert.equal(permissionFor(undefined), null);
  });

  it('does not claim an unknown capability is harmless', () => {
    assert.equal(isDestructive('teleport'), null, 'unknown must be null, not false');
    assert.equal(isDestructive('publish_release'), true);
    assert.equal(isDestructive('read_fleet_state'), false);
  });

  it('keeps every capability in a band the authority model actually defines', () => {
    // The table must not invent its own numbers, or it becomes a second authority model.
    const bands = Object.values(AUTHORITY_BANDS);
    for (const c of CAPABILITIES) {
      assert.ok(bands.includes(c.min_authority), `${c.name} has min_authority ${c.min_authority}, not a declared band`);
    }
  });

  it('requires a higher band for a destructive capability than for a read', () => {
    // The one ordering claim worth asserting: destruction is never the cheapest thing to authorise.
    const reads = CAPABILITIES.filter((c) => c.destructive === false).map((c) => c.min_authority);
    const destroys = CAPABILITIES.filter((c) => c.destructive === true).map((c) => c.min_authority);
    assert.ok(destroys.length > 0 && reads.length > 0);
    assert.ok(Math.min(...destroys) >= Math.max(...reads) || Math.min(...destroys) >= AUTHORITY_BANDS.CAPTAIN);
  });
});

describe('layer model: the graph builder reads what it claims to read', () => {
  it('finds a cross-layer edge in a tree it has never seen', () => {
    // A synthetic tree, so this asserts the reader rather than the repository. Without it, a bug that made
    // buildGraph return zero edges would make the real-tree test below pass for the wrong reason.
    const root = mkdtempSync(join(tmpdir(), 'w2m-layers-'));
    cleanup.push(root);
    mkdirSync(join(root, 'alpha'), { recursive: true });
    mkdirSync(join(root, 'beta'), { recursive: true });
    writeFileSync(join(root, 'alpha', 'a.mjs'), "import { x } from '../beta/b.mjs';\n", 'utf8');
    writeFileSync(join(root, 'beta', 'b.mjs'), 'export const x = 1;\n', 'utf8');
    const graph = buildGraph(root);
    assert.equal(graph.files, 2);
    const edge = graph.edges.find((e) => e.from === 'alpha' && e.to === 'beta');
    assert.ok(edge, `expected an alpha -> beta edge, got ${JSON.stringify(graph.edges)}`);
    assert.equal(edge.count, 1);
    assert.match(edge.example, /alpha\/a\.mjs/);
  });

  it('folds a file that sits directly in the source root into the shared layer', () => {
    // The bug this replaced: each root-level file became a layer named after itself, so an undeclared file
    // passed the check silently.
    const root = mkdtempSync(join(tmpdir(), 'w2m-layers-root-'));
    cleanup.push(root);
    mkdirSync(join(root, 'alpha'), { recursive: true });
    writeFileSync(join(root, 'root-file.mjs'), 'export const y = 2;\n', 'utf8');
    writeFileSync(join(root, 'alpha', 'a.mjs'), "import { y } from '../root-file.mjs';\n", 'utf8');
    const graph = buildGraph(root);
    const edge = graph.edges.find((e) => e.to === 'shared');
    assert.ok(edge, `a root-level import must resolve to the shared layer, got ${JSON.stringify(graph.edges)}`);
    assert.equal(edge.from, 'alpha');
  });

  it('ignores a relative specifier that leaves the source tree', () => {
    // `../../scripts/foo.mjs` is a different kind of dependency and is not this checker's business.
    const root = mkdtempSync(join(tmpdir(), 'w2m-layers-out-'));
    cleanup.push(root);
    mkdirSync(join(root, 'alpha'), { recursive: true });
    writeFileSync(join(root, 'alpha', 'a.mjs'), "import { z } from '../../elsewhere/z.mjs';\n", 'utf8');
    const graph = buildGraph(root);
    assert.equal(graph.edges.length, 0);
  });
});

describe('layer model: the real tree obeys the declared model', () => {
  it('has no undeclared cross-layer edge', () => {
    // The test that fails when somebody adds an import without declaring it. Everything above is about the
    // checker being correct; this is about the repository being correct.
    const graph = buildGraph();
    assert.ok(graph.files > 50, `expected a substantial tree, read ${graph.files} file(s)`);
    const result = checkEdges(graph.edges);
    assert.deepEqual(result.violations, [], `undeclared or upward edges: ${JSON.stringify(result.violations, null, 2)}`);
    assert.deepEqual(result.unexplained, [], `edges involving a non-layer: ${JSON.stringify(result.unexplained, null, 2)}`);
    assert.equal(result.ok, true);
  });

  it('has no allow-list entry that matches nothing', () => {
    // An unused entry is either a typo or a dependency somebody removed and did not clean up. Both are worth
    // failing on, because an allow-list nobody prunes stops describing the code.
    const present = new Set(buildGraph().edges.map((e) => `${e.from} -> ${e.to}`));
    const unused = ALLOWED_EDGES.map(([a, b]) => `${a} -> ${b}`).filter((k) => !present.has(k));
    assert.deepEqual(unused, [], `declared but absent: ${unused.join(', ')}`);
  });
});
