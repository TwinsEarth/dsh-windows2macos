/**
 * Relay capability negotiation (v2 G0-2).
 *
 * A joint-dev dispatch names machines on the wire and expects the relay to honour
 * `target_machines`/`executor_machine_id`. An older relay silently ignores those fields, which
 * widens an intended single-machine dispatch to the whole online fleet. The dispatcher therefore
 * reads the relay's advertised features first and refuses when a required feature is missing.
 *
 * A relay with no `features` field at all is older than this protocol: callers decide policy
 * (joint-dev refuses; ordinary dispatch keeps its post-dispatch lease check).
 */

/** Features a joint-dev dispatch requires from the relay. */
export const JOINT_REQUIRED_FEATURES = Object.freeze(['target-machines', 'result-projection']);

/**
 * Read `/healthz` and normalise the capability fields.
 *
 * @param {{rabbitUrl: string, fetchImpl?: Function, timeoutMs?: number}} input
 * @returns {Promise<{ok: boolean, relay_version?: string|null, features?: string[]|null, protocol_version?: number|null, error?: string}>}
 */
export async function readRelayCapabilities(input) {
  const base = typeof input?.rabbitUrl === 'string' ? input.rabbitUrl.replace(/\/$/, '') : '';
  if (base === '') return { ok: false, error: 'rabbitUrl is required' };
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : 15_000;
  try {
    const response = await fetchImpl(`${base}/healthz`, {
      headers: { accept: 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (response?.ok !== true) return { ok: false, error: `healthz answered HTTP ${response?.status ?? '?'}` };
    const doc = await response.json();
    const features = Array.isArray(doc?.features) ? doc.features.filter((entry) => typeof entry === 'string') : null;
    return {
      ok: true,
      relay_version: typeof doc?.relay_version === 'string' ? doc.relay_version : (typeof doc?.version === 'string' ? doc.version : null),
      features,
      protocol_version: Number.isInteger(doc?.protocol_version) ? doc.protocol_version : null,
      operator_token_required: typeof doc?.operator_token_required === 'boolean' ? doc.operator_token_required : null,
      signing_required: typeof doc?.signing?.required === 'boolean' ? doc.signing.required : null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Decide whether the advertised capabilities satisfy a required set.
 *
 * @param {{features?: string[]|null}|null} capabilities
 * @param {string[]} [required]
 * @returns {{ok: boolean, code?: string, missing?: string[], unknown?: boolean}}
 */
export function negotiateFeatures(capabilities, required = JOINT_REQUIRED_FEATURES) {
  if (capabilities === null || capabilities?.ok !== true) {
    return { ok: false, code: 'RELAY_CAPABILITIES_UNAVAILABLE', unknown: true };
  }
  const features = capabilities.features;
  if (!Array.isArray(features)) {
    // No advertisement at all: an older relay. Callers that need the fields must not guess.
    return { ok: false, code: 'RELAY_CAPABILITIES_MISSING', missing: [...required], unknown: true };
  }
  const missing = required.filter((feature) => !features.includes(feature));
  if (missing.length > 0) return { ok: false, code: 'RELAY_CAPABILITIES_MISSING', missing, unknown: false };
  return { ok: true };
}
