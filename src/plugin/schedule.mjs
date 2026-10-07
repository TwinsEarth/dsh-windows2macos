/**
 * Daily wall-clock scheduling for the plugin's self-update check.
 *
 * The requirement is "every day at 00:00, 03:00 and 05:00 Beijing time". Three
 * things make that harder than a `setInterval(24h)`:
 *
 *   1. **It is a wall-clock time in a named zone, not an interval.** The machine
 *      may sit in any time zone; the times are Beijing's. We therefore convert
 *      through the zone rather than trusting the host's local clock.
 *   2. **The machine sleeps.** A laptop closed at 23:50 and opened at 08:00 has
 *      missed all three slots. The user's intent is a daily check, not three
 *      reminders, so we run the check **once** on wake and resume the normal
 *      schedule -- we do not fire three times in a row.
 *   3. **Timers drift and clocks jump.** Every wake re-derives the next instant
 *      from the current clock instead of trusting an accumulated delay.
 *
 * `dsh-schedule` was the obvious candidate to delegate this to and it is the
 * wrong tool: its reminders are bound to an Agent Session and are delivered by
 * appending a message to that Session's inbox. Its own README states it "cannot
 * be mounted alone in a headless or SDK-only composition" and that the shipped
 * Web composition carries no `schedule` row. A plugin-owned recurring job has no
 * Session to bind to, so it owns its timer -- reversibly, via `ctx.effect`.
 */

/** Default check times: midnight, 03:00 and 05:00. */
export const DEFAULT_DAILY_TIMES = Object.freeze(['00:00:00', '03:00:00', '05:00:00']);

/** Default zone. Beijing has observed UTC+8 with no DST since 1991. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** Hard error code for a malformed `HH:mm:ss`. */
export const SCHEDULE_TIME_INVALID = 'SCHEDULE_TIME_INVALID';

/** Hard error code for an unusable IANA zone name. */
export const SCHEDULE_ZONE_INVALID = 'SCHEDULE_ZONE_INVALID';

const SECOND_MS = 1000;
const DAY_MS = 86_400 * SECOND_MS;

/** setTimeout saturates above 2^31-1 ms; longer waits must be re-armed. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How late a slot may be and still run on startup.
 *
 * Deliberately much shorter than a day. With a day-long window the scheduler
 * would fire at whatever hour the process happened to start -- 06:00, 14:00,
 * whenever -- because some slot from the last 24 hours always qualifies. That
 * turns "check daily at 00:00/03:00/05:00" into "check at every start", which is
 * not what was asked and would also mean three checks on a restart-heavy day.
 *
 * 90 minutes covers the real case (a machine asleep across one slot, or a slow
 * boot) without inventing runs at unrelated hours. A caller with different needs
 * passes `catchUpMs` explicitly.
 */
export const DEFAULT_CATCH_UP_MS = 90 * 60_000;

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Parse `HH:mm:ss` into a second-of-day.
 *
 * Strict on purpose: the value usually arrives from configuration, and a
 * silently-accepted `"25:00"` or `"1:00"` would move the check to a time the
 * user never asked for.
 *
 * @param {string} value - `HH:mm:ss`, optionally with 1-3 fractional digits.
 * @returns {number} Seconds since local midnight, 0-86399.
 * @throws {Error} `SCHEDULE_TIME_INVALID` when the value is not a valid time.
 */
export function parseTimeOfDay(value) {
  const m = typeof value === 'string' ? TIME_RE.exec(value) : null;
  if (!m) {
    throw Object.assign(
      new Error(`invalid time ${JSON.stringify(value)}: expected HH:mm:ss`),
      { code: SCHEDULE_TIME_INVALID },
    );
  }
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3]);
  if (h > 23 || mi > 59 || s > 59) {
    throw Object.assign(
      new Error(`invalid time ${JSON.stringify(value)}: out of range`),
      { code: SCHEDULE_TIME_INVALID },
    );
  }
  return h * 3600 + mi * 60 + s;
}

/**
 * Format a second-of-day back to `HH:mm:ss`.
 *
 * @param {number} seconds - Seconds since local midnight.
 * @returns {string} The `HH:mm:ss` spelling.
 */
export function formatTimeOfDay(seconds) {
  const h = Math.floor(seconds / 3600);
  const mi = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, mi, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * Normalize a list of times into ascending unique order.
 *
 * Duplicates matter: two identical entries would arm two timers for one instant
 * and run the check twice.
 *
 * @param {string[]} times - `HH:mm:ss` values.
 * @returns {{seconds: number[], formatted: string[]}} Normalized values.
 * @throws {Error} `SCHEDULE_TIME_INVALID` on any malformed entry.
 */
export function normalizeTimes(times) {
  const list = Array.isArray(times) && times.length > 0 ? times : DEFAULT_DAILY_TIMES;
  const seconds = [...new Set(list.map(parseTimeOfDay))].sort((a, b) => a - b);
  return { seconds, formatted: seconds.map(formatTimeOfDay) };
}

/** Cached `Intl.DateTimeFormat` per zone; constructing one is not cheap. */
const formatters = new Map();

/**
 * Build (and cache) a wall-clock formatter for a zone.
 *
 * @param {string} timeZone - IANA zone name.
 * @returns {Intl.DateTimeFormat} Formatter yielding the zone's wall clock.
 * @throws {Error} `SCHEDULE_ZONE_INVALID` when the zone is not recognized.
 */
function formatterFor(timeZone) {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (cause) {
    throw Object.assign(
      new Error(`invalid time zone ${JSON.stringify(timeZone)}`),
      { code: SCHEDULE_ZONE_INVALID, cause },
    );
  }
  formatters.set(timeZone, fmt);
  return fmt;
}

/**
 * Read an instant as wall-clock fields in a zone.
 *
 * The offset is derived from `Intl` rather than hardcoded, so a configured zone
 * other than Beijing still gets correct results -- including zones that observe
 * DST.
 *
 * @param {number} epochMs - The instant.
 * @param {string} timeZone - IANA zone name.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, offsetMs: number}}
 *   Wall-clock fields plus the zone's offset at that instant.
 */
export function zonedParts(epochMs, timeZone) {
  const fmt = formatterFor(timeZone);
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(epochMs))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  // `wall` is the zone's wall clock misread as UTC; the offset is the gap. We
  // only need second resolution, so dropping milliseconds is safe and keeps the
  // returned instant aligned to a second boundary.
  const truncated = Math.floor(epochMs / SECOND_MS) * SECOND_MS;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    offsetMs: wall - truncated,
  };
}

/** Milliseconds since local midnight in the zone, for an instant. */
function secondOfDayIn(epochMs, timeZone) {
  const p = zonedParts(epochMs, timeZone);
  return p.hour * 3600 + p.minute * 60 + p.second;
}

/** Offset of the zone for the local date `YYYY-MM-DD`, sampled at local noon. */
function offsetForLocalDate(parts, timeZone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  return zonedParts(guess, timeZone).offsetMs;
}

/**
 * The next instant at or after `fromMs` whose local wall clock in `timeZone`
 * equals `secondOfDay`.
 *
 * @param {number} fromMs - Lower bound, inclusive.
 * @param {number} secondOfDay - Target second since local midnight.
 * @param {string} timeZone - IANA zone name.
 * @returns {number} The next matching instant, epoch milliseconds.
 */
export function nextOccurrence(fromMs, secondOfDay, timeZone = DEFAULT_TIME_ZONE) {
  formatterFor(timeZone);
  const p = zonedParts(fromMs, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    // Walk local calendar days by rebuilding the date from its parts, so month
    // and year rollover are handled by `Date.UTC` rather than by arithmetic.
    const dayProbe = Date.UTC(p.year, p.month - 1, p.day + dayOffset, 12, 0, 0);
    const dp = zonedParts(dayProbe, timeZone);
    const offset = offsetForLocalDate({ year: dp.year, month: dp.month, day: dp.day }, timeZone);
    // The wall clock misread as UTC, minus the offset, is the true instant.
    const candidate = Date.UTC(dp.year, dp.month - 1, dp.day, 0, 0, 0) + secondOfDay * SECOND_MS - offset;
    if (candidate >= fromMs) return candidate;
  }
  // Unreachable: any second-of-day recurs within 24h, and we searched 3 days.
  throw new Error(`no occurrence of ${formatTimeOfDay(secondOfDay)} within 3 days in ${timeZone}`);
}

/**
 * The next scheduled instant strictly after `afterMs`, over a set of times.
 *
 * @param {number} afterMs - Exclusive lower bound.
 * @param {number[]} timesSeconds - Normalized times, seconds since local midnight.
 * @param {string} timeZone - IANA zone name.
 * @returns {{atMs: number, secondOfDay: number, time: string}|null} The next slot.
 */
export function nextSlot(afterMs, timesSeconds, timeZone = DEFAULT_TIME_ZONE) {
  let best = null;
  for (const seconds of timesSeconds) {
    const candidate = nextOccurrence(afterMs + 1, seconds, timeZone);
    if (!best || candidate < best.atMs) best = { atMs: candidate, secondOfDay: seconds, time: formatTimeOfDay(seconds) };
  }
  return best;
}

/**
 * The scheduled slot most recently passed, within a catch-up window.
 *
 * Used when a timer fires late -- the machine was suspended, or the process
 * started after the slot -- so the check still happens once instead of being
 * silently skipped until tomorrow.
 *
 * Strictly before `nowMs`: a slot that is exactly now is not missed. It is about
 * to be armed by `nextSlot`, which is inclusive, so treating it as missed here
 * would both run the check and arm a timer for the same instant.
 *
 * @param {number} nowMs - The current instant.
 * @param {number[]} timesSeconds - Normalized times.
 * @param {string} timeZone - IANA zone name.
 * @param {number} [maxAgeMs] - How far back a missed slot still counts.
 * @returns {{atMs: number, secondOfDay: number, time: string}|null} The slot, or null.
 */
export function missedSlot(nowMs, timesSeconds, timeZone = DEFAULT_TIME_ZONE, maxAgeMs = DAY_MS) {
  const nowParts = zonedParts(nowMs, timeZone);
  let best = null;
  for (const seconds of timesSeconds) {
    // Only today and yesterday can hold a recent occurrence, and we test both
    // rather than deriving "yesterday" from the next occurrence: when the next
    // occurrence is almost a full day away, that derivation lands two days back
    // and reports a slot that never happened as if it had.
    for (const backDays of [0, 1]) {
      const dayProbe = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day - backDays, 12, 0, 0);
      const dp = zonedParts(dayProbe, timeZone);
      const offset = offsetForLocalDate({ year: dp.year, month: dp.month, day: dp.day }, timeZone);
      const candidate = Date.UTC(dp.year, dp.month - 1, dp.day, 0, 0, 0) + seconds * SECOND_MS - offset;
      if (candidate >= nowMs) continue; // exactly-now belongs to nextSlot, which is inclusive
      if (nowMs - candidate > maxAgeMs) continue;
      if (!best || candidate > best.atMs) {
        best = { atMs: candidate, secondOfDay: seconds, time: formatTimeOfDay(seconds) };
      }
    }
  }
  return best;
}

/**
 * Create a daily scheduler.
 *
 * Every side effect is reachable from `stop()`, so the caller can hand it to
 * `ctx.effect` and be certain no timer survives a plugin unload. The timer is
 * `unref`'d: a pending check must never be the reason a process stays alive.
 *
 * @param {object} options - Scheduler options.
 * @param {(info: {scheduledAtMs: number, ranAtMs: number, slot: string, late: boolean}) => (void|Promise<void>)} options.run
 *   Invoked once per due slot. Rejections are routed to `onError` and never
 *   escape, so one failing check cannot kill the schedule.
 * @param {string[]} [options.times] - `HH:mm:ss` slots; defaults to 00:00/03:00/05:00.
 * @param {string} [options.timeZone] - IANA zone; defaults to Asia/Shanghai.
 * @param {number} [options.catchUpMs] - How late a missed slot may be and still run.
 * @param {(err: Error) => void} [options.onError] - Error sink; defaults to a no-op.
 * @param {() => number} [options.nowMs] - Clock, injectable for tests.
 * @param {(fn: () => void, ms: number) => any} [options.setTimer] - Timer, injectable.
 * @param {(h: any) => void} [options.clearTimer] - Timer canceller, injectable.
 * @returns {object} `{start, stop, triggerNow, describe}`.
 */
export function createDailyScheduler(options) {
  const {
    run,
    times,
    timeZone = DEFAULT_TIME_ZONE,
    catchUpMs = DEFAULT_CATCH_UP_MS,
    onError = () => {},
    nowMs = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options ?? {};

  if (typeof run !== 'function') throw new TypeError('createDailyScheduler requires a run function');

  const normalized = normalizeTimes(times);

  const state = {
    running: false,
    /** @type {any} */ timer: null,
    nextAtMs: /** @type {number|null} */ (null),
    nextTime: /** @type {string|null} */ (null),
    lastRunMs: /** @type {number|null} */ (null),
    lastSlot: /** @type {string|null} */ (null),
    runs: 0,
    failures: 0,
    stopped: false,
  };

  /** Arm the timer for the next slot, re-deriving it from the current clock. */
  function arm() {
    if (state.stopped) return;
    const now = nowMs();
    const slot = nextSlot(now, normalized.seconds, timeZone);
    state.nextAtMs = slot.atMs;
    state.nextTime = slot.time;
    const delay = Math.max(0, Math.min(slot.atMs - now, MAX_TIMER_MS));
    state.timer = setTimer(fire, delay);
    // Never keep the event loop alive just to wait for a scheduled check.
    state.timer?.unref?.();
  }

  /** Run the check, then re-arm. Overlapping runs are impossible by construction. */
  async function fire() {
    if (state.stopped || state.running) return;
    state.running = true;
    const firedFor = state.nextAtMs;
    try {
      await run({
        scheduledAtMs: firedFor,
        ranAtMs: nowMs(),
        slot: state.nextTime,
        // Late means the timer was not merely imprecise but genuinely delayed --
        // a suspended machine, not timer jitter.
        late: firedFor === null ? false : nowMs() - firedFor > SECOND_MS,
      });
      state.runs += 1;
      state.lastRunMs = nowMs();
      state.lastSlot = state.nextTime;
    } catch (error) {
      state.failures += 1;
      try {
        onError(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // A throwing error sink must not break the schedule either.
      }
    } finally {
      state.running = false;
      arm();
    }
  }

  return {
    /** Arm the first timer, running a catch-up check if a slot was just missed. */
    start() {
      if (state.stopped) throw new Error('scheduler already stopped');
      const now = nowMs();
      const missed = missedSlot(now, normalized.seconds, timeZone, catchUpMs);
      if (missed) {
        // Report the deadline that was actually missed, then continue normally.
        // One catch-up run for any number of missed slots: the user asked for a
        // daily check, not one per skipped hour.
        state.nextAtMs = missed.atMs;
        state.nextTime = missed.time;
        void fire();
      } else {
        arm();
      }
    },
    /** Run the check immediately, without disturbing the daily schedule. */
    async triggerNow(reason = 'manual') {
      if (state.stopped) throw new Error('scheduler already stopped');
      try {
        await run({ scheduledAtMs: null, ranAtMs: nowMs(), slot: reason, late: false });
        state.runs += 1;
        state.lastRunMs = nowMs();
      } catch (error) {
        state.failures += 1;
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    /** Release the timer. Idempotent, and safe to call from a disposer. */
    stop() {
      state.stopped = true;
      if (state.timer !== null) {
        clearTimer(state.timer);
        state.timer = null;
      }
    },
    /** Diagnostic snapshot for `w2m_status`. Contains no seconds-resolution secrets. */
    describe() {
      return {
        time_zone: timeZone,
        times: normalized.formatted,
        catch_up_ms: catchUpMs,
        started: state.nextAtMs !== null,
        stopped: state.stopped,
        next_at_ms: state.nextAtMs,
        next_at: state.nextAtMs === null ? null : new Date(state.nextAtMs).toISOString(),
        next_time: state.nextTime,
        last_run_ms: state.lastRunMs,
        last_run: state.lastRunMs === null ? null : new Date(state.lastRunMs).toISOString(),
        last_slot: state.lastSlot,
        runs: state.runs,
        failures: state.failures,
        running: state.running,
      };
    },
  };
}
