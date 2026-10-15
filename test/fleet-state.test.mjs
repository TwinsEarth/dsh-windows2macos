/**
 * Fleet-state suite: the disagreement between two relay endpoints, and why history is not an outcome record.
 *
 * What these protect, said once: this module exists because **two endpoints answer "is this machine usable?"
 * and disagree**, and because **a history listing is not a record of what happened**. Both are the kind of
 * error that produces a confidently wrong plan — a fleet believed to be five machines when three can run, or a
 * fleet believed reliable because nothing ever reported a failure. So the fixtures are the *measured* payloads,
 * not invented ones.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE,
  classifyMachine,
  historyIsOutcomeRecord,
  readStats,
  reconcile,
} from '../src/agent/fleet-state.mjs';

/** The measured `w2m_stats` machines, verbatim: three live and two silent for ~17 hours. */
const MEASURED = [
  { machine_id: 'jp', machine_name: 'jp-shared', online: true, offline_reason: null, silent_ms: 2411, rtt_ms: 6, rtt_stale: false },
  { machine_id: 'w1', machine_name: 'win-desktop', online: false, offline_reason: 'silent', silent_ms: 61384294, rtt_ms: null, rtt_stale: true },
  { machine_id: 'mac', machine_name: 'macmini', online: true, offline_reason: null, silent_ms: 4418, rtt_ms: 538, rtt_stale: false },
  { machine_id: 'w2', machine_name: 'win-desktop', online: false, offline_reason: 'silent', silent_ms: 61384294, rtt_ms: null, rtt_stale: true },
  { machine_id: 'tof', machine_name: 'ToFuture', online: true, offline_reason: null, silent_ms: 0, rtt_ms: 122, rtt_stale: false },
];

const statsPayload = { counts: { devices: 5, online: 3 }, machines: MEASURED };

describe('fleet state: the fleet is the size that can run work', () => {
  it('counts three usable out of five paired, from the measured payload', () => {
    const r = readStats(statsPayload);
    assert.equal(r.paired, 5);
    assert.equal(r.usable, 3);
    assert.equal(r.silent.length, 2);
    assert.match(r.detail, /3 of 5 paired machine\(s\) can run work/);
  });

  it('treats a live machine with a measured round trip as the strongest evidence', () => {
    const c = classifyMachine(MEASURED[0]);
    assert.equal(c.usable, true);
    assert.equal(c.evidence, EVIDENCE.HEARTBEAT_WITH_RTT);
    assert.equal(c.rtt_ms, 6);
  });

  it('does not accept a machine as usable when its round trip is stale', () => {
    // `online: true` with `rtt_stale: true` is a contradiction, and the stale flag is the one that reflects
    // the measurement rather than the last known value.
    const c = classifyMachine({ machine_id: 'x', online: true, rtt_ms: 10, rtt_stale: true });
    assert.equal(c.usable, false);
  });

  it('reports the silent duration, because "went away" and "never arrived" differ', () => {
    const c = classifyMachine(MEASURED[1]);
    assert.equal(c.usable, false);
    assert.equal(c.reason, 'silent');
    assert.equal(c.silent_ms, 61384294);
    assert.match(c.detail, /silent for 61384s/);
  });

  it('is usable with no round trip at all, because a heartbeat is still evidence of life', () => {
    const c = classifyMachine({ machine_id: 'x', online: true, rtt_ms: null, rtt_stale: false });
    assert.equal(c.usable, true);
    assert.equal(c.evidence, EVIDENCE.HEARTBEAT_ALONE);
  });

  it('refuses a machine the relay did not describe', () => {
    for (const bad of [null, undefined, 42, {}, { machine_name: 'no id' }]) {
      const c = classifyMachine(bad);
      assert.equal(c.usable, false, JSON.stringify(bad));
      assert.equal(c.evidence, EVIDENCE.UNKNOWN);
    }
  });

  it('takes the number to plan against from the machines, not from the count field', () => {
    // `counts.online` is the relay's own claim. When it and the per-machine entries disagree, the entries are
    // what was measured and the count is a summary of them.
    const r = readStats({ counts: { devices: 5, online: 5 }, machines: MEASURED });
    assert.equal(r.usable, 3, 'three machines are usable regardless of what the count says');
    assert.equal(r.online, 5, 'the relay claim is still reported, not hidden');
  });

  it('finds the fastest usable machine, which is what a scheduler wants', () => {
    assert.equal(readStats(statsPayload).runner_up_rtt_ms, 6);
  });
});

describe('fleet state: the two endpoints disagree and the module says so', () => {
  it('names every machine a device listing calls online that stats does not', () => {
    // The measured divergence: `w2m_devices` reported all five as `online: true`, including the two silent
    // for seventeen hours. A caller trusting that listing plans for five and gets three.
    const devices = {
      devices: [
        { machine_id: 'jp', name: 'jp-shared', state: 'online' },
        { machine_id: 'w1', name: 'win-desktop', state: 'online' },
        { machine_id: 'mac', name: 'macmini', state: 'online' },
        { machine_id: 'w2', name: 'win-desktop', state: 'online' },
        { machine_id: 'tof', name: 'ToFuture', state: 'online' },
      ],
    };
    const r = reconcile(devices, statsPayload);
    assert.equal(r.devices_claims_online, 5);
    assert.equal(r.stats_says_usable, 3);
    assert.equal(r.disagreements.length, 2);
    assert.deepEqual(r.disagreements.map((d) => d.machine_id).sort(), ['w1', 'w2']);
    assert.equal(r.disagreements[0].devices_says, 'online');
    assert.equal(r.disagreements[0].stats_says, 'silent');
  });

  it('states which endpoint to trust, as a field rather than as advice', () => {
    const r = reconcile({ devices: [{ machine_id: 'w1', state: 'online' }] }, statsPayload);
    assert.equal(r.trust, 'stats');
    assert.match(r.reason, /carries a reason/);
  });

  it('says the endpoints agree when they do, rather than reporting an empty disagreement', () => {
    const agree = { devices: [{ machine_id: 'jp', state: 'online' }, { machine_id: 'mac', state: 'online' }, { machine_id: 'tof', state: 'online' }] };
    const r = reconcile(agree, statsPayload);
    assert.deepEqual(r.disagreements, []);
    assert.equal(r.reason, 'the two endpoints agree');
  });

  it('does not count a machine the device listing omits', () => {
    // Missing from one side is not the same as disagreement about it; only an active false claim is.
    const r = reconcile({ devices: [] }, statsPayload);
    assert.equal(r.devices_claims_online, 0);
    assert.deepEqual(r.disagreements, []);
  });

  it('survives a device listing that is not a listing', () => {
    for (const bad of [null, undefined, {}, { devices: 'five' }]) {
      const r = reconcile(bad, statsPayload);
      assert.equal(r.devices_claims_online, 0);
      assert.equal(r.stats_says_usable, 3, 'the stats half still answers');
    }
  });
});

describe('fleet state: a history listing is not an outcome record', () => {
  it('refuses the measured history, and says why', () => {
    // Every task in the forty-task sample recorded macmini as `done`, including runs that expired with no exit
    // code. That uniformity is the signature of a current-state map.
    const tasks = Array.from({ length: 40 }, (_, i) => ({
      task_id: 'T' + i,
      lease_states: { mac: 'done', jp: 'observing', tof: 'observing' },
    }));
    const r = historyIsOutcomeRecord({ tasks });
    assert.equal(r.usable_as_outcome_record, false);
    assert.equal(r.homogeneous.length, 3, 'all three machines hold one state each');
    assert.match(r.reason, /current-state map, not an outcome record/);
    assert.match(r.reason, /w2m_report per task instead/);
  });

  it('is unambiguous even when a state does vary, because the map is still not an outcome', () => {
    const tasks = [
      { lease_states: { a: 'done' } },
      { lease_states: { a: 'expired' } },
    ];
    const r = historyIsOutcomeRecord({ tasks });
    assert.equal(r.usable_as_outcome_record, false, 'a varying current state is still a current state');
    assert.equal(r.homogeneous.length, 0);
    assert.match(r.reason, /reports the current state, not what happened/);
  });

  it('refuses an empty sample rather than calling it reliable', () => {
    // The optimistic reading of "no failures observed" is "no failures happened". With no tasks there is
    // nothing to observe, and that must not read as a clean record.
    const r = historyIsOutcomeRecord({ tasks: [] });
    assert.equal(r.usable_as_outcome_record, false);
    assert.match(r.reason, /no tasks in the sample/);
    assert.equal(historyIsOutcomeRecord(null).usable_as_outcome_record, false);
    assert.equal(historyIsOutcomeRecord({}).usable_as_outcome_record, false);
  });
});
