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
export const AUTHORITY_BANDS = Object.freeze({
  ORDINARY: 0,
  CAPTAIN: 50,
  ORG_ADMIN: 70,
  SYSTEM_ADMIN: 90,
});

export const CAPABILITIES = Object.freeze([
  { name: 'read_fleet_state', min_authority: AUTHORITY_BANDS.ORDINARY, destructive: false, note: 'listing machines and tasks changes nothing' },
  { name: 'dispatch_readonly', min_authority: AUTHORITY_BANDS.ORDINARY, destructive: false, note: 'a task that may not write' },
  { name: 'dispatch_writing', min_authority: AUTHORITY_BANDS.CAPTAIN, destructive: false, note: 'a task that may write inside a declared scope' },
  { name: 'publish_release', min_authority: AUTHORITY_BANDS.ORG_ADMIN, destructive: true, note: 'a published version cannot be unpublished from here' },
  { name: 'delete_permanent', min_authority: AUTHORITY_BANDS.SYSTEM_ADMIN, destructive: true, note: 'overrides the storage tier refusal; forced removal only' },
  { name: 'amend_law', min_authority: AUTHORITY_BANDS.ORG_ADMIN, destructive: false, note: 'amendment keeps the chain, so it is not a destruction' },
  { name: 'write_config', min_authority: AUTHORITY_BANDS.SYSTEM_ADMIN, destructive: true, note: 'allowedCommands and the relay URL live here' },
]);

/** The minimum authority for a capability, or `null` when it is not declared. */
export function permissionFor(name) {
  return CAPABILITIES.find((c) => c.name === name)?.min_authority ?? null;
}

/** Whether a capability is declared destructive. An unknown capability is not assumed safe. */
export function isDestructive(name) {
  const found = CAPABILITIES.find((c) => c.name === name);
  return found === undefined ? null : found.destructive;
}
