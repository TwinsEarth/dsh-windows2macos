/**
 * Wall-clock time in a named zone: parsing, converting, and finding the next daily occurrence.
 *
 * ## Why this is shared rather than duplicated
 *
 * Two features need "every day at HH:mm:ss in a named zone, on a machine whose own zone may differ": the
 * plugin's self-update check (00:00/03:00/05:00) and the session backup (22:00). The arithmetic is not obvious
 * -- DST means a local time can be missing or repeated, the offset must come from `Intl` rather than a hardcoded
 * number, and a naive `+24h` drifts across a change. A second copy written for the backup would be a second set
 * of answers to the same question, and the two would disagree exactly on the days a user notices.
 *
 * So the math lives here, once. `src/plugin/schedule.mjs` keeps the scheduler that owns a timer; this module
 * keeps the calendar.
 *
 * ## The one thing a caller must know
 *
 * `nextOccurrence`/`nextSlot` are inclusive of the lower bound for the exact instant; `missedSlot` is strictly
 * exclusive. That split is what makes "arm the next timer" and "one catch-up run after sleep" compose without
 * running a slot twice or skipping one.
 */

/** Milliseconds in a second, spelled rather than literal: the arithmetic reads as calendar work. */
export const SECOND_MS = 1000;

/** Milliseconds in a day. */
export const DAY_MS = 86_400 * SECOND_MS;

/** Default zone for both scheduled features. Beijing has observed UTC+8 with no DST since 1991. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** Error codes a caller may match on. */
export const CLOCK_CODES = Object.freeze({
  TIME_INVALID: 'SCHEDULE_TIME_INVALID',
  ZONE_INVALID: 'SCHEDULE_ZONE_INVALID',
});

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Parse `HH:mm:ss` into a second-of-day.
 *
 * Strict on purpose: the value usually arrives from configuration, and a silently-accepted `"25:00"` or
 * `"1:00"` would move the check to a time the user never asked for.
 *
 * @param {string} value `HH:mm:ss`
 * @returns {number} Seconds since local midnight, 0-86399.
 * @throws {Error} `SCHEDULE_TIME_INVALID` when the value is not a valid time.
 */
export function parseTimeOfDay(value) {
  const match = typeof value === 'string' ? TIME_RE.exec(value) : null;
  if (!match) {
    throw Object.assign(new Error(`invalid time ${JSON.stringify(value)}: expected HH:mm:ss`), { code: CLOCK_CODES.TIME_INVALID });
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw Object.assign(new Error(`invalid time ${JSON.stringify(value)}: out of range`), { code: CLOCK_CODES.TIME_INVALID });
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Format a second-of-day back to `HH:mm:ss`.
 *
 * @param {number} seconds Seconds since local midnight.
 * @returns {string} The `HH:mm:ss` spelling.
 */
export function formatTimeOfDay(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, '0')).join(':');
}

/**
 * Normalize a list of times into ascending unique order.
 *
 * Duplicates matter: two identical entries would arm two timers for one instant and run the check twice.
 *
 * @param {string[]} times `HH:mm:ss` values; an empty list falls back to `fallback`.
 * @param {readonly string[]} fallback Times to use when the caller supplies none.
 * @returns {{seconds: number[], formatted: string[]}} Normalized values.
 * @throws {Error} `SCHEDULE_TIME_INVALID` on any malformed entry.
 */
export function normalizeTimes(times, fallback) {
  const list = Array.isArray(times) && times.length > 0 ? times : fallback;
  const seconds = [...new Set(list.map(parseTimeOfDay))].sort((a, b) => a - b);
  return { seconds, formatted: seconds.map(formatTimeOfDay) };
}

/** Cached `Intl.DateTimeFormat` per zone; constructing one is not cheap. */
const formatters = new Map();

/** Build (and cache) a wall-clock formatter for a zone. */
function formatterFor(timeZone) {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
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
    throw Object.assign(new Error(`invalid time zone ${JSON.stringify(timeZone)}`), { code: CLOCK_CODES.ZONE_INVALID, cause });
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Read an instant as wall-clock fields in a zone.
 *
 * The offset is derived from `Intl` rather than hardcoded, so a configured zone other than Beijing still gets
 * correct results -- including zones that observe DST.
 *
 * @param {number} epochMs The instant.
 * @param {string} timeZone IANA zone name.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, offsetMs: number}}
 */
export function zonedParts(epochMs, timeZone) {
  const formatter = formatterFor(timeZone);
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  // `wall` is the zone's wall clock misread as UTC; the offset is the gap. Only second resolution matters, so
  // dropping milliseconds is safe and keeps the returned instant aligned to a second boundary.
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

/** Offset of the zone for a local date, sampled at local noon (never in a DST gap). */
function offsetForLocalDate(parts, timeZone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  return zonedParts(guess, timeZone).offsetMs;
}

/**
 * The next instant at or after `fromMs` whose local wall clock in `timeZone` equals `secondOfDay`.
 *
 * @param {number} fromMs Lower bound, inclusive.
 * @param {number} secondOfDay Target second since local midnight.
 * @param {string} [timeZone] IANA zone name.
 * @returns {number} The next matching instant, epoch milliseconds.
 */
export function nextOccurrence(fromMs, secondOfDay, timeZone = DEFAULT_TIME_ZONE) {
  formatterFor(timeZone);
  const parts = zonedParts(fromMs, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    // Walk local calendar days by rebuilding the date from its parts, so month and year rollover are handled by
    // `Date.UTC` rather than by arithmetic.
    const dayProbe = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, 12, 0, 0);
    const dayParts = zonedParts(dayProbe, timeZone);
    const offset = offsetForLocalDate({ year: dayParts.year, month: dayParts.month, day: dayParts.day }, timeZone);
    // The wall clock misread as UTC, minus the offset, is the true instant.
    const candidate = Date.UTC(dayParts.year, dayParts.month - 1, dayParts.day, 0, 0, 0) + secondOfDay * SECOND_MS - offset;
    if (candidate >= fromMs) return candidate;
  }
  throw new Error(`no occurrence of ${formatTimeOfDay(secondOfDay)} within 3 days in ${timeZone}`);
}

/**
 * The next scheduled instant strictly after `afterMs`, over a set of times.
 *
 * @param {number} afterMs Exclusive lower bound.
 * @param {number[]} timesSeconds Normalized times, seconds since local midnight.
 * @param {string} [timeZone] IANA zone name.
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
 * Strictly before `nowMs`: a slot that is exactly now is not missed. It is about to be armed by `nextSlot`,
 * which is inclusive, so treating it as missed here would both run the check and arm a timer for the same
 * instant.
 *
 * @param {number} nowMs The current instant.
 * @param {number[]} timesSeconds Normalized times.
 * @param {string} [timeZone] IANA zone name.
 * @param {number} [maxAgeMs] How far back a missed slot still counts.
 * @returns {{atMs: number, secondOfDay: number, time: string}|null} The slot, or null.
 */
export function missedSlot(nowMs, timesSeconds, timeZone = DEFAULT_TIME_ZONE, maxAgeMs = DAY_MS) {
  const nowParts = zonedParts(nowMs, timeZone);
  let best = null;
  for (const seconds of timesSeconds) {
    // Only today and yesterday can hold a recent occurrence, and both are tested rather than deriving
    // "yesterday" from the next occurrence: when the next occurrence is almost a full day away, that derivation
    // lands two days back and reports a slot that never happened as if it had.
    for (const backDays of [0, 1]) {
      const dayProbe = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day - backDays, 12, 0, 0);
      const dayParts = zonedParts(dayProbe, timeZone);
      const offset = offsetForLocalDate({ year: dayParts.year, month: dayParts.month, day: dayParts.day }, timeZone);
      const candidate = Date.UTC(dayParts.year, dayParts.month - 1, dayParts.day, 0, 0, 0) + seconds * SECOND_MS - offset;
      if (candidate >= nowMs) continue; // exactly-now belongs to nextSlot, which is inclusive
      if (nowMs - candidate > maxAgeMs) continue;
      if (!best || candidate > best.atMs) {
        best = { atMs: candidate, secondOfDay: seconds, time: formatTimeOfDay(seconds) };
      }
    }
  }
  return best;
}
