/**
 * Turns inside a thread, derived from the messages themselves.
 *
 * The relay assigns `turn` when it stores a message, so the only thing this module does is check that the sequence it
 * receives is usable: a reader that trusts client timestamps for ordering shows answers above questions. When a message has
 * no turn, it inherits the previous one so a machine writing plain chat does not split every message into its own turn.
 */
/**
 * @param {Array<{message_id?: string, thread_id?: string|null, turn?: number, at_ms?: number, text?: string}>} messages
 * @returns {{threads: Array<{thread_id: string|null, turns: Array<{turn: number, messages: object[]}>}>}}
 */
export function deriveTurns(messages = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const byThread = new Map();
  let inferred = 0;
  for (const message of list) {
    const threadId = typeof message?.thread_id === 'string' && message.thread_id !== '' ? message.thread_id : null;
    if (!byThread.has(threadId)) byThread.set(threadId, []);
    let turn = Number.isInteger(message?.turn) ? message.turn : null;
    if (turn === null) {
      const history = byThread.get(threadId);
      const last = history[history.length - 1] ?? null;
      turn = last === null ? 1 : last.turn;
      inferred += 1;
    }
    byThread.get(threadId).push({ message, turn });
  }
  const threads = [...byThread.entries()].map(([threadId, entries]) => {
    const turns = [];
    for (const entry of entries) {
      const last = turns[turns.length - 1] ?? null;
      if (last !== null && last.turn === entry.turn) { last.messages.push(entry.message); continue; }
      turns.push({ turn: entry.turn, messages: [entry.message] });
    }
    // Turns are reported in the order the relay assigned them, never the order the list happened to arrive in.
    turns.sort((a, b) => a.turn - b.turn);
    return { thread_id: threadId, turns };
  });
  threads.sort((a, b) => String(a.thread_id ?? '').localeCompare(String(b.thread_id ?? '')));
  return { threads, inferred_turns: inferred };
}
