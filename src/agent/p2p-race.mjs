/**
 * Multi-transport race: capability negotiation + first-usable-path wins.
 *
 * The control plane never waits for this. A dispatch goes through the relay
 * immediately; this race only decides which data-channel carries results.
 * There is deliberately no relay fallback here: if every transport loses, the
 * caller gets ALL_TRANSPORTS_FAILED and the task result stays on the control
 * plane, which is a different (and already-working) path.
 */

export const TRANSPORT_PRIORITY = Object.freeze(['iroh', 'udp']);

/**
 * Intersect the local and remote capability lists.
 * A peer that declares nothing is an older build and gets the UDP path only.
 *
 * @param {{local?: string[], remote?: string[]|null, priority?: string[]}} input
 * @returns {string[]} ordered transport names both ends can attempt
 */
export function negotiateTransports({ local = ['udp'], remote = null, priority = TRANSPORT_PRIORITY } = {}) {
  const localSet = new Set(local.filter((name) => typeof name === 'string'));
  const remoteSet = remote === null ? new Set(['udp']) : new Set(remote.filter((name) => typeof name === 'string'));
  return priority.filter((name) => localSet.has(name) && remoteSet.has(name));
}

/**
 * Run every candidate's start() concurrently and resolve with the first channel.
 * The losers are aborted as soon as a winner exists (or the total budget expires).
 *
 * @param {{
 *   candidates: Array<{name: string, timeoutMs?: number, start: (ctx: {signal: AbortSignal}) => Promise<any>}>,
 *   budgetMs?: number,
 *   now?: () => number,
 * }} input
 * @returns {Promise<{ok: true, name: string, channel: any, attempts: object[], elapsedMs: number}
 *   | {ok: false, code: 'ALL_TRANSPORTS_FAILED'|'NO_TRANSPORTS', attempts: object[], elapsedMs: number}>}
 */
export async function raceTransports({ candidates, budgetMs = 3000, now = Date.now } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, code: 'NO_TRANSPORTS', attempts: [], elapsedMs: 0 };
  }
  const startedAt = now();
  const attempts = [];
  const controllers = new Map();
  let settled = false;
  let resolveRace = null;
  const race = new Promise((resolve) => { resolveRace = resolve; });

  const finish = (result) => {
    if (settled) return;
    settled = true;
    for (const [name, controller] of controllers.entries()) {
      if (result.ok === true && result.name === name) continue; // the winner keeps its channel
      controller.abort();
    }
    resolveRace({ ...result, elapsedMs: now() - startedAt });
  };

  const budgetTimer = setTimeout(() => {
    finish({ ok: false, code: 'ALL_TRANSPORTS_FAILED', attempts });
  }, budgetMs);
  budgetTimer.unref?.();

  for (const candidate of candidates) {
    if (typeof candidate?.start !== 'function') continue;
    const controller = new AbortController();
    controllers.set(candidate.name, controller);
    const record = { name: candidate.name, ok: false, code: null, elapsedMs: null };
    attempts.push(record);
    const started = now();
    const timer = setTimeout(() => {
      record.code = 'TRANSPORT_TIMEOUT';
      record.elapsedMs = now() - started;
      controller.abort();
      if (attempts.every((attempt) => attempt.elapsedMs !== null) && attempts.every((attempt) => attempt.ok !== true)) {
        finish({ ok: false, code: 'ALL_TRANSPORTS_FAILED', attempts });
      }
    }, Number.isFinite(candidate.timeoutMs) ? candidate.timeoutMs : budgetMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => candidate.start({ signal: controller.signal }))
      .then((channel) => {
        clearTimeout(timer);
        if (settled) return;
        record.ok = true;
        record.elapsedMs = now() - started;
        finish({ ok: true, name: candidate.name, channel, attempts });
      })
      .catch((error) => {
        clearTimeout(timer);
        if (settled) return;
        record.code = error?.code ?? 'TRANSPORT_FAILED';
        record.message = error instanceof Error ? error.message : String(error);
        record.elapsedMs = now() - started;
        if (attempts.every((attempt) => attempt.ok !== true && attempt.elapsedMs !== null)) {
          finish({ ok: false, code: 'ALL_TRANSPORTS_FAILED', attempts });
        }
      });
  }

  const result = await race;
  clearTimeout(budgetTimer);
  if (result.ok !== true) return result;
  return result;
}
