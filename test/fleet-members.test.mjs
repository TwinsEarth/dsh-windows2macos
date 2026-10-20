/**
 * Members and read watermarks: the two facts a group needs that are not messages.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERS_REFUSAL, buildMembers, isMemberRole, setMemberRole } from '../src/relay/fleet-members.mjs';

const devices = () => new Map([
  ['m1', { machine_name: 'win-desktop', paired_at_ms: 100, online: true, last_seen_at_ms: 900 }],
  ['m2', { machine_name: 'macmini', paired_at_ms: 200, online: false, last_seen_at_ms: 800 }],
]);

describe('buildMembers', () => {
  it('lists every device with its role, defaulting to worker', () => {
    const list = buildMembers({ devices: devices(), roles: new Map([['m1', 'owner']]) });
    assert.equal(list.length, 2);
    const byId = Object.fromEntries(list.map((m) => [m.machine_id, m]));
    assert.equal(byId.m1.role, 'owner');
    assert.equal(byId.m2.role, 'worker', 'a machine cannot gain authority by being re-paired');
    assert.equal(byId.m1.joined_at_ms, 100);
    assert.equal(byId.m2.online, false);
  });

  it('sorts by machine id so two reads render the same order', () => {
    assert.deepEqual(buildMembers({ devices: devices() }).map((m) => m.machine_id), ['m1', 'm2']);
  });
});

describe('setMemberRole', () => {
  it('sets a role it knows', () => {
    const roles = new Map();
    const result = setMemberRole({ machineId: 'm1', role: 'owner', devices: devices(), roles });
    assert.equal(result.ok, true);
    assert.equal(roles.get('m1'), 'owner');
  });

  it('refuses an unknown machine and an unknown role by name', () => {
    assert.equal(setMemberRole({ machineId: 'ghost', role: 'worker', devices: devices(), roles: new Map() }).code, MEMBERS_REFUSAL.UNKNOWN_MACHINE);
    assert.equal(setMemberRole({ machineId: 'm1', role: 'admin', devices: devices(), roles: new Map() }).code, MEMBERS_REFUSAL.BAD_ROLE);
  });

  it('refuses to demote the last owner', () => {
    const roles = new Map([['m1', 'owner']]);
    const result = setMemberRole({ machineId: 'm1', role: 'worker', devices: devices(), roles });
    assert.equal(result.code, MEMBERS_REFUSAL.LAST_OWNER);
    assert.equal(roles.get('m1'), 'owner');
    // with a second owner, the demotion is allowed
    roles.set('m2', 'owner');
    assert.equal(setMemberRole({ machineId: 'm1', role: 'worker', devices: devices(), roles }).ok, true);
  });

  it('knows the closed role set', () => {
    assert.equal(isMemberRole('observer'), true);
    assert.equal(isMemberRole('root'), false);
    assert.equal(isMemberRole(null), false);
  });
});
