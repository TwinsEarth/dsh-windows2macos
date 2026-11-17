/**
 * The backup schedule's configuration: defaults the user asked for, strict validation, and exact instants.
 *
 * The failure this guards against is silent -- a schedule that computes the wrong instant still runs, just at the
 * wrong time of day -- so the next/missed instants are pinned as exact UTC values in zones that make naive
 * arithmetic fail.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_SCHEDULE_CODES,
  DEFAULT_BACKUP_CATCH_UP_MS,
  DEFAULT_BACKUP_TIME,
  DEFAULT_BACKUP_TIME_ZONE,
  describeBackupSchedule,
  missedBackupAt,
  nextBackupAt,
  normalizeBackupSchedule,
  normalizeBackupTimes,
  validateBackupTimeZone,
} from '../src/backup/schedule.mjs';

const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

describe('schedule: defaults and normalization', () => {
  it('defaults to 22:00 Asia/Shanghai, once a day', () => {
    const config = normalizeBackupSchedule({});
    assert.equal(config.ok, true);
    assert.deepEqual(config.times, ['22:00:00']);
    assert.equal(config.time_zone, 'Asia/Shanghai');
    assert.equal(config.enabled, true);
    assert.equal(config.catch_up_ms, DEFAULT_BACKUP_CATCH_UP_MS);
    assert.equal(DEFAULT_BACKUP_TIME, '22:00:00');
    assert.equal(DEFAULT_BACKUP_TIME_ZONE, 'Asia/Shanghai');
  });

  it('accepts HH:mm the way a person writes it, sorts, and de-duplicates', () => {
    assert.deepEqual(normalizeBackupTimes(['22:00']), ['22:00:00']);
    assert.deepEqual(normalizeBackupTimes(['21:15', '06:30', '21:15']), ['06:30:00', '21:15:00']);
    assert.deepEqual(normalizeBackupTimes([]), ['22:00:00']);
    assert.deepEqual(normalizeBackupTimes(undefined), ['22:00:00']);
  });

  it('refuses a malformed time or zone with its own code, instead of silently using the default', () => {
    const badTime = normalizeBackupSchedule({ times: ['25:00'] });
    assert.equal(badTime.ok, false);
    assert.equal(badTime.reason_code, BACKUP_SCHEDULE_CODES.TIME_INVALID);
    const badZone = normalizeBackupSchedule({ timeZone: 'Mars/Olympus' });
    assert.equal(badZone.ok, false);
    assert.equal(badZone.reason_code, BACKUP_SCHEDULE_CODES.ZONE_INVALID);
    assert.throws(() => validateBackupTimeZone('Not/AZone'), (error) => error.code === BACKUP_SCHEDULE_CODES.ZONE_INVALID);
    assert.equal(validateBackupTimeZone('UTC'), 'UTC');
    assert.equal(validateBackupTimeZone(''), 'Asia/Shanghai');
  });

  it('honours an explicit disabled flag and a custom catch-up window', () => {
    const config = normalizeBackupSchedule({ enabled: false, times: ['06:30'], catchUpMs: 60_000 });
    assert.equal(config.enabled, false);
    assert.deepEqual(config.times, ['06:30:00']);
    assert.equal(config.catch_up_ms, 60_000);
  });
});

describe('schedule: exact instants', () => {
  it('finds Beijing 22:00 as 14:00 UTC, and does not re-fire an already-due slot', () => {
    const before = nextBackupAt(utc(2026, 11, 17, 0, 0, 0), ['22:00:00'], 'Asia/Shanghai');
    assert.equal(before.atMs, utc(2026, 11, 17, 14, 0, 0));
    assert.equal(before.time, '22:00:00');

    const exactly = nextBackupAt(utc(2026, 11, 17, 14, 0, 0), ['22:00:00'], 'Asia/Shanghai');
    assert.equal(exactly.atMs, utc(2026, 11, 18, 14, 0, 0), 'the instant itself is already due; the next one is tomorrow');

    const after = nextBackupAt(utc(2026, 11, 17, 15, 30, 0), ['22:00:00'], 'Asia/Shanghai');
    assert.equal(after.atMs, utc(2026, 11, 18, 14, 0, 0));
  });

  it('handles a DST-observing zone through the zone, not with an offset constant', () => {
    // 2026-11-17 is after the US DST change (2026-11-01), so New York is UTC-5: 22:00 local = 03:00Z next day.
    const next = nextBackupAt(utc(2026, 11, 17, 12, 0, 0), ['22:00:00'], 'America/New_York');
    assert.equal(next.atMs, utc(2026, 11, 18, 3, 0, 0));
  });

  it('picks the earliest of several configured times per day', () => {
    const next = nextBackupAt(utc(2026, 11, 17, 0, 0, 0), ['06:30:00', '21:15:00'], 'Asia/Shanghai');
    assert.equal(next.atMs, utc(2026, 11, 17, 13, 15, 0), '21:15 Beijing on the 17th is 13:15 UTC the same day');
    assert.equal(next.time, '21:15:00');
  });
});

describe('schedule: catch-up across sleep', () => {
  it('reports a recently missed slot once, and forgets an old one', () => {
    const slot = utc(2026, 11, 17, 14, 0, 0); // 22:00 Beijing
    const recent = missedBackupAt(slot + 60 * 60_000, ['22:00:00'], 'Asia/Shanghai');
    assert.equal(recent.atMs, slot);

    const exactlyNow = missedBackupAt(slot, ['22:00:00'], 'Asia/Shanghai');
    assert.equal(exactlyNow, null, 'a slot that is exactly now belongs to the next timer, not catch-up');

    const tooLate = missedBackupAt(slot + DEFAULT_BACKUP_CATCH_UP_MS + 60 * 60_000, ['22:00:00'], 'Asia/Shanghai');
    assert.equal(tooLate, null);
  });

  it('does not catch up a slot from two days ago', () => {
    const slot = utc(2026, 11, 17, 14, 0, 0);
    const missed = missedBackupAt(slot + 2 * 24 * 60 * 60_000, ['22:00:00'], 'Asia/Shanghai');
    assert.equal(missed, null);
  });
});

describe('schedule: the status card', () => {
  it('describes the default schedule with its next occurrence', () => {
    const card = describeBackupSchedule({ nowMs: utc(2026, 11, 17, 0, 0, 0) });
    assert.equal(card.implemented, true);
    assert.deepEqual(card.times, ['22:00:00']);
    assert.equal(card.time_zone, 'Asia/Shanghai');
    assert.equal(card.next_at, new Date(utc(2026, 11, 17, 14, 0, 0)).toISOString());
    assert.equal(card.next_time, '22:00:00');
    assert.equal(card.enabled, true);
  });

  it('stays renderable when the configuration is invalid', () => {
    const card = describeBackupSchedule({ times: ['nope'], nowMs: utc(2026, 11, 17) });
    assert.equal(card.enabled, false);
    assert.equal(card.next_at, null);
    assert.equal(card.implemented, true);
  });
});
