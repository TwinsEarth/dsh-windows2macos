/**
 * SSE cursor rule (P0-f): only replayable frames may move the resume cursor.
 *
 * The relay's `ready` and `notice` frames are assigned a sequence number with `reserveSeq()` but are
 * not written into the replay ring, so a client that adopts those numbers claims to have seen events
 * it never received - and a reconnect then silently skips the gap. The cursor therefore advances
 * only for frames the ring actually replays (`task.*`, `peer.*`, `result.ack`).
 */
export const NON_REPLAYABLE_EVENTS = Object.freeze(['ready', 'notice']);

/** @param {{type?: string|null, event?: string|null}} input */
export function shouldAdvanceCursor(input) {
  const type = String(input?.type ?? input?.event ?? '');
  if (type === '') return false;
  return !NON_REPLAYABLE_EVENTS.includes(type);
}
