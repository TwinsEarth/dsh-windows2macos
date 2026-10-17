/**
 * The fallback joining path, as the client actually walks it.
 *
 * ## Why this is a separate, injectable function
 *
 * The old path fails for three named reasons only (see join-degradation.mjs), and then this runs: ask for a challenge,
 * sign it with the account key, submit the proof, wait for a human (or the ten-second popup) to decide. Every one of
 * those steps can be slow or refuse, and the whole thing must be testable without a relay, a fleet, or a person.
 *
 * ## The two rules this encodes, both learned the hard way
 *
 * - **A rejection is final.** Re-asking after a "no" turns a decision into a notification queue and harasses the members
 *   who said no. Only a caller that explicitly resets may try again.
 * - **Give up loudly.** If the request is never decided, the caller must be told which state it ended in (expired,
 *   pending past the deadline) rather than being left with a promise that never settles.
 */
import { signChallenge } from '../util/account-identity.mjs';

/** Terminal states from the relay. \`pending\` is NOT terminal: it means "still waiting". */
const TERMINAL = new Set(['approved', 'rejected', 'expired']);

/**
 * @param {{request: Function, identity: {fingerprint: string, privateKey: unknown},
 *          machine: {machine_id: string, machine_name?: string},
 *          basePath?: string, pollIntervalMs?: number, maxPolls?: number, sleep?: Function,
 *          now?: () => number}} deps
 * @returns {Promise<{ok: boolean, state: string, device_token?: string, request_id?: string, code?: string}>}
 */
export async function joinByAccount({
  request,
  identity,
  machine,
  basePath = '',
  pollIntervalMs = 1000,
  maxPolls = 30,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  if (!identity || typeof identity.fingerprint !== 'string') throw new TypeError('identity with a fingerprint is required');
  if (!machine || typeof machine.machine_id !== 'string' || machine.machine_id === '') throw new TypeError('machine.machine_id is required');

  const challenge = await request({
    method: 'GET',
    pathname: basePath + '/v1/fleet/admission/challenge',
    query: { fingerprint: identity.fingerprint, machine_id: machine.machine_id },
  });
  if (challenge?.ok !== true) {
    return { ok: false, state: 'error', code: challenge?.error?.code ?? 'CHALLENGE_REFUSED' };
  }
  const signature = signChallenge(identity, [challenge.json.challenge_id, challenge.json.nonce, identity.fingerprint, machine.machine_id].join('|'));

  const submitted = await request({
    method: 'POST',
    pathname: basePath + '/v1/fleet/admission/request',
    body: { machine_id: machine.machine_id, machine_name: machine.machine_name ?? null, challenge_id: challenge.json.challenge_id, signature },
  });
  if (submitted?.ok !== true) {
    return { ok: false, state: 'error', code: submitted?.error?.code ?? 'REQUEST_REFUSED' };
  }
  let state = submitted.json.state ?? 'pending';
  const requestId = submitted.json.request_id ?? null;
  const pollToken = submitted.json.poll_token ?? null;

  for (let attempt = 0; attempt < maxPolls && !TERMINAL.has(state); attempt += 1) {
    if (attempt > 0) await sleep(pollIntervalMs);
    const polled = await request({
      method: 'GET',
      pathname: basePath + '/v1/fleet/admission/' + encodeURIComponent(requestId ?? ''),
      query: { poll_token: pollToken ?? '' },
    });
    if (polled?.ok !== true) {
      return { ok: false, state: 'error', code: polled?.error?.code ?? 'POLL_REFUSED' };
    }
    state = polled.json.state ?? state;
    if (TERMINAL.has(state)) {
      return { ok: state === 'approved', state, request_id: requestId, device_token: polled.json.device_token };
    }
  }
  // Not terminal within the budget: report the state we ended in rather than hanging.
  return { ok: false, state, request_id: requestId, code: TERMINAL.has(state) ? undefined : 'STILL_PENDING' };
}

/** True only for a state a caller may treat as an answer. Exported so callers do not re-derive it. */
export function isTerminalAdmissionState(state) {
  return TERMINAL.has(state);
}
