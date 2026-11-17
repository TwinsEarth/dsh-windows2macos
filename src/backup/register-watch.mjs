/**
 * The bounded watch after `register` writes the workspace registry (G2's third half, with an end date).
 *
 * ## What the race is, stated as a number
 *
 * The DSH client owns `storages/workspace.json`. It holds the registry in memory and saves on its own schedule,
 * so a file-level write can be replaced by a save that started before our write. `registry.mjs` reads back what it
 * wrote; that proves the write landed, **not** that it survives. `registry-watch.mjs` samples a few times after a
 * restore for the same reason.
 *
 * Register's watch is the same idea with a **minute budget**: after a successful apply, sample at 2 s, 8 s, 20 s,
 * 60 s and then every 60 s until the budget ends. A sample that no longer holds the plan re-applies the registry
 * plan (the register copy was already taken by `applyRegister`, so a re-apply never writes a second copy) and
 * counts as `clobbered` + `reapplied`. The final report is
 * `{minutes, samples, clobbered, reapplied, stable_at}`.
 *
 * The watch **does not remove the race**. It shrinks the window and quantifies what happened inside it; a save
 * that happens after the watch is still able to remove the entry. That is why every report carries
 * {@link REGISTER_RESIDUAL_RISK_LINE} and why the in-host route exists: on the panel path the client is by
 * definition running, so running the same watch inside the host (bounded to
 * {@link DEFAULT_ROUTE_WATCH_CAP_MS}) is the correct context, not a pretence that the race is gone.
 *
 * ## Two callers, one schedule
 *
 * The CLI cannot yield its event loop (`main()` is synchronous and the process exits), so it waits with an
 * injected `sleep` (production: `Atomics.wait`). The host route must not block the process for 30 s, so it waits
 * with an injected async `wait` (production: `setTimeout`). Both call {@link sampleWatchSchedule} so the timing,
 * the budget arithmetic and the report shape cannot drift between the two.
 */

import { recheckRegistry } from './registry-watch.mjs';

/** Delays before the first samples: 2 s / 8 s / 20 s / 60 s (milliseconds). */
export const WATCH_SAMPLE_DELAYS_MS = Object.freeze([2_000, 8_000, 20_000, 60_000]);

/** The delay between samples once the 60 s mark has been reached. */
export const WATCH_REPEAT_MS = 60_000;

/** The host route's hard cap for the in-process watch (30 s). */
export const DEFAULT_ROUTE_WATCH_CAP_MS = 30_000;

/**
 * The honest one-line residual risk every register report carries. Stated once, quoted everywhere.
 *
 * It does not say "could not be verified" (the watch does verify inside its window) and it does not say "safe":
 * the window has an end, and a client save after it still wins.
 */
export const REGISTER_RESIDUAL_RISK_LINE = 'a client save after the watch window can still remove it; re-run or enable the plugin route';

/** Normalize a minute budget into milliseconds; 0 means "no watch". */
export function watchBudgetMs(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 60_000);
}

/** The delay before sample `index` (0-based): 2 s, 8 s, 20 s, then every 60 s. */
export function watchSampleDelayMs(index) {
  const value = WATCH_SAMPLE_DELAYS_MS[index];
  return value === undefined ? WATCH_REPEAT_MS : value;
}

/**
 * The sampling schedule that fits inside a budget.
 *
 * A sample whose delay would land past the budget is not scheduled: the budget is a promise about wall time, and
 * a final sample taken after it would make the report claim a window that did not happen.
 *
 * @param {{minutes?: number, budgetMs?: number|null}} [input]
 * @returns {{budget_ms: number, delays_ms: number[]}}
 */
export function watchSampleSchedule(input = {}) {
  const budgetMs = Number.isSafeInteger(input.budgetMs) && input.budgetMs >= 0
    ? input.budgetMs
    : watchBudgetMs(input.minutes ?? 0);
  const delays = [];
  let planned = 0;
  for (let index = 0; ; index += 1) {
    const delay = watchSampleDelayMs(index);
    if (planned + delay > budgetMs) break;
    delays.push(delay);
    planned += delay;
    // Defensive bound: a caller that passes an absurd minute budget must not build an unbounded array.
    if (delays.length >= 10_000) break;
  }
  return { budget_ms: budgetMs, delays_ms: delays };
}

/**
 * Fold sample outcomes into the reported `watch` block.
 *
 * `samples` counts observations actually taken; `clobbered` counts samples whose first read no longer held the
 * plan; `reapplied` counts the re-applies attempted for those samples (a re-check re-applies the same registry
 * plan once). `stable_at` is the ISO time of the last sample that verified the registry afterwards, or `null`
 * when no sample ever held -- which is a different, worse state than "0 clobbers".
 *
 * @param {{minutes: number, budget_ms: number, observations: Array<{at: string|null, ok: boolean, rewrote: boolean}>}} input
 * @returns {{minutes: number, samples: number, clobbered: number, reapplied: number, stable_at: string|null}}
 */
export function summarizeRegisterWatch(input) {
  const observations = Array.isArray(input.observations) ? input.observations : [];
  let clobbered = 0;
  let reapplied = 0;
  let stableAt = null;
  for (const observation of observations) {
    if (observation?.rewrote === true) {
      clobbered += 1;
      reapplied += 1;
    }
    if (observation?.ok === true) stableAt = typeof observation.at === 'string' ? observation.at : stableAt;
    else stableAt = null;
  }
  return {
    minutes: Number.isFinite(input.minutes) ? input.minutes : 0,
    samples: observations.length,
    clobbered,
    reapplied,
    stable_at: stableAt,
  };
}

/** One sample: re-check, and describe what happened in the shape the summary folds. */
function sampleOnce({ dshHome, plan, recheck, now }) {
  const at = new Date(now()).toISOString();
  try {
    const outcome = recheck({ dshHome, plan });
    return { at, ok: outcome?.ok === true, rewrote: outcome?.rewrote === true, detail: outcome?.detail ?? null };
  } catch (error) {
    return { at, ok: false, rewrote: false, detail: `the re-check threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The shared walk: wait for each planned delay, sample, stop at the budget.
 *
 * The `wait` function is what differs between the synchronous CLI and the asynchronous host route; everything
 * else (schedule, budget arithmetic, re-apply decision in `recheckRegistry`, report shape) is this one loop.
 *
 * @param {{
 *   dshHome: string, plan: object, minutes?: number, budgetMs?: number|null,
 *   wait: (ms: number) => (void|Promise<void>), now: () => number, recheck?: Function,
 * }} input
 * @returns {Promise<object>} the `watch` report
 */
export async function sampleWatchSchedule(input) {
  const minutes = Number.isFinite(input.minutes) ? input.minutes : 0;
  const schedule = watchSampleSchedule({ minutes, budgetMs: input.budgetMs });
  const observations = [];
  const recheck = typeof input.recheck === 'function' ? input.recheck : recheckRegistry;
  if (schedule.delays_ms.length === 0) {
    return summarizeRegisterWatch({ minutes, budget_ms: schedule.budget_ms, observations });
  }
  const startMs = input.now();
  for (const delay of schedule.delays_ms) {
    // Stop when the real clock says the budget is exhausted, so an injected clock that moved (a suspended host,
    // a test) cannot make the loop sample past its own end.
    if (input.now() - startMs + delay > schedule.budget_ms) break;
    await input.wait(delay);
    observations.push(sampleOnce({ dshHome: input.dshHome, plan: input.plan, recheck, now: input.now }));
  }
  return summarizeRegisterWatch({ minutes, budget_ms: schedule.budget_ms, observations });
}

/**
 * The CLI's synchronous watch: same schedule, `Atomics.wait`-shaped sleeping injected by the caller.
 *
 * @param {{
 *   dshHome: string, plan: object, minutes?: number, budgetMs?: number|null,
 *   sleep: (ms: number) => void, now?: () => number, recheck?: Function,
 * }} input
 * @returns {{minutes: number, samples: number, clobbered: number, reapplied: number, stable_at: string|null}}
 */
export function watchRegistrationSync(input) {
  const minutes = Number.isFinite(input.minutes) ? input.minutes : 0;
  const schedule = watchSampleSchedule({ minutes, budgetMs: input.budgetMs });
  const now = typeof input.now === 'function' ? input.now : Date.now;
  const recheck = typeof input.recheck === 'function' ? input.recheck : recheckRegistry;
  const observations = [];
  const startMs = now();
  for (const delay of schedule.delays_ms) {
    if (now() - startMs + delay > schedule.budget_ms) break;
    input.sleep(delay);
    observations.push(sampleOnce({ dshHome: input.dshHome, plan: input.plan, recheck, now }));
  }
  return summarizeRegisterWatch({ minutes, budget_ms: schedule.budget_ms, observations });
}
