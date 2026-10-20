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

/** 100 MB per 24h per fleet (operator decision). */
export const QUOTA_24H_BYTES = 100 * 1024 * 1024;
/** Hard ceiling regardless of how much the 7-day window would allow. */
export const HARD_CAP_BYTES = 200 * 1024 * 1024;
/** Retention window used for the "keep the larger" comparison. */
export const RETENTION_DAYS = 7;
/** One message. Text is cheap; a 4 KiB cap keeps a single paste from eating the budget. */
export const MAX_MESSAGE_BYTES = 4 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{now?: () => number, quota24hBytes?: number, hardCapBytes?: number, retentionDays?: number,
 *          maxMessageBytes?: number}} [options]
 */
export function createFleetMessages(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
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
  let seq = 0;

  const all = () => {
    const out = [];
    for (const rows of sessions.values()) out.push(...rows);
    return out;
  };

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
      const ivOk = typeof rawEnc.iv === 'string' && rawEnc.iv.length > 0 && rawEnc.iv.length <= 64;
      const tagOk = typeof rawEnc.tag === 'string' && rawEnc.tag.length > 0 && rawEnc.tag.length <= 64;
      if (rawEnc.v !== 1 || rawEnc.alg !== 'aes-256-gcm' || !ivOk || !tagOk) return { ok: false, code: 'BAD_ENCRYPTION' };
      enc = { v: 1, alg: 'aes-256-gcm', iv: rawEnc.iv, tag: rawEnc.tag };
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
      message_id: 'msg-' + String(seq).padStart(6, '0'),
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
      at_ms: now(),
      bytes,
    };
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push(message);
    for (const listener of listeners) {
      if (listener.sessionId !== null && listener.sessionId !== sessionId) continue;
      try {
        // The event carries addressing and mentions so a listener can say "you were named"; it never carries the text.
        listener.fn({
          session_id: sessionId,
          message_id: message.message_id,
          machine_id: message.machine_id,
          at_ms: message.at_ms,
          to: message.to,
          ...(mentions.length === 0 ? {} : { mentions }),
        });
      }
      catch { /* a dead listener must not fail the write */ }
    }
    if (idempotencyKey !== null) {
      idempotency.set(sessionId + '\u0000' + idempotencyKey, message.message_id);
      if (idempotency.size > MAX_IDEMPOTENCY_KEYS) {
        const oldest = idempotency.keys().next().value;
        if (oldest !== undefined) idempotency.delete(oldest);
      }
    }

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

  /** Deleting a session deletes its history -- the operator's rule, not a side effect. */
  function deleteSession(sessionId) {
    return sessions.delete(sessionId);
  }

  /** @param {string|null} sessionId null subscribes to every session; returns the unsubscribe function. */
  function subscribe(sessionId, fn) {
    const listener = { sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null, fn };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { post, list, usage, limitBytes, deleteSession, subscribe, _sessions: sessions };
}
