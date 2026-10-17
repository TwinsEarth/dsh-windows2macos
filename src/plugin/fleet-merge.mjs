/**
 * Fleet memory merge — the deterministic core of #2b.
 *
 * ## The rule, which is the operator's and not mine
 *
 * > **默认最新的赢；如果是修复默认流程，最全 & 验证最全面的有最后修改权。**
 * > (Default: the newest wins. But if it is a repair of the default flow, the most complete and most thoroughly
 * > verified one has final edit authority.)
 *
 * ## What is the operator's decision, and what is my operationalisation
 *
 * **The operator's:** the two layers. Newest wins by default; a declared repair of the default flow outranks
 * recency. A repaired fact must not be overwritten by a later-written older understanding.
 *
 * **Mine, and it must be reviewable:**
 *
 *   * the entry syntax (§3 of FLEET-SYNC-2B-MERGE-SPEC.md) — there is no way to read "is this a repair" out of
 *     prose, and guessing would overwrite correct versions with wrong ones;
 *   * `completeness = evidence + 2 * verified`. Verified evidence is a stronger signal than more unverified evidence
 *     — one reproduced fact beats three unreproduced ones. **The weight 2 is a judgement, not the operator's words**,
 *     and it only applies when both sides declare `fix`.
 *
 * ## Why nothing here is silent
 *
 * Every adjudicated id produces a decision record, and the decision records are appended to the output as comments.
 * **A merge that cannot explain its own choices produces a document nobody can audit**, and the first sign of a
 * wrong rule would be a fact nobody can find.
 *
 * @module fleet-merge
 */

/** The bracket pair that marks an entry: U+3014 / U+3015. Chosen because they never occur in the prose. */
const OPEN = '〔';
const CLOSE = '〕';
/** `- 〔...〕content` -- built from the constants so a change to the pair cannot desynchronise the parser. */
const ENTRY_RE = new RegExp('^-\\s+' + OPEN + '([^' + CLOSE + ']*)' + CLOSE + '(.*)$');

/**
 * Parse one markdown line as a keyed entry.
 *
 * Only `- ` list items that begin with a `〔...〕` metadata bracket are entries. **Everything else is unkeyed prose**,
 * and unkeyed lines never participate in adjudication: without an id there is no way to tell "these two lines are
 * about the same thing" from "these two lines are different facts", and guessing produces conflicts that are not
 * conflicts.
 *
 * @param {string} line
 * @returns {{id:string, fix:boolean, evidence:number, verified:number, content:string, raw:string}|null}
 */
export function parseEntry(line) {
  if (typeof line !== 'string') return null;
  const match = ENTRY_RE.exec(line);
  if (match === null) return null;
  const meta = match[1];
  const content = match[2];

  let id = null;
  let fix = false;
  let evidence = 0;
  let verified = 0;
  for (const token of meta.trim().split(/\s+/)) {
    if (token.startsWith('id:')) {
      id = token.slice(3).trim();
      continue;
    }
    if (token === 'fix') { fix = true; continue; }
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = Number(token.slice(eq + 1));
      if (!Number.isInteger(value) || value < 0) continue;
      if (key === 'evidence') evidence = value;
      else if (key === 'verified') verified = value;
    }
  }
  if (id === null || id === '') return null;
  return { id, fix, evidence, verified, content: content.trim(), raw: line };
}

/**
 * How much a declared repair has to show, for the "most complete and most thoroughly verified" half of the rule.
 *
 * @param {{evidence:number, verified:number}} entry
 */
export function completeness(entry) {
  return entry.evidence + 2 * entry.verified;
}

/**
 * Split a document into unkeyed prose and keyed entries.
 *
 * A duplicate id **within one document** is recorded rather than merged, because two entries claiming the same id in
 * one document is a broken document, not a conflict to resolve.
 *
 * @param {string} text
 * @returns {{prose:string[], entries:Map<string, object>, duplicates:string[]}}
 */
export function parseDocument(text) {
  const prose = [];
  const entries = new Map();
  const duplicates = [];
  for (const line of String(text ?? '').split('\n')) {
    const entry = parseEntry(line);
    if (entry === null) {
      if (line.trim() !== '') prose.push(line);
      continue;
    }
    if (entries.has(entry.id)) {
      if (!duplicates.includes(entry.id)) duplicates.push(entry.id);
      continue;
    }
    entries.set(entry.id, entry);
  }
  return { prose, entries, duplicates };
}

/**
 * Decide one id, given the same entry from two documents.
 *
 * The order is fixed so the result never depends on iteration order:
 *
 *   1. only one side declares `fix`      -> that side
 *   2. both declare `fix`                 -> higher `completeness`
 *   3. equal `completeness`               -> higher `verified`
 *   4. still equal                        -> newer (higher `addedAtMs`)
 *   5. still equal                        -> lower hash, for determinism only, and the tie is recorded
 *
 * @returns {{winner:'local'|'fleet', layer:'repair'|'default'|'tie', reason:string}}
 */
export function decide(local, fleet, context) {
  const { localAddedAtMs = 0, fleetAddedAtMs = 0, localHash = '', fleetHash = '' } = context;

  if (local.fix !== fleet.fix) {
    const winner = local.fix ? 'local' : 'fleet';
    return {
      winner,
      layer: 'repair',
      reason: `${winner} declares "fix" of the default flow, which outranks recency (the other side does not)`,
    };
  }

  if (local.fix && fleet.fix) {
    const localScore = completeness(local);
    const fleetScore = completeness(fleet);
    if (localScore !== fleetScore) {
      return {
        winner: localScore > fleetScore ? 'local' : 'fleet',
        layer: 'repair',
        reason: `both declare "fix"; completeness ${localScore} vs ${fleetScore} (evidence + 2 x verified)`,
      };
    }
    if (local.verified !== fleet.verified) {
      return {
        winner: local.verified > fleet.verified ? 'local' : 'fleet',
        layer: 'repair',
        reason: `both declare "fix" with equal completeness; verified ${local.verified} vs ${fleet.verified}`,
      };
    }
    // fall through to recency
  }

  if (localAddedAtMs !== fleetAddedAtMs) {
    return {
      winner: localAddedAtMs > fleetAddedAtMs ? 'local' : 'fleet',
      layer: 'default',
      reason: `default layer: the newer publication wins (${Math.max(localAddedAtMs, fleetAddedAtMs)} > ${Math.min(localAddedAtMs, fleetAddedAtMs)})`,
    };
  }

  const winner = localHash < fleetHash ? 'local' : 'fleet';
  return {
    winner,
    layer: 'tie',
    reason: 'identical timestamps and scores; resolved by hash order for determinism only -- this is a genuine tie',
  };
}

/**
 * Merge two documents under the rule above.
 *
 * **Never throws for a resolvable merge, never resolves something it cannot justify, and never invents content.**
 *
 * @param {{localText:string, localAddedAtMs?:number, localHash?:string,
 *          fleetText:string, fleetAddedAtMs?:number, fleetHash?:string}} input
 * @returns {{text:string, decisions:{id:string,winner:string,layer:string,reason:string}[],
 *            unresolved:{id:string,reason:string}[], refused:{id:string,reason:string}[],
 *            added:string[], removed:string[], unchanged:number, wroteAnything:false}}
 */
export function mergeMemory(input) {
  const {
    localText, localAddedAtMs = 0, localHash = '',
    fleetText, fleetAddedAtMs = 0, fleetHash = '',
  } = input;

  const local = parseDocument(localText);
  const fleet = parseDocument(fleetText);
  const context = { localAddedAtMs, fleetAddedAtMs, localHash, fleetHash };

  const decisions = [];
  const unresolved = [];
  const refused = [];

  /** ids that are broken (duplicated) in either document -- refused, never merged. */
  const broken = new Set([...local.duplicates, ...fleet.duplicates]);
  for (const id of broken) {
    refused.push({ id, reason: 'this id appears more than once in one document; a broken document is not a conflict' });
  }

  const allIds = [...new Set([...local.entries.keys(), ...fleet.entries.keys()])];
  const chosen = new Map();
  let unchanged = 0;

  for (const id of allIds) {
    if (broken.has(id)) continue;
    const l = local.entries.get(id);
    const f = fleet.entries.get(id);

    if (l !== undefined && f === undefined) { chosen.set(id, { entry: l, side: 'local' }); continue; }
    if (l === undefined && f !== undefined) { chosen.set(id, { entry: f, side: 'fleet' }); continue; }

    // Same id on both sides. Identical text is not a conflict.
    if (l.raw === f.raw || l.content === f.content) { chosen.set(id, { entry: l, side: 'both' }); unchanged += 1; continue; }

    const verdict = decide(l, f, context);
    chosen.set(id, { entry: verdict.winner === 'local' ? l : f, side: verdict.winner });
    decisions.push({ id, winner: verdict.winner, layer: verdict.layer, reason: verdict.reason });
  }

  // Prose is a union; it cannot conflict because it has no identity to conflict on.
  const localProse = new Set(local.prose);
  const proseOut = [...local.prose];
  for (const line of fleet.prose) if (!localProse.has(line)) proseOut.push(line);

  // Entries: local document order first (so the machine's own structure survives), then fleet-only ids in fleet order.
  const entryLines = [];
  for (const line of String(localText ?? '').split('\n')) {
    const parsed = parseEntry(line);
    if (parsed === null || !chosen.has(parsed.id)) continue;
    const pick = chosen.get(parsed.id);
    if (!entryLines.some((e) => e.id === parsed.id)) entryLines.push({ id: parsed.id, raw: pick.entry.raw });
  }
  for (const line of String(fleetText ?? '').split('\n')) {
    const parsed = parseEntry(line);
    if (parsed === null || !chosen.has(parsed.id)) continue;
    if (!entryLines.some((e) => e.id === parsed.id)) entryLines.push({ id: parsed.id, raw: chosen.get(parsed.id).entry.raw });
  }

  const audit = [
    '<!-- fleet-merge: decisions are recorded so a wrong rule is visible after the fact -->',
    ...decisions.map((d) => `<!-- ${d.id} -> ${d.winner} (${d.layer}): ${d.reason} -->`),
    ...unresolved.map((u) => `<!-- ${u.id} UNRESOLVED: ${u.reason} -->`),
    ...refused.map((r) => `<!-- ${r.id} REFUSED: ${r.reason} -->`),
  ];

  const text = [
    ...proseOut,
    ...entryLines.map((e) => e.raw),
    ...audit,
  ].join('\n');

  return {
    text,
    decisions,
    unresolved,
    refused,
    added: [...fleet.entries.keys()].filter((id) => !local.entries.has(id) && !broken.has(id)),
    removed: [...local.entries.keys()].filter((id) => !fleet.entries.has(id) && !broken.has(id)),
    unchanged,
    wroteAnything: false,
  };
}
