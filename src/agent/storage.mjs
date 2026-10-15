/**
 * Tiered storage: temporary, compressed, permanent — and the two kinds of knowledge that persist forever.
 *
 * ## Why tiers rather than one directory
 *
 * The Linux host reached 100% filesystem today from a single uncapped writer at 14.7 GB/day, and the
 * recovery cost real time. The lesson was not "delete more" — it was that **data with different lifetimes
 * was being stored in one place with one policy**, so the only available policy was "never delete" until it
 * was "delete under pressure", which is exactly the wrong moment to be deciding what matters.
 *
 * So a file's tier is written down when it is stored, and the tier alone decides what may happen to it:
 *
 * | Tier | Lifetime | May it be deleted? |
 * |---|---|---|
 * | `temp` | a stated TTL | yes, automatically, once expired |
 * | `compressed` | until the archive is no longer wanted | only whole-archive, never partially |
 * | `permanent` | forever | **no** — and a caller asking to is refused, not obeyed |
 * | `skill` | forever | **no** — a capability, not data |
 * | `law` | forever | **no** — a rule, and rules are amended, never deleted |
 *
 * ## Why `permanent` refuses deletion rather than allowing it with a warning
 *
 * A warning is a thing a caller can ignore, and this module exists because the caller under pressure is
 * the one who will. `memory.jsonl` is the **only** durable copy of what a command printed — the relay keeps
 * `stdout_sha256` and never the text — so deleting it deletes the fleet's ability to answer what it already
 * tried, and nothing else in the system notices. The refusal is the feature.
 *
 * Amending is different from deleting, and is supported: `law` entries carry an amendment chain, because a
 * rule that cannot change is one that gets bypassed instead. What is refused is *removal*, and the chain is
 * how a reader sees what a rule used to say.
 *
 * ## What this deliberately is not
 *
 * It is not a database and not a filesystem abstraction. It stores opaque bytes plus a declaration of what
 * they are and how long they matter, in a directory, with a manifest. Three functions and a manifest is the
 * whole dependency budget, which matters because every machine in this fleet has node and a shell and
 * nothing else.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';

/** The tiers, with the rule that applies to each. Data rather than branches, so it can be enumerated. */
export const TIERS = Object.freeze({
  TEMP: 'temp',
  COMPRESSED: 'compressed',
  PERMANENT: 'permanent',
  SKILL: 'skill',
  LAW: 'law',
});

/** Tiers whose contents may never be removed by this module. */
export const UNDELETABLE_TIERS = Object.freeze([TIERS.PERMANENT, TIERS.SKILL, TIERS.LAW]);

/** Default lifetime for `temp`, in milliseconds. Two hours: longer than any task, shorter than a shift. */
export const DEFAULT_TEMP_TTL_MS = 2 * 60 * 60 * 1000;

/** Why an operation was refused. Codes, so a caller branches without matching prose. */
export const STORAGE_REFUSAL = Object.freeze({
  UNKNOWN_TIER: 'STORAGE_UNKNOWN_TIER',
  NO_KEY: 'STORAGE_NO_KEY',
  UNDELETABLE: 'STORAGE_UNDELETABLE_TIER',
  NOT_FOUND: 'STORAGE_NOT_FOUND',
  HASH_MISMATCH: 'STORAGE_HASH_MISMATCH',
});

/** A refused operation carries enough to explain itself. */
export class StorageRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'StorageRefusal';
    this.code = code;
    this.detail = detail;
  }
}

const isTier = (t) => Object.values(TIERS).includes(t);

/** `sha256` of a buffer, the identity of every stored blob. */
export function contentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A key is a path-like name, and the constraints are deliberate.
 *
 * `..` is refused because keys become filenames, and a key that can escape its tier directory is a way to
 * write anywhere the process can. An empty key is refused because it names nothing, and "the file with no
 * name" is how a store acquires an entry nobody can find or delete.
 */
function keyProblem(key) {
  if (typeof key !== 'string' || key.trim() === '') return 'key must be a non-empty string';
  if (key.includes('..')) return 'key must not contain ".."';
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) return 'key must be relative';
  return null;
}

/**
 * A storage root.
 *
 * @param {object} options
 * @param {string} options.dir The directory that holds every tier.
 * @param {() => number} [options.now] Injected clock, so TTL is testable without waiting.
 */
export function createStore({ dir, now = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createStore: dir is required');
  const manifestPath = join(dir, 'manifest.json');

  const ensure = () => {
    for (const tier of Object.values(TIERS)) mkdirSync(join(dir, tier), { recursive: true });
  };

  /**
   * The manifest, read and written whole.
   *
   * Whole-file rather than append-only because it is small, and because a store whose index disagrees with
   * its contents is worse than one that cannot start. A corrupt manifest is reported rather than rebuilt by
   * guessing: rebuilding would silently adopt files nobody declared.
   */
  function readManifest() {
    if (!existsSync(manifestPath)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
        return { version: 1, entries: {}, corrupt: true };
      }
      return { version: 1, ...parsed };
    } catch {
      return { version: 1, entries: {}, corrupt: true };
    }
  }

  function writeManifest(manifest) {
    ensure();
    // Written beside and moved into place: a manifest half-written by a crash would lose the index for
    // every blob, which is the one failure this file cannot recover from by itself.
    const temp = `${manifestPath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(temp, manifestPath);
  }

  const blobPath = (tier, key) => join(dir, tier, key);

  /**
   * Store bytes under a key in a tier.
   *
   * `compressed` gzips on the way in and records the uncompressed size, so a reader can tell a truncated
   * archive from a small one. `permanent`, `skill` and `law` are stored verbatim: they are the small,
   * important things, and compressing them would save nothing while adding a way for them to be unreadable.
   *
   * @returns {{ok: true, tier: string, key: string, bytes: number, stored_bytes: number, sha256: string}}
   */
  function put(tier, key, bytes, options = {}) {
    if (!isTier(tier)) throw new StorageRefusal(STORAGE_REFUSAL.UNKNOWN_TIER, `${JSON.stringify(tier)} is not one of ${Object.values(TIERS).join(', ')}`);
    const problem = keyProblem(key);
    if (problem !== null) throw new StorageRefusal(STORAGE_REFUSAL.NO_KEY, problem);

    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
    const payload = tier === TIERS.COMPRESSED ? gzipSync(input) : input;
    const target = blobPath(tier, key);
    ensure();
    // Parent directories for a nested key, created before the write rather than discovered by its failure.
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (parent.length > 0) mkdirSync(parent, { recursive: true });
    writeFileSync(target, payload);

    const manifest = readManifest();
    const entry = {
      tier,
      key,
      sha256: contentHash(input),
      bytes: input.length,
      stored_bytes: payload.length,
      stored_at: new Date(now()).toISOString(),
      expires_at: tier === TIERS.TEMP
        ? new Date(now() + (Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TEMP_TTL_MS)).toISOString()
        : null,
      // Free-form, so a caller can record why a thing is kept without this module having to know.
      labels: options.labels ?? null,
      ...(tier === TIERS.COMPRESSED ? { encoding: 'gzip' } : {}),
    };
    manifest.entries[`${tier}/${key}`] = entry;
    writeManifest(manifest);
    return { ok: true, tier, key, bytes: input.length, stored_bytes: payload.length, sha256: entry.sha256 };
  }

  /**
   * Read bytes back.
   *
   * A blob whose content does not match the hash recorded for it is reported as `HASH_MISMATCH` rather than
   * returned. Returning it would be worse than failing: the caller asked for content by identity, and
   * handing back something else under that identity is how a corrupted archive becomes a wrong answer that
   * nobody traces back here.
   */
  function get(tier, key) {
    if (!isTier(tier)) throw new StorageRefusal(STORAGE_REFUSAL.UNKNOWN_TIER, tier);
    const problem = keyProblem(key);
    if (problem !== null) throw new StorageRefusal(STORAGE_REFUSAL.NO_KEY, problem);

    const target = blobPath(tier, key);
    if (!existsSync(target)) return { ok: false, reason_code: STORAGE_REFUSAL.NOT_FOUND, detail: `${tier}/${key} is not stored` };

    const raw = readFileSync(target);
    const entry = readManifest().entries[`${tier}/${key}`] ?? null;
    const bytes = entry?.encoding === 'gzip' ? gunzipSync(raw) : raw;

    if (entry !== null && contentHash(bytes) !== entry.sha256) {
      return {
        ok: false,
        reason_code: STORAGE_REFUSAL.HASH_MISMATCH,
        detail: `${tier}/${key} hashes to something other than what was stored; refusing to return it as that content`,
        expected: entry.sha256,
        actual: contentHash(bytes),
      };
    }
    return { ok: true, tier, key, bytes, entry };
  }

  /**
   * Remove a blob.
   *
   * Refused outright for `permanent`, `skill` and `law`. The refusal is the feature: a warning is a thing a
   * caller under pressure ignores, and the caller under pressure is exactly who this module exists for.
   * `temp` and `compressed` may be removed, and removing a `compressed` blob removes the whole archive
   * rather than part of it -- a partially-deleted archive is not a smaller archive, it is a broken one.
   */
  function remove(tier, key, options = {}) {
    if (!isTier(tier)) throw new StorageRefusal(STORAGE_REFUSAL.UNKNOWN_TIER, tier);
    if (UNDELETABLE_TIERS.includes(tier) && options.force !== true) {
      throw new StorageRefusal(
        STORAGE_REFUSAL.UNDELETABLE,
        `"${tier}" may not be deleted. memory.jsonl is the only durable copy of what a command printed -- the relay keeps hashes and never the text -- and device.key is the identity peers know this machine by. Amend rather than delete, or pass force with a reason.`,
      );
    }
    const target = blobPath(tier, key);
    const manifest = readManifest();
    delete manifest.entries[`${tier}/${key}`];
    if (!existsSync(target)) {
      writeManifest(manifest);
      return { ok: false, reason_code: STORAGE_REFUSAL.NOT_FOUND, detail: `${tier}/${key} was not stored` };
    }
    rmSync(target, { force: true });
    writeManifest(manifest);
    return { ok: true, tier, key, forced: options.force === true };
  }

  /**
   * Delete expired `temp` blobs and nothing else.
   *
   * This is the only automatic deletion in the module, and it is narrow on purpose: it removes only what
   * was *stored with a TTL that has passed*. Nothing here decides that a permanent thing has become
   * unimportant, because that decision is not one a cleanup pass is entitled to make.
   */
  function sweep({ nowMs = now() } = {}) {
    const manifest = readManifest();
    const removed = [];
    for (const [id, entry] of Object.entries(manifest.entries)) {
      if (entry.tier !== TIERS.TEMP || entry.expires_at === null) continue;
      if (Date.parse(entry.expires_at) > nowMs) continue;
      const target = blobPath(entry.tier, entry.key);
      try { rmSync(target, { force: true }); } catch { /* already gone */ }
      delete manifest.entries[id];
      removed.push(id);
    }
    if (removed.length > 0) writeManifest(manifest);
    return { removed, remaining: Object.keys(manifest.entries).length };
  }

  /** Every entry, optionally for one tier. */
  function list(tier = null) {
    const manifest = readManifest();
    return Object.values(manifest.entries).filter((e) => tier === null || e.tier === tier);
  }

  /**
   * Verify every blob against the manifest.
   *
   * Exists because "it is stored" and "it can still be read" are different claims, and the difference is
   * discovered at the worst possible moment -- when someone finally needs the data. A blob whose file is
   * missing, or whose bytes no longer match, is named rather than counted.
   */
  function verify() {
    const manifest = readManifest();
    const missing = [];
    const mismatched = [];
    for (const entry of Object.values(manifest.entries)) {
      const target = blobPath(entry.tier, entry.key);
      if (!existsSync(target)) { missing.push(`${entry.tier}/${entry.key}`); continue; }
      try {
        const raw = readFileSync(target);
        const bytes = entry.encoding === 'gzip' ? gunzipSync(raw) : raw;
        if (contentHash(bytes) !== entry.sha256) mismatched.push(`${entry.tier}/${entry.key}`);
      } catch {
        mismatched.push(`${entry.tier}/${entry.key}`);
      }
    }
    return { checked: Object.keys(manifest.entries).length, missing, mismatched, ok: missing.length === 0 && mismatched.length === 0 };
  }

  /** Total stored bytes per tier, for a health report. */
  function usage() {
    const out = {};
    for (const tier of Object.values(TIERS)) {
      const p = join(dir, tier);
      let bytes = 0;
      let files = 0;
      if (existsSync(p)) {
        const stack = [p];
        while (stack.length > 0) {
          const d = stack.pop();
          let entries;
          try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
          for (const e of entries) {
            const full = join(d, e.name);
            try {
              if (e.isDirectory()) stack.push(full);
              else if (e.isFile()) { bytes += statSync(full).size; files += 1; }
            } catch { /* skip */ }
          }
        }
      }
      out[tier] = { bytes, files };
    }
    return out;
  }

  return { put, get, remove, sweep, list, verify, usage, manifestPath, _internals: { readManifest } };
}

/**
 * Amend a `law` entry rather than replacing it.
 *
 * A rule that cannot change is one that gets bypassed instead, so amendment is supported -- and what is
 * kept is the chain, because "what does the rule say now" and "what did it used to say" are both questions
 * a reader has, and only the second one explains why something was done the old way.
 *
 * @param {object} store
 * @param {string} key
 * @param {string} text
 * @param {{by?: string|null, why?: string|null, now?: () => number}} [options]
 */
export function amendLaw(store, key, text, options = {}) {
  const now = options.now ?? (() => Date.now());
  const existing = store.get(TIERS.LAW, key);
  const prior = existing.ok ? JSON.parse(existing.bytes.toString('utf8')) : null;
  const amendment = {
    at: new Date(now()).toISOString(),
    by: options.by ?? null,
    why: options.why ?? null,
    supersedes_sha256: prior === null ? null : existing.entry.sha256,
  };
  const body = {
    text,
    amendments: [...(prior?.amendments ?? []), amendment],
  };
  const written = store.put(TIERS.LAW, key, JSON.stringify(body, null, 2), { labels: { kind: 'law' } });
  return { ...written, amendments: body.amendments.length, superseded: prior !== null };
}

/**
 * Store a skill.
 *
 * A skill is a capability rather than data, which is why it has its own tier: it is not a record of what
 * happened, so the rules that govern records do not fit it, and it is not disposable, so the rules that
 * govern caches do not either. What it shares with `law` is that losing it costs something that cannot be
 * recomputed from anything else in the system.
 */
export function putSkill(store, name, { description, body, entry, labels = null }) {
  const record = {
    name,
    description: description ?? null,
    body: body ?? null,
    entry: entry ?? null,
    stored_at: new Date().toISOString(),
  };
  return store.put(TIERS.SKILL, name, JSON.stringify(record, null, 2), { labels });
}
