/**
 * Cognitive memory blocks: field-level acceptance with lineage.
 *
 * ## The two problems this solves
 *
 * The individual and collective memory layers shipped in 0.9.6/0.9.7 accept **everything or nothing**: a
 * claim arriving from a peer is taken whole, or refused whole. That is a blunt instrument, and it has two
 * consequences the roadmap records as P1 and P2.
 *
 * **P1 — field-level acceptance.** A peer's claim may be trustworthy in part. Its *subject* and its
 * *body* might be worth keeping while its *confidence* is an opinion this machine has no reason to adopt,
 * and its *lineage* is not something a receiver gets to choose at all. Accepting the block whole means
 * taking the parts you do not want; refusing it whole means discarding the parts you do.
 *
 * **P2 — provenance.** A claim that comes back around the fleet must be recognisable as the receiver's
 * own earlier thought rather than as independent corroboration. Without that, a rumour and a fact look
 * identical once each has been repeated twice, which is the failure mode that makes a multi-agent memory
 * worse than no memory at all.
 *
 * ## What a block is
 *
 * Seven fields, fixed and named, so that acceptance can be decided per field rather than per block:
 *
 * | Field | Kind | May a receiver choose it? |
 * |---|---|---|
 * | `origin` | who asserted this | no — it is a fact about the sender |
 * | `subject` | what it is about | yes |
 * | `body` | the assertion itself | yes |
 * | `evidence` | what supports it | yes |
 * | `confidence` | how sure the sender is | yes, and **defaults to refusing it** |
 * | `observed_at` | when the sender observed it | no — the receiver did not observe it |
 * | `lineage` | content hashes of its ancestors | no — inherited, never chosen |
 *
 * The three that a receiver may **not** choose are not a policy decision; they are fields whose value
 * would be a lie if the receiver set it. A receiver that stamped its own timestamp on a peer's
 * observation, or replaced the ancestor chain, would be manufacturing provenance — and provenance that
 * can be manufactured is not provenance.
 *
 * ## Lineage is by content hash, not by id
 *
 * An id is assigned by whoever creates the block and can be copied; a hash is the content. So an ancestor
 * reference is `sha256` of the ancestor's canonical form, and a block whose parent cannot be produced
 * **is refused rather than re-rooted** — see `acceptBlock`. Silently re-rooting is how a fabricated claim
 * acquires a respectable history.
 */

import { createHash } from 'node:crypto';

/** The seven field names, in canonical order. The order is part of the hash. */
export const CAT7_FIELDS = Object.freeze([
  'origin',
  'subject',
  'body',
  'evidence',
  'confidence',
  'observed_at',
  'lineage',
]);

/**
 * Fields a receiver may decide for itself.
 *
 * The complement of this list is the more important half: `origin`, `observed_at` and `lineage` are
 * **inherited**. A receiver that could set them could assert a provenance it does not have.
 */
export const RECEIVER_CHOOSABLE_FIELDS = Object.freeze(['subject', 'body', 'evidence', 'confidence']);

/** Fields whose value is a property of the sender and must travel unchanged. */
export const INHERITED_FIELDS = Object.freeze(['origin', 'observed_at', 'lineage']);

/** Why a block was refused. Codes, not sentences, so a caller can branch without matching prose. */
export const BLOCK_REFUSAL = Object.freeze({
  NOT_AN_OBJECT: 'BLOCK_NOT_AN_OBJECT',
  MISSING_FIELD: 'BLOCK_MISSING_FIELD',
  UNKNOWN_FIELD: 'BLOCK_UNKNOWN_FIELD',
  BAD_ORIGIN: 'BLOCK_BAD_ORIGIN',
  BAD_TIMESTAMP: 'BLOCK_BAD_TIMESTAMP',
  BAD_LINEAGE: 'BLOCK_BAD_LINEAGE',
  BAD_HASH: 'BLOCK_BAD_HASH',
  HASH_MISMATCH: 'BLOCK_HASH_MISMATCH',
  MISSING_PARENT: 'BLOCK_MISSING_PARENT',
  CYCLE: 'BLOCK_CYCLE',
});

/** A refusal carries a code and enough context to explain it without re-reading the block. */
export class BlockRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'BlockRefusal';
    this.code = code;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Canonical JSON: sorted keys, no whitespace, arrays in order.
 *
 * Hand-rolled rather than imported because this must be **stable across machines and versions** — it is
 * what the hash is taken over, so two implementations that differ by a key order would compute different
 * hashes for the same block and each would call the other a forgery.
 */
export function canonical(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonical: unsupported value of type ${typeof value}`);
}

/** `sha256` of a block's canonical form, excluding any `hash` field the caller attached. */
export function blockHash(block) {
  const { hash: _ignored, ...rest } = block ?? {};
  return createHash('sha256').update(canonical(rest), 'utf8').digest('hex');
}

/**
 * Structural validation. Returns the first problem found, or `null`.
 *
 * Separate from acceptance because the two are different questions: "is this a well-formed block" is
 * answerable without knowing who sent it, and mixing them makes a malformed block indistinguishable from
 * a distrusted one.
 */
export function blockProblem(block) {
  if (!isPlainObject(block)) return { code: BLOCK_REFUSAL.NOT_AN_OBJECT, detail: `expected an object, got ${typeof block}` };
  for (const field of CAT7_FIELDS) {
    if (!(field in block)) return { code: BLOCK_REFUSAL.MISSING_FIELD, detail: `missing "${field}"` };
  }
  for (const key of Object.keys(block)) {
    if (!CAT7_FIELDS.includes(key) && key !== 'hash') {
      return { code: BLOCK_REFUSAL.UNKNOWN_FIELD, detail: `unknown field "${key}"; the seven are fixed so acceptance can be per field` };
    }
  }
  if (typeof block.origin !== 'string' || block.origin.trim() === '') {
    return { code: BLOCK_REFUSAL.BAD_ORIGIN, detail: 'origin must be a non-empty string' };
  }
  if (typeof block.observed_at !== 'string' || Number.isNaN(Date.parse(block.observed_at))) {
    return { code: BLOCK_REFUSAL.BAD_TIMESTAMP, detail: `observed_at must be an ISO timestamp, got ${JSON.stringify(block.observed_at)}` };
  }
  if (!Array.isArray(block.lineage)) {
    return { code: BLOCK_REFUSAL.BAD_LINEAGE, detail: 'lineage must be an array of ancestor hashes' };
  }
  for (const ancestor of block.lineage) {
    if (typeof ancestor !== 'string' || !/^[0-9a-f]{64}$/.test(ancestor)) {
      return { code: BLOCK_REFUSAL.BAD_LINEAGE, detail: `ancestor must be a 64-char lowercase hex sha256, got ${JSON.stringify(ancestor)}` };
    }
  }
  if (new Set(block.lineage).size !== block.lineage.length) {
    return { code: BLOCK_REFUSAL.BAD_LINEAGE, detail: 'lineage repeats an ancestor' };
  }
  if (block.hash !== undefined && (typeof block.hash !== 'string' || !/^[0-9a-f]{64}$/.test(block.hash))) {
    return { code: BLOCK_REFUSAL.BAD_HASH, detail: 'hash, when present, must be a 64-char lowercase hex sha256' };
  }
  return null;
}

/**
 * Build a block, hashing it on the way out.
 *
 * `lineage` is taken as ancestor **blocks or hashes**. Blocks are hashed here so a caller cannot
 * accidentally attach an ancestor's id instead of its content, which is the mistake that makes a
 * fabricated history look well-formed.
 *
 * @param {{origin: string, subject: unknown, body: unknown, evidence?: unknown, confidence?: unknown,
 *   observed_at?: string, lineage?: Array<object|string>}} input
 * @returns {object} the block with `hash`
 */
export function makeBlock(input) {
  const lineage = (input?.lineage ?? []).map((a) => (typeof a === 'string' ? a : blockHash(a)));
  const block = {
    origin: input?.origin ?? null,
    subject: input?.subject ?? null,
    body: input?.body ?? null,
    evidence: input?.evidence ?? null,
    confidence: input?.confidence ?? null,
    observed_at: input?.observed_at ?? new Date().toISOString(),
    lineage,
  };
  const problem = blockProblem(block);
  if (problem !== null) throw new BlockRefusal(problem.code, problem.detail);
  return { ...block, hash: blockHash(block) };
}

/**
 * Verify a block's declared hash against its content.
 *
 * The point of the field: a block whose hash does not cover its content can be edited after the fact
 * without the lineage that references it noticing.
 */
export function verifyBlock(block) {
  const problem = blockProblem(block);
  if (problem !== null) return { ok: false, ...problem };
  if (block.hash === undefined) return { ok: false, code: BLOCK_REFUSAL.BAD_HASH, detail: 'block carries no hash to verify' };
  const actual = blockHash(block);
  if (actual !== block.hash) {
    return { ok: false, code: BLOCK_REFUSAL.HASH_MISMATCH, detail: `declared ${block.hash.slice(0, 12)}… but content hashes to ${actual.slice(0, 12)}…` };
  }
  return { ok: true, hash: actual };
}

/**
 * Decide, field by field, which of a peer's fields this receiver accepts.
 *
 * Returns a **partition** rather than a filtered copy, because the refused half is evidence: "this
 * machine declined the confidence and kept the body" is a decision worth being able to inspect, and a
 * filtered object silently loses it.
 *
 * `choose` is called once per choosable field with `(field, value, block)`. It may return a boolean, or
 * `{accept: boolean, why?: string}`. The default **refuses `confidence`** and accepts the rest — the
 * conservative reading of a design whose P1 says a receiver decides per field, not that it decides
 * generously.
 *
 * Inherited fields are never offered to `choose`. A caller that wants to override `origin` is not making
 * an acceptance decision, it is forging one, and the returned `accepted` will not carry it.
 *
 * @param {object} block
 * @param {{choose?: Function, lineage?: string[]|null}} [options]
 * @returns {{accepted: object, refused: Array<{field: string, why: string|null}>,
 *   accepted_fields: string[], verified: boolean}}
 */
export function acceptBlock(block, options = {}) {
  const { choose = defaultChoose, lineage = null } = options;
  const verified = verifyBlock(block);
  if (!verified.ok) {
    // A block that fails its own hash is refused *entirely*: field-level acceptance is about trust, and
    // there is nothing to trust about a block whose content does not match what it claims to be.
    return {
      accepted: null,
      refused: CAT7_FIELDS.map((field) => ({ field, why: `${verified.code}: ${verified.detail}` })),
      accepted_fields: [],
      verified: false,
    };
  }

  /**
   * A block whose parent is not producible is refused rather than re-rooted.
   *
   * This is the single most important refusal in the file. Re-rooting -- keeping the block and emptying
   * its lineage -- turns a claim with an unverifiable history into one with no history, which reads as a
   * fresh, independent assertion. That is precisely how a fabricated claim acquires respectability.
   */
  if (Array.isArray(lineage)) {
    const known = new Set(lineage);
    const missing = block.lineage.filter((a) => !known.has(a));
    if (missing.length > 0) {
      return {
        accepted: null,
        refused: [{ field: 'lineage', why: `${BLOCK_REFUSAL.MISSING_PARENT}: cannot produce ancestor(s) ${missing.map((m) => m.slice(0, 12)).join(', ')}…; refusing rather than re-rooting` }],
        accepted_fields: [],
        verified: true,
      };
    }
  }

  const accepted = {};
  const refused = [];
  const acceptedFields = [];

  for (const field of INHERITED_FIELDS) {
    accepted[field] = block[field];
    acceptedFields.push(field);
  }

  for (const field of RECEIVER_CHOOSABLE_FIELDS) {
    const value = block[field];

    /**
     * `confidence` is refused whatever the chooser says.
     *
     * Found by a test: a custom `choose` that accepted everything caused `refused` to hold one entry
     * instead of two, because supplying a chooser *replaced* the default rather than refining it. That
     * made the file's central conservative property -- a receiver does not adopt the sender's certainty
     * about the sender's own assertion -- silently optional, and "silently optional" is how a safety
     * default stops being one.
     *
     * So the refusal is a hard invariant here rather than a default a caller can override. A caller that
     * genuinely needs the sender's confidence can read it from the block it was handed; what it cannot do
     * is have this function put it into `accepted` as though the receiver had established it.
     */
    if (field === 'confidence') {
      refused.push({ field, why: 'a receiver does not adopt the sender\'s certainty (invariant, not a default)' });
      continue;
    }

    let decision;
    try {
      decision = choose(field, value, block);
    } catch (e) {
      decision = { accept: false, why: `chooser threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    const accept = typeof decision === 'boolean' ? decision : decision?.accept === true;
    const why = typeof decision === 'object' && decision !== null ? (decision.why ?? null) : null;
    if (accept) {
      accepted[field] = value;
      acceptedFields.push(field);
    } else {
      refused.push({ field, why });
    }
  }

  return { accepted, refused, accepted_fields: acceptedFields, verified: true };
}

/**
 * The default per-field decision, kept deliberately conservative.
 *
 * `confidence` is refused. It is the one field whose value is an *opinion about the sender's own
 * assertion*, and adopting it would mean this machine now asserts a certainty it did not establish --
 * which is exactly the kind of quiet transfer of belief that a fleet memory has to prevent.
 */
export function defaultChoose(field) {
  if (field === 'confidence') return { accept: false, why: 'a receiver does not adopt the sender\'s certainty' };
  return true;
}

/**
 * Walk a block's ancestry.
 *
 * Breadth-first with three colours, which is the standard way to tell a **diamond** from a **cycle** and
 * the reason this is not a simple recursive walk: a claim supported by two paths is ordinary and must be
 * walked once, while a claim that descends from itself is malformed and must be named. An earlier draft
 * of this function mixed `chain.includes` with the frontier and would have reported a diamond as a cycle
 * in some orders and a cycle as a diamond in others.
 *
 * `have` maps hash to block. `missing` collects every gap rather than stopping at the first, because
 * knowing how much of a history is absent is more useful than knowing that some of it is.
 *
 * @param {object} block
 * @param {Map<string, object>} have
 * @param {{maxDepth?: number}} [options]
 * @returns {{chain: string[], missing: string[], cycle: string|null, depth: number}}
 */
export function ancestry(block, have, { maxDepth = 1000 } = {}) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map();
  const chain = [];
  const missing = [];

  /** @returns {string|null} the hash that closed a cycle, or null. */
  function visit(hash, depth) {
    if (depth > maxDepth) return null;
    const state = colour.get(hash) ?? WHITE;
    if (state === GREY) return hash;      // a back edge: this hash is on the path being walked
    if (state === BLACK) return null;     // already fully explored: a diamond, and ordinary

    const parent = have.get(hash);
    if (parent === undefined) {
      // Not visited and not available: a gap. Left WHITE so a second path to it reports it once, and
      // `missing` is de-duplicated below.
      missing.push(hash);
      return null;
    }

    colour.set(hash, GREY);
    for (const ancestor of parent.lineage ?? []) {
      const closed = visit(ancestor, depth + 1);
      if (closed !== null) return closed;
    }
    colour.set(hash, BLACK);
    chain.push(hash);
    return null;
  }

  let cycle = null;
  for (const root of block?.lineage ?? []) {
    cycle = visit(root, 0);
    if (cycle !== null) break;
  }

  return {
    // `chain` is post-order: ancestors appear before the blocks that depend on them, which is the order a
    // reader needs to reconstruct the history from the beginning.
    chain: [...new Set(chain)],
    missing: [...new Set(missing)],
    cycle,
    depth: chain.length,
  };
}

/**
 * Is `candidate` an ancestor of `block`, given the blocks available?
 *
 * The question P2 actually asks. A claim that descends from something this machine already thought is an
 * **echo**, not corroboration, and a fleet that cannot tell those apart will confidently agree with
 * itself.
 */
export function isDescendantOf(block, candidateHash, have) {
  const { chain, missing } = ancestry(block, have);
  return { descendant: chain.includes(candidateHash), chain, missing, checked: chain.length };
}

/**
 * Store blocks under the hash their ancestors refer to, so a fixture's keys and references agree.
 *
 * ## Why this exists rather than being written inline in the test
 *
 * A cycle cannot be built by `makeBlock`: each block's hash covers its `lineage`, so linking two blocks
 * to each other changes the very hashes being linked. The first attempt in the suite mutated `lineage`
 * after hashing and keyed the map by `blockHash(...)`, which produced blocks whose internal references
 * pointed at hashes the map did not contain -- so the walker reported `missing` and **never encountered
 * the cycle it was supposed to test**. The test passed its setup and asserted nothing.
 *
 * This helper makes the reference and the key the same string by construction, so a fixture cannot
 * silently fail to be the shape it claims. It produces blocks that are deliberately **not
 * hash-consistent** -- `verifyBlock` would refuse them, and `acceptBlock` does -- because a cycle is by
 * nature unforgeable; its only job is to exercise the walker, which traverses references rather than
 * re-deriving hashes.
 *
 * @param {object[]} blocks
 * @returns {Map<string, object>} keyed by the reference its own ancestors use
 */
export function linkFixtures(blocks) {
  const have = new Map();
  for (const b of blocks) {
    // The key must be what the OTHER blocks reference. A block's own `hash` is what its ancestors
    // reference it by, so that is the key -- not a freshly computed digest, which would differ whenever
    // the block's lineage was mutated after it was built.
    const key = typeof b.hash === 'string' && /^[0-9a-f]{64}$/.test(b.hash) ? b.hash : blockHash(b);
    have.set(key, b);
  }
  return have;
}
