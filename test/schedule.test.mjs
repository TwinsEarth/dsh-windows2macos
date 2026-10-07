/**
 * Daily wall-clock scheduler tests.
 *
 * The three slots are Beijing wall-clock times on a machine that may sit in any
 * zone, and the failure mode we are guarding against is silent: a scheduler that
 * computes the wrong instant still runs, just at the wrong time of day. So the
 * tests pin exact UTC instants rather than trusting relative comparisons.
 *
 * Fixtures use `Asia/Shanghai` (UTC+8, no DST since 1991) plus `America/New_York`
 * and `Australia/Lord_Howe` for the zones where naive arithmetic breaks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CATCH_UP_MS,
  DEFAULT_DAILY_TIMES,
  DEFAULT_TIME_ZONE,
  SCHEDULE_TIME_INVALID,
  SCHEDULE_ZONE_INVALID,
  createDailyScheduler,
  formatTimeOfDay,
  missedSlot,
  nextOccurrence,
  nextSlot,
  normalizeTimes,
  parseTimeOfDay,
  zonedParts,
} from '../src/plugin/schedule.mjs';

/** `Date.UTC` spelled out, so an expectation reads as an instant. */
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

describe('time-of-day parsing', () => {
  it('parses HH:mm:ss into seconds since midnight', () => {
    assert.equal(parseTimeOfDay('00:00:00'), 0);
    assert.equal(parseTimeOfDay('03:00:00'), 3 * 3600);
    assert.equal(parseTimeOfDay('05:00:00'), 5 * 3600);
    assert.equal(parseTimeOfDay('23:59:59'), 23 * 3600 + 59 * 60 + 59);
  });

  it('rejects anything that is not exactly HH:mm:ss', () => {
    for (const bad of ['3:00:00', '03:00', '030000', '', 'abc', '03:00:00Z', '  03:00:00  ', 300, null, undefined, {}]) {
      assert.throws(
        () => parseTimeOfDay(bad),
        (err) => err.code === SCHEDULE_TIME_INVALID,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });

  it('rejects out-of-range components instead of normalising them', () => {
    // 24:00 is not midnight -- it is a configuration mistake, and normalising it
    // would move the check to a time the user never asked for.
    for (const bad of ['24:00:00', '00:60:00', '00:00:60', '99:99:99']) {
      assert.throws(() => parseTimeOfDay(bad), (err) => err.code === SCHEDULE_TIME_INVALID);
    }
  });

  it('round-trips through formatting', () => {
    for (const t of ['00:00:00', '03:00:00', '05:00:00', '09:07:01', '23:59:59']) {
      assert.equal(formatTimeOfDay(parseTimeOfDay(t)), t);
    }
  });

  it('defaults to midnight, 03:00 and 05:00 Beijing, and sorts + dedupes', () => {
    const defaults = normalizeTimes(undefined);
    assert.deepEqual(defaults.formatted, ['00:00:00', '03:00:00', '05:00:00']);
    assert.deepEqual([...DEFAULT_DAILY_TIMES], ['00:00:00', '03:00:00', '05:00:00']);
    assert.equal(DEFAULT_TIME_ZONE, 'Asia/Shanghai');

    // Unsorted input with a duplicate: the duplicate would otherwise arm two
    // timers for one instant and run the check twice.
    const messy = normalizeTimes(['05:00:00', '00:00:00', '03:00:00', '05:00:00']);
    assert.deepEqual(messy.formatted, ['00:00:00', '03:00:00', '05:00:00']);
    assert.deepEqual(messy.seconds, [0, 10800, 18000]);
  });

  it('falls back to the defaults for an empty list', () => {
    assert.deepEqual(normalizeTimes([]).formatted, ['00:00:00', '03:00:00', '05:00:00']);
  });
});

describe('zone wall-clock conversion', () => {
  it('reads Beijing wall clock, which is UTC+8 with no DST', () => {
    // 2026-10-07T16:00:00Z is exactly midnight on the 8th in Beijing.
    const p = zonedParts(utc(2026, 10, 7, 16, 0, 0), 'Asia/Shanghai');
    assert.deepEqual(
      { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second },
      { y: 2026, mo: 10, d: 8, h: 0, mi: 0, s: 0 },
    );
    assert.equal(p.offsetMs, 8 * 3600 * 1000);
  });

  it('handles the UTC date rolling back a day', () => {
    // 2026-10-07T20:00:00Z is 04:00 on the 8th in Beijing, but still the 7th in UTC.
    const p = zonedParts(utc(2026, 10, 7, 20, 0, 0), 'Asia/Shanghai');
    assert.equal(p.day, 8);
    assert.equal(p.hour, 4);
  });

  it('reports a negative offset for a western zone', () => {
    const p = zonedParts(utc(2026, 1, 15, 12, 0, 0), 'America/New_York');
    assert.equal(p.hour, 7); // EST is UTC-5 in January
    assert.equal(p.offsetMs, -5 * 3600 * 1000);
  });

  it('tracks a zone that shifts by 30 minutes for DST', () => {
    // Lord Howe Island uses a 30-minute DST shift -- the case that breaks any
    // implementation assuming whole-hour offsets.
    const summer = zonedParts(utc(2026, 1, 15, 0, 0, 0), 'Australia/Lord_Howe');
    const winter = zonedParts(utc(2026, 7, 15, 0, 0, 0), 'Australia/Lord_Howe');
    assert.equal(summer.offsetMs, 11 * 3600 * 1000);
    assert.equal(winter.offsetMs, 10.5 * 3600 * 1000);
  });

  it('names an unknown zone instead of silently using UTC', () => {
    assert.throws(
      () => zonedParts(Date.now(), 'Not/AZone'),
      (err) => err.code === SCHEDULE_ZONE_INVALID,
    );
  });
});

describe('next occurrence in Beijing', () => {
  const midnight = parseTimeOfDay('00:00:00');
  const three = parseTimeOfDay('03:00:00');

  it('resolves the three default slots to exact UTC instants', () => {
    // From 2026-10-08T00:00:00+08:00, the slots are 16:00Z, 19:00Z and 21:00Z.
    const from = utc(2026, 10, 7, 16, 0, 0);
    assert.equal(nextOccurrence(from, 0, 'Asia/Shanghai'), utc(2026, 10, 7, 16, 0, 0));
    assert.equal(nextOccurrence(from, 3 * 3600, 'Asia/Shanghai'), utc(2026, 10, 7, 19, 0, 0));
    assert.equal(nextOccurrence(from, 5 * 3600, 'Asia/Shanghai'), utc(2026, 10, 7, 21, 0, 0));
  });

  it('rolls to the next day when today\u2019s slot has passed', () => {
    // 2026-10-08T05:30:00+08:00 == 2026-10-07T21:30:00Z; midnight is next.
    const from = utc(2026, 10, 7, 21, 30, 0);
    assert.equal(nextOccurrence(from, 0, 'Asia/Shanghai'), utc(2026, 10, 8, 16, 0, 0));
  });

  it('is inclusive at the exact slot and exclusive one second later', () => {
    const slot = utc(2026, 10, 7, 19, 0, 0);
    assert.equal(nextOccurrence(slot, three, 'Asia/Shanghai'), slot);
    assert.equal(nextOccurrence(slot + 1000, three, 'Asia/Shanghai'), utc(2026, 10, 8, 19, 0, 0));
  });

  it('crosses a month boundary', () => {
    // 2026-10-31T21:30:00Z -> 2026-11-01T00:00:00+08:00 is 2026-10-31T16:00:00Z, already passed,
    // so the next midnight is 2026-11-01T16:00:00Z.
    const from = utc(2026, 10, 31, 21, 30, 0);
    assert.equal(nextOccurrence(from, 0, 'Asia/Shanghai'), utc(2026, 11, 1, 16, 0, 0));
  });

  it('crosses a leap day', () => {
    // 2028 is a leap year; 2028-02-28T21:30:00Z -> 2028-02-29T16:00:00Z.
    const from = utc(2028, 2, 28, 21, 30, 0);
    assert.equal(nextOccurrence(from, 0, 'Asia/Shanghai'), utc(2028, 2, 29, 16, 0, 0));
  });

  it('picks the earliest of several slots and skips the elapsed ones', () => {
    const times = normalizeTimes(['00:00:00', '03:00:00', '05:00:00']).seconds;
    // 2026-10-08T03:30:00+08:00 == 2026-10-07T19:30:00Z -> next is 05:00 local.
    const slot = nextSlot(utc(2026, 10, 7, 19, 30, 0), times, 'Asia/Shanghai');
    assert.equal(slot.time, '05:00:00');
    assert.equal(slot.atMs, utc(2026, 10, 7, 21, 0, 0));

    // 2026-10-08T05:30:00+08:00 -> next is midnight tomorrow.
    const after = nextSlot(utc(2026, 10, 7, 21, 30, 0), times, 'Asia/Shanghai');
    assert.equal(after.time, '00:00:00');
    assert.equal(after.atMs, utc(2026, 10, 8, 16, 0, 0));
  });

  it('is stable across a whole year of consecutive arming', () => {
    // Walk a year slot by slot; the sequence must be strictly increasing and
    // land on each slot exactly once per day. This is the invariant a drifting
    // implementation breaks slowly and invisibly.
    const times = normalizeTimes(undefined).seconds;
    let cursor = utc(2026, 1, 1, 0, 0, 0);
    const seen = new Map();
    for (let i = 0; i < 365 * 3; i += 1) {
      const slot = nextSlot(cursor, times, 'Asia/Shanghai');
      assert.ok(slot.atMs > cursor, `slot ${i} must advance`);
      const p = zonedParts(slot.atMs, 'Asia/Shanghai');
      assert.equal(p.offsetMs, 8 * 3600 * 1000, 'Beijing offset must never shift');
      assert.equal(p.hour * 3600 + p.minute * 60 + p.second, slot.secondOfDay, 'must land on its slot');
      seen.set(slot.time, (seen.get(slot.time) ?? 0) + 1);
      cursor = slot.atMs;
    }
    assert.deepEqual([...seen.keys()].sort(), ['00:00:00', '03:00:00', '05:00:00']);
    assert.equal(seen.get('00:00:00'), 365);
    assert.equal(seen.get('03:00:00'), 365);
    assert.equal(seen.get('05:00:00'), 365);
  });

  it('honours a zone other than Beijing', () => {
    // 2026-01-14T00:00:00Z is 19:00 on the 13th in New York, so the next local
    // midnight is the 14th -- 05:00Z, because EST is UTC-5 in January.
    assert.equal(
      nextOccurrence(utc(2026, 1, 14, 0, 0, 0), 0, 'America/New_York'),
      utc(2026, 1, 14, 5, 0, 0),
    );
    // And just after that midnight, it moves to the 15th.
    assert.equal(
      nextOccurrence(utc(2026, 1, 14, 5, 0, 1), 0, 'America/New_York'),
      utc(2026, 1, 15, 5, 0, 0),
    );
  });
});

describe('catch-up for a suspended machine', () => {
  const times = normalizeTimes(undefined).seconds;

  it('finds the slot just missed', () => {
    // 2026-10-08T05:10:00+08:00 == 2026-10-07T21:10:00Z; 05:00 was 10 minutes ago.
    const missed = missedSlot(utc(2026, 10, 7, 21, 10, 0), times, 'Asia/Shanghai');
    assert.equal(missed.time, '05:00:00');
    assert.equal(missed.atMs, utc(2026, 10, 7, 21, 0, 0));
  });

  it('reports nothing once the window has passed, so no stale run happens', () => {
    // At 05:10 Beijing the most recent slot (05:00) is ten minutes old; with a
    // five-minute window it is too stale to be worth running.
    const now = utc(2026, 10, 7, 21, 10, 0); // 05:10 Beijing on the 8th
    assert.equal(missedSlot(now, times, 'Asia/Shanghai', 5 * 60_000), null);
    // Ten minutes old is inside a 30-minute window.
    assert.equal(missedSlot(now, times, 'Asia/Shanghai', 30 * 60_000).time, '05:00:00');
  });

  it('collapses several missed slots into the most recent one', () => {
    // Opened at 06:00 Beijing: 00:00, 03:00 and 05:00 all passed today, and the
    // caller must run once -- picking the latest -- not three times.
    const now = utc(2026, 10, 7, 22, 0, 0); // 06:00 Beijing on the 8th
    const missed = missedSlot(now, times, 'Asia/Shanghai', 24 * 3600 * 1000);
    assert.equal(missed.time, '05:00:00');
    assert.equal(missed.atMs, utc(2026, 10, 7, 21, 0, 0)); // 05:00 Beijing on the 8th
  });

  it('does not report a slot from the previous day when the current day has one', () => {
    // Exactly three minutes after midnight Beijing: only midnight counts.
    const now = utc(2026, 10, 7, 16, 3, 0);
    const missed = missedSlot(now, times, 'Asia/Shanghai', 24 * 3600 * 1000);
    assert.equal(missed.time, '00:00:00');
  });

  it('does not treat a slot that is exactly now as missed', () => {
    // Regression: with an inclusive comparison, at exactly a slot instant the
    // scheduler reported that slot as missed *and* armed a timer for it -- two
    // runs for one slot. `nextSlot` is inclusive, so the instant belongs to it.
    const twoAm = normalizeTimes(['02:00:00']).seconds;

    // The exact instant of 02:00 Beijing, so "now" is precisely a slot boundary.
    const slot = nextOccurrence(utc(2026, 7, 15, 0, 0, 0), 2 * 3600, 'Asia/Shanghai');
    assert.deepEqual(
      (({ hour, minute }) => ({ hour, minute }))(zonedParts(slot, 'Asia/Shanghai')),
      { hour: 2, minute: 0 },
      'fixture must land exactly on the slot',
    );

    assert.equal(
      missedSlot(slot, twoAm, 'Asia/Shanghai', DEFAULT_CATCH_UP_MS),
      null,
      'the instant itself must not be reported as missed',
    );

    // One second later the same slot is genuinely just missed, and still inside
    // the default window.
    const justAfter = missedSlot(slot + 1000, twoAm, 'Asia/Shanghai', DEFAULT_CATCH_UP_MS);
    assert.equal(justAfter.time, '02:00:00', 'a just-elapsed slot must still be caught up');
    assert.equal(justAfter.atMs, slot, 'the reported instant is the slot itself');

    // And `nextSlot` still fires for the instant that `missedSlot` declines.
    assert.equal(nextSlot(slot - 1, twoAm, 'Asia/Shanghai').atMs, slot);
  });

  it('reports the most recent elapsed slot, even one from earlier the same local day', () => {
    // At exactly 00:00 Beijing the most recent configured slot is 05:00 of the
    // *previous* Beijing day, 19 hours earlier -- 05:00 of the current local day
    // has not happened yet. Getting this backwards would run the check at the
    // wrong end of the day.
    const midnight = utc(2026, 10, 7, 16, 0, 0);
    const missed = missedSlot(midnight, times, 'Asia/Shanghai', 24 * 3600 * 1000);
    assert.equal(missed.time, '05:00:00');
    assert.equal(missed.atMs, utc(2026, 10, 6, 21, 0, 0)); // 05:00 Beijing on the 7th

    // Two hours later the recent slot is the current day's midnight.
    const two = utc(2026, 10, 7, 18, 0, 0);
    assert.equal(missedSlot(two, times, 'Asia/Shanghai', 24 * 3600 * 1000).time, '00:00:00');
    assert.equal(missedSlot(two, times, 'Asia/Shanghai', 24 * 3600 * 1000).atMs, utc(2026, 10, 7, 16, 0, 0));
  });

  it('does not check at unrelated hours just because the process started', () => {
    // The default window is 90 minutes, so starting at 14:00 Beijing -- with no
    // slot anywhere near -- must not produce a catch-up run. A day-long window
    // would fire here, turning "check at 00:00/03:00/05:00" into "check on every
    // start".
    const afternoon = utc(2026, 10, 8, 6, 0, 0); // 14:00 Beijing on the 8th
    assert.equal(missedSlot(afternoon, times, 'Asia/Shanghai', DEFAULT_CATCH_UP_MS), null);
    // 06:05 Beijing is 65 minutes after the 05:00 slot, so it is caught up.
    const early = utc(2026, 10, 7, 22, 5, 0);
    assert.equal(missedSlot(early, times, 'Asia/Shanghai', DEFAULT_CATCH_UP_MS).time, '05:00:00');
  });

  it('looks back across a month boundary', () => {
    // 2026-11-01T00:30:00+08:00 == 2026-10-31T16:30:00Z.
    const missed = missedSlot(utc(2026, 10, 31, 16, 30, 0), times, 'Asia/Shanghai');
    assert.equal(missed.time, '00:00:00');
    assert.equal(missed.atMs, utc(2026, 10, 31, 16, 0, 0));
  });
});

describe('scheduler lifecycle', () => {
  /**
   * A controllable clock + timer pair, so no test waits on real time.
   *
   * The default start is 02:00 Beijing, chosen so the most recent slot (00:00)
   * is already behind us while the next one (03:00) is a clear hour away -- that
   * keeps "armed for the next slot" and "caught up a missed slot" independent.
   */
  function harness({ startMs = utc(2026, 10, 7, 18, 0, 0), times, timeZone, catchUpMs } = {}) {
    let now = startMs;
    const timers = [];
    const runs = [];
    const errors = [];
    const scheduler = createDailyScheduler({
      run: async (info) => {
        runs.push(info);
      },
      times,
      timeZone,
      catchUpMs,
      onError: (e) => errors.push(e),
      nowMs: () => now,
      setTimer: (fn, ms) => {
        const handle = { fn, ms, cleared: false, unref() { this.unrefed = true; } };
        timers.push(handle);
        return handle;
      },
      clearTimer: (h) => {
        if (h) h.cleared = true;
      },
    });
    return {
      scheduler,
      runs,
      errors,
      timers,
      get pending() {
        return timers.filter((t) => !t.cleared);
      },
      advance(ms) {
        now += ms;
      },
      setNow(ms) {
        now = ms;
      },
      /** Fire the newest armed timer, awaiting the async run it starts. */
      async fire() {
        const t = this.pending[this.pending.length - 1];
        assert.ok(t, 'expected an armed timer');
        t.cleared = true;
        t.fn();
        // Let the async run settle.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      },
    };
  }

  it('arms the first timer for the next slot, unref\u2019d', () => {
    const h = harness();
    h.scheduler.start();
    // 02:00 Beijing: 00:00 is 2h old, 03:00 is 1h away.
    assert.equal(h.pending.length, 1, 'exactly one timer is armed');
    assert.equal(h.pending[0].unrefed, true, 'a pending check must not hold the process open');
    assert.equal(h.pending[0].ms, 3600 * 1000, 'one hour until 03:00');
    const d = h.scheduler.describe();
    assert.equal(d.next_time, '03:00:00');
    assert.equal(d.times.join(','), '00:00:00,03:00:00,05:00:00');
    assert.equal(d.time_zone, 'Asia/Shanghai');
    assert.equal(d.runs, 0);
  });

  it('runs the check when the timer fires and re-arms for the following slot', async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(3600 * 1000);
    await h.fire();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].slot, '03:00:00');
    assert.equal(h.runs[0].late, false);
    const d = h.scheduler.describe();
    assert.equal(d.runs, 1);
    assert.equal(d.next_time, '05:00:00');
    assert.equal(d.last_slot, '03:00:00');
  });

  it('runs once on start when a slot was just missed, then resumes the schedule', () => {
    // Started at 05:10 Beijing -- 05:00 was missed ten minutes ago.
    const h = harness({ startMs: utc(2026, 10, 7, 21, 10, 0) });
    h.scheduler.start();
    assert.equal(h.runs.length, 1, 'a just-missed slot must be caught up');
    assert.equal(h.runs[0].slot, '05:00:00');
    assert.equal(h.runs[0].late, true);
  });

  it('does not catch up when no slot is inside the window', () => {
    // Started at 06:00 Beijing with a 30-minute window: nothing to catch up.
    const h = harness({ startMs: utc(2026, 10, 7, 22, 0, 0), catchUpMs: 30 * 60_000 });
    h.scheduler.start();
    assert.equal(h.runs.length, 0);
    assert.equal(h.scheduler.describe().next_time, '00:00:00');
  });

  it('never runs the check twice for one slot', async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(3600 * 1000);
    await h.fire();
    // A duplicate timer firing for the same slot must not double-run; the
    // scheduler only ever has one live timer.
    assert.equal(h.pending.length, 1);
    assert.equal(h.runs.length, 1);
  });

  it('routes a throwing run into onError and keeps the schedule alive', async () => {
    const timers = [];
    const errors = [];
    // 02:00 Beijing: no slot is inside the catch-up window, so the only run is
    // the one this test triggers deliberately.
    let now = utc(2026, 10, 7, 18, 0, 0);
    const scheduler = createDailyScheduler({
      run: async () => {
        throw new Error('network exploded');
      },
      onError: (e) => errors.push(e),
      nowMs: () => now,
      setTimer: (fn, ms) => {
        const handle = { fn, ms, cleared: false, unref() {} };
        timers.push(handle);
        return handle;
      },
      clearTimer: (h) => {
        if (h) h.cleared = true;
      },
    });
    scheduler.start();
    now += 3600 * 1000;
    const t = timers[timers.length - 1];
    t.cleared = true;
    t.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /network exploded/);
    const d = scheduler.describe();
    assert.equal(d.failures, 1);
    assert.equal(d.runs, 0, 'a failed check must not count as a run');
    // Still armed for tomorrow.
    assert.equal(timers.filter((x) => !x.cleared).length, 1);
  });

  it('survives an onError sink that itself throws', async () => {
    const timers = [];
    let now = utc(2026, 10, 7, 18, 0, 0);
    const scheduler = createDailyScheduler({
      run: async () => {
        throw new Error('boom');
      },
      onError: () => {
        throw new Error('sink is broken too');
      },
      nowMs: () => now,
      setTimer: (fn, ms) => {
        const handle = { fn, ms, cleared: false, unref() {} };
        timers.push(handle);
        return handle;
      },
      clearTimer: (h) => {
        if (h) h.cleared = true;
      },
    });
    scheduler.start();
    now += 3600 * 1000;
    const t = timers[timers.length - 1];
    t.cleared = true;
    assert.doesNotThrow(() => t.fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.filter((x) => !x.cleared).length, 1, 'still armed');
  });

  it('stop() releases the timer and is idempotent', () => {
    const h = harness();
    h.scheduler.start();
    assert.equal(h.pending.length, 1);
    h.scheduler.stop();
    assert.equal(h.pending.length, 0);
    assert.doesNotThrow(() => h.scheduler.stop());
    assert.equal(h.scheduler.describe().stopped, true);
  });

  it('a stopped scheduler runs nothing, even if a timer already fired', async () => {
    const h = harness();
    h.scheduler.start();
    const t = h.pending[0];
    h.scheduler.stop();
    t.fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.runs.length, 0);
    await assert.rejects(() => h.scheduler.triggerNow(), /stopped/);
  });

  it('triggerNow runs immediately without disturbing the daily schedule', async () => {
    const h = harness();
    h.scheduler.start();
    const before = h.scheduler.describe().next_at_ms;
    await h.scheduler.triggerNow('manual-test');
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].slot, 'manual-test');
    assert.equal(h.scheduler.describe().next_at_ms, before);
  });

  it('rejects a missing run function at construction', () => {
    assert.throws(() => createDailyScheduler({}), /requires a run function/);
  });

  it('refuses to start twice after stop', () => {
    const h = harness();
    h.scheduler.start();
    h.scheduler.stop();
    assert.throws(() => h.scheduler.start(), /already stopped/);
  });
});

