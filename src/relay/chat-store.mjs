/**
 * Relay chat replication store (Phase 2A): the durable half of fleet chat.
 *
 * ## What this file is
 *
 * `fleet-messages.mjs` keeps the authoritative chat list in memory and owns the quota rules. This store gives that chat a
 * disk footprint and the replication log the relay cluster pulls from:
 *
 *     <state>/chat/
 *       replication.jsonl   append-only; one record per line
 *       state.json          { v: 1, generation, next_local_offset }   (atomic tmp+rename, 0600)
 *       applied.json        { v: 1, applied: { "<origin>": <maxOffset> } }   (idempotency)
 *
 * Every record is `{ v: 1, origin, offset, at_ms, kind, data }` with `kind` one of `chat.message`, `chat.read`,
 * `chat.session.deleted`. A local record gets `offset = next_local_offset` for its own `origin`; a record imported from a
 * peer is re-exported **verbatim** (same origin/offset), which is what lets any surviving relay bootstrap a new node.
 *
 * ## Why an append-only log and a generation
 *
 * The cluster sync cursor is a byte offset into `replication.jsonl`, and appends never rewrite earlier bytes, so a byte
 * offset stays valid while the file grows. Retention (`retentionDays`) and the hard byte cap require rewriting the file
 * older-to-newer, which invalidates every peer cursor -- so a rewrite bumps `generation`, and a peer that sees a different
 * generation resets its cursor to zero and re-pulls. Import deduplication makes that replay idempotent.
 *
 * ## Deletion
 *
 * A `chat.session.deleted` tombstone is permanent: `load()` never returns a message of a tombstoned session (regardless
 * of the message's `at_ms`, so a re-import or a restart cannot resurrect a deleted conversation) and `prune()` removes
 * those message records from the log. The tombstone itself is retained forever; dropping it would let a later sync bring
 * the conversation back. The relay's HTTP API has no device-facing delete route yet -- the tombstone is produced by the
 * relay-level delete path and by peers that already recorded the deletion.
 *
 * ## Crash ordering
 *
 * * `append*` persists `next_local_offset` **before** appending the line. A crash between the two leaves an unused offset
 *   (harmless); the reverse order could reuse an offset for a different message and make a peer drop the second one.
 * * `importRecord` appends the re-export **before** persisting the applied watermark. A crash between the two re-delivers
 *   the same record, which the log's `(origin, offset)` dedupe absorbs.
 * * `prune` bumps `generation` before rewriting the log, so a crash after the bump makes peers re-pull the (still complete)
 *   old log instead of silently missing bytes.
 *
 * ## What is deliberately not here
 *
 * No E2E key, no decryption, no interpretation of `text`/`enc`: the relay copies the row it is given. No fleet-message
 * quota check either -- the design (§5.1) says an imported message must not be refused because THIS relay's quota is full;
 * the store bounds itself with retention and the hard cap instead.
 *
 * The design lives in `RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md` §4.1/§4.3/§5.
 */
import fs from 'node:fs';
import path from 'node:path';

import { HARD_CAP_BYTES, QUOTA_24H_BYTES, RETENTION_DAYS } from './fleet-messages.mjs';

/** The substructure under the relay state directory. */
export const CHAT_DIR = 'chat';
/** The append-only replication log every peer pulls from. */
export const CHAT_REPLICATION_FILE = 'replication.jsonl';
/** `{ v: 1, generation, next_local_offset }`. */
export const CHAT_STATE_FILE = 'state.json';
/** `{ v: 1, applied: { "<origin>": <maxOffset> } }`. */
export const CHAT_APPLIED_FILE = 'applied.json';

/** Record format version understood by this build. */
export const CHAT_RECORD_VERSION = 1;
/** The three record kinds the chat domain replicates. */
export const CHAT_RECORD_KINDS = Object.freeze(['chat.message', 'chat.read', 'chat.session.deleted']);
/** Default page size: plaintext bytes per `exportSlice` call (design §4.2 asks for 128 KiB pages). */
export const DEFAULT_CHAT_SLICE_BYTES = 128 * 1024;

/** Defaults come from `fleet-messages.mjs`, so the two modules cannot drift apart. */
export const DEFAULT_CHAT_RETENTION_DAYS = RETENTION_DAYS;
export const DEFAULT_CHAT_HARD_CAP_BYTES = HARD_CAP_BYTES;
export const DEFAULT_CHAT_QUOTA_24H_BYTES = QUOTA_24H_BYTES;

const KIND_MESSAGE = 'chat.message';
const KIND_READ = 'chat.read';
const KIND_DELETED = 'chat.session.deleted';
const KIND_SET = new Set(CHAT_RECORD_KINDS);
const DAY_MS = 24 * 60 * 60 * 1000;
const NEWLINE = 0x0a;
/** 1-based generation used when the state file is missing/corrupt. */
const INITIAL_GENERATION = 1;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function positiveIntOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveBytesOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** A chat.message row is the full fleet-messages row; validate only what replication cannot work without. */
function isMessageData(data) {
  return isObject(data)
    && isNonEmptyString(data.message_id)
    && isNonEmptyString(data.session_id)
    && isNonEmptyString(data.machine_id)
    && typeof data.text === 'string'
    && Number.isFinite(data.at_ms);
}

function isReadData(data) {
  return isObject(data)
    && isNonEmptyString(data.session_id)
    && isNonEmptyString(data.machine_id)
    && Number.isFinite(data.at_ms)
    && (data.message_id === null || typeof data.message_id === 'string');
}

function isDeletedData(data) {
  return isObject(data) && isNonEmptyString(data.session_id);
}

function dataMatchesKind(kind, data) {
  if (kind === KIND_MESSAGE) return isMessageData(data);
  if (kind === KIND_READ) return isReadData(data);
  if (kind === KIND_DELETED) return isDeletedData(data);
  return false;
}

/** The record envelope every path (load, slice, import, prune) accepts. Anything else is corruption to skip. */
function isChatRecord(record) {
  return isObject(record)
    && record.v === CHAT_RECORD_VERSION
    && typeof record.origin === 'string' && record.origin.trim() !== '' && record.origin.length <= 128
    && Number.isInteger(record.offset) && record.offset >= 0
    && Number.isFinite(record.at_ms)
    && KIND_SET.has(record.kind)
    && dataMatchesKind(record.kind, record.data);
}

function recordKey(record) {
  return `${record.origin}\u0000${record.offset}`;
}

/** Deterministic LWW order for read marks / tombstones: at_ms, then origin, then offset. */
function isNewerAtMsCandidate(candidate, previous) {
  if (candidate.data.at_ms !== previous.data.at_ms) return candidate.data.at_ms > previous.data.at_ms;
  if (candidate.origin !== previous.origin) return candidate.origin > previous.origin;
  return candidate.offset > previous.offset;
}

/** Same rule for a tombstone, whose timestamp is the record's `at_ms`. */
function isNewerTombstone(candidate, previous) {
  if (candidate.at_ms !== previous.at_ms) return candidate.at_ms > previous.at_ms;
  if (candidate.origin !== previous.origin) return candidate.origin > previous.origin;
  return candidate.offset > previous.offset;
}

function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Message order: at_ms ascending, then origin, then offset -- fully deterministic across relays. */
function compareMessageRecords(a, b) {
  if (a.data.at_ms !== b.data.at_ms) return a.data.at_ms - b.data.at_ms;
  return compareStrings(a.origin, b.origin) || a.offset - b.offset;
}

/** Deep copy for values handed to callers, so no caller can mutate the cached rows. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {{dir?: string, now?: () => number, retentionDays?: number, hardCapBytes?: number,
 *          quota24hBytes?: number}} [options]
 *   `dir` is the relay state directory (the store creates `<dir>/chat/`); `quota24hBytes` is accepted so the caller can
 *   hand over the same chat limits it uses for `fleet-messages`, and is reported back on the store for diagnostics --
 *   retention/cap enforcement in this file deliberately uses only `retentionDays` and `hardCapBytes`.
 * @returns {{
 *   load: () => {messages: object[], readMarks: object[], deletedSessions: string[], stats: object},
 *   appendMessage: (input: {origin: string, message: object}) => object,
 *   appendRead: (input: {origin: string, session_id: string, machine_id: string, at_ms?: number, message_id?: string|null}) => object,
 *   appendSessionDeleted: (input: {origin: string, session_id: string}) => object,
 *   exportSlice: (fromOffset?: number, maxBytes?: number) => object,
 *   importRecord: (record: object) => {applied: boolean, generation: number},
 *   prune: () => object,
 *   stats: () => object,
 *   dir: string,
 *   retentionDays: number,
 *   hardCapBytes: number,
 *   quota24hBytes: number,
 * }}
 */
export function createChatStore(options = {}) {
  const inputDir = options?.dir;
  if (typeof inputDir !== 'string' || inputDir.trim() === '') {
    throw new TypeError('createChatStore: `dir` must be a non-empty string');
  }
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const retentionDays = positiveIntOr(options?.retentionDays, DEFAULT_CHAT_RETENTION_DAYS);
  const hardCapBytes = positiveBytesOr(options?.hardCapBytes, DEFAULT_CHAT_HARD_CAP_BYTES);
  const quota24hBytes = positiveBytesOr(options?.quota24hBytes, DEFAULT_CHAT_QUOTA_24H_BYTES);
  const retentionMs = retentionDays * DAY_MS;

  const chatDir = path.join(path.resolve(inputDir), CHAT_DIR);
  const logFile = path.join(chatDir, CHAT_REPLICATION_FILE);
  const stateFile = path.join(chatDir, CHAT_STATE_FILE);
  const appliedFile = path.join(chatDir, CHAT_APPLIED_FILE);

  /** Monotonic per-instance generation; a log rewrite bumps it. */
  let generation = INITIAL_GENERATION;
  /** Next offset to hand to a locally produced record. */
  let nextLocalOffset = 0;
  /** origin -> highest (origin, offset) already represented in this log, imported or local. */
  const applied = new Map();
  /** lazily read once from disk; later writes keep it current */
  let stateLoaded = false;
  /** unique records of the log in file order, or null when not read yet */
  let cachedRecords = null;
  let dirModeFixed = false;
  let logModeFixed = false;
  let tmpCounter = 0;

  /* ------------------------------------------------------------------------------------------- */
  /* filesystem primitives                                                                       */
  /* ------------------------------------------------------------------------------------------- */

  /** `<state>/chat/` exists and is 0700. `chmod` is best-effort: Windows has no POSIX mode bits. */
  function ensureDir() {
    fs.mkdirSync(chatDir, { recursive: true, mode: 0o700 });
    if (!dirModeFixed) {
      try { fs.chmodSync(chatDir, 0o700); } catch { /* best effort on Windows */ }
      dirModeFixed = true;
    }
  }

  /** The replication log is 0600. Creation mode already says so; this also fixes a pre-existing file once. */
  function ensureLogMode() {
    if (logModeFixed) return;
    try {
      if (fs.existsSync(logFile)) fs.chmodSync(logFile, 0o600);
    } catch { /* best effort on Windows */ }
    logModeFixed = true;
  }

  function tempPathFor(file) {
    tmpCounter += 1;
    return `${file}.tmp-${process.pid}-${tmpCounter.toString(36)}`;
  }

  /**
   * Read a JSON document. Missing or unparseable reads as `null` (a corrupt snapshot must not take chat down); every
   * other filesystem error is a real IO error and is re-thrown.
   */
  function readJson(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Atomic JSON write: temp file (0600), fsync-free like `persistence._writeJsonAtomic`, then rename over the target. */
  function writeJsonAtomic(file, value) {
    ensureDir();
    const tmp = tempPathFor(file);
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* the temp file may never have existed */ }
      throw err;
    }
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  }

  function logBytes() {
    try {
      return fs.statSync(logFile).size;
    } catch (err) {
      if (err?.code === 'ENOENT') return 0;
      throw err;
    }
  }

  /* ------------------------------------------------------------------------------------------- */
  /* state + applied                                                                             */
  /* ------------------------------------------------------------------------------------------- */

  function stateDoc() {
    return { v: CHAT_RECORD_VERSION, generation, next_local_offset: nextLocalOffset };
  }

  function appliedDoc() {
    const out = {};
    for (const origin of [...applied.keys()].sort(compareStrings)) {
      const offset = applied.get(origin);
      if (Number.isInteger(offset) && offset >= 0) out[origin] = offset;
    }
    return { v: CHAT_RECORD_VERSION, applied: out };
  }

  /** One-time read of `state.json` + `applied.json`; a damaged document falls back to its default, never throws. */
  function loadState() {
    if (stateLoaded) return;
    stateLoaded = true;
    const state = readJson(stateFile);
    if (state !== null && state.v === CHAT_RECORD_VERSION) {
      if (Number.isInteger(state.generation) && state.generation >= INITIAL_GENERATION) generation = state.generation;
      if (Number.isInteger(state.next_local_offset) && state.next_local_offset >= 0) nextLocalOffset = state.next_local_offset;
    }
    const appliedSnapshot = readJson(appliedFile);
    if (appliedSnapshot !== null && appliedSnapshot.v === CHAT_RECORD_VERSION && isObject(appliedSnapshot.applied)) {
      for (const [origin, offset] of Object.entries(appliedSnapshot.applied)) {
        if (isNonEmptyString(origin) && Number.isInteger(offset) && offset >= 0) applied.set(origin, offset);
      }
    }
  }

  /** Raise the applied watermark for `origin` to at least `offset`. */
  function noteApplied(origin, offset) {
    const previous = applied.get(origin);
    if (!Number.isInteger(previous) || offset > previous) applied.set(origin, offset);
  }

  /** Records already in the log are already applied; this also recovers if `state.json` was lost. */
  function seedAppliedFrom(records) {
    for (const record of records) noteApplied(record.origin, record.offset);
  }

  /* ------------------------------------------------------------------------------------------- */
  /* log reading                                                                                 */
  /* ------------------------------------------------------------------------------------------- */

  /**
   * Parse complete lines of a replication log. A torn trailing line (no newline yet) is left alone; malformed JSON and
   * non-conforming records are skipped, never fatal -- a single corrupt line must not take the chat history down.
   *
   * @returns {{records: object[], rawCount: number}} unique records in file order, and the number of valid lines read
   */
  function parseLogBuffer(buf) {
    const records = [];
    const seen = new Set();
    let rawCount = 0;
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(NEWLINE, pos);
      if (nl < 0) break; // trailing partial line: a write may still be in progress
      const line = buf.subarray(pos, nl).toString('utf8').trim();
      pos = nl + 1;
      if (line === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isChatRecord(record)) continue;
      rawCount += 1;
      const key = recordKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
    return { records, rawCount };
  }

  function readLog() {
    let buf;
    try {
      buf = fs.readFileSync(logFile);
    } catch (err) {
      if (err?.code === 'ENOENT') return { records: [], rawCount: 0 };
      throw err;
    }
    return parseLogBuffer(buf);
  }

  function ensureCache() {
    if (cachedRecords !== null) return cachedRecords;
    const { records } = readLog();
    seedAppliedFrom(records);
    cachedRecords = records;
    return cachedRecords;
  }

  /* ------------------------------------------------------------------------------------------- */
  /* log writing                                                                                 */
  /* ------------------------------------------------------------------------------------------- */

  /**
   * Append one record line. If a previous crash left a torn line without its newline, terminate that line first: otherwise
   * the next JSON object would be glued onto the garbage and the record would be lost too.
   *
   * @returns {object} the record as it was serialized (also the object cached in memory)
   */
  function appendRecordLine(record) {
    ensureDir();
    ensureLogMode();
    const body = JSON.stringify(record);
    const separator = needsTrailingNewline() ? '\n' : '';
    fs.appendFileSync(logFile, `${separator}${body}\n`, { encoding: 'utf8', mode: 0o600 });
    // Cache the serialized form, not the caller's object: a caller mutating its message later must not rewrite history.
    const stored = JSON.parse(body);
    if (cachedRecords !== null) cachedRecords.push(stored);
    noteApplied(stored.origin, stored.offset);
    return stored;
  }

  function needsTrailingNewline() {
    let stat;
    try {
      stat = fs.statSync(logFile);
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
    if (stat.size === 0) return false;
    const fd = fs.openSync(logFile, 'r');
    try {
      const last = Buffer.alloc(1);
      const read = fs.readSync(fd, last, 0, 1, stat.size - 1);
      return read === 1 && last[0] !== NEWLINE;
    } finally {
      fs.closeSync(fd);
    }
  }

  function writeLogAtomic(records) {
    ensureDir();
    const tmp = tempPathFor(logFile);
    const body = records.map((record) => `${JSON.stringify(record)}\n`).join('');
    try {
      fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, logFile);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      throw err;
    }
    try { fs.chmodSync(logFile, 0o600); } catch { /* best effort on Windows */ }
    logModeFixed = true;
  }

  /** Reserve a fresh local offset. Persisting it first is what makes an offset reuse impossible. */
  function reserveOffset(origin) {
    loadState();
    let offset = nextLocalOffset;
    const previousFromOrigin = applied.get(origin);
    // If the state file was lost but the log was not, the log's own highest offset for this origin wins.
    if (Number.isInteger(previousFromOrigin) && previousFromOrigin >= offset) offset = previousFromOrigin + 1;
    nextLocalOffset = offset + 1;
    writeJsonAtomic(stateFile, stateDoc());
    return offset;
  }

  function assertOrigin(origin) {
    if (typeof origin !== 'string' || origin.trim() === '' || origin.length > 128) {
      throw new TypeError('chat-store: `origin` must be a non-empty string of at most 128 characters');
    }
  }

  /* ------------------------------------------------------------------------------------------- */
  /* public API                                                                                  */
  /* ------------------------------------------------------------------------------------------- */

  /**
   * Read the log back into the shapes the relay needs at boot.
   *
   * * `messages`: chat.message rows within `retentionDays`, ascending by `at_ms` (ties by origin then offset), deduplicated
   *   by `message_id` -- the full original row, ready to seed `createFleetMessages({initialMessages})`. A message whose
   *   session carries a tombstone is **not** returned: deletion wins over any statement about the meaning of a timestamp.
   * * `readMarks`: one LWW winner per `(session_id, machine_id)`, within retention.
   * * `deletedSessions`: the tombstoned session ids (`string[]`, sorted) -- the relay applies a deletion by session id.
   *   Tombstones are **never** filtered by retention; they are what stops a re-import from resurrecting a deleted
   *   conversation. The newest deletion time stays in the log (`record.at_ms`) so a merge rule can compare it to a
   *   message timestamp if one is ever added.
   * * `stats`: same shape as `stats()`.
   *
   * Corrupt JSON lines are skipped. Real IO errors are thrown.
   */
  function load() {
    loadState();
    const { records } = readLog();
    seedAppliedFrom(records);
    cachedRecords = records;
    const cutoff = now() - retentionMs;

    const messageCandidates = [];
    const readWinners = new Map();
    const tombstoneWinners = new Map();
    for (const record of records) {
      if (record.kind === KIND_MESSAGE) {
        if (record.data.at_ms < cutoff) continue;
        messageCandidates.push(record);
      } else if (record.kind === KIND_READ) {
        if (record.data.at_ms < cutoff) continue;
        const key = `${record.data.session_id}\u0000${record.data.machine_id}`;
        const previous = readWinners.get(key);
        if (previous === undefined || isNewerAtMsCandidate(record, previous)) readWinners.set(key, record);
      } else if (record.kind === KIND_DELETED) {
        // Keyed by session so the newest tombstone wins; only the ids are returned, but keeping the winner deterministic
        // is what a future merge rule comparing a deletion time to a message time would need.
        const sessionId = record.data.session_id;
        const previous = tombstoneWinners.get(sessionId);
        if (previous === undefined || isNewerTombstone(record, previous)) tombstoneWinners.set(sessionId, record);
      }
    }

    messageCandidates.sort(compareMessageRecords);
    const seenMessageIds = new Set();
    const messages = [];
    for (const record of messageCandidates) {
      // The tombstone is the session's final state: filter here (not only at import) so a restart or a fresh node
      // that pulls the whole log cannot bring a deleted conversation back.
      if (tombstoneWinners.has(record.data.session_id)) continue;
      if (seenMessageIds.has(record.data.message_id)) continue;
      seenMessageIds.add(record.data.message_id);
      messages.push(cloneJson(record.data));
    }

    const readMarks = [...readWinners.values()]
      .map((record) => ({
        session_id: record.data.session_id,
        machine_id: record.data.machine_id,
        at_ms: record.data.at_ms,
        message_id: record.data.message_id ?? null,
      }))
      .sort((a, b) => compareStrings(a.session_id, b.session_id) || compareStrings(a.machine_id, b.machine_id));

    const deletedSessions = [...tombstoneWinners.keys()].sort(compareStrings);

    return {
      messages,
      readMarks,
      deletedSessions,
      stats: {
        generation,
        records: records.length,
        bytes: logBytes(),
        messages: messages.length,
        next_local_offset: nextLocalOffset,
      },
    };
  }

  /**
   * Persist a locally produced chat message. The whole fleet-messages row is stored verbatim (E2E ciphertext included);
   * this module never looks inside `text`/`enc`.
   *
   * @returns {object} the record that was appended, `{v, origin, offset, at_ms, kind, data}`
   */
  function appendMessage({ origin, message } = {}) {
    assertOrigin(origin);
    if (!isMessageData(message)) {
      throw new TypeError('appendMessage: message must carry message_id/session_id/machine_id/text and a finite at_ms');
    }
    ensureCache();
    const offset = reserveOffset(origin);
    const atMs = Number.isInteger(message.at_ms) ? message.at_ms : Math.floor(message.at_ms);
    return appendRecordLine({
      v: CHAT_RECORD_VERSION,
      origin,
      offset,
      at_ms: atMs,
      kind: KIND_MESSAGE,
      data: { ...message },
    });
  }

  /**
   * Persist a read watermark. The store does not decide which mark wins; it stores the fact and `load()` applies LWW.
   *
   * @returns {object} the appended record
   */
  function appendRead({ origin, session_id: sessionId, machine_id: machineId, at_ms: atMs, message_id: messageId } = {}) {
    assertOrigin(origin);
    if (!isNonEmptyString(sessionId)) throw new TypeError('appendRead: `session_id` must be a non-empty string');
    if (!isNonEmptyString(machineId)) throw new TypeError('appendRead: `machine_id` must be a non-empty string');
    const when = Number.isFinite(atMs) ? Math.floor(atMs) : Math.floor(now());
    if (messageId !== undefined && messageId !== null && typeof messageId !== 'string') {
      throw new TypeError('appendRead: `message_id` must be a string, null, or omitted');
    }
    ensureCache();
    const offset = reserveOffset(origin);
    return appendRecordLine({
      v: CHAT_RECORD_VERSION,
      origin,
      offset,
      at_ms: when,
      kind: KIND_READ,
      data: {
        session_id: sessionId,
        machine_id: machineId,
        at_ms: when,
        message_id: isNonEmptyString(messageId) ? messageId : null,
      },
    });
  }

  /**
   * Persist the tombstone that makes a deleted session's history disappear on every relay. Tombstones are retained by
   * `prune()` forever: deleting one would let a later sync bring the conversation back.
   *
   * @returns {object} the appended record
   */
  function appendSessionDeleted({ origin, session_id: sessionId } = {}) {
    assertOrigin(origin);
    if (!isNonEmptyString(sessionId)) throw new TypeError('appendSessionDeleted: `session_id` must be a non-empty string');
    ensureCache();
    const offset = reserveOffset(origin);
    return appendRecordLine({
      v: CHAT_RECORD_VERSION,
      origin,
      offset,
      at_ms: Math.floor(now()),
      kind: KIND_DELETED,
      data: { session_id: sessionId },
    });
  }

  /**
   * Read one page of the replication log from an absolute byte offset, in complete lines only.
   *
   * The page stops *before* a line that would push it past `maxBytes`; a single line larger than `maxBytes` is still
   * returned whole (never half a record). Malformed lines are skipped but their bytes are consumed, so corrupt data cannot
   * stall a peer's cursor forever. A cursor that lands mid-line (a corrupted cursor, not something this store produces) is
   * advanced to the next line boundary.
   *
   * @param {number} [fromOffset] absolute byte offset into `replication.jsonl`
   * @param {number} [maxBytes] plaintext byte budget for this page
   * @returns {{generation: number, records: object[], next_offset: number, eof: boolean, bytes: number}}
   */
  function exportSlice(fromOffset = 0, maxBytes = DEFAULT_CHAT_SLICE_BYTES) {
    loadState();
    const pageGeneration = generation;
    const cap = positiveBytesOr(maxBytes, DEFAULT_CHAT_SLICE_BYTES);
    let buf;
    try {
      buf = fs.readFileSync(logFile);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      const emptyOffset = Number.isInteger(fromOffset) && fromOffset >= 0 ? fromOffset : 0;
      return { generation: pageGeneration, records: [], next_offset: emptyOffset, eof: true, bytes: 0 };
    }

    let start = Number.isInteger(fromOffset) && fromOffset >= 0 ? fromOffset : 0;
    if (start > buf.length) {
      return { generation: pageGeneration, records: [], next_offset: start, eof: true, bytes: 0 };
    }
    if (start > 0 && start < buf.length && buf[start - 1] !== NEWLINE) {
      const nextLine = buf.indexOf(NEWLINE, start);
      if (nextLine < 0) return { generation: pageGeneration, records: [], next_offset: start, eof: false, bytes: 0 };
      start = nextLine + 1;
    }

    const records = [];
    let pos = start;
    let consumed = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(NEWLINE, pos);
      if (nl < 0) break; // trailing partial line: leave it for the next tick
      const lineEnd = nl + 1;
      const lineBytes = lineEnd - pos;
      if (consumed > 0 && consumed + lineBytes > cap) break;
      const line = buf.subarray(pos, nl).toString('utf8').trim();
      pos = lineEnd;
      consumed += lineBytes;
      if (line !== '') {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          record = null;
        }
        if (isChatRecord(record)) records.push(record);
      }
      if (consumed >= cap) break;
    }
    return {
      generation: pageGeneration,
      records,
      next_offset: pos,
      eof: pos >= buf.length,
      bytes: pos - start,
    };
  }

  /**
   * Apply one record pulled from a peer, exactly once.
   *
   * The watermark is `(origin, offset)` max-tracking, so applying a lower or equal offset is a no-op. An accepted record is
   * appended **as it arrived** -- same origin, same offset -- so this relay can serve it to the next node (design §4.1's
   * re-export). The log append happens before the watermark is persisted; a crash between the two may duplicate a log line,
   * which `load()`/`exportSlice()` collapse deterministically.
   *
   * @returns {{applied: boolean, generation: number}} `applied: false` for a duplicate or a non-conforming record
   */
  function importRecord(record) {
    loadState();
    ensureCache();
    if (!isChatRecord(record)) return { applied: false, generation };
    const previous = applied.get(record.origin);
    if (Number.isInteger(previous) && previous >= record.offset) return { applied: false, generation };
    appendRecordLine(record);
    writeJsonAtomic(appliedFile, appliedDoc());
    return { applied: true, generation };
  }

  /**
   * Retention + hard-cap compaction. Drops message/read records outside `retentionDays` (oldest first under the byte cap),
   * drops message records of tombstoned sessions (deletion is permanent; their bytes have no reader), keeps every
   * tombstone, keeps only the LWW read per `(session_id, machine_id)`, and rewrites the log atomically.
   *
   * The generation is bumped **only when the rewritten log actually differs** -- a periodic prune with nothing to remove is
   * a no-op, otherwise every peer would be forced to re-pull the whole log every sync round. `next_local_offset` never goes
   * backwards: local offsets must stay monotonic across compactions.
   *
   * @returns {{generation: number, removed_messages: number, removed_records: number, kept_records: number, bytes: number}}
   */
  function prune() {
    loadState();
    const { records, rawCount } = readLog();
    seedAppliedFrom(records);
    const cutoff = now() - retentionMs;

    // Read marks are LWW state: only the winning record per (session, machine) needs to survive.
    const readWinners = new Map();
    /** Sessions whose history was deleted: their message rows are dead bytes in the log. */
    const tombstonedSessions = new Set();
    for (const record of records) {
      if (record.kind === KIND_DELETED) tombstonedSessions.add(record.data.session_id);
      if (record.kind !== KIND_READ) continue;
      if (record.data.at_ms < cutoff) continue;
      const key = `${record.data.session_id}\u0000${record.data.machine_id}`;
      const previous = readWinners.get(key);
      if (previous === undefined || isNewerAtMsCandidate(record, previous)) readWinners.set(key, record);
    }

    let kept = [];
    let removedMessages = 0;
    let removedRecords = 0;
    for (const record of records) {
      if (record.kind === KIND_MESSAGE) {
        if (record.data.at_ms < cutoff || tombstonedSessions.has(record.data.session_id)) {
          removedMessages += 1;
          removedRecords += 1;
          continue;
        }
        kept.push(record);
      } else if (record.kind === KIND_READ) {
        const winner = readWinners.get(`${record.data.session_id}\u0000${record.data.machine_id}`);
        if (winner === undefined || winner !== record) {
          removedRecords += 1;
          continue;
        }
        kept.push(record);
      } else {
        // Tombstones are retained regardless of age: they are the only thing that stops resurrection.
        kept.push(record);
      }
    }

    // Hard cap: count the bytes the rewritten log would occupy, then drop messages oldest-first until it fits.
    const lineBytes = new Map();
    let projectedBytes = 0;
    for (const record of kept) {
      const size = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
      lineBytes.set(record, size);
      projectedBytes += size;
    }
    if (projectedBytes > hardCapBytes) {
      const removable = kept.filter((record) => record.kind === KIND_MESSAGE).sort(compareMessageRecords);
      const dropped = new Set();
      for (const record of removable) {
        if (projectedBytes <= hardCapBytes) break;
        dropped.add(record);
        projectedBytes -= lineBytes.get(record);
        removedMessages += 1;
        removedRecords += 1;
      }
      if (dropped.size > 0) kept = kept.filter((record) => !dropped.has(record));
    }

    const changed = removedRecords > 0 || rawCount > records.length;
    if (!changed) {
      cachedRecords = records;
      return {
        generation,
        removed_messages: 0,
        removed_records: 0,
        kept_records: records.length,
        bytes: logBytes(),
      };
    }

    // Bump the generation first: a crash before the log rewrite must make peers re-pull, never silently skip data.
    const nextGeneration = generation + 1;
    writeJsonAtomic(stateFile, { v: CHAT_RECORD_VERSION, generation: nextGeneration, next_local_offset: nextLocalOffset });
    generation = nextGeneration;
    writeLogAtomic(kept);
    cachedRecords = kept;
    return {
      generation,
      removed_messages: removedMessages,
      removed_records: removedRecords,
      kept_records: kept.length,
      bytes: logBytes(),
    };
  }

  /**
   * Occupancy counters for `/healthz`: never message content, never secrets.
   *
   * `messages` counts the distinct chat.message rows within the retention window (what `load().messages` returns; a
   * tombstoned session's rows are not counted); `records` counts distinct `(origin, offset)` records still in the log.
   */
  function stats() {
    loadState();
    const records = ensureCache();
    const cutoff = now() - retentionMs;
    const tombstonedSessions = new Set();
    for (const record of records) {
      if (record.kind === KIND_DELETED) tombstonedSessions.add(record.data.session_id);
    }
    const seenMessageIds = new Set();
    let messages = 0;
    for (const record of records) {
      if (record.kind !== KIND_MESSAGE) continue;
      if (record.data.at_ms < cutoff) continue;
      if (tombstonedSessions.has(record.data.session_id)) continue;
      if (seenMessageIds.has(record.data.message_id)) continue;
      seenMessageIds.add(record.data.message_id);
      messages += 1;
    }
    return {
      generation,
      records: records.length,
      bytes: logBytes(),
      messages,
      next_local_offset: nextLocalOffset,
    };
  }

  return {
    load,
    appendMessage,
    appendRead,
    appendSessionDeleted,
    exportSlice,
    importRecord,
    prune,
    stats,
    dir: chatDir,
    retentionDays,
    hardCapBytes,
    quota24hBytes,
  };
}

export default createChatStore;
