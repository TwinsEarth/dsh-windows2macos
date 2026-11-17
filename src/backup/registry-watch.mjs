/**
 * The third half of gate G2: **re-check after the client saves**.
 *
 * ## The residual risk, stated once
 *
 * `workspace.json` is client-owned state. `applyRegistryRestore` writes it atomically and reads it back, which
 * proves the write landed -- not that it survives: the client holds the registry in memory and saves on its own
 * schedule, and the session vanished from the UI when that save overwrote the entry.
 *
 * ## What this module does about it
 *
 * After a restore, sample the registry again a few times (2 s / 8 s / 20 s by default). If a sample shows the
 * session's registration gone, re-apply the plan once and sample again. Every attempt is reported, so the caller can
 * say "verified, re-applied once after the client saved, verified again" instead of "probably fine".
 *
 * The timers are injectable: tests run the whole schedule synchronously, and the host route can pass its own
 * scheduler if it wants the work on a lifecycle it owns.
 *
 * ## Why not a file watcher
 *
 * The client's save is an atomic replace, so a watcher would fire for every unrelated registry change too. A small
 * number of samples covers the save that matters (the one in the seconds after our write) without holding a handle
 * on a user file for minutes.
 */

import { applyRegistryRestore, verifyRegistryWrite } from './registry.mjs';

/** Default sampling schedule, in milliseconds after the restore. */
export const DEFAULT_RECHECK_DELAYS = Object.freeze([2_000, 8_000, 20_000]);

/**
 * Sample the registry once; if the plan's promises no longer hold, re-apply the plan and verify again.
 *
 * @param {{dshHome: string, plan: object}} input
 * @returns {{ok: boolean, rewrote: boolean, detail: string|null, attempts: number}}
 */
export function recheckRegistry(input) {
  const first = verifyRegistryWrite({ dshHome: input.dshHome, plan: input.plan });
  if (first.ok === true) return { ok: true, rewrote: false, detail: null, attempts: 1 };
  const reapplied = applyRegistryRestore({ dshHome: input.dshHome, plan: input.plan });
  const second = verifyRegistryWrite({ dshHome: input.dshHome, plan: input.plan });
  return {
    ok: reapplied.ok === true && second.ok === true,
    rewrote: true,
    detail: reapplied.ok === true ? second.detail : reapplied.detail,
    attempts: 2,
  };
}

/**
 * Schedule the post-save re-checks.
 *
 * @param {{
 *   dshHome: string, plan: object, delaysMs?: number[],
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   onResult?: (result: {delay_ms: number, ok: boolean, rewrote: boolean, detail: string|null}) => void,
 * }} input
 * @returns {{cancel: () => void, results: Array<object>, promise: Promise<Array<object>>}}
 *   `promise` settles when the schedule is exhausted, which is how tests await it and how the panel can log the
 *   final state; production does not have to await it.
 */
export function scheduleRegistryRecheck(input) {
  const delays = Array.isArray(input.delaysMs) && input.delaysMs.length > 0 ? input.delaysMs : [...DEFAULT_RECHECK_DELAYS];
  const timers = input.timers ?? { setTimeout, clearTimeout };
  const results = [];
  const handles = [];
  let cancelled = false;
  let resolveDone;
  const promise = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let remaining = delays.length;
  const settle = () => {
    remaining -= 1;
    if (remaining <= 0) resolveDone(results);
  };
  for (const delay of delays) {
    handles.push(
      timers.setTimeout(() => {
        if (cancelled) {
          settle();
          return;
        }
        let result;
        try {
          const outcome = recheckRegistry({ dshHome: input.dshHome, plan: input.plan });
          result = { delay_ms: delay, ok: outcome.ok, rewrote: outcome.rewrote, detail: outcome.detail };
        } catch (error) {
          result = { delay_ms: delay, ok: false, rewrote: false, detail: `the re-check threw: ${error instanceof Error ? error.message : String(error)}` };
        }
        results.push(result);
        try {
          input.onResult?.(result);
        } catch {
          // A logging callback must not break the schedule.
        }
        settle();
      }, delay),
    );
  }
  return {
    cancel: () => {
      cancelled = true;
      for (const handle of handles) timers.clearTimeout(handle);
      resolveDone(results);
    },
    results,
    promise,
  };
}
