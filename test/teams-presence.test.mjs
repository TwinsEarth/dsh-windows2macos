/**
 * Presence is a control-plane judgement, not a socket observation.
 *
 * The clock is injected so the ninety-second threshold is tested in microseconds, and the relay
 * mapping is tested against the fields `/v1/devices` actually returns rather than an invented shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  presenceFromDevices,
  TEAM_PRESENCE_DEFAULT_STALE_MS,
  TeamPresence,
  toTeamTimestampMs,
} from '../src/plugin/teams/presence.mjs';

const NOW = Date.parse('2026-11-23T10:00:00.000Z');

describe('team presence', () => {
  it('records a heartbeat and retains user info across a later blank beat', () => {
    const presence = new TeamPresence({ now: () => NOW });
    const first = presence.heartbeat({
      machine_id: 'machine-a',
      user: { id: 'u1', name: 'Fang' },
      role: 'owner',
      caps: { os: 'windows' },
    });
    assert.equal(first.user.name, 'Fang');
    assert.equal(first.heartbeats, 1);
    const second = presence.heartbeat({ machine_id: 'machine-a' });
    assert.equal(second.user.name, 'Fang');
    assert.equal(second.role, 'owner');
    assert.equal(second.heartbeats, 2);
    assert.equal(presence.size, 1);
  });

  it('judges online versus stale from age, not from a stored flag', () => {
    let clock = NOW;
    const presence = new TeamPresence({ now: () => clock, staleAfterMs: 90_000 });
    presence.heartbeat({ machine_id: 'machine-a', user: 'Fang' });
    clock = NOW + 89_000;
    let snapshot = presence.snapshot();
    assert.equal(snapshot.online, 1);
    assert.equal(snapshot.members[0].state, 'online');
    assert.equal(snapshot.members[0].age_ms, 89_000);

    clock = NOW + 91_000;
    snapshot = presence.snapshot();
    assert.equal(snapshot.online, 0);
    assert.equal(snapshot.stale, 1);
    assert.equal(snapshot.members[0].state, 'stale');
    assert.equal(snapshot.members[0].online, false);
  });

  it('supports an explicit last_seen for a replay and rejects a missing machine id', () => {
    const presence = new TeamPresence({ now: () => NOW });
    const entry = presence.heartbeat({ machine_id: 'machine-b', last_seen_ms: NOW - 1_000 });
    assert.equal(entry.last_seen_ms, NOW - 1_000);
    assert.throws(
      () => presence.heartbeat({}),
      (error) => error.code === 'TEAM_PRESENCE_MACHINE_ID_REQUIRED',
    );
    assert.equal(presence.forget('machine-b'), true);
    assert.equal(presence.size, 0);
  });

  it('maps the relay device list to the same roster shape without inventing freshness', () => {
    const snapshot = presenceFromDevices(
      [
        {
          machine_id: 'machine-a',
          machine_name: 'DESKTOP-A',
          user: { id: 'u1', name: 'Fang' },
          role: 'owner',
          caps: { os: 'windows' },
          last_seen: new Date(NOW - 10_000).toISOString(),
        },
        {
          machine_id: 'machine-b',
          machine_name: 'TOFUTURE',
          last_seen_at: new Date(NOW - 120_000).toISOString(),
        },
        { machine_id: 'machine-offline', online: false },
        { machine_name: 'no-id-is-not-a-machine' },
      ],
      { now: NOW, staleAfterMs: 90_000 },
    );
    assert.equal(snapshot.count, 3);
    assert.equal(snapshot.online, 1);
    assert.equal(snapshot.stale, 1);
    const a = snapshot.members.find((member) => member.machine_id === 'machine-a');
    assert.equal(a.state, 'online');
    assert.equal(a.user.name, 'Fang');
    assert.equal(a.source, 'relay');
    const b = snapshot.members.find((member) => member.machine_id === 'machine-b');
    assert.equal(b.state, 'stale');
    assert.equal(b.name, 'TOFUTURE');
    const offline = snapshot.members.find((member) => member.machine_id === 'machine-offline');
    assert.equal(offline.state, 'offline');
    assert.equal(offline.last_seen, null);
  });

  it('keeps the documented default and clamps a nonsense threshold', () => {
    assert.equal(TEAM_PRESENCE_DEFAULT_STALE_MS, 90_000);
    const presence = new TeamPresence({ staleAfterMs: 10 });
    assert.equal(presence.snapshot().stale_after_ms, 90_000);
    assert.equal(presenceFromDevices([], { staleAfterMs: 10 ** 9 }).stale_after_ms, 86_400_000);
  });

  it('parses ISO, epoch ms, and epoch seconds without producing NaN', () => {
    assert.equal(toTeamTimestampMs('2026-11-23T10:00:00.000Z'), NOW);
    assert.equal(toTeamTimestampMs(NOW), NOW);
    assert.equal(toTeamTimestampMs(Math.floor(NOW / 1_000)), NOW);
    assert.equal(toTeamTimestampMs('not-a-date'), null);
    assert.equal(toTeamTimestampMs(null), null);
  });
});
