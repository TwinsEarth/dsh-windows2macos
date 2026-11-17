/**
 * W2M Rabbit relay — v0.1.2 persistence (PROTOCOL-v0.1.2 §7).
 *
 * `<state>/devices.json`  atomic snapshot (tmp file + rename)
 * `<state>/ledger.jsonl`  append-only, one JSON object per line
 * `<state>/operator-token.txt`  single line, 0600
 * `<state>/blobs/<aa>/<sha256>`  content-addressed bytes, v1.0.7 (see `putBlob`)
 *
 * This is the only relay module allowed to touch the filesystem.
 * Corruption is never silent: every skipped line / unreadable snapshot is
 * recorded in `warnings` and surfaced through `/healthz`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { rfc3339 } from './state.mjs';

export const DEVICES_FILE = 'devices.json';
export const LEDGER_FILE = 'ledger.jsonl';
export const OPERATOR_TOKEN_FILE = 'operator-token.txt';
/**
 * Phase 2 (project room / fleet chat cross-relay sync) state layout.
 *
 * `<state>/chat/`                     durable chat replication log + generation/applied state
 * `<state>/projects/objects.json`     shared project objects (artifacts/decisions/memory/refs/locks/
 *                                     reviews/notifications/read marks) so a restart keeps them
 * `<state>/instance-id.json`          stable per-state-directory id used as the origin of records
 *                                     created before cluster sync existed (and by single-node relays)
 */
export const INSTANCE_ID_FILE = 'instance-id.json';
export const CHAT_DIR = 'chat';
export const PROJECTS_DIR = 'projects';
export const PROJECT_OBJECTS_FILE = 'objects.json';
export const CLUSTER_DOMAINS_FILE = 'domains.json';

/**
 * v3.0.0 relay cluster sync state (docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md).
 *
 * Everything below lives under `<state>/cluster/` and is written 0600: the imported ledger carries
 * other relays' task facts (which include command lines), and the cursor tells a peer how far this
 * relay has read from it. Nothing here is ever logged.
 */
export const CLUSTER_DIR = 'cluster';
export const CLUSTER_NODE_FILE = 'cluster-node.json';
export const CLUSTER_CURSORS_FILE = 'cursors.json';
export const CLUSTER_LEDGER_FILE = 'ledger.jsonl';
export const CLUSTER_LAST_SYNC_FILE = 'last-sync.json';
/** How many bytes of the local ledger one snapshot chunk may carry. */
export const CLUSTER_LEDGER_CHUNK_BYTES = 2 * 1024 * 1024;
/** v1.0.7: the content-addressed blob directory, and the two caps that keep it bounded. */
export const BLOB_DIR = 'blobs';
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const MAX_BLOBS = 256;
/**
 * v1.0.7: **which fleet wrote each blob.**
 *
 * Content addressing keys a blob by its own hash, and a hash knows nothing about fleets. So two fleets that store
 * the same bytes land at the same path -- and without this index, the second one could read the first one's content.
 * **A content-addressed store with no ownership record is not isolated, it is shared.**
 *
 * The index is a separate document rather than part of the path (`blobs/<fleet>/<aa>/<hash>`) for one concrete
 * reason: **deduplication is only sound when the content is identical**, and identical bytes stored twice would
 * otherwise occupy two entries. The path stays a pure function of the content; the fleet is metadata.
 *
 * Shape: `{ "<sha256>": { fleet_id: string|null, added_at_ms: number } }`.
 */
export const BLOB_INDEX_FILE = 'index.json';

/**
 * v1.0.9: **which blob is each fleet's current document** -- the discovery half of the channel.
 *
 * ## Why a hash alone is not enough
 *
 * v1.0.7/1.0.8 gave the fleet a content-addressed channel: anyone in the fleet can `pull <hash>`. **A hash is only
 * useful to someone who already has it**, and the only way to get one was to read `publish`'s output on another
 * machine. That makes the channel work exactly as well as a human relaying a 64-character string.
 *
 * So the relay keeps one pointer per fleet: four fields of metadata it was already entitled to hold, because it
 * already holds `fleet_id` for every blob.
 *
 * ## A pointer is a hint, not a guarantee
 *
 * Eviction is oldest-first and can take the current document on a busy fleet. `latest` may therefore name a blob
 * that no longer exists, and a pull of it answers `404`. **That is the honest outcome**: keeping a document alive
 * because it is pointed at would make eviction depend on a second, unstated rule.
 *
 * Shape: `{ "<fleet_id>": { hash, bytes, published_at_ms, published_by } }`.
 */
export const BLOB_LATEST_FILE = 'latest.json';

/** Ledger entry types understood by `RabbitState#restore`. */
export const LEDGER_TYPES = Object.freeze([
  'task.created',
  'lease.changed',
  'result.stored',
  'task.cancelled',
]);

export class Persistence {
  /**
   * @param {{dir?:string|null, now?:() => number}} options `dir: null` disables persistence.
   */
  constructor({ dir = null, now = Date.now } = {}) {
    this.dir = dir ? path.resolve(dir) : null;
    this._now = now;
    /** @type {{file:string, message:string, line?:number}[]} */
    this.warnings = [];
    /**
     * Durability state (v0.6.2): whether the ledger is actually being written.
     *
     * `appendFailures` is cumulative and never reset, so "how much was lost" stays answerable after a
     * disk fills and is freed again. `degradedSinceMs` is the live condition.
     */
    this.appendFailures = 0;
    this.lastAppendError = null;
    this.degradedSinceMs = null;
    this.devicesCorrupt = false;
    this.devicesMissing = true;
    this.revivedDevices = 0;
    this.revivedTasks = 0;
    this.ledgerLinesRead = 0;
    this.ledgerLinesSkipped = 0;
  }

  get enabled() { return this.dir !== null; }
  get devicesFile() { return this.enabled ? path.join(this.dir, DEVICES_FILE) : null; }
  get ledgerFile() { return this.enabled ? path.join(this.dir, LEDGER_FILE) : null; }
  get operatorTokenFile() { return this.enabled ? path.join(this.dir, OPERATOR_TOKEN_FILE) : null; }
  get clusterDir() { return this.enabled ? path.join(this.dir, CLUSTER_DIR) : null; }
  get clusterNodeFile() { return this.enabled ? path.join(this.dir, CLUSTER_NODE_FILE) : null; }
  get clusterCursorsFile() { return this.enabled ? path.join(this.dir, CLUSTER_DIR, CLUSTER_CURSORS_FILE) : null; }
  get clusterLedgerFile() { return this.enabled ? path.join(this.dir, CLUSTER_DIR, CLUSTER_LEDGER_FILE) : null; }
  get clusterLastSyncFile() { return this.enabled ? path.join(this.dir, CLUSTER_DIR, CLUSTER_LAST_SYNC_FILE) : null; }
  get instanceIdFile() { return this.enabled ? path.join(this.dir, INSTANCE_ID_FILE) : null; }
  get chatDir() { return this.enabled ? path.join(this.dir, CHAT_DIR) : null; }
  get projectsDir() { return this.enabled ? path.join(this.dir, PROJECTS_DIR) : null; }
  get projectObjectsFile() { return this.enabled ? path.join(this.dir, PROJECTS_DIR, PROJECT_OBJECTS_FILE) : null; }
  get clusterDomainsFile() { return this.enabled ? path.join(this.dir, CLUSTER_DIR, CLUSTER_DOMAINS_FILE) : null; }

  warn(file, message, extra = {}) {
    // Deduplicated (v0.6.2). A full disk fails *every* append, and appending an identical entry each
    // time buried the signal in its own repetition: this fleet's relay reached 22 byte-identical
    // "ENOSPC" warnings and no way to ask "is this relay still recording?" without counting them. One
    // entry that counts is what an operator can act on.
    const existing = this.warnings.find((entry) => entry.file === file && entry.message === message);
    if (existing !== undefined) {
      existing.count = (existing.count ?? 1) + 1;
      existing.last_at = rfc3339(this._now());
      return existing;
    }
    const entry = { file, message, count: 1, ...extra };
    this.warnings.push(entry);
    return entry;
  }

  /**
   * One ledger append failed: the relay is still serving, but it is no longer recording (v0.6.2).
   *
   * This is a first-class state rather than a log line because the ledger *is* the relay's durability
   * story. Every machine's result, every lease, everything a later question would be answered from —
   * none of it survives a restart once appends stop landing. A relay in this state accepts work
   * exactly as before, which is precisely why it has to say so out loud.
   *
   * @param {string} message
   * @returns {false}
   */
  noteAppendFailure(message) {
    this.appendFailures += 1;
    this.lastAppendError = message;
    if (this.degradedSinceMs === null) this.degradedSinceMs = this._now();
    this.warn(LEDGER_FILE, `append failed: ${message}`);
    return false;
  }

  /**
   * The ledger is being written again.
   *
   * The history is kept — `append_failures` is not reset — because "how much was lost" is the first
   * question after a disk fills, and a counter that silently returns to zero cannot answer it.
   *
   * @returns {true}
   */
  noteAppendSuccess() {
    if (this.degradedSinceMs !== null) {
      const forMs = Math.max(0, this._now() - this.degradedSinceMs);
      this.degradedSinceMs = null;
      this.lastAppendError = null;
      this.warn(LEDGER_FILE, `append recovered after ${this.appendFailures} failure(s) over ${forMs}ms`);
    }
    return true;
  }

  /** Is the relay serving without recording? @returns {boolean} */
  get degraded() {
    return this.degradedSinceMs !== null;
  }

  ensureDir() {
    if (!this.enabled) return false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return true;
  }

  /* ---------------- devices.json ---------------- */

  /**
   * @returns {{devices: Record<string, object>, corrupt: boolean, missing: boolean}}
   * `corrupt: true` means the snapshot was unreadable — the caller starts from an
   * EMPTY table and must report that loudly (never a silent wipe).
   */
  loadDevices() {
    if (!this.enabled) return { devices: {}, corrupt: false, missing: true };
    if (!fs.existsSync(this.devicesFile)) return { devices: {}, corrupt: false, missing: true };

    let raw;
    try {
      raw = fs.readFileSync(this.devicesFile, 'utf8');
    } catch (err) {
      this.devicesCorrupt = true;
      this.warn(DEVICES_FILE, `unreadable (${err.message}); starting from an empty device table`);
      return { devices: {}, corrupt: true, missing: false };
    }
    if (raw.trim() === '') return { devices: {}, corrupt: false, missing: false };

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('snapshot must be a JSON object keyed by machine_id');
      }
      return { devices: parsed, corrupt: false, missing: false };
    } catch (err) {
      this.devicesCorrupt = true;
      this.warn(DEVICES_FILE, `corrupt snapshot ignored (${err.message}); starting from an empty device table`);
      return { devices: {}, corrupt: true, missing: false };
    }
  }

  /** Atomic snapshot: write a temp file, fsync, then rename over the target. */
  saveDevices(devices) {
    if (!this.enabled) return false;
    this.ensureDir();
    const out = {};
    const iterable = devices instanceof Map ? devices.values() : Object.values(devices ?? {});
    for (const d of iterable) {
      out[d.machine_id] = {
        machine_name: d.machine_name ?? d.machine_id,
        platform: d.platform ?? {},
        caps: d.caps ?? {},
        user_id: d.user_id ?? null,
        device_token: d.device_token ?? null,
        paired_at: rfc3339(d.paired_at_ms ?? this._now()),
        re_paired: d.re_paired === true,
        /**
         * v1.4.4: **the fleet binding is part of the device, so it must survive a restart.**
         *
         * Measured on the shared relay (2026-10-23): a relay restart came back with every device
         * present and every fleet assignment gone, because this snapshot did not carry the two
         * fields the pairing decision had produced. The devices were still authorised, so nothing
         * looked broken -- they simply stopped being in a fleet, which is the one thing the fleet
         * key had been bought to guarantee. `fleet_id` is a derived hash (not a secret) and
         * `fleet_source` is the provenance that makes a wrong binding visible.
         */
        fleet_id: d.fleet_id ?? null,
        fleet_source: d.fleet_source ?? null,
      };
    }
    const body = JSON.stringify(out, null, 2);
    const tmp = `${this.devicesFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.devicesFile);
    return true;
  }

  /* ---------------- ledger.jsonl ---------------- */

  /** Replay-safe read: a single broken line is skipped and counted, never fatal. */
  loadLedger() {
    if (!this.enabled) return [];
    if (!fs.existsSync(this.ledgerFile)) return [];
    let text;
    try {
      text = fs.readFileSync(this.ledgerFile, 'utf8');
    } catch (err) {
      this.warn(LEDGER_FILE, `unreadable (${err.message}); ledger not replayed`);
      return [];
    }
    const entries = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      this.ledgerLinesRead += 1;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
          throw new Error('entry must be an object with a string `type`');
        }
        entries.push(entry);
      } catch (err) {
        this.ledgerLinesSkipped += 1;
        this.warn(LEDGER_FILE, `line ${i + 1} skipped: ${err.message}`, { line: i + 1 });
      }
    }
    return entries;
  }

  /** §7: synchronous append is enough — the volume is tiny. */
  append(entry) {
    if (!this.enabled) return false;
    this.ensureDir();
    const line = `${JSON.stringify({ ts: rfc3339(this._now()), ...entry })}\n`;
    fs.appendFileSync(this.ledgerFile, line, { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  /* ---------------- operator-token.txt ---------------- */

  readOperatorToken() {
    if (!this.enabled) return null;
    try {
      if (!fs.existsSync(this.operatorTokenFile)) return null;
      const token = fs.readFileSync(this.operatorTokenFile, 'utf8').trim();
      return token.length > 0 ? token : null;
    } catch (err) {
      this.warn(OPERATOR_TOKEN_FILE, `unreadable (${err.message}); a new token will be generated`);
      return null;
    }
  }

  writeOperatorToken(token) {
    if (!this.enabled || !token) return false;
    this.ensureDir();
    fs.writeFileSync(this.operatorTokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.operatorTokenFile, 0o600); } catch { /* best effort on Windows */ }
    return true;
  }

  /* ------------------------------------------------------------------------------------------- */
  /* v1.0.7: content-addressed blobs — the fleet sync channel (#1)                               */
  /* ------------------------------------------------------------------------------------------- */

  /**
   * Store bytes under their own SHA-256, and read them back by that hash.
   *
   * ## Why the relay may carry bytes at all, when it deliberately carries none today
   *
   * The relay persists `stdout_sha256` and never the text, and `src/agent/storage.mjs` records why that matters:
   * `memory.jsonl` on each machine is the only durable copy of what a command printed. **That invariant is about
   * the relay not becoming a document store** — it never interprets content and never asserts that content is
   * authentic.
   *
   * A blob keyed by **its own hash** preserves both halves. The relay still interprets nothing; **the hash is what
   * says the bytes are the bytes**, exactly as `stdout_sha256` does for a result. The only thing that is new is
   * that a hash the relay already holds can now have its bytes fetched from the same place.
   *
   * ## The two limits, because an uncapped writer is what caused the original incident
   *
   * `storage.mjs`'s header records the incident that produced its whole design: a single uncapped writer reached
   * 100% filesystem at 14.7 GB/day. A blob channel with no ceiling reproduces that on the relay, so:
   *
   *   * **8 MiB per blob** — a `fleet-memory.md` is tens of KB; this is three orders of magnitude of headroom.
   *     Larger content is an archive, not a memory.
   *   * **256 blobs** — bounded *count* matters as much as bounded size: 256 × 8 MiB caps a fleet's share at
   *     2 GiB regardless of what it writes.
   *
   * Eviction is oldest-first and **never takes the last blob**: deleting the only copy of a fact is the failure
   * `UNDELETABLE_TIERS` exists to prevent locally.
   *
   * @param {Buffer} bytes
   * @param {{fleetId?: string|null}} [options] the owning fleet, recorded so another fleet cannot read it back
   * @returns {{ok:true, hash:string, bytes:number, evicted:string[]}|{ok:false, reason:string, detail:string}}
   */
  putBlob(bytes, options = {}) {
    if (!this.enabled) return { ok: false, reason: 'PERSISTENCE_DISABLED', detail: 'the relay has no state directory' };
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return { ok: false, reason: 'BLOB_EMPTY', detail: 'an empty blob is a caller bug, not content' };
    }
    if (bytes.length > MAX_BLOB_BYTES) {
      return {
        ok: false,
        reason: 'BLOB_TOO_LARGE',
        detail: `${bytes.length} bytes exceeds the ${MAX_BLOB_BYTES}-byte limit`,
      };
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = this.blobFile(hash);
    if (file === null) return { ok: false, reason: 'PERSISTENCE_DISABLED', detail: 'no blob directory' };

    const index = this.readBlobIndex();
    const fleetId = typeof options.fleetId === 'string' && options.fleetId !== '' ? options.fleetId : null;

    // Content addressing makes the write idempotent: the same bytes always land at the same path.
    if (fs.existsSync(file)) {
      /**
       * Already stored. **The first writer's fleet keeps ownership** -- re-assigning it on a second write would let
       * one fleet claim a blob another fleet already owns by simply PUT-ting the same bytes, which is the same
       * failure as having no index at all.
       */
      const entry = index[hash];
      if (entry === undefined) {
        index[hash] = { fleet_id: fleetId, added_at_ms: this._now() };
        this.writeBlobIndex(index);
        this.advanceFleetLatest(fleetId, hash, bytes.length, options.publishedBy);
      } else if (entry.fleet_id === fleetId) {
        // Re-publishing the same bytes is a statement that this is the current document, so the pointer advances
        // even though the path did not change. Only for the **owner**: pointing another fleet's pointer at a blob it
        // cannot read would advertise a document that answers 404 to the very fleet being told about it.
        this.advanceFleetLatest(fleetId, hash, bytes.length, options.publishedBy);
      }
      return { ok: true, hash, bytes: bytes.length, evicted: [] };
    }

    const evicted = this.evictBlobsFor(1);
    for (const gone of evicted) delete index[gone];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${this._now()}`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, file);
    } catch (error) {
      this.warn(BLOB_DIR, `blob write failed: ${error?.message ?? String(error)}`);
      return { ok: false, reason: 'BLOB_WRITE_FAILED', detail: error?.message ?? String(error) };
    }
    index[hash] = { fleet_id: fleetId, added_at_ms: this._now() };
    this.writeBlobIndex(index);
    this.advanceFleetLatest(fleetId, hash, bytes.length, options.publishedBy);
    return { ok: true, hash, bytes: bytes.length, evicted };
  }

  /**
   * The bytes for a hash, or `null`.
   *
   * Never throws -- an unreadable blob is a miss, not a crash -- and **when `fleetId` is supplied, a blob owned by a
   * different fleet is a miss too.** The caller cannot distinguish "no such blob" from "not yours", which is
   * deliberate: a distinguishable refusal tells a prober that a hash exists on this relay.
   *
   * @param {string} hash
   * @param {{fleetId?: string|null|undefined}} [options] omit `fleetId` entirely for an unscoped read
   */
  getBlob(hash, options = {}) {
    const file = this.blobFile(hash);
    if (file === null) return null;
    if (options.fleetId !== undefined) {
      const entry = this.readBlobIndex()[hash];
      // A blob with no recorded owner predates the index or was written unscoped; it is not this fleet's.
      if (entry === undefined || entry.fleet_id !== options.fleetId) return null;
    }
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  hasBlob(hash) {
    const file = this.blobFile(hash);
    if (file === null) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Every stored blob, newest last, with the size and mtime needed to enforce the count cap.
   *
   * @returns {{hash:string, bytes:number, mtimeMs:number}[]}
   */
  listBlobs() {
    if (!this.enabled) return [];
    const root = path.join(this.dir, BLOB_DIR);
    let shards;
    try {
      shards = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardPath = path.join(root, shard.name);
      let names;
      try {
        names = fs.readdirSync(shardPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of names) {
        if (!entry.isFile() || entry.name.includes('.tmp-')) continue;
        try {
          const stat = fs.statSync(path.join(shardPath, entry.name));
          out.push({ hash: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* a blob that vanished mid-scan is not a failure */
        }
      }
    }
    out.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return out;
  }

  /**
   * Make room for `incoming` more blobs, oldest first, and never take the last one.
   *
   * **The caller must prune the index for the returned hashes** -- this method deletes files, and the index is a
   * separate document. `putBlob` does that pruning; a future caller that evicts for another reason owes the same.
   *
   * @param {number} incoming
   * @returns {string[]} the hashes evicted
   */
  evictBlobsFor(incoming) {
    const existing = this.listBlobs();
    const over = existing.length + incoming - MAX_BLOBS;
    if (over <= 0) return [];
    const evicted = [];
    let count = existing.length;
    for (const blob of existing) {
      if (count <= 1) break; // never delete the only copy of anything
      try {
        fs.rmSync(path.join(this.dir, BLOB_DIR, blob.hash.slice(0, 2), blob.hash), { force: true });
        evicted.push(blob.hash);
        count -= 1;
      } catch {
        /* leave it; the caller will see the count did not drop */
      }
      if (evicted.length >= over) break;
    }
    if (evicted.length > 0) this.warn(BLOB_DIR, `evicted ${evicted.length} blob(s) to stay within ${MAX_BLOBS}`);
    return evicted;
  }

  /** Read the hash -> owner map. A missing or corrupt index reads as empty rather than taking the relay down. */
  readBlobIndex() {
    if (!this.enabled) return {};
    try {
      const raw = fs.readFileSync(path.join(this.dir, BLOB_DIR, BLOB_INDEX_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Atomically replace the index. Best-effort: a failure is warned about, never thrown at the caller. */
  writeBlobIndex(index) {
    if (!this.enabled) return false;
    const file = path.join(this.dir, BLOB_DIR, BLOB_INDEX_FILE);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${this._now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify(index)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      this.warn(BLOB_DIR, `blob index write failed: ${error?.message ?? String(error)}`);
      return false;
    }
  }

  /** Read the fleet -> latest-blob pointer map. Missing or corrupt reads as empty, never throws. */
  readBlobLatest() {
    if (!this.enabled) return {};
    try {
      const raw = fs.readFileSync(path.join(this.dir, BLOB_DIR, BLOB_LATEST_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Atomically replace the pointer map. Best-effort, like the ownership index. */
  writeBlobLatest(latest) {
    if (!this.enabled) return false;
    const file = path.join(this.dir, BLOB_DIR, BLOB_LATEST_FILE);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${this._now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify(latest)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      this.warn(BLOB_DIR, `blob latest-pointer write failed: ${error?.message ?? String(error)}`);
      return false;
    }
  }

  /**
   * Point a fleet at the blob it just published.
   *
   * ## `null` is a real scope, not a missing value
   *
   * The first version of this method skipped `fleetId === null`, reasoning that a fleetless device has no fleet to
   * advertise to. **That was wrong for the most common deployment.** On a relay with no fleet configured,
   * `scopeFleetId` returns `{fleetId: null, legacy: true}` -- and `null` there means **one shared scope**, which
   * is exactly the pre-v0.7.7 behaviour that fleet scoping's own comment insists a migration must not change:
   * *"a migration must not change behaviour for devices that were never asked to change."*
   *
   * Skipping it meant the pointer was never written on an unclaimed relay, so `latest` answered 404 for every
   * machine on the default single-relay setup -- the feature worked nowhere it was most likely to be used. A test
   * caught it, which is the only reason this is a comment instead of a bug report.
   *
   * The genuinely fleetless case on a **claimed** relay never reaches here: `scopeFleetId` refuses it outright
   * (`REQUESTER_HAS_NO_FLEET`), so the blob is rejected before any pointer could be written.
   *
   * @param {string|null} fleetId `null` means the relay-wide legacy scope
   * @param {string} hash
   * @param {number} bytes
   * @param {string|null} [publishedBy]
   */
  advanceFleetLatest(fleetId, hash, bytes, publishedBy = null) {
    if (!this.enabled || fleetId === undefined) return false;
    const latest = this.readBlobLatest();
    latest[fleetId] = {
      hash,
      bytes,
      published_at_ms: this._now(),
      published_by: typeof publishedBy === 'string' && publishedBy !== '' ? publishedBy : null,
    };
    return this.writeBlobLatest(latest);
  }

  /**
   * The blob `fleetId` last published, or `null`.
   *
   * **A returned pointer is a hint.** It may name a blob that eviction has since removed, and the caller is expected
   * to read it and answer not-found rather than being told a comfortable lie here.
   */
  fleetLatest(fleetId) {
    if (!this.enabled || fleetId === undefined) return null;
    const entry = this.readBlobLatest()[fleetId];
    return entry !== undefined && typeof entry.hash === 'string' ? entry : null;
  }

  /** `<state>/blobs/<aa>/<sha256>`, or `null` when persistence is off or the hash is not a sha256. */
  blobFile(hash) {
    if (!this.enabled) return null;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    return path.join(this.dir, BLOB_DIR, hash.slice(0, 2), hash);
  }

  /** Redacted view for `/healthz` — never contains tokens. */
  /* ---------------- v3.0.0: relay cluster sync ---------------- */

  /** Atomic JSON write (tmp + rename), 0600, with the parent directory created 0700. */
  _writeJsonAtomic(file, value) {
    if (!this.enabled || typeof file !== 'string') return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
      return true;
    } catch (err) {
      this.warn(path.basename(file), `write failed: ${err.message}`);
      return false;
    }
  }

  /** The stable node id used by cluster sync; `null` when never generated. */
  loadClusterNodeId() {
    if (!this.enabled) return null;
    try {
      if (!fs.existsSync(this.clusterNodeFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.clusterNodeFile, 'utf8'));
      const nodeId = parsed?.node_id;
      return typeof nodeId === 'string' && /^node-[0-9a-f]{8,32}$/.test(nodeId) ? nodeId : null;
    } catch (err) {
      this.warn(CLUSTER_NODE_FILE, `unreadable (${err.message}); a new node id will be generated`);
      return null;
    }
  }

  saveClusterNodeId(nodeId) {
    if (!/^node-[0-9a-f]{8,32}$/.test(String(nodeId))) return false;
    return this._writeJsonAtomic(this.clusterNodeFile, { v: 1, node_id: nodeId });
  }

  /** Per-peer sync cursors: `{ "<peer-node-id>": { ledger_offset, last_ok_at_ms, ... } }`. */
  loadClusterCursors() {
    if (!this.enabled) return {};
    try {
      if (!fs.existsSync(this.clusterCursorsFile)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.clusterCursorsFile, 'utf8'));
      const cursors = parsed?.cursors;
      return cursors !== null && typeof cursors === 'object' && !Array.isArray(cursors) ? cursors : {};
    } catch (err) {
      this.warn(CLUSTER_CURSORS_FILE, `unreadable (${err.message}); starting from an empty cursor set`);
      return {};
    }
  }

  saveClusterCursors(cursors) {
    return this._writeJsonAtomic(this.clusterCursorsFile, { v: 1, cursors: cursors ?? {} });
  }

  saveClusterLastSync(info) {
    return this._writeJsonAtomic(this.clusterLastSyncFile, { v: 1, ...info });
  }

  loadClusterLastSync() {
    if (!this.enabled) return null;
    try {
      if (!fs.existsSync(this.clusterLastSyncFile)) return null;
      return JSON.parse(fs.readFileSync(this.clusterLastSyncFile, 'utf8'));
    } catch { return null; }
  }

  /* ---------------- Phase 2: chat / project sync state ---------------- */

  /**
   * A stable per-state-directory id.
   *
   * Used as the origin of project events that predate cluster sync (they carry no origin), and by
   * single-node relays that have no cluster node id. It is random, not secret, and must never change:
   * changing it would make the same historical event look like a different one to peers.
   */
  loadInstanceId() {
    if (!this.enabled) return null;
    if (this._instanceId !== undefined) return this._instanceId;
    try {
      if (fs.existsSync(this.instanceIdFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.instanceIdFile, 'utf8'));
        if (typeof parsed?.id === 'string' && parsed.id !== '') {
          this._instanceId = parsed.id;
          return this._instanceId;
        }
      }
    } catch (err) {
      this.warn(INSTANCE_ID_FILE, `unreadable (${err.message}); generating a new instance id`);
    }
    const id = 'inst-' + randomBytes(8).toString('hex');
    this._instanceId = id;
    this._writeJsonAtomic(this.instanceIdFile, { v: 1, id });
    return id;
  }

  saveProjectObjects(value) {
    if (!this.enabled) return false;
    return this._writeJsonAtomic(this.projectObjectsFile, { v: 1, ...value });
  }

  loadProjectObjects() {
    if (!this.enabled) return null;
    try {
      if (!fs.existsSync(this.projectObjectsFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.projectObjectsFile, 'utf8'));
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      this.warn('projects/objects.json', `unreadable (${err.message}); project objects start empty`);
      return null;
    }
  }

  saveClusterDomains(state) {
    return this._writeJsonAtomic(this.clusterDomainsFile, { v: 1, ...state });
  }

  loadClusterDomains() {
    if (!this.enabled) return null;
    try {
      if (!fs.existsSync(this.clusterDomainsFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.clusterDomainsFile, 'utf8'));
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      this.warn(CLUSTER_DOMAINS_FILE, `unreadable (${err.message}); domain cursors start empty`);
      return null;
    }
  }

  /**
   * Foreign ledger entries imported from peers, as `{origin, offset, ts, entry}`.
   *
   * Deduplicated on load by `(origin, offset)`: a snapshot chunk may legitimately be re-requested
   * after a crash between "applied" and "cursor saved", and replaying an entry twice must not
   * double-apply it to the live task table.
   */
  loadClusterLedger() {
    if (!this.enabled) return [];
    try {
      if (!fs.existsSync(this.clusterLedgerFile)) return [];
      const raw = fs.readFileSync(this.clusterLedgerFile, 'utf8');
      const records = [];
      const seen = new Set();
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const record = JSON.parse(line);
          if (typeof record?.origin !== 'string' || !Number.isInteger(record?.offset) || record?.entry === null || typeof record.entry !== 'object') {
            this.ledgerLinesSkipped += 1;
            continue;
          }
          const key = `${record.origin}@${record.offset}`;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push(record);
        } catch (err) {
          this.ledgerLinesSkipped += 1;
          this.warn(CLUSTER_LEDGER_FILE, `line skipped: ${err.message}`);
        }
      }
      return records;
    } catch (err) {
      this.warn(CLUSTER_LEDGER_FILE, `unreadable (${err.message}); imported ledger not replayed`);
      return [];
    }
  }

  appendClusterLedger(record) {
    if (!this.enabled || !this._clusterDirReady()) return false;
    try {
      fs.appendFileSync(this.clusterLedgerFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (err) {
      this.warn(CLUSTER_LEDGER_FILE, `append failed: ${err.message}`);
      return false;
    }
  }

  _clusterDirReady() {
    if (!this.enabled) return false;
    try { fs.mkdirSync(this.clusterDir, { recursive: true, mode: 0o700 }); return true; } catch (err) {
      this.warn(CLUSTER_DIR, `mkdir failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Read the local ledger from a byte offset, in complete lines only.
   *
   * Offsets are byte offsets in the file (not line numbers) because appends never rewrite earlier
   * bytes: a byte offset is the only cursor that is stable while the file grows. A trailing partial
   * line is never consumed (it is a write in progress), so the next read starts at the same offset.
   *
   * @param {{offset?: number, maxBytes?: number}} [options]
   * @returns {{entries: {offset:number, entry:object}[], nextOffset:number, totalBytes:number, eof:boolean}}
   */
  readLedgerSlice({ offset = 0, maxBytes = CLUSTER_LEDGER_CHUNK_BYTES } = {}) {
    const empty = { entries: [], nextOffset: offset, totalBytes: 0, eof: true };
    if (!this.enabled) return empty;
    let buf;
    try {
      buf = fs.readFileSync(this.ledgerFile);
    } catch (err) {
      if (err.code !== 'ENOENT') this.warn(LEDGER_FILE, `unreadable for cluster sync (${err.message})`);
      return empty;
    }
    const start = Number.isInteger(offset) && offset >= 0 && offset <= buf.length ? offset : 0;
    const entries = [];
    let pos = start;
    let consumed = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break; // trailing partial line: leave it for the next tick
      const lineStart = pos;
      pos = nl + 1;
      const line = buf.subarray(lineStart, nl).toString('utf8').trim();
      if (line !== '') {
        try {
          const entry = JSON.parse(line);
          if (entry !== null && typeof entry === 'object' && typeof entry.type === 'string') {
            entries.push({ offset: lineStart, entry });
          }
        } catch (err) {
          this.ledgerLinesSkipped += 1;
          this.warn(LEDGER_FILE, `cluster slice skipped malformed line: ${err.message}`);
        }
      }
      consumed = pos - start;
      if (consumed >= maxBytes) break;
    }
    return { entries, nextOffset: pos, totalBytes: buf.length, eof: pos >= buf.length };
  }

  describe() {
    const blobs = this.listBlobs();
    return {
      enabled: this.enabled,
      dir: this.dir,
      revived_devices: this.revivedDevices,
      revived_tasks: this.revivedTasks,
      devices_corrupt: this.devicesCorrupt,
      devices_missing: this.devicesMissing,
      ledger_lines_read: this.ledgerLinesRead,
      ledger_lines_skipped: this.ledgerLinesSkipped,
      /** v1.0.7: the fleet sync channel's occupancy, reported as counts and bytes — never contents. */
      blobs: blobs.length,
      blob_bytes: blobs.reduce((sum, b) => sum + b.bytes, 0),
      blobs_limit: MAX_BLOBS,
      blob_bytes_limit: MAX_BLOB_BYTES,
      /**
       * v0.6.2. `degraded: true` means the relay is answering requests while failing to record them,
       * which is the one relay failure that looks exactly like health from the outside.
       */
      degraded: this.degraded,
      degraded_since: this.degradedSinceMs === null ? null : rfc3339(this.degradedSinceMs),
      last_append_error: this.lastAppendError,
      append_failures: this.appendFailures,
      warnings: this.warnings.map((w) => ({ ...w })),
    };
  }
}

export default Persistence;
