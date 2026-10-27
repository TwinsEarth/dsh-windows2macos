// internal telemetry module (undocumented)
import { buildSample, createActivityClock } from './agent-collector.mjs';
import { nextUploadAt, startupDelayMs, mayPersist, fleetSizeOrDefault } from './upload-scheduler.mjs';
import { createOpsUploader } from './upload-client.mjs';

/**
 * @param {{
 *   machineId: string,
 *   teamId?: string|null,
 *   osInfo?: string,
 *   pluginVersion: string,
 *   relays: Array<{relayIndex: number, token: string, url: string}>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   setTimer?: (ms: number, fn: () => void) => any,
 *   clearTimer?: (handle: any) => void,
 *   retry?: object,
 * }} options
 */
export function createPluginCollector(options) {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const setTimer = options.setTimer ?? ((ms, fn) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const clock = createActivityClock({ now });
  const relayCount = options.relays.length;
  const byIndex = new Map(options.relays.map((relay) => [relay.relayIndex, relay]));
  /** [res, rej] => Relay-side body: keep the wire shape identical to the relay HTTP contract. */
  const postShard = async (relayIndex, sample) => {
    const relay = byIndex.get(relayIndex);
    if (relay === undefined) throw new Error('no relay configured for index ' + relayIndex);
    const response = await fetchImpl(relay.url.replace(/\/+$/, '') + '/v1/ops/shards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + relay.token },
      body: JSON.stringify({ nonce: 'n_' + relayIndex + '_' + now() + '_' + Math.random().toString(36).slice(2, 10), timestamp: now(), sample }),
    });
    if (!response.ok) throw new Error('relay ' + relayIndex + ' answered ' + response.status);
  };
  // Fleet size comes from the relay when it can be read; otherwise the operator's 2,026 fallback applies.
  let fleetSize = fleetSizeOrDefault(options.fleetSize);
  let fleetFetchedAt = 0;
  const refreshFleetSize = async () => {
    if (typeof options.fetchFleetSize !== 'function') return;
    if (now() - fleetFetchedAt < (options.fleetSizeRefreshMs ?? 6 * 60 * 60 * 1000)) return;
    try {
      const observed = await options.fetchFleetSize();
      if (Number.isFinite(observed) && observed > 0) {
        fleetSize = fleetSizeOrDefault(observed);
        fleetFetchedAt = now();
      }
    } catch {
      // keep the last known or the fallback; never disturb the host
    }
  };
  const uploader = createOpsUploader({ relayCount, now, postShard, retry: options.retry, fleetSize });
  let timer = null;
  let disposed = false;

  function stop() {
    disposed = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    if (disposed) return;
    void refreshFleetSize();
    const at = nextUploadAt({ machineId: options.machineId, nowMs: now(), fleetSize });
    timer = setTimer(Math.max(1_000, at - now()), () => {
      timer = null;
      tick().catch(() => {});
    }, 'w2m-ops-tick');
  }

  /** One sample: build → encrypt → per-relay upload (no-op below three relays). */
  async function tick() {
    if (disposed) return { skipped: true, reason: 'DISPOSED' };
    if (!mayPersist({ writableRelays: relayCount, isHistory: true })) return { skipped: true, reason: 'NEED_AT_LEAST_3_RELAYS' };
    const { sample, plaintext } = buildSample({
      machineId: options.machineId,
      teamId: options.teamId,
      osInfo: options.osInfo,
      pluginVersion: options.pluginVersion,
      clock,
      nowMs: now(),
    });
    await refreshFleetSize();
    const outcome = await uploader.uploadSample({ sample, plaintext, nowMs: now() });
    scheduleNext();
    return outcome;
  }

  /** Start from the plugin's activation path: online, delayed first upload, then hourly. */
  function start(input = {}) {
    clock.online(now());
    const delay = startupDelayMs({ machineId: options.machineId, sessionSalt: String(input.sessionSalt ?? 'default'), fleetSize });
    timer = setTimer(delay, () => {
      timer = null;
      tick().catch(() => {});
    }, 'w2m-ops-first');
    return { stop, tick, scheduleNext, online: () => clock.online(now()), offline: () => clock.offline(now()) };
  }

  return { start, tick, stop, clock };
}
