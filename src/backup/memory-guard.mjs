/**
 * The backup engine's memory-safety guard (`BACKUP_MEMORY_GUARD`, v3.5.1).
 *
 * ## Why this exists
 *
 * 3.5.0 crashed the DSH desktop host on enable: a missed-slot catch-up ran inside the mount path and the engine
 * materialised whole files (a 118 MB session log, 300 MB `old/` copies) into a 4 GB host heap that also carries
 * the Electron main process. V8 reported `Scavenge ... Allocation failed - JavaScript heap out of memory` and the
 * app could not start. The catch-up default is fixed in the plugin (`backupCatchUpOnStart: false`), but a guard
 * that refuses a materialisation **before** it is attempted is the second half: a single unexpected large file
 * (or a chain of small ones under pressure) can then never be the reason the host dies. A refusal is a named
 * result, not a crash.
 *
 * ## How the check is defined
 *
 * The caller states how many bytes it is about to allocate (`requestedBytes`) and the ceiling it is willing to
 * spend on this process's V8 heap (`maxHeapBytes`). The guard compares
 * `process.memoryUsage().heapUsed + requestedBytes + reservedBytes` against the ceiling. It deliberately uses
 * `heapUsed` (not RSS): buffers live in external memory, but the arrays/strings the engine builds from them do
 * live in the heap, and the host's 4 GB budget named in the incident is a V8-heap budget.
 *
 * The ceiling defaults to {@link DEFAULT_MAX_HEAP_BYTES} (~1.5 GB of a 4 GB host, leaving the rest for the
 * Electron main process and the V8 baseline). Callers may pass a smaller number (a worker's resource limit, the
 * CLI's `--max-heap-mb`, a test) or `0`/`null` to disable the guard explicitly -- an operator can always say
 * "attempt it anyway", but nothing silently ignores the guard.
 */

/** Named refusal code: the caller wanted to materialise more than the heap budget allows. */
export const BACKUP_MEMORY_GUARD = 'BACKUP_MEMORY_GUARD';

/** Default ceiling: 1.5 GB of `heapUsed` for a 4 GB desktop host. */
export const DEFAULT_MAX_HEAP_BYTES = Math.round(1.5 * 1024 ** 3);

/** The overhead a caller may reserve on top of the bytes it asked for (bookkeeping, strings, JSON). */
export const DEFAULT_GUARD_RESERVE_BYTES = 32 * 1024 ** 2;

/**
 * Normalise a configured heap ceiling.
 *
 * `undefined`/`null` means "use the default"; `0` or a negative number means "guard disabled" (returned as
 * `null`); anything else must be a positive finite number of bytes and is rounded down. A non-number is a
 * caller bug, not a policy: it is refused by name here rather than coerced.
 *
 * @param {unknown} value
 * @returns {{ok: true, maxHeapBytes: number|null} | {ok: false, reason_code: string, detail: string}}
 */
export function resolveMaxHeapBytes(value) {
  if (value === undefined || value === null) return { ok: true, maxHeapBytes: DEFAULT_MAX_HEAP_BYTES };
  if (typeof value === 'boolean') return { ok: false, reason_code: BACKUP_MEMORY_GUARD, detail: `maxHeapBytes must be a number of bytes, got ${String(value)}` };
  const number = Number(value);
  if (!Number.isFinite(number)) return { ok: false, reason_code: BACKUP_MEMORY_GUARD, detail: `maxHeapBytes must be a finite number, got ${String(value)}` };
  if (number <= 0) return { ok: true, maxHeapBytes: null };
  return { ok: true, maxHeapBytes: Math.floor(number) };
}

/**
 * Decide whether a materialisation of `requestedBytes` fits the remaining heap budget.
 *
 * @param {{requestedBytes?: number, maxHeapBytes?: number|null, reservedBytes?: number, label?: string,
 *   heapUsedBytes?: number}} [input]
 * @returns {{ok: true, code: null, heap_used_bytes: number, limit_bytes: number|null, requested_bytes: number,
 *   projected_bytes: number, headroom_bytes: number|null, label: string|null}
 *   | {ok: false, code: string, heap_used_bytes: number, limit_bytes: number|null, requested_bytes: number,
 *   projected_bytes: number, headroom_bytes: number, label: string|null, detail: string}}
 */
export function memoryGuard(input = {}) {
  const requested = Number.isFinite(input.requestedBytes) && input.requestedBytes > 0 ? Math.floor(input.requestedBytes) : 0;
  const reserved = Number.isFinite(input.reservedBytes) && input.reservedBytes > 0 ? Math.floor(input.reservedBytes) : DEFAULT_GUARD_RESERVE_BYTES;
  const label = typeof input.label === 'string' && input.label !== '' ? input.label : null;
  const heapUsed = Number.isFinite(input.heapUsedBytes) ? input.heapUsedBytes : process.memoryUsage().heapUsed;
  const resolution = resolveMaxHeapBytes(input.maxHeapBytes);
  const limit = resolution.ok === true ? resolution.maxHeapBytes : DEFAULT_MAX_HEAP_BYTES;
  const projected = heapUsed + requested + reserved;
  if (limit === null) {
    return {
      ok: true,
      code: null,
      heap_used_bytes: heapUsed,
      limit_bytes: null,
      requested_bytes: requested,
      projected_bytes: projected,
      headroom_bytes: null,
      label,
    };
  }
  if (resolution.ok !== true) {
    return {
      ok: false,
      code: BACKUP_MEMORY_GUARD,
      heap_used_bytes: heapUsed,
      limit_bytes: limit,
      requested_bytes: requested,
      projected_bytes: projected,
      headroom_bytes: 0,
      label,
      detail: resolution.detail,
    };
  }
  if (projected <= limit) {
    return {
      ok: true,
      code: null,
      heap_used_bytes: heapUsed,
      limit_bytes: limit,
      requested_bytes: requested,
      projected_bytes: projected,
      headroom_bytes: limit - projected,
      label,
    };
  }
  return {
    ok: false,
    code: BACKUP_MEMORY_GUARD,
    heap_used_bytes: heapUsed,
    limit_bytes: limit,
    requested_bytes: requested,
    projected_bytes: projected,
    headroom_bytes: limit - heapUsed,
    label,
    detail:
      `${label === null ? 'this materialisation' : label} would need ~${requested} byte(s) on top of ` +
      `${heapUsed} used of a ${limit}-byte budget (V8 heap); refusing instead of risking the host's OOM. ` +
      'Raise backupMaxHeapMb / input.maxHeapBytes only on a host that can afford it.',
  };
}

/**
 * Accumulate guard outcomes for a run report.
 *
 * @returns {{checks: number, refusals: number, refused: Array<{label: string|null, requested_bytes: number,
 *   heap_used_bytes: number, limit_bytes: number|null, detail: string}>, limit_bytes: null|number}}
 */
export function createMemoryGuardReport() {
  return { checks: 0, refusals: 0, refused: [], limit_bytes: null };
}

/**
 * Run one guard check and record it in the report.
 *
 * @param {ReturnType<typeof createMemoryGuardReport>} report
 * @param {Parameters<typeof memoryGuard>[0]} input
 * @returns {ReturnType<typeof memoryGuard>}
 */
export function checkMemory(report, input = {}) {
  const verdict = memoryGuard(input);
  if (report !== null && typeof report === 'object') {
    report.checks += 1;
    report.limit_bytes = verdict.limit_bytes;
    if (verdict.ok !== true) {
      report.refusals += 1;
      if (report.refused.length < 20) {
        report.refused.push({
          label: verdict.label,
          requested_bytes: verdict.requested_bytes,
          heap_used_bytes: verdict.heap_used_bytes,
          limit_bytes: verdict.limit_bytes,
          detail: verdict.detail,
        });
      }
    }
  }
  return verdict;
}
