/**
 * The backup schedule's configuration: when the daily run happens, and what "a valid configuration" means.
 *
 * ## Defaults, and the one the user asked for
 *
 * One run a day at **22:00 Asia/Shanghai**, changeable per machine. The user's instruction was "每天定时（默认晚上
 * 10 点，用户也可自行更改）"; a backup that fires at an unpredictable hour is worse than no schedule, because it
 * competes with the work the machine is doing.
 *
 * ## Catch-up covers sleep, not every restart
 *
 * A laptop asleep at 22:00 should still back up once when it wakes -- a daily backup that silently skips days is
 * the failure mode the schedule exists to prevent. But a long catch-up window would also turn "daily at 22:00"
 * into "at every start", so the window is bounded: `DEFAULT_CATCH_UP_MS` is 12 hours, which covers an overnight
 * sleep and a late-morning wake, and refuses to run at 21:00 for a slot that was due yesterday.
 *
 * ## Validation is strict and named
 *
 * Times and zones arrive from configuration (and, later, from the panel). A malformed value is refused with a
 * specific code rather than quietly replaced with the default: a silent fallback would mean the user's "23:30"
 * becomes 22:00 and nobody ever learns why the backup runs at the wrong time.
 */

import {
  CLOCK_CODES,
  DEFAULT_TIME_ZONE,
  missedSlot,
  nextSlot,
  normalizeTimes as normalizeClockTimes,
} from '../util/daily-clock.mjs';

/** The default daily slot: 22:00 in the default zone. */
export const DEFAULT_BACKUP_TIME = '22:00:00';

/** Default zone for the schedule. */
export const DEFAULT_BACKUP_TIME_ZONE = DEFAULT_TIME_ZONE;

/** How late a missed slot may be and still run on startup. */
export const DEFAULT_BACKUP_CATCH_UP_MS = 12 * 60 * 60 * 1000;

/** Named schedule failure codes. */
export const BACKUP_SCHEDULE_CODES = Object.freeze({
  TIME_INVALID: 'BACKUP_SCHEDULE_TIME_INVALID',
  ZONE_INVALID: 'BACKUP_SCHEDULE_ZONE_INVALID',
});

/** A backup-schedule configuration failure with a stable code. */
export class BackupScheduleError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'BackupScheduleError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/**
 * Normalize configured times to `HH:mm:ss`, ascending and unique.
 *
 * `HH:mm` is accepted because that is how a person writes "22:00"; the canonical stored form is still `HH:mm:ss`,
 * which is what the scheduler and the config row use.
 *
 * @param {string[]} [times]
 * @returns {string[]}
 * @throws {BackupScheduleError} `BACKUP_SCHEDULE_TIME_INVALID`
 */
export function normalizeBackupTimes(times) {
  const list = Array.isArray(times) && times.length > 0 ? times : [DEFAULT_BACKUP_TIME];
  const padded = list.map((value) => (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value.trim()) ? `${value.trim()}:00` : value));
  try {
    return normalizeClockTimes(padded, [DEFAULT_BACKUP_TIME]).formatted;
  } catch (error) {
    if (error?.code === CLOCK_CODES.TIME_INVALID) {
      throw new BackupScheduleError(BACKUP_SCHEDULE_CODES.TIME_INVALID, error.message);
    }
    throw error;
  }
}

/** Validate an IANA zone name by asking `Intl` to build a formatter for it. */
export function validateBackupTimeZone(timeZone) {
  const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : DEFAULT_BACKUP_TIME_ZONE;
  try {
    // Constructing the formatter is the check; an unknown zone throws RangeError.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    throw new BackupScheduleError(BACKUP_SCHEDULE_CODES.ZONE_INVALID, `invalid time zone ${JSON.stringify(zone)}`);
  }
}

/**
 * Normalize a whole backup-schedule configuration.
 *
 * @param {{enabled?: boolean, times?: string[], timeZone?: string, catchUpMs?: number}} [config]
 * @returns {{ok: true, enabled: boolean, times: string[], time_zone: string, catch_up_ms: number}
 *   | {ok: false, reason_code: string, detail: string}}
 */
export function normalizeBackupSchedule(config = {}) {
  try {
    const times = normalizeBackupTimes(config.times);
    const timeZone = validateBackupTimeZone(config.timeZone);
    const catchUpMs = Number.isSafeInteger(config.catchUpMs) && config.catchUpMs > 0
      ? config.catchUpMs
      : DEFAULT_BACKUP_CATCH_UP_MS;
    return {
      ok: true,
      enabled: config.enabled !== false,
      times,
      time_zone: timeZone,
      catch_up_ms: catchUpMs,
    };
  } catch (error) {
    if (error instanceof BackupScheduleError) return { ok: false, reason_code: error.code, detail: error.detail };
    return { ok: false, reason_code: 'BACKUP_SCHEDULE_INVALID', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The next instant a configured set of times occurs, at or after `nowMs`.
 *
 * @param {number} nowMs
 * @param {string[]} times normalized `HH:mm:ss`
 * @param {string} [timeZone]
 * @returns {{atMs: number, time: string}}
 */
export function nextBackupAt(nowMs, times, timeZone = DEFAULT_BACKUP_TIME_ZONE) {
  const normalized = times.length > 0 ? times : [DEFAULT_BACKUP_TIME];
  const seconds = normalized.map((value) => {
    const [hours, minutes, rest] = value.split(':').map(Number);
    return hours * 3600 + minutes * 60 + (rest ?? 0);
  });
  const slot = nextSlot(nowMs, seconds, timeZone);
  return { atMs: slot.atMs, time: slot.time };
}

/**
 * The most recent configured time that was missed within the catch-up window.
 *
 * @param {number} nowMs
 * @param {string[]} times
 * @param {string} [timeZone]
 * @param {number} [catchUpMs]
 * @returns {{atMs: number, time: string}|null}
 */
export function missedBackupAt(nowMs, times, timeZone = DEFAULT_BACKUP_TIME_ZONE, catchUpMs = DEFAULT_BACKUP_CATCH_UP_MS) {
  const normalized = times.length > 0 ? times : [DEFAULT_BACKUP_TIME];
  const seconds = normalized.map((value) => {
    const [hours, minutes, rest] = value.split(':').map(Number);
    return hours * 3600 + minutes * 60 + (rest ?? 0);
  });
  const slot = missedSlot(nowMs, seconds, timeZone, catchUpMs);
  return slot === null ? null : { atMs: slot.atMs, time: slot.time };
}

/**
 * The schedule card a status surface shows.
 *
 * @param {{enabled?: boolean, times?: string[], timeZone?: string, nowMs?: number}} [options]
 * @returns {{enabled: boolean, times: string[], time_zone: string, next_at: string|null, next_time: string|null, implemented: boolean}}
 */
export function describeBackupSchedule(options = {}) {
  const normalized = normalizeBackupSchedule({ times: options.times, timeZone: options.timeZone });
  if (normalized.ok !== true) {
    return { enabled: false, times: [], time_zone: String(options.timeZone ?? DEFAULT_BACKUP_TIME_ZONE), next_at: null, next_time: null, implemented: true };
  }
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const next = nextBackupAt(nowMs, normalized.times, normalized.time_zone);
  return {
    enabled: options.enabled !== false,
    times: normalized.times,
    time_zone: normalized.time_zone,
    next_at: new Date(next.atMs).toISOString(),
    next_time: next.time,
    implemented: true,
  };
}
