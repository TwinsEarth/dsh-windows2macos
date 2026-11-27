/**
 * Teams transport policy: two planes, two channels, no silent promotion.
 *
 * The operator's rule (2026-11-23) is deliberately asymmetric:
 *
 *   * control (heartbeat, presence, user info, plan/approval/lease, every RPC that changes what a
 *     machine will do) is small and must be reliable, so it travels over the relay's TCP path;
 *   * bulk data (images, files, artifact bytes, data sync) is large and not confidential, so it
 *     travels over the UDP P2P path, and a failed delivery is abandoned after 33 attempts with an
 *     alert. It is **not** silently promoted to the relay: a large payload that quietly takes the
 *     reliable path is a bandwidth bill nobody chose.
 *
 * This module owns the decision and the bounded retry loop, not the sockets. A caller supplies
 * `sendControl` and `sendBulk`; tests supply fakes. Keeping the policy pure is what lets the same
 * rule be asserted without a live relay or a NAT.
 *
 * A P2P frame may still be encrypted by the transport that carries it; "not confidential" here is a
 * statement about routing preference, never a licence to send plaintext.
 */

/** The only control channel this policy permits. */
export const TEAM_CONTROL_CHANNEL = 'relay-tcp';

/** The only bulk data channel this policy permits: WebRTC DataChannel over the shared pool. */
export const TEAM_DATA_CHANNEL = 'webrtc-v1';

/** The operator's fixed ceiling. A caller cannot raise it by configuration. */
export const TEAM_DATA_MAX_ATTEMPTS = 33;

/** The floor: a transfer must be attempted at least once, or it was never a transfer. */
export const TEAM_DATA_MIN_ATTEMPTS = 1;

/** Stable reason codes, so a caller can branch without parsing prose. */
export const TEAM_TRANSPORT_CODE = Object.freeze({
  CONTROL_RELAY_FAILED: 'TEAM_CONTROL_RELAY_FAILED',
  DATA_P2P_EXHAUSTED: 'TEAM_DATA_P2P_EXHAUSTED',
  DATA_SENDER_MISSING: 'TEAM_DATA_SENDER_MISSING',
  CONTROL_SENDER_MISSING: 'TEAM_CONTROL_SENDER_MISSING',
  PAYLOAD_INVALID: 'TEAM_PAYLOAD_INVALID',
});

/** Kinds that are unambiguously bulk bytes. */
const DATA_KINDS = new Set([
  'file',
  'files',
  'image',
  'images',
  'artifact',
  'artifacts',
  'blob',
  'blobs',
  'data',
  'data-sync',
  'data_sync',
  'sync',
  'bulk',
  'attachment',
  'attachments',
  'media',
]);

/** Kinds that are unambiguously control. */
const CONTROL_KINDS = new Set([
  'heartbeat',
  'presence',
  'user',
  'user-info',
  'user_info',
  'identity',
  'roster',
  'plan',
  'joint-plan',
  'joint_plan',
  'approval',
  'lease',
  'task',
  'task-control',
  'task_control',
  'rpc',
  'council',
  'room',
  'room-event',
  'room_event',
  'decision',
  'control',
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Classify one payload before it is sent.
 *
 * Unknown kinds fall back to control on purpose: an unrecognised frame is more likely to be a new
 * control RPC than a file, and putting it on the reliable path is the recoverable mistake. The
 * result says `needs_review: true` so that fallback is visible rather than silent.
 *
 * @param {{kind?: string, bytes?: number}} [input]
 * @returns {{channel: string, kind: string, bytes: number|null, max_attempts: number,
 *   data_plane: boolean, needs_review: boolean, reason: string}}
 */
export function classifyTeamPayload(input = {}) {
  const kind = typeof input?.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  const bytes =
    Number.isFinite(Number(input?.bytes)) && Number(input.bytes) >= 0 ? Number(input.bytes) : null;
  if (DATA_KINDS.has(kind)) {
    return {
      channel: TEAM_DATA_CHANNEL,
      kind,
      bytes,
      max_attempts: TEAM_DATA_MAX_ATTEMPTS,
      data_plane: true,
      needs_review: false,
      reason: 'bulk-data',
    };
  }
  if (CONTROL_KINDS.has(kind)) {
    return {
      channel: TEAM_CONTROL_CHANNEL,
      kind,
      bytes,
      max_attempts: 1,
      data_plane: false,
      needs_review: false,
      reason: 'control',
    };
  }
  return {
    channel: TEAM_CONTROL_CHANNEL,
    kind: kind === '' ? '<missing>' : kind,
    bytes,
    max_attempts: 1,
    data_plane: false,
    needs_review: true,
    reason: 'unknown-control-fallback',
  };
}

/**
 * Normalize the timing knobs and the attempt count.
 *
 * `dataMaxAttempts` is a bounded dial, not a free knob: the operator may lower it to fail faster on
 * a bad link, but `TEAM_DATA_MAX_ATTEMPTS` remains the ceiling. Values below one are clamped to one:
 * a zero-attempt transfer would report "exhausted" without ever trying.
 *
 * @param {{dataRetryDelayMs?: number, dataMaxAttempts?: number, data_max_attempts?: number}} [config]
 * @returns {{control_channel: string, data_channel: string, data_max_attempts: number,
 *   data_retry_delay_ms: number}}
 */
export function normalizeTeamTransportPolicy(config = {}) {
  const rawDelay = Number(config?.dataRetryDelayMs ?? config?.data_retry_delay_ms);
  const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? Math.min(5_000, rawDelay) : 1_000;
  const rawAttempts = Number(config?.dataMaxAttempts ?? config?.data_max_attempts);
  const attempts =
    Number.isFinite(rawAttempts) && rawAttempts >= TEAM_DATA_MIN_ATTEMPTS
      ? Math.min(TEAM_DATA_MAX_ATTEMPTS, Math.round(rawAttempts))
      : TEAM_DATA_MAX_ATTEMPTS;
  return {
    control_channel: TEAM_CONTROL_CHANNEL,
    data_channel: TEAM_DATA_CHANNEL,
    data_max_attempts: attempts,
    data_retry_delay_ms: delay,
  };
}

/**
 * A bounded router over injected senders.
 *
 * `sendBulk` is retried exactly {@link TEAM_DATA_MAX_ATTEMPTS} times. A result with `ok: false` is a
 * failure; any other return is success, so a sender that returns nothing still works. When every
 * attempt fails the router calls `onAlert` once and returns the alert in the result. There is no
 * relay fallback in this method -- that would be a different policy and needs a different name.
 *
 * @param {{policy?: object, sendControl?: Function, sendBulk?: Function,
 *   sleep?: (ms:number) => Promise<void>, onAlert?: (alert: object) => void,
 *   now?: () => number}} [options]
 */
export function createTeamTransportRouter(options = {}) {
  const policy = normalizeTeamTransportPolicy(options.policy ?? {});
  const sleep =
    typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => {
          if (ms <= 0) return Promise.resolve();
          return new Promise((resolve) => {
            setTimeout(resolve, ms);
          });
        };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const alert = (fields) => ({
    severity: 'error',
    code: TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED,
    channel: TEAM_DATA_CHANNEL,
    max_attempts: policy.data_max_attempts,
    created_at: new Date(now()).toISOString(),
    ...fields,
  });

  return {
    policy: { ...policy },

    /**
     * Send one control payload over the relay TCP path. Exactly one attempt: the relay is the
     * reliable channel, and retrying here would be a second policy hidden inside this one.
     *
     * @param {object} payload
     * @returns {Promise<{ok: boolean, channel: string, attempts: number, code?: string, detail?: any}>}
     */
    async control(payload) {
      if (!isRecord(payload)) {
        return {
          ok: false,
          code: TEAM_TRANSPORT_CODE.PAYLOAD_INVALID,
          channel: TEAM_CONTROL_CHANNEL,
          attempts: 0,
        };
      }
      if (typeof options.sendControl !== 'function') {
        return {
          ok: false,
          code: TEAM_TRANSPORT_CODE.CONTROL_SENDER_MISSING,
          channel: TEAM_CONTROL_CHANNEL,
          attempts: 0,
        };
      }
      try {
        const result = await options.sendControl(payload);
        if (result !== null && typeof result === 'object' && result.ok === false) {
          return {
            ok: false,
            code: result.code ?? TEAM_TRANSPORT_CODE.CONTROL_RELAY_FAILED,
            channel: TEAM_CONTROL_CHANNEL,
            attempts: 1,
            detail: result.detail ?? null,
          };
        }
        return { ok: true, channel: TEAM_CONTROL_CHANNEL, attempts: 1 };
      } catch (error) {
        return {
          ok: false,
          code: TEAM_TRANSPORT_CODE.CONTROL_RELAY_FAILED,
          channel: TEAM_CONTROL_CHANNEL,
          attempts: 1,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    /**
     * Send one bulk payload over UDP P2P, retrying at most 33 times.
     *
     * @param {object & {kind?: string, bytes?: number}} payload
     * @returns {Promise<{ok: boolean, channel: string, attempts: number, code?: string,
     *   detail?: any, alert?: object}>}
     */
    async bulk(payload) {
      if (!isRecord(payload)) {
        return {
          ok: false,
          code: TEAM_TRANSPORT_CODE.PAYLOAD_INVALID,
          channel: TEAM_DATA_CHANNEL,
          attempts: 0,
        };
      }
      const route = classifyTeamPayload(payload);
      if (route.data_plane !== true) {
        // A bulk call for a control-looking kind is still a caller error: the caller asked for the
        // bulk path and the payload says it is control. Refuse instead of quietly switching channels.
        return {
          ok: false,
          code: TEAM_TRANSPORT_CODE.PAYLOAD_INVALID,
          channel: TEAM_DATA_CHANNEL,
          attempts: 0,
          detail: { kind: route.kind, classified_channel: route.channel },
        };
      }
      if (typeof options.sendBulk !== 'function') {
        return {
          ok: false,
          code: TEAM_TRANSPORT_CODE.DATA_SENDER_MISSING,
          channel: TEAM_DATA_CHANNEL,
          attempts: 0,
        };
      }
      let lastCode = null;
      let lastDetail = null;
      for (let attempt = 1; attempt <= policy.data_max_attempts; attempt += 1) {
        try {
          const result = await options.sendBulk(payload, attempt);
          if (!(result !== null && typeof result === 'object' && result.ok === false)) {
            return { ok: true, channel: TEAM_DATA_CHANNEL, attempts: attempt, bytes: route.bytes };
          }
          lastCode = result.code ?? 'TEAM_DATA_P2P_ATTEMPT_FAILED';
          lastDetail = result.detail ?? null;
        } catch (error) {
          lastCode = 'TEAM_DATA_P2P_ATTEMPT_FAILED';
          lastDetail = error instanceof Error ? error.message : String(error);
        }
        if (attempt < policy.data_max_attempts && policy.data_retry_delay_ms > 0) {
          await sleep(policy.data_retry_delay_ms);
        }
      }
      const notice = alert({
        attempts: policy.data_max_attempts,
        kind: route.kind,
        bytes: route.bytes,
        last_error: lastCode,
        last_detail: lastDetail,
        message: `P2P bulk delivery failed ${policy.data_max_attempts} times; the transfer was abandoned and the relay was not used`,
      });
      if (typeof options.onAlert === 'function') {
        try {
          options.onAlert(notice);
        } catch {
          /* the alert callback must never turn a failed transfer into a thrown one */
        }
      }
      return {
        ok: false,
        code: TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED,
        channel: TEAM_DATA_CHANNEL,
        attempts: policy.data_max_attempts,
        detail: { last_error: lastCode, last_detail: lastDetail },
        alert: notice,
      };
    },
  };
}
