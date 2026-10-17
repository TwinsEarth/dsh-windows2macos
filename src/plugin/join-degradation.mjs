/**
 * When may the old joining path give up and the new one take over?
 *
 * The operator's rule (2026-10-17): "旧机制优先，失败才降级". The whole value of a fallback is that it fires when the
 * old path **cannot** work -- and the whole danger is that it fires when the old path merely hiccuped. A machine pushed
 * into an approval queue because the network blipped for two seconds is worse than one that retried.
 *
 * So this is a whitelist of three reasons, and everything else is "retry the old path":
 *
 *   1. the pairing code is invalid or already used -- the old path can never succeed with it;
 *   2. the relay is unreachable at the configured address -- no code will help;
 *   3. pairing timed out -- the old path got its chance and did not finish.
 *
 * Everything else (401 on the operator token, a config error, a permission refusal, an unexpected 5xx) is a signal that
 * something needs a human, **not** a signal to change mechanisms. Defaulting to `false` is deliberate: an unknown
 * failure must not silently move a machine between flows.
 */

/** The only three reasons the old path may be abandoned. */
export const DEGRADABLE_REASONS = Object.freeze([
  'PAIRING_CODE_INVALID',
  'RELAY_UNREACHABLE',
  'PAIRING_TIMEOUT',
]);

/**
 * @param {string|{reason_code?: string, code?: string, status?: number}} failure
 * @returns {boolean} true only for the three whitelisted reasons.
 */
export function shouldDegrade(failure) {
  const reason = typeof failure === 'string' ? failure : (failure?.reason_code ?? failure?.code ?? null);
  if (typeof reason !== 'string') return false;
  return DEGRADABLE_REASONS.includes(reason);
}
