/**
 * Fleet chat: plain-text messages scoped to a SESSION, with a byte budget.
 *
 * ## Why the session is the scope
 *
 * The operator's decision: messages belong to the conversation, like a group chat, and disappear with it. A machine that
 * joins or leaves a session changes who can read the flow, but never rewrites what was said -- and deleting the session
 * deletes the history, because keeping it would be a second, silently-growing store nobody asked for.
 *
 * ## The quota, as specified
 *
 * 100 MB per fleet per 24 hours is the baseline; when that is exceeded, the 7-day retention figure is compared and the
 * larger is kept, capped at 200 MB:
 *
 *     limit = min(hardCap, max(quota24h, used7d))
 *
 * A message over the limit is REFUSED with the current usage attached -- never silently dropped, and never accepted by
 * evicting somebody else's words. The relay is the only clock here: a client-chosen timestamp would let one machine
 * claim its messages are older than they are.
 *
 * ## Sharding is not this file
 *
 * This keeps the authoritative list in memory for the relay to serve and to shard out; distributing encrypted shards
 * across the fleet's machines is the next step and depends on this shape staying the same.
 */
import { randomBytes } from 'node:crypto';


/** 100 MB per 24h per fleet (operator decision). */
export const QUOTA_24H_BYTES = 100 * 1024 * 1024;
/** Hard ceiling regardless of how much the 7-day window would allow. */
export const HARD_CAP_BYTES = 200 * 1024 * 1024;
/** Retention window used for the "keep the larger" comparison. */
export const RETENTION_DAYS = 7;
/** One message. Text is cheap; a 4 KiB cap keeps a single paste from eating the budget. */
export const MAX_MESSAGE_BYTES = 4 * 1024;

/** The only cipher the relay accepts in an `enc` envelope (it never holds a key). */
const CHAT_ALG = 'aes-256-gcm';
/** AEAD v2: adds an AAD object binding the ciphertext to session/machine/message id. */
const CHAT_ENC_V2 = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{now?: () => number, quota24hBytes?: number, hardCapBytes?: number, retentionDays?: number,
 *          maxMessageBytes?: number, epoch?: string, initialMessages?: object[], onAppend?: (message: object) => void,
 *          onDelete?: (sessionId: string) => void, onImported?: (message: object) => void}} [options]
 *   Phase 2A additions (all optional, all additive):
 *   `initialMessages` seeds restored rows at construction (restart recovery); `onAppend`/`onDelete`/`onImported` are the
 *   persistence hooks the relay wires to `chat-store.mjs`. A hook is synchronous and its exception can never change what
 *   chat does -- a full disk must not fail a message that is already in memory.
 */
export function createFleetMessages(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /**
   * v1.2.8: the relay's message sequence resets on restart, so a bare `msg-000001` names a DIFFERENT message after every
   * restart. Clients persist message ids -- an open turn, a read watermark, a reply_to -- and a reused id makes a new message
   * settle an old turn with the wrong state. The epoch is random per process, so ids are unique across restarts without a
   * persisted counter, and old clients that render ids verbatim keep working.
   */
  const epoch = typeof options.epoch === 'string' && options.epoch !== ''
    ? options.epoch
    : randomBytes(3).toString('hex');
  const quota24hBytes = Number.isInteger(options.quota24hBytes) ? options.quota24hBytes : QUOTA_24H_BYTES;
  const hardCapBytes = Number.isInteger(options.hardCapBytes) ? options.hardCapBytes : HARD_CAP_BYTES;
  const retentionDays = Number.isInteger(options.retentionDays) ? options.retentionDays : RETENTION_DAYS;
  const maxMessageBytes = Number.isInteger(options.maxMessageBytes) ? options.maxMessageBytes : MAX_MESSAGE_BYTES;

  /**
   * Notification subscribers. An event carries NO text: the notification says "there is something new to read", and the
   * reader fetches the text through the endpoint that already authenticates them. Putting the text in a broadcast would
   * send every message to every connected listener regardless of session membership.
   */
  const listeners = new Set();
  /**
   * v1.2.5 idempotency: (session, key) -> message_id. A sender that retries after a lost response must not post the text twice,
   * and the answer to a replay is the FIRST message -- a second row would make the same sentence appear twice in the thread.
   */
  const idempotency = new Map();
  const MAX_IDEMPOTENCY_KEYS = 2000;
  /** session_id -> [{ message_id, session_id, machine_id, text, at_ms, bytes }] */
  const sessions = new Map();
  /** message_id -> the same row, so dedupe on import and lookup by id never scan the whole history. */
  const messageIds = new Map();
  let seq = 0;

  /**
   * Phase 2A persistence hooks. Options, not imports: `fleet-messages.mjs` stays the in-memory chat and does not depend on
   * a disk existing. Each hook is wrapped so its failure cannot change a chat result -- but the store behind it reports its
   * own IO errors, so nothing is silently lost twice.
   */
  const onAppend = typeof options.onAppend === 'function' ? options.onAppend : null;
  const onDelete = typeof options.onDelete === 'function' ? options.onDelete : null;
  const onImported = typeof options.onImported === 'function' ? options.onImported : null;

  const all = () => {
    const out = [];
    for (const rows of sessions.values()) out.push(...rows);
    return out;
  };

  const bytesOf = (message) => (Number.isInteger(message.bytes) && message.bytes >= 0
    ? message.bytes
    : Buffer.byteLength(typeof message.text === 'string' ? message.text : '', 'utf8'));

  function safelyInvoke(hook, ...args) {
    if (hook === null) return;
    try { hook(...args); } catch { /* a persistence hook must never change what chat does */ }
  }

  /**
   * Tell subscribers that a message exists. The event carries addressing and mentions -- never the text: the reader fetches
   * the text through the endpoint that already authenticated it.
   */
  function notifyListeners(message) {
    const mentions = Array.isArray(message.mentions) ? message.mentions.filter((entry) => typeof entry === 'string') : [];
    for (const listener of listeners) {
      if (listener.sessionId !== null && listener.sessionId !== message.session_id) continue;
      try {
        listener.fn({
          session_id: message.session_id,
          message_id: message.message_id,
          machine_id: message.machine_id,
          at_ms: message.at_ms,
          to: message.to ?? 'all',
          ...(mentions.length === 0 ? {} : { mentions }),
        });
      }
      catch { /* a dead listener must not fail the write */ }
    }
  }

  /**
   * A restored row must be safe to serve: reject shapes that `list()`/`usage()` would crash on. Bytes are recomputed only
   * when missing, so a restored row keeps the exact shape it was persisted with.
   */
  function normalizeSeed(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.message_id !== 'string' || raw.message_id === '') return null;
    if (typeof raw.session_id !== 'string' || raw.session_id === '') return null;
    if (typeof raw.machine_id !== 'string' || raw.machine_id === '') return null;
    if (!Number.isFinite(raw.at_ms) || typeof raw.text !== 'string') return null;
    return { ...raw, bytes: bytesOf(raw) };
  }

  /**
   * If a restored id was minted in THIS process's epoch (only possible when `epoch` was supplied explicitly), continue the
   * counter after it: otherwise a restart would hand out an id a restored message already owns.
   */
  function advanceSeqPast(messageId) {
    const prefix = 'msg-' + epoch + '-';
    if (!messageId.startsWith(prefix)) return;
    const parsed = Number.parseInt(messageId.slice(prefix.length), 10);
    if (Number.isInteger(parsed) && parsed > seq) seq = parsed;
  }

  function usage() {
    const t = now();
    const day = all().filter((m) => t - m.at_ms <= DAY_MS);
    const week = all().filter((m) => t - m.at_ms <= retentionDays * DAY_MS);
    const sum = (rows) => rows.reduce((total, m) => total + m.bytes, 0);
    return { used_24h_bytes: sum(day), used_retention_bytes: sum(week), messages: all().length };
  }

  function limitBytes() {
    const { used_retention_bytes: week } = usage();
    return Math.min(hardCapBytes, Math.max(quota24hBytes, week));
  }

  /**
   * @param {{session_id: string, fleet_id?: string|null, machine_id: string, text: string}} input
   * @returns {{ok: true, message: object} | {ok: false, code: string, detail?: object}}
   */
  function post(input) {
    const sessionId = typeof input?.session_id === 'string' ? input.session_id.trim() : '';
    if (sessionId === '') return { ok: false, code: 'BAD_SESSION' };
    const machineId = typeof input?.machine_id === 'string' ? input.machine_id.trim() : '';
    if (machineId === '') return { ok: false, code: 'BAD_MACHINE' };
    // v1.9.18: chat carries text and slash-command text only; images never travel over the relay.
    const MEDIA_FIELDS = ['image', 'image_url', 'image_base64', 'image_bytes', 'picture', 'photo', 'thumb', 'thumbnail', 'attachment', 'attachments', 'file', 'files', 'data', 'base64', 'blob', 'binary', 'buffer', 'media', 'sticker_image', 'sticker_data', 'gif', 'png', 'jpeg', 'webp'];
    const mediaField = Object.keys(input ?? {}).find((key) => MEDIA_FIELDS.includes(key.toLowerCase()));
    if (mediaField !== undefined) return { ok: false, code: 'CHAT_FIELD_FORBIDDEN', detail: { field: mediaField } };
    if (typeof input?.text !== 'string') return { ok: false, code: 'NOT_TEXT' };
    const text = input.text;
    if (text.trim() === '') return { ok: false, code: 'EMPTY_TEXT' };
    // Reject control characters (except tab/newline): "plain text" is a contract, not a preference.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return { ok: false, code: 'NOT_TEXT' };
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxMessageBytes) return { ok: false, code: 'MESSAGE_TOO_LARGE', detail: { bytes, maxBytes: maxMessageBytes } };

    // Addressing: 'all' is the group, a machine id is one recipient. ONE row either way -- N copies for N recipients
    // would multiply the byte budget by the fleet size for no extra meaning; visibility is a filter at read time.
    const to = typeof input?.to === 'string' && input.to.trim() !== '' ? input.to.trim() : 'all';
    if (to !== 'all' && (to.length > 64 || /\s/.test(to))) return { ok: false, code: 'BAD_ADDRESS' };
    // Correlation: a thread groups a conversation, reply_to points at the message being answered, turn orders the
    // exchange inside one thread. Plain fields, validated rather than trusted.
    /**
     * v1.2.6 end-to-end encryption: the relay carries the ciphertext and its metadata, and never a key. It validates the SHAPE
     * because a malformed envelope would be stored and later fail on every reader; it cannot check the content, and that is the
     * point -- which also means it cannot search messages or know their real length.
     */
    const rawEnc = input?.enc;
    let enc = null;
    if (rawEnc !== undefined && rawEnc !== null) {
      if (typeof rawEnc !== 'object' || Array.isArray(rawEnc)) return { ok: false, code: 'BAD_ENCRYPTION' };
      const ivOk = typeof rawEnc.iv === 'string' && rawEnc.iv.length > 0 && rawEnc.iv.length <= 64;
      const tagOk = typeof rawEnc.tag === 'string' && rawEnc.tag.length > 0 && rawEnc.tag.length <= 64;
      if (rawEnc.alg !== CHAT_ALG || !ivOk || !tagOk) return { ok: false, code: 'BAD_ENCRYPTION' };
      if (rawEnc.v === 1) {
        enc = { v: 1, alg: CHAT_ALG, iv: rawEnc.iv, tag: rawEnc.tag };
      } else if (rawEnc.v === CHAT_ENC_V2) {
        // AEAD v2 binds the ciphertext to its context. The AAD travels in the clear so every
        // reader can rebuild it, and the GCM tag authenticates those exact bytes. The relay knows
        // session_id/machine_id, so it refuses clear AAD naming another session or machine; it never
        // sees a key and never inspects the ciphertext.
        const aad = rawEnc.aad;
        if (aad === null || typeof aad !== 'object' || Array.isArray(aad)) return { ok: false, code: 'CHAT_AAD_MISSING' };
        const aadSession = typeof aad.session_id === 'string' ? aad.session_id : '';
        const aadMachine = typeof aad.machine_id === 'string' ? aad.machine_id : '';
        const aadMessage = typeof aad.message_id === 'string' ? aad.message_id : '';
        if (aadSession !== sessionId || aadMachine !== machineId) return { ok: false, code: 'CHAT_AAD_MISMATCH' };
        // eslint-disable-next-line no-control-regex
        if (aadMessage === '' || aadMessage.length > 64 || /[\u0000-\u001F]/.test(aadMessage)) return { ok: false, code: 'CHAT_AAD_INVALID' };
        enc = { v: CHAT_ENC_V2, alg: CHAT_ALG, iv: rawEnc.iv, tag: rawEnc.tag, aad: { session_id: aadSession, machine_id: aadMachine, message_id: aadMessage } };
      } else {
        return { ok: false, code: 'BAD_ENCRYPTION' };
      }
    }

    // v1.9.18: a plain-text message may not smuggle an image payload. Encrypted text is exempt:
    // it is base64 ciphertext by design and the relay cannot (and must not) inspect it.
    if (enc === null) {
      if (/data:(?:image|video|audio)\//i.test(text) || /!\[[^\]]*\]\(/i.test(text)) {
        return { ok: false, code: 'TEXT_IMAGE_FORBIDDEN' };
      }
      const block = text.match(/[A-Za-z0-9+/]{256,}={0,2}/);
      if (block !== null) {
        try {
          const head = Buffer.from(block[0].slice(0, 32), 'base64');
          const magic = head.slice(0, 4).toString('latin1');
          if ((head[0] === 0x89 && head.slice(1, 4).toString('latin1') === 'PNG') || (head[0] === 0xff && head[1] === 0xd8) || magic.startsWith('GIF8') || magic.startsWith('RIFF')) {
            return { ok: false, code: 'TEXT_BINARY_FORBIDDEN' };
          }
        } catch { /* not base64 that matters */ }
      }
    }

    // v1.2.5 idempotency: replay the first message instead of storing the text twice.
    const idempotencyKey = typeof input?.idempotency_key === 'string' && input.idempotency_key.trim() !== ''
      ? input.idempotency_key.trim().slice(0, 64)
      : null;
    if (idempotencyKey !== null) {
      const seenId = idempotency.get(sessionId + '\u0000' + idempotencyKey) ?? null;
      if (seenId !== null) {
        const known = (sessions.get(sessionId) ?? []).find((entry) => entry.message_id === seenId) ?? null;
        if (known !== null) return { ok: true, message: { ...known }, deduped: true };
      }
    }

    // v1.2.5 mentions: names to alert, validated as a small set. The message still has ONE row; a mention is a notification
    // hint, not a delivery mechanism.
    const rawMentions = input?.mentions;
    let mentions = [];
    if (rawMentions !== undefined && rawMentions !== null) {
      if (!Array.isArray(rawMentions) || rawMentions.length > 10) return { ok: false, code: 'BAD_MENTIONS' };
      for (const entry of rawMentions) {
        if (typeof entry !== 'string' || entry === '' || entry.length > 64 || /\s/.test(entry)) return { ok: false, code: 'BAD_MENTIONS' };
      }
      mentions = [...new Set(rawMentions)];
    }

    // v1.2.7: a reply can be an ANSWER or a REFUSAL, and the difference is a state, not a wording. Validated here so the
    // turn state machine reads the sender's own word instead of guessing from text.
    const replyState = input?.reply_state === undefined || input?.reply_state === null ? null : input.reply_state;
    if (replyState !== null && replyState !== 'answered' && replyState !== 'refused') return { ok: false, code: 'BAD_REPLY_STATE' };

    const threadId = typeof input?.thread_id === 'string' && input.thread_id.trim() !== ''
      ? input.thread_id.trim().slice(0, 64)
      : null;
    const replyTo = typeof input?.reply_to === 'string' && input.reply_to.trim() !== '' ? input.reply_to.trim() : null;

    const before = usage();
    const limit = limitBytes();
    if (before.used_24h_bytes + bytes > limit) {
      return { ok: false, code: 'FLEET_QUOTA_EXCEEDED', detail: { used_24h_bytes: before.used_24h_bytes, limit_bytes: limit, bytes } };
    }

    // A reply must point at something that exists in the SAME session: a dangling reply_to makes a thread unreadable.
    const existing = sessions.get(sessionId) ?? [];
    if (replyTo !== null && !existing.some((m) => m.message_id === replyTo)) {
      return { ok: false, code: 'REPLY_TARGET_MISSING', detail: { reply_to: replyTo } };
    }
    const threadOf = threadId ?? (replyTo !== null ? (existing.find((m) => m.message_id === replyTo)?.thread_id ?? null) : null);
    const turn = existing.filter((m) => (threadOf === null ? m.thread_id === null : m.thread_id === threadOf)).length + 1;

    seq += 1;
    const message = {
      message_id: 'msg-' + epoch + '-' + String(seq).padStart(6, '0'),
      session_id: sessionId,
      fleet_id: typeof input?.fleet_id === 'string' ? input.fleet_id : null,
      machine_id: machineId,
      to,
      thread_id: threadOf,
      reply_to: replyTo,
      turn,
      text,
      // Omitted when empty so a message without mentions keeps the pre-1.2.5 shape.
      ...(mentions.length === 0 ? {} : { mentions }),
      // v1.2.6: ciphertext metadata travels beside the text so an old client can read it as opaque text and a new one can name
      // the cipher it does not have a key for.
      ...(enc === null ? {} : { enc }),
      ...(idempotencyKey === null ? {} : { idempotency_key: idempotencyKey }),
      ...(replyState === null ? {} : { reply_state: replyState }),
      at_ms: now(),
      bytes,
    };
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push(message);
    messageIds.set(message.message_id, message);
    notifyListeners(message);
    if (idempotencyKey !== null) {
      idempotency.set(sessionId + '\u0000' + idempotencyKey, message.message_id);
      if (idempotency.size > MAX_IDEMPOTENCY_KEYS) {
        const oldest = idempotency.keys().next().value;
        if (oldest !== undefined) idempotency.delete(oldest);
      }
    }
    // Phase 2A: persist the accepted row (never a replay -- the first post already persisted it).
    safelyInvoke(onAppend, message);

    return { ok: true, message };
  }

  /** Read one session's flow. \`since_ms\` is exclusive; the order is the order it was said. */
  function list({ session_id: sessionId, since_ms: sinceMs = null, limit = 50, for_machine_id: forMachine = null,
    thread_id: threadId = null, to: toFilter = null } = {}) {
    const rows = sessions.get(sessionId) ?? [];
    let filtered = Number.isFinite(sinceMs) ? rows.filter((m) => m.at_ms > sinceMs) : rows;
    // A reader sees the group and what was addressed to it, never another machine's private message.
    if (typeof forMachine === 'string' && forMachine !== '') {
      filtered = filtered.filter((m) => (m.to ?? 'all') === 'all' || m.to === forMachine || m.machine_id === forMachine);
    }
    if (typeof threadId === 'string' && threadId !== '') filtered = filtered.filter((m) => m.thread_id === threadId);
    if (typeof toFilter === 'string' && toFilter !== '') filtered = filtered.filter((m) => (m.to ?? 'all') === toFilter);
    const capped = filtered.slice(-Math.max(1, Math.min(limit, 200)));
    return { ok: true, messages: capped.map((m) => ({ ...m })), count: capped.length };
  }

  /**
   * Phase 2A: insert a message another relay accepted (design §4.3 `chat.message` union, keyed by `message_id`).
   *
   * **No quota check, on purpose.** §5.1: an imported message is not checked against the local quota, otherwise one
   * relay's full budget would block another relay's writes. Retention and the byte cap are enforced by `pruneBefore`.
   * The row keeps its shape and is placed in `at_ms` order so a page applied out of order still reads as a conversation.
   *
   * @returns {{ok: true, inserted: boolean} | {ok: false, code: string}}
   */
  function insertImported(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'BAD_MESSAGE' };
    const messageId = typeof raw.message_id === 'string' ? raw.message_id.trim() : '';
    if (messageId === '') return { ok: false, code: 'BAD_MESSAGE_ID' };
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
    if (sessionId === '') return { ok: false, code: 'BAD_SESSION' };
    const machineId = typeof raw.machine_id === 'string' ? raw.machine_id.trim() : '';
    if (machineId === '') return { ok: false, code: 'BAD_MACHINE' };
    if (!Number.isFinite(raw.at_ms)) return { ok: false, code: 'BAD_AT_MS' };
    if (typeof raw.text !== 'string') return { ok: false, code: 'NOT_TEXT' };
    // The same message can arrive from every peer; a second copy is a no-op, not a duplicate row.
    if (messageIds.has(messageId)) return { ok: true, inserted: false };

    const message = {
      ...raw,
      message_id: messageId,
      session_id: sessionId,
      machine_id: machineId,
      at_ms: Math.floor(raw.at_ms),
      bytes: bytesOf(raw),
    };
    const rows = sessions.get(sessionId) ?? [];
    let at = rows.length;
    while (at > 0 && rows[at - 1].at_ms > message.at_ms) at -= 1;
    rows.splice(at, 0, message);
    sessions.set(sessionId, rows);
    messageIds.set(messageId, message);
    notifyListeners(message);
    safelyInvoke(onImported, { ...message });
    return { ok: true, inserted: true };
  }

  /**
   * Phase 2A retention: drop messages older than `cutoffMs`, then (when `maxBytes` is given) keep dropping the oldest
   * remaining messages until the stored byte total fits. Sessions emptied by pruning disappear; a session tombstone is a
   * separate decision made by `deleteSession`/the replication store.
   *
   * @returns {{removed: number}}
   */
  function pruneBefore(cutoffMs, { maxBytes } = {}) {
    const cutoff = Number.isFinite(cutoffMs) ? cutoffMs : 0;
    let removed = 0;
    const removedIds = new Set();
    for (const [sessionId, rows] of sessions) {
      const kept = rows.filter((m) => m.at_ms >= cutoff);
      if (kept.length === rows.length) continue;
      for (const m of rows) {
        if (m.at_ms < cutoff) removedIds.add(m.message_id);
      }
      removed += rows.length - kept.length;
      if (kept.length === 0) sessions.delete(sessionId);
      else sessions.set(sessionId, kept);
    }
    if (Number.isFinite(maxBytes) && maxBytes >= 0) {
      const entries = [];
      let total = 0;
      for (const [sessionId, rows] of sessions) {
        for (const m of rows) {
          const bytes = bytesOf(m);
          total += bytes;
          entries.push({ sessionId, message: m, bytes });
        }
      }
      if (total > maxBytes) {
        // Oldest first, then a deterministic tie-break, so every relay prunes the same rows.
        entries.sort((a, b) => (a.message.at_ms - b.message.at_ms)
          || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
          || (a.message.message_id < b.message.message_id ? -1 : a.message.message_id > b.message.message_id ? 1 : 0));
        const dropped = new Set();
        for (const entry of entries) {
          if (total <= maxBytes) break;
          total -= entry.bytes;
          dropped.add(entry.message);
          removedIds.add(entry.message.message_id);
          removed += 1;
        }
        if (dropped.size > 0) {
          for (const [sessionId, rows] of sessions) {
            const kept = rows.filter((m) => !dropped.has(m));
            if (kept.length === rows.length) continue;
            if (kept.length === 0) sessions.delete(sessionId);
            else sessions.set(sessionId, kept);
          }
        }
      }
    }
    for (const id of removedIds) messageIds.delete(id);
    return { removed };
  }

  /** One message by id, or null. Phase 2A diagnostics/tests. */
  function findMessage(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return null;
    const message = messageIds.get(messageId);
    return message === undefined ? null : { ...message };
  }

  /** The session ids currently held, in first-seen order. Phase 2A diagnostics/tests. */
  function getSessionIds() {
    return [...sessions.keys()];
  }

  /** Deleting a session deletes its history -- the operator's rule, not a side effect. Phase 2A also records the tombstone. */
  function deleteSession(sessionId) {
    const rows = sessions.get(sessionId);
    if (!sessions.delete(sessionId)) return false;
    if (rows !== undefined) {
      for (const message of rows) messageIds.delete(message.message_id);
    }
    safelyInvoke(onDelete, sessionId);
    return true;
  }

  /** @param {string|null} sessionId null subscribes to every session; returns the unsubscribe function. */
  function subscribe(sessionId, fn) {
    const listener = { sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null, fn };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Phase 2A restart recovery: seed rows restored from `chat-store.load()`, preserving the given order exactly.
  for (const raw of Array.isArray(options.initialMessages) ? options.initialMessages : []) {
    const message = normalizeSeed(raw);
    if (message === null || messageIds.has(message.message_id)) continue;
    if (!sessions.has(message.session_id)) sessions.set(message.session_id, []);
    sessions.get(message.session_id).push(message);
    messageIds.set(message.message_id, message);
    advanceSeqPast(message.message_id);
  }

  return {
    post,
    list,
    usage,
    limitBytes,
    deleteSession,
    subscribe,
    insertImported,
    pruneBefore,
    findMessage,
    getSessionIds,
    _sessions: sessions,
  };
}
