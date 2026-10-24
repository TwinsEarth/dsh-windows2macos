/**
 * Relay failover supervisor (v1.6.6).
 *
 * ## The failure this exists for
 *
 * On 2026-10-24 the primary relay's host went down entirely (HTTP 8787 and SSH 22 both timed out).
 * Every machine kept dialling the dead primary: the fleet was unreachable even though the backup
 * relay was healthy the whole time. The backup carried a "standby member" per machine, but nothing
 * ever *moved* the working connection to it. This module is the decision half of the fix; the wiring
 * in `tools.mjs` restarts the in-process stack against the chosen relay, and re-pairing happens
 * through the fleet key (per-relay tokens differ, so a switch is a re-join, not a reconnect).
 *
 * ## Hysteresis, deliberately asymmetric
 *
 * Switching away needs **3 consecutive** failed probes (a single dropped health request during a
 * deploy must not move a fleet), while returning to the primary needs **5 consecutive** successes.
 * Coming back is the riskier direction — a flapping primary that answers twice must not drag every
 * machine back and forth — so it requires more evidence than leaving does.
 *
 * Pure state machine: no timers, no network. The caller probes and feeds results in, which is what
 * makes the thresholds testable without waiting ten seconds per transition.
 */

/** Defaults are exported so the tests and the status report cannot invent different numbers. */
export const FAILOVER_DEFAULTS = Object.freeze({
  probeIntervalMs: 10_000,
  probeTimeoutMs: 2_000,
  failuresToSwitch: 3,
  successesToReturn: 5,
});

/**
 * The ordered relay pool for this machine.
 *
 * `relayUrls` is the operator's pool (v1.5.1+); `rabbitUrl` is the active one. Deduplicated and
 * normalized so a trailing slash cannot make one relay look like two.
 *
 * @param {{rabbitUrl?: string|null, relayUrls?: string[]|null}} cfg
 * @returns {string[]}
 */
export function relayPool(cfg) {
  const cleaned = (Array.isArray(cfg?.relayUrls) ? cfg.relayUrls : [])
    .filter((url) => typeof url === 'string' && url.trim() !== '')
    .map((url) => url.trim().replace(/\/+$/, ''));
  const active = typeof cfg?.rabbitUrl === 'string' && cfg.rabbitUrl.trim() !== ''
    ? cfg.rabbitUrl.trim().replace(/\/+$/, '')
    : null;
  const pool = [];
  for (const url of [...(active === null ? [] : [active]), ...cleaned]) {
    if (!pool.includes(url)) pool.push(url);
  }
  return pool;
}

/**
 * Create the failover state machine.
 *
 * @param {object} options
 * @param {string[]} options.pool Ordered relay URLs; `pool[0]` is the primary.
 * @param {string} [options.primary] Overrides which URL counts as "the one to return to".
 * @param {number} [options.failuresToSwitch]
 * @param {number} [options.successesToReturn]
 * @param {() => number} [options.now]
 */
export function createRelayFailover(options) {
  const pool = Array.isArray(options?.pool) ? [...options.pool] : [];
  if (pool.length === 0) throw new TypeError('pool must contain at least one relay URL');
  const primary = typeof options?.primary === 'string' && pool.includes(options.primary) ? options.primary : pool[0];
  const failuresToSwitch = Number.isInteger(options?.failuresToSwitch) && options.failuresToSwitch > 0
    ? options.failuresToSwitch : FAILOVER_DEFAULTS.failuresToSwitch;
  const successesToReturn = Number.isInteger(options?.successesToReturn) && options.successesToReturn > 0
    ? options.successesToReturn : FAILOVER_DEFAULTS.successesToReturn;
  const now = typeof options?.now === 'function' ? options.now : Date.now;

  let active = typeof options?.active === 'string' && pool.includes(options.active) ? options.active : primary;
  let failures = 0;
  let primarySuccesses = 0;
  let switches = 0;
  let lastSwitchAtMs = null;
  let lastReason = null;
  const history = [];

  /**
   * Feed one round of health results and get the decision.
   *
   * @param {Map<string, boolean>|Record<string, boolean>} health url -> reachable
   * @returns {{action: 'stay'|'switch', active: string, target?: string, reason?: string}}
   */
  function assess(health) {
    const reachable = (url) => (health instanceof Map ? health.get(url) : health?.[url]) === true;
    const activeOk = reachable(active);

    if (activeOk) {
      failures = 0;
      if (active === primary) {
        primarySuccesses = 0;
      }
      // A healthy non-primary route still watches the primary for the way home.
    } else {
      failures += 1;
    }

    if (active !== primary && reachable(primary)) {
      primarySuccesses += 1;
    } else if (active !== primary) {
      primarySuccesses = 0;
    }

    if (activeOk !== true && failures >= failuresToSwitch) {
      const alternative = pool.find((url) => url !== active && reachable(url));
      if (alternative !== undefined) {
        const reason = `active relay ${active} failed ${failures} consecutive probes`;
        history.push({ at_ms: now(), from: active, to: alternative, reason });
        active = alternative;
        failures = 0;
        primarySuccesses = 0;
        switches += 1;
        lastSwitchAtMs = now();
        lastReason = reason;
        return { action: 'switch', active, target: alternative, reason };
      }
      // No reachable alternative: stay, but keep reporting the failure streak.
    }

    if (active !== primary && primarySuccesses >= successesToReturn) {
      const reason = `primary relay ${primary} healthy ${primarySuccesses} consecutive probes`;
      history.push({ at_ms: now(), from: active, to: primary, reason });
      active = primary;
      failures = 0;
      primarySuccesses = 0;
      switches += 1;
      lastSwitchAtMs = now();
      lastReason = reason;
      return { action: 'switch', active, target: primary, reason };
    }

    return { action: 'stay', active };
  }

  /** What `w2m_status` reports: which relay is in use and why it last moved. */
  function snapshot() {
    return {
      primary,
      active,
      pool: [...pool],
      failures,
      failures_to_switch: failuresToSwitch,
      primary_successes: primarySuccesses,
      successes_to_return: successesToReturn,
      switches,
      last_switch_at_ms: lastSwitchAtMs,
      last_reason: lastReason,
      history: history.slice(-10),
    };
  }

  return { assess, snapshot, thresholds: { failuresToSwitch, successesToReturn } };
}
