/**
 * DSH-GPW -- Global Permission Watchdog (v1.0.5), shipped as an OPTIONAL sub-plugin of @twinsearth/w2m-dsh-plugin.
 *
 * ## What it does, in one paragraph
 *
 * It answers permission requests on the `approval/request` waterfall with a hard global budget: **at most 10
 * auto-approvals per rolling 60 s, at least 3000 ms apart.** Anything past either limit returns `next()`, which is
 * *"no opinion"* -- the request falls through to the human prompt and **waits**. It never refuses, and it never
 * changes what is being asked; it only decides who answers and how fast.
 *
 * ## Why the budget exists
 *
 * Every auto-approval is a permission decision made without a human reading it. A watchdog with no ceiling is a
 * plugin that grants everything and is indistinguishable from one that is working correctly -- the failure mode this
 * repository has recorded seven times. The two counters it logs (`allowedTotal`, `deferredTotal`) exist so that
 * "mounted and doing nothing" and "mounted and working" look different.
 *
 * ## How it is enabled -- it is NOT on by default
 *
 * Installing this package does **not** mount the watchdog: its own `dsh.bundle.patch` mounts only the w2m plugin.
 * To enable it, add ONE `insert:` to the profile's `cordis.patch.yml`:
 *
 *     - insert:
 *         - id: dsh-gpw
 *           name: '@twinsearth/w2m-dsh-plugin/gpw'
 *           config:
 *             maxPerWindow: 10      # optional; these are the defaults
 *             windowMs: 60000
 *             minGapMs: 3000
 *
 * `insert:` is required: no earlier layer creates a `dsh-gpw` row, and a bare `- id:` patch aimed at a
 * non-existent row is skipped **silently**. Remove the row to disable it again -- no other change is needed.
 *
 * ## Its dependency, and the bug that shipped in the standalone copy
 *
 * `inject = ['approval']`. The first version of this module declared `{ required: ['approval'] }`; the host reads
 * `inject` as an array (**283 array-shaped declarations across the shipped tree, 0 object-shaped**), so it waited
 * for a service named `required` and stayed `pending (waiting for service: required)` forever. `approval` itself
 * exists: `@deepseek-ai/dsh-base`'s patch mounts `@deepseek-ai/dsh-user-approval` as id `approval`.
 *
 * ## Provenance
 *
 * Written as a standalone package `dsh-approval-ratelimit@1.0.0`, then folded in here so a fleet operator installs
 * one thing. The logic is unchanged apart from the name and the `inject` fix; every comment explaining a decision is
 * the original.
 */

/** @type {import('node:timers').Timeout | null} */
let logTimer = null;

export const name = 'dsh-gpw';

export const inject = ['approval'];

/**
 * @param {object} ctx Cordis context.
 * @param {object} [config]
 * @param {number} [config.maxPerWindow] Auto-approvals allowed per rolling window. Default 10.
 * @param {number} [config.windowMs] Window length in ms. Default 60000.
 * @param {number} [config.minGapMs] Minimum gap between two auto-approvals, in ms. Default 3000.
 */
export function apply(ctx, config = {}) {
  const maxPerWindow = positiveInt(config.maxPerWindow, 10);
  const windowMs = positiveInt(config.windowMs, 60_000);
  const minGapMs = positiveInt(config.minGapMs, 3_000);

  /** Timestamps of the auto-approvals inside the current window, oldest first. */
  const approvals = [];
  /** Timestamp of the most recent auto-approval, or null. */
  let lastApprovalAt = null;
  /** Counters for the periodic line, so the operator can see this thing working. */
  let deferredTotal = 0;
  let allowedTotal = 0;

  /**
   * Drop approvals that have aged out of the window.
   *
   * A rolling window is the requirement; a fixed one would allow a burst of `2 * maxPerWindow`
   * straddling a boundary (ten at the end of one minute, ten at the start of the next).
   *
   * @param {number} now
   */
  function prune(now) {
    const cutoff = now - windowMs;
    while (approvals.length > 0 && approvals[0] <= cutoff) approvals.shift();
  }

  /**
   * Decide one request, without ever rejecting.
   *
   * @param {number} now
   * @returns {{ allow: boolean, reason: string, inWindow: number }}
   */
  function decide(now) {
    prune(now);
    if (lastApprovalAt !== null && now - lastApprovalAt < minGapMs) {
      return {
        allow: false,
        reason: `only ${now - lastApprovalAt} ms since the last auto-approval (needs ${minGapMs} ms)`,
        inWindow: approvals.length,
      };
    }
    if (approvals.length >= maxPerWindow) {
      return {
        allow: false,
        reason: `${approvals.length} auto-approvals already in the last ${Math.round(windowMs / 1000)} s (limit ${maxPerWindow})`,
        inWindow: approvals.length,
      };
    }
    return { allow: true, reason: 'within both limits', inWindow: approvals.length };
  }

  /**
   * One line per window of real activity, so a silent plugin and a broken plugin look different.
   *
   * The failure mode this guards against is the one this whole session keeps meeting: a component
   * that is mounted, doing nothing, and indistinguishable from a healthy one. `allowedTotal` and
   * `deferredTotal` are the two numbers that tell them apart.
   */
  function startReporter() {
    if (logTimer !== null) return () => {};
    logTimer = setInterval(() => {
      if (allowedTotal === 0 && deferredTotal === 0) return;
      ctx.logger?.info?.(
        `approval-ratelimit: ${allowedTotal} auto-approved, ${deferredTotal} deferred to the human `
        + `(limit ${maxPerWindow}/${Math.round(windowMs / 1000)}s, gap ${minGapMs}ms, ${approvals.length} in the current window)`,
      );
    }, windowMs);
    logTimer.unref?.();
    return () => {
      if (logTimer !== null) {
        clearInterval(logTimer);
        logTimer = null;
      }
    };
  }

  /**
   * The answerer.
   *
   * Registered on the `approval/request` waterfall. Returning `'allowed-once'` grants this one
   * request; returning `next()` is "no opinion" and hands the decision to whoever answers next --
   * which is the human prompt, and it *waits* there rather than being refused.
   */
  const disposeListener = ctx.on('approval/request', (request, next) => {
    const now = Date.now();
    const verdict = decide(now);
    if (!verdict.allow) {
      deferredTotal += 1;
      // Debug, not warn: deferring is the designed behaviour of this plugin, and warning about the
      // normal path trains an operator to ignore the line that would matter.
      ctx.logger?.debug?.(
        `approval-ratelimit: deferring to the human -- ${verdict.reason}`
        + (request?.toolName ? ` (tool ${request.toolName})` : ''),
      );
      return next();
    }
    approvals.push(now);
    lastApprovalAt = now;
    allowedTotal += 1;
    ctx.logger?.info?.(
      `approval-ratelimit: auto-approved (${approvals.length}/${maxPerWindow} in the current window)`
      + (request?.toolName ? ` tool ${request.toolName}` : '')
      + (request?.reason ? ` -- ${request.reason}` : ''),
    );
    return 'allowed-once';
  });

  const stopReporter = startReporter();

  // Reversible: the host owns this effect, so an unload removes the answerer and the timer with it.
  // A listener that outlived its plugin would keep approving requests with nobody watching.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposeListener?.();
      stopReporter();
    });
  } else {
    // No effect seam: say so rather than pretending the cleanup is guaranteed.
    ctx.logger?.warn?.(
      'approval-ratelimit: the context provides no ctx.effect, so the answerer and its reporter '
      + 'cannot be released on unload',
    );
  }

  ctx.logger?.info?.(
    `approval-ratelimit: active -- at most ${maxPerWindow} auto-approvals per ${Math.round(windowMs / 1000)} s, `
    + `at least ${minGapMs} ms apart, process-wide; everything else waits for the human`,
  );
}

/**
 * Coerce a config value to a positive integer, falling back to the default.
 *
 * A misconfigured limit must not silently become "0", which would disable the plugin while looking
 * like it was on -- and must not become a non-finite number, which would break the comparison.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
