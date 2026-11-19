/**
 * Relay state — result domain: envelope checks, instance keys and dedupe inputs.
 *
 * Split out of `state.mjs` (P1 refactor slice S5). Every function that touches the owning
 * `RabbitState` takes it as its first argument: the state remains owned by the facade (one copy
 * of every field), and this module only operates on it; the pure envelope/key helpers take no
 * state at all.
 *
 * `submitResult` itself deliberately stays on the facade: the relay red-line audit pins its
 * projection-before-storage wiring as source text inside `state.mjs`, and this slice must keep
 * the relay suites passing unchanged. This module holds the pure result-domain functions the
 * facade and the report read (envelope checks, instance keys, dedupe inputs).
 */

import { ProtocolError, REQUIRED_ENVELOPE_FIELDS, RESULT_STATUSES, TRANSPORT_VALUES, rfc3339 } from './shared.mjs';

const INSTANCE_SEP = '\u0000';

/**
 * v0.4.0 §5.2: validate the optional transport fields of a result envelope.
 *
 * Same reasoning as `validateTaskRouting`: `transport` is an enum and `p2p` is an opaque object,
 * so anything else is refused by name at the door. Both fields stay OUT of
 * `REQUIRED_ENVELOPE_FIELDS` (a missing one is a v0.3.9 envelope, not an incomplete one) and out
 * of `COMPARABLE_FIELDS` (a path is not a result).
 */
export function validateTransportFields(envelope = {}) {
  if (envelope.transport !== undefined && envelope.transport !== null) {
    if (!TRANSPORT_VALUES.includes(envelope.transport)) {
      throw new ProtocolError(
        'BAD_REQUEST',
        `transport must be one of ${TRANSPORT_VALUES.join('|')}`,
        { transport: envelope.transport },
      );
    }
  }
  if (envelope.p2p !== undefined && envelope.p2p !== null
    && (typeof envelope.p2p !== 'object' || Array.isArray(envelope.p2p))) {
    throw new ProtocolError('BAD_REQUEST', 'p2p must be an object', { p2p: envelope.p2p });
  }
}

export function instanceKey(machineId, dedupeKey, attempt) {
  return `${machineId}${INSTANCE_SEP}${dedupeKey}${INSTANCE_SEP}${attempt}`;
}

/**
 * §5 result envelope validation.
 * Missing §5.1 required fields do NOT reject the frame — they make the result
 * `unverifiable` (§5.1 "缺一即 unverifiable").
 */
export function validateEnvelope(envelope) {
  const missing = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { missing: [...REQUIRED_ENVELOPE_FIELDS], malformed: true };
  }
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (!(field in envelope) || envelope[field] === undefined) missing.push(field);
  }
  const problems = [];
  if ('status' in envelope && !RESULT_STATUSES.includes(envelope.status)) {
    problems.push(`status must be one of ${RESULT_STATUSES.join('|')}`);
  }
  if (envelope.status === 'refused' && !envelope.refusal_reason) {
    problems.push('refusal_reason is required when status=refused');
  }
  if ('warnings' in envelope && !Array.isArray(envelope.warnings)) problems.push('warnings must be string[]');
  return { missing, problems };
}

/** All recorded results for a task, keyed by machine_id (later attempts win). */
export function taskResults(state, taskId) {
  const task = state.tasks.get(taskId);
  if (!task) return new Map();
  const out = new Map();
  for (const rec of state.results.values()) {
    if (rec.envelope.task_id !== taskId) continue;
    const prev = out.get(rec.machine_id);
    if (!prev || rec.received_at_ms >= prev.received_at_ms) out.set(rec.machine_id, rec);
  }
  return out;
}

/** Global dedupe book-keeping: dedupe_key -> instances seen. */
export function dedupeReport(state) {
  const out = {};
  for (const rec of state.results.values()) {
    if (!rec.dedupe_key) continue;
    out[rec.dedupe_key] = out[rec.dedupe_key] ?? [];
    out[rec.dedupe_key].push({
      machine_id: rec.machine_id,
      attempt: rec.attempt,
      received_at: rfc3339(rec.received_at_ms),
    });
  }
  return out;
}
