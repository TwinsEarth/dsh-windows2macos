/**
 * Open questions and their answers, on disk.
 *
 * ## Why a file, when the answer also arrives by chat
 *
 * An `await` that is answered while the asking process is being restarted has to survive the restart: the question is still
 * the machine's question, and the answer is still an answer. Keeping the state in memory made the outcome depend on uptime.
 *
 * ## The two states that are easy to get wrong
 *
 * - **timeout is not final.** A late answer is recorded as `answered_after_timeout` rather than overwriting the timeout or
 *   being dropped: the operator asked, something answered, and when it answered is a fact worth keeping.
 * - **a settled question is never reopened.** `settle` on a decided ask returns the existing record with `settled: false`, so
 *   two replies cannot race into one slot.
 *
 * Records are appended as JSON lines; `compact` rewrites atomically through a temporary file, which is the only writer of the
 * whole file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ASK_STATE = Object.freeze(['open', 'answered', 'refused', 'timeout', 'answered_after_timeout']);

/** The states that are still waiting for something. */
export const OPEN_STATES = Object.freeze(['open']);

/**
 * @param {{now?: () => number, maxRecords?: number}} [options]
 */
export function createAskStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0 ? options.maxRecords : 2_000;
  /** ask_id -> record */
  const asks = new Map();
  let seq = 0;
  const file = typeof options.stateDir === 'string' && options.stateDir !== ''
    ? join(options.stateDir, 'ask-store.jsonl')
    : null;

  /**
   * Load whatever a previous process wrote. A malformed line is skipped rather than fatal: an unfinished write is the
   * expected shape of a crash, and losing the whole store over the last line would be worse than losing the line.
   */
  if (file !== null) {
    try {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try { const record = JSON.parse(line); if (typeof record?.ask_id === 'string') asks.set(record.ask_id, record); } catch { /* one bad line */ }
      }
    } catch { /* no store yet */ }
  }

  /** Rewrite the file atomically: a reader never sees half a record. */
  function persist() {
    if (file === null) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const body = exportAll().map((record) => JSON.stringify(record)).join('\n') + '\n';
      const temporary = file + '.tmp';
      writeFileSync(temporary, body, 'utf8');
      renameSync(temporary, file);
    } catch { /* the in-memory store is still correct; persistence is best effort and says so by not throwing */ }
  }

  function openAsk(input = {}) {
    const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null;
    const messageId = typeof input.messageId === 'string' && input.messageId !== '' ? input.messageId : null;
    if (sessionId === null || messageId === null) return { ok: false, code: 'ASK_BAD_INPUT' };
    const askId = 'ask_' + (++seq) + '_' + now();
    const record = {
      ask_id: askId,
      session_id: sessionId,
      message_id: messageId,
      thread_id: typeof input.threadId === 'string' ? input.threadId : null,
      to: typeof input.to === 'string' ? input.to : null,
      opened_at_ms: now(),
      deadline_ms: now() + (Number.isFinite(input.timeoutMs) ? Math.max(1, input.timeoutMs) : 60_000),
      state: 'open',
      reply_message_id: null,
      settled_at_ms: null,
    };
    asks.set(askId, record);
    trim();
    persist();
    return { ok: true, ask: { ...record } };
  }

  function settle(askId, state, reply = {}) {
    const record = asks.get(askId) ?? null;
    if (record === null) return { ok: false, code: 'ASK_UNKNOWN', detail: { askId } };
    if (!ASK_STATE.includes(state) || state === 'open') return { ok: false, code: 'ASK_BAD_STATE', detail: { state } };
    if (record.state !== 'open' && record.state !== 'timeout') {
      return { ok: true, ask: { ...record }, settled: false };
    }
    // A reply after the deadline is recorded as such: "answered late" and "answered" are different facts.
    const late = record.state === 'timeout';
    record.state = late ? 'answered_after_timeout' : state;
    record.reply_message_id = typeof reply.messageId === 'string' ? reply.messageId : null;
    record.settled_at_ms = now();
    persist();
    return { ok: true, ask: { ...record }, settled: true };
  }

  function expire(askId) {
    const record = asks.get(askId) ?? null;
    if (record === null) return { ok: false, code: 'ASK_UNKNOWN', detail: { askId } };
    if (record.state !== 'open') return { ok: true, ask: { ...record }, expired: false };
    record.state = 'timeout';
    record.settled_at_ms = now();
    persist();
    return { ok: true, ask: { ...record }, expired: true };
  }

  function expireDue() {
    const due = [];
    for (const record of asks.values()) {
      if (record.state === 'open' && record.deadline_ms <= now()) {
        record.state = 'timeout';
        record.settled_at_ms = now();
        due.push(record.ask_id);
      }
    }
    if (due.length > 0) persist();
    return { ok: true, expired: due };
  }

  /** @param {{state?: string, sessionId?: string}} [filter] */
  function list(filter = {}) {
    const wanted = typeof filter.state === 'string' ? filter.state : null;
    const session = typeof filter.sessionId === 'string' ? filter.sessionId : null;
    return {
      ok: true,
      asks: [...asks.values()]
        .filter((record) => (wanted === null || record.state === wanted) && (session === null || record.session_id === session))
        .sort((a, b) => a.opened_at_ms - b.opened_at_ms)
        .map((record) => ({ ...record })),
    };
  }

  function restore(records) {
    const restored = [];
    for (const record of Array.isArray(records) ? records : []) {
      const askId = typeof record?.ask_id === 'string' ? record.ask_id : null;
      if (askId === null || !ASK_STATE.includes(record.state)) continue;
      asks.set(askId, { ...record });
      restored.push(askId);
    }
    persist();
    return { ok: true, restored: restored.length };
  }

  /** The records that survive a restart, oldest first. */
  function exportAll() {
    return [...asks.values()].sort((a, b) => a.opened_at_ms - b.opened_at_ms).map((record) => ({ ...record }));
  }

  function trim() {
    while (asks.size > maxRecords) {
      const oldest = [...asks.values()].sort((a, b) => a.opened_at_ms - b.opened_at_ms)[0];
      if (oldest === undefined) return;
      asks.delete(oldest.ask_id);
    }
  }

  return { openAsk, settle, expire, expireDue, list, restore, exportAll, _asks: asks };
}
