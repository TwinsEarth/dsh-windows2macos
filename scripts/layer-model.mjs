/**
 * The module and layer model of this codebase, as data, so it can be enforced rather than described.
 *
 * ## Why this is a manifest and not a document
 *
 * The goal's wording is "分模块&分层级&分权限" — modules, layers, permissions. A prose description of a
 * layering is a thing that is true on the day it is written and quietly false afterwards, because nothing
 * fails when an import is added. So the model lives here as **data**, `layer-check.mjs` derives its rules
 * from it, and `test/layer-check.test.mjs` asserts the tree still obeys them.
 *
 * ## What the layers are, taken from the code rather than invented
 *
 * The measured cross-layer edges when this was written were:
 *
 *   plugin -> agent (12)   plugin -> util (1)   plugin -> relay (1)
 *   relay  -> chatops (4)
 *   agent  -> signing.mjs (1)   relay -> signing.mjs (1)
 *
 * So the real structure is a chain with one shared leaf, and the model below names it. It is a **description
 * of what exists**, not an aspiration: inventing a tidier layering and asserting it would fail immediately
 * and teach nothing.
 */

/**
 * Layers, ordered from the most independent to the most dependent.
 *
 * `rank` is what "upward" and "downward" mean; a layer may depend on any layer with a **lower** rank, and on
 * none with a higher one. The ordering is derived from the measured edges, and the leaves sit at the bottom
 * because nothing in them imports anything else in `src`.
 *
 * **`shared` is a layer of files, not of a directory.** `src/signing.mjs` sits directly in `src/` and is
 * imported by both `agent` and `relay`, so it is a real dependency target with no directory to name it. The
 * first version of the checker returned its basename (`signing.mjs`) as a layer name, which made two genuine
 * edges come back as "unexplained" and would have let a future root-level file masquerade as a layer. Naming
 * the category is what makes the model complete enough to be checked against.
 */
export const LAYERS = Object.freeze([
  { name: 'util', rank: 0, kind: 'leaf', note: 'shared helpers with no intra-src imports' },
  { name: 'shared', rank: 0, kind: 'leaf', note: 'root-level src/*.mjs imported across layers (signing.mjs)' },
  { name: 'chatops', rank: 1, kind: 'capability', note: 'chat-command surfaces; depended on by relay' },
  { name: 'maintenance', rank: 1, kind: 'capability', note: 'signed maintenance requests; the root runner never executes agent-requested shell' },
  { name: 'agent', rank: 2, kind: 'capability', note: 'the machine-side agent; depended on by plugin' },
  { name: 'relay', rank: 3, kind: 'service', note: 'the relay server; depends on chatops' },
  { name: 'plugin', rank: 4, kind: 'surface', note: 'the DSH-facing tool surface; the only entry point' },
]);

/**
 * Edges that exist and are allowed. Anything not listed is refused by the checker.
 *
 * **An allow-list rather than a denylist**, because the two fail differently: a denylist lets a new edge
 * through by default and reports nothing, while an allow-list refuses it and forces a decision. The cost is
 * that adding a legitimate dependency means editing this file — which is the point, since that edit is where
 * somebody asks whether the new edge belongs.
 */
export const ALLOWED_EDGES = Object.freeze([
  ['plugin', 'agent'],
  ['plugin', 'util'],
  ['plugin', 'relay'],
  ['relay', 'chatops'],
  ['agent', 'shared'],
  // v0.30.0: the shared sliding-window limiter. Not ['agent', 'relay'] -- that edge points UP (agent is
  // rank 2, relay is rank 3), and the class moved to util rather than the model being widened.
  ['agent', 'util'],
  // v1.3.10-beta.2: the agent verifies a signed maintenance request and ferries it; the root runner executes it.
  ['agent', 'maintenance'],
  // The same limiter, reached from the layer it was originally written in. Also downward (relay 3 -> util 0),
  // and the second half of the same decision: one shared window rather than two that could disagree.
  ['relay', 'util'],
  ['relay', 'shared'],
]);

/** Layer names, for a caller that wants just the vocabulary. */
export const LAYER_NAMES = Object.freeze(LAYERS.map((l) => l.name));

/** The rank of a layer, or `null` when the name is not a layer. */
export function rankOf(name) {
  return LAYERS.find((l) => l.name === name)?.rank ?? null;
}

/**
 * Check a set of edges against the model.
 *
 * @param {Array<{from: string, to: string, count: number, example: string}>} edges
 * @returns {{ok: boolean, violations: Array<object>, unexplained: Array<object>, allowed: Array<object>}}
 */
export function checkEdges(edges) {
  const allowedKeys = new Set(ALLOWED_EDGES.map(([a, b]) => `${a} -> ${b}`));
  const violations = [];
  const allowed = [];
  const unexplained = [];

  for (const edge of edges) {
    const key = `${edge.from} -> ${edge.to}`;
    const fromRank = rankOf(edge.from);
    const toRank = rankOf(edge.to);

    if (fromRank === null || toRank === null) {
      // An edge involving something that is not a layer at all -- a file sitting directly in `src/`, for
      // instance. Reported separately from a rank violation, because the fix is different: this one is about
      // a file being in the wrong place, not about two layers being wired wrongly.
      unexplained.push({ ...edge, reason: `"${fromRank === null ? edge.from : edge.to}" is not a declared layer` });
      continue;
    }
    if (allowedKeys.has(key)) {
      allowed.push(edge);
      continue;
    }
    const direction = toRank > fromRank ? 'upward (a lower layer depending on a higher one)' : 'undeclared';
    violations.push({
      ...edge,
      reason: `${key} is not in ALLOWED_EDGES (${direction})`,
      from_rank: fromRank,
      to_rank: toRank,
    });
  }
  return { ok: violations.length === 0 && unexplained.length === 0, violations, unexplained, allowed };
}

/**
 * The permission half of "分权限".
 *
 * Each operational capability names the **minimum authority band** that may exercise it, using the bands
 * v4.7.0 already defines, so this table cannot drift from the authority model by inventing its own numbers.
 * A capability with no entry here is not "unrestricted" -- `permissionFor` returns `null` and callers must
 * treat that as a refusal, because defaulting an unknown capability to allowed is how a permission table
 * becomes decoration.
 *
 * This is deliberately a table and not (yet) a wired gate: nothing in this codebase consults it today, and
 * claiming otherwise would be false. What it provides is a single place where the answer is written down, and
 * a test that fails if a capability is added to the tool surface without a decision here.
 */
// v0.23.0: the capability table and its accessors MOVED to `src/agent/authority.mjs`, which owns the
// bands the costs are expressed in. They are re-exported here so this module's public surface is unchanged
// for the suites that assert on it.
//
// The move was not cosmetic: `src/agent/permission.mjs` imported the table from THIS file, and `scripts/` is
// not in `package.json#files`, so the published package could not resolve it. The packed-tarball check caught
// that, and the layering rule says the same thing -- a `src/` module must not depend on `scripts/`.
// NOTE ON THE NAME: `AUTHORITY_BANDS` here is the NAMED-FLOOR map (`{ORDINARY: 0, CAPTAIN: 50, ...}`),
// which is what this module exported before the move, and it is NOT the `AUTHORITY_BANDS` array that
// `authority.mjs` owns. The alias keeps this module's public surface exactly as it was -- the first attempt
// at the move re-exported the array under this name and broke two assertions in this module's own suite.
export const AUTHORITY_BANDS = AUTHORITY_BAND_FLOORS;
export { AUTHORITY_BAND_FLOORS, CAPABILITIES, permissionFor, isDestructive };
import { AUTHORITY_BAND_FLOORS, CAPABILITIES, permissionFor, isDestructive } from '../src/agent/authority.mjs';