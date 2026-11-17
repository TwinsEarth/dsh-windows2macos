/**
 * Daily wall-clock scheduling for the plugin's self-update check.
 *
 * The requirement is "every day at 00:00, 03:00 and 05:00 Beijing time". Three things make that harder than a
 * `setInterval(24h)`:
 *
 *   1. **It is a wall-clock time in a named zone, not an interval.** The machine may sit in any time zone; the
 *      times are Beijing's. The conversion therefore goes through the zone rather than the host's local clock.
 *   2. **The machine sleeps.** A laptop closed at 23:50 and opened at 08:00 has missed all three slots. The
 *      user's intent is a daily check, not three reminders, so the check runs **once** on wake and the normal
 *      schedule resumes -- not three times in a row.
 *   3. **Timers drift and clocks jump.** Every wake re-derives the next instant from the current clock instead
 *      of trusting an accumulated delay.
 *
 * ## What moved, and why
 *
 * The calendar arithmetic (zone conversion, next/missed occurrence) now lives in `src/util/daily-clock.mjs`,
 * because the session backup schedules "daily at 22:00" too and a second copy would answer the same question
 * differently on exactly the days a user notices. What stays here is the part that owns something: the timer.
 *
 * `dsh-schedule` was the obvious candidate to delegate this to and it is the wrong tool: its reminders are bound
 * to an Agent Session and are delivered by appending a message to that Session's inbox. Its own README states it
 * "cannot be mounted alone in a headless or SDK-only composition" and that the shipped Web composition carries no
 * `schedule` row. A plugin-owned recurring job has no Session to bind to, so it owns its timer -- reversibly, via
 * `ctx.effect`.
 */

import {
  DAY_MS,
  SECOND_MS,
  CLOCK_CODES,
  DEFAULT_TIME_ZONE,
  formatTimeOfDay,
  missedSlot,
  nextOccurrence,
  nextSlot,
  normalizeTimes as normalizeClockTimes,
  parseTimeOfDay,
  zonedParts,
} from '../util/daily-clock.mjs';

/** Default check times: midnight, 03:00 and 05:00. */
export const DEFAULT_DAILY_TIMES = Object.freeze(['00:00:00', '03:00:00', '05:00:00']);

/** Hard error code for a malformed `HH:mm:ss`; owned by the shared clock module. */
export const SCHEDULE_TIME_INVALID = CLOCK_CODES.TIME_INVALID;

/** Hard error code for an unusable IANA zone name; owned by the shared clock module. */
export const SCHEDULE_ZONE_INVALID = CLOCK_CODES.ZONE_INVALID;

/** setTimeout saturates above 2^31-1 ms; longer waits must be re-armed. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How late a slot may be and still run on startup.
 *
 * Deliberately much shorter than a day. With a day-long window the scheduler would fire at whatever hour the
 * process happened to start -- 06:00, 14:00, whenever -- because some slot from the last 24 hours always
 * qualifies. That turns "check daily at 00:00/03:00/05:00" into "check at every start", which is not what was
 * asked and would also mean three checks on a restart-heavy day.
 *
 * 90 minutes covers the real case (a machine asleep across one slot, or a slow boot) without inventing runs at
 * unrelated hours. A caller with different needs passes `catchUpMs` explicitly.
 */
export const DEFAULT_CATCH_UP_MS = 90 * 60_000;

/**
 * Normalize a list of times into ascending unique order, defaulting to this feature's slots.
 *
 * @param {string[]} times `HH:mm:ss` values.
 * @returns {{seconds: number[], formatted: string[]}} Normalized values.
 * @throws {Error} `SCHEDULE_TIME_INVALID` on any malformed entry.
 */
export function normalizeTimes(times) {
  return normalizeClockTimes(times, DEFAULT_DAILY_TIMES);
}

export {
  DAY_MS,
  DEFAULT_TIME_ZONE,
  SECOND_MS,
  formatTimeOfDay,
  missedSlot,
  nextOccurrence,
  nextSlot,
  parseTimeOfDay,
  zonedParts,
};

/**
 * Create a daily scheduler.
 *
 * Every side effect is reachable from `stop()`, so the caller can hand it to `ctx.effect` and be certain no timer
 * survives a plugin unload. The timer is `unref`'d: a pending check must never be the reason a process stays
 * alive.
 *
 * @param {object} options Scheduler options.
 * @param {(info: {scheduledAtMs: number, ranAtMs: number, slot: string, late: boolean}) => (void|Promise<void>)} options.run
 *   Invoked once per due slot. Rejections are routed to `onError` and never escape, so one failing check cannot
 *   kill the schedule.
 * @param {string[]} [options.times] `HH:mm:ss` slots; defaults to 00:00/03:00/05:00.
 * @param {string} [options.timeZone] IANA zone; defaults to Asia/Shanghai.
 * @param {number} [options.catchUpMs] How late a missed slot may be and still run.
 * @param {(err: Error) => void} [options.onError] Error sink; defaults to a no-op.
 * @param {() => number} [options.nowMs] Clock, injectable for tests.
 * @param {(fn: () => void, ms: number) => any} [options.setTimer] Timer, injectable.
 * @param {(h: any) => void} [options.clearTimer] Timer canceller, injectable.
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
        // Late means the timer was not merely imprecise but genuinely delayed -- a suspended machine, not timer
        // jitter.
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
        // Report the deadline that was actually missed, then continue normally. One catch-up run for any number
        // of missed slots: the user asked for a daily check, not one per skipped hour.
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
