/**
 * Relay state — event ring buffer, SSE sequence allocation and replay.
 *
 * Split out of `state.mjs` (P1 refactor slice S5). Every function takes the owning
 * `RabbitState` as its first argument: the state remains owned by the facade (one copy of
 * every field), and this module only operates on it. No module-level mutable state, no
 * timers, no network, no filesystem — the behaviour is the same code as before the split.
 */
export function nextSeq(state) { state.seq += 1; return state.seq; }

/** Reserve a seq WITHOUT buffering (used for the per-connection `ready` frame). */
export function reserveSeq(state) { return state.nextSeq(); }

export function onEvent(state, listener) {
  state._listeners.add(listener);
  return () => state._listeners.delete(listener);
}

/**
 * Emit an event: allocates the next global seq, buffers it (ring of N) and
 * notifies subscribers. `target` is the machine_id the event is addressed to
 * (null = broadcast). The target is NOT serialized except as `machine_id`.
 */
export function emit(state, type, fields = {}, opts = {}) {
  const target = opts.target ?? null;
  const seq = state.nextSeq();
  const event = {
    type,
    seq,
    rabbit_time: state.nowIso(),
    ...(target ? { machine_id: target } : {}),
    ...fields,
  };
  const entry = { seq, event, target };
  state.buffer.push(entry);
  if (state.buffer.length > state.eventBufferSize) {
    state.buffer.splice(0, state.buffer.length - state.eventBufferSize);
  }
  for (const listener of state._listeners) {
    try { listener(entry); } catch { /* subscriber errors must never break state */ }
  }
  return event;
}

export function oldestBufferedSeq(state) { return state.buffer.length ? state.buffer[0].seq : state.seq + 1; }
/**
 * Highest seq present in the replay ring (0 when empty).
 *
 * Deliberately different from `lastSeq()`: `ready` frames allocate seq numbers
 * without being buffered, so `lastSeq()` can run ahead of anything a client can
 * actually replay. Diagnostics that describe the REPLAY WINDOW must use this one.
 */
export function lastBufferedSeq(state) { return state.buffer.length ? state.buffer[state.buffer.length - 1].seq : 0; }
export function lastSeq(state) { return state.seq; }

/** Replay entries with seq >= from (used by GET /v1/stream?seq=|Last-Event-ID). */
export function replayEntries(state, from) {
  return state.buffer.filter((e) => e.seq >= from);
}

export function eventsSince(state, from) { return state.replayEntries(from).map((e) => e.event); }
