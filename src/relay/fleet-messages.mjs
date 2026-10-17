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
    // Control characters are the thing being rejected here, so the rule that forbids them in a pattern
    // does not apply -- the escape IS the contract.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return { ok: false, code: 'NOT_TEXT' };
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxMessageBytes) return { ok: false, code: 'MESSAGE_TOO_LARGE', detail: { bytes, maxBytes: maxMessageBytes } };

    const before = usage();
    const limit = limitBytes();
    if (before.used_24h_bytes + bytes > limit) {
      return { ok: false, code: 'FLEET_QUOTA_EXCEEDED', detail: { used_24h_bytes: before.used_24h_bytes, limit_bytes: limit, bytes } };
    }

    seq += 1;
    const message = {
      message_id: 'msg-' + String(seq).padStart(6, '0'),
      session_id: sessionId,
      fleet_id: typeof input?.fleet_id === 'string' ? input.fleet_id : null,
      machine_id: machineId,
      text,
      at_ms: now(),
      bytes,
    };
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push(message);
    for (const listener of listeners) {
      if (listener.sessionId !== null && listener.sessionId !== sessionId) continue;
      try { listener.fn({ session_id: sessionId, message_id: message.message_id, machine_id: message.machine_id, at_ms: message.at_ms }); }
      catch { /* a dead listener must not fail the write */ }
    }
    return { ok: true, message };
  }

  /** Read one session's flow. \`since_ms\` is exclusive; the order is the order it was said. */
  function list({ session_id: sessionId, since_ms: sinceMs = null, limit = 50 } = {}) {
    const rows = sessions.get(sessionId) ?? [];
    const filtered = Number.isFinite(sinceMs) ? rows.filter((m) => m.at_ms > sinceMs) : rows;
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
