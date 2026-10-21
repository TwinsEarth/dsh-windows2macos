/**
 * Project room tests (M4, v1.3.10-beta.12 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_ACTIONS, PROJECT_ROLES, createProjectRoom, ProjectRoomError } from '../src/relay/project-room.mjs';

const owner = { kind: 'operator', id: 'lead' };
const worker = { kind: 'machine', id: 'm-1' };
const observer = { kind: 'machine', id: 'm-2' };

function setup() {
  const room = createProjectRoom();
  const created = room.createProject({ name: 'demo', origin: { kind: 'git', url: 'https://example.invalid/repo.git' }, createdBy: owner });
  const projectId = created.project.project.project_id;
  return { room, projectId };
}

describe('project room', () => {
  it('makes the creator an owner and records it in the event log', () => {
    const { room, projectId } = setup();
    const snapshot = room.snapshot({ projectId });
    assert.equal(snapshot.project.name, 'demo');
    assert.equal(snapshot.members.length, 1);
    assert.equal(snapshot.members[0].role, 'owner');
    assert.equal(room.events({ projectId }).events[0].type, 'project.created');
    assert.equal(room.events({ projectId }).events[0].seq, 1);
  });

  it('adds members with roles and reports a duplicate by name', () => {
    const { room, projectId } = setup();
    room.addMember({ projectId, member: worker, role: 'worker' });
    assert.equal(room.memberOf({ projectId, member: worker }).role, 'worker');
    assert.throws(() => room.addMember({ projectId, member: worker, role: 'observer' }), (error) => error instanceof ProjectRoomError && error.code === 'DUPLICATE_MEMBER');
    assert.throws(() => room.addMember({ projectId, member: { kind: 'machine', id: 'm-3' }, role: 'superuser' }), (error) => error.code === 'BAD_ROLE');
  });

  it('enforces the deny-by-default matrix for each role', () => {
    const { room, projectId } = setup();
    room.addMember({ projectId, member: worker, role: 'worker' });
    room.addMember({ projectId, member: observer, role: 'observer' });
    assert.equal(room.mayAct({ projectId, member: owner, action: 'members' }).ok, true);
    assert.equal(room.mayAct({ projectId, member: worker, action: 'dispatch' }).ok, true);
    assert.equal(room.mayAct({ projectId, member: worker, action: 'merge' }).ok, false);
    const denied = room.mayAct({ projectId, member: observer, action: 'dispatch' });
    assert.equal(denied.code, 'FORBIDDEN_ACTION');
    assert.equal(denied.required_role, 'worker');
    assert.equal(denied.current_role, 'observer');
    const outsider = room.mayAct({ projectId, member: { kind: 'machine', id: 'stranger' }, action: 'read' });
    assert.equal(outsider.code, 'NOT_A_MEMBER');
    for (const action of Object.keys(PROJECT_ACTIONS)) assert.ok(PROJECT_ROLES.includes(PROJECT_ACTIONS[action]));
  });

  it('refuses to remove the last owner and allows removing a non-owner', () => {
    const { room, projectId } = setup();
    room.addMember({ projectId, member: worker, role: 'worker' });
    assert.throws(() => room.removeMember({ projectId, member: owner }), (error) => error.code === 'LAST_OWNER');
    assert.equal(room.removeMember({ projectId, member: worker }).ok, true);
    assert.equal(room.memberOf({ projectId, member: worker }), null);
  });

  it('records role changes as events with from and to', () => {
    const { room, projectId } = setup();
    room.addMember({ projectId, member: worker, role: 'observer' });
    const changed = room.setRole({ projectId, member: worker, role: 'maintainer' });
    assert.equal(changed.changed, true);
    const last = room.events({ projectId }).events.at(-1);
    assert.equal(last.type, 'member.role_changed');
    assert.deepEqual(last.payload, { from: 'observer', to: 'maintainer' });
  });

  it('returns a snapshot whose last_event_seq lets a client apply only newer events', () => {
    const { room, projectId } = setup();
    room.addMember({ projectId, member: worker, role: 'worker' });
    const snapshot = room.snapshot({ projectId });
    const before = room.events({ projectId }).events.length;
    room.addMember({ projectId, member: observer, role: 'observer' });
    const delta = room.events({ projectId, sinceSeq: snapshot.last_event_seq });
    assert.equal(delta.events.length, 1);
    assert.equal(delta.events[0].type, 'member.added');
    assert.equal(delta.next_seq, snapshot.last_event_seq + 1);
    assert.equal(before, 2);
  });

  it('lists only the projects a member belongs to', () => {
    const { room, projectId } = setup();
    const second = room.createProject({ name: 'other', createdBy: { kind: 'operator', id: 'someone-else' } });
    assert.deepEqual(room.listProjects({ member: owner }).projects.map((p) => p.project_id), [projectId]);
    assert.deepEqual(room.listProjects({ member: { kind: 'operator', id: 'someone-else' } }).projects.map((p) => p.project_id), [second.project.project.project_id]);
  });

  it('keeps project state isolated and names unknown projects', () => {
    const { room } = setup();
    assert.throws(() => room.snapshot({ projectId: 'nope' }), (error) => error.code === 'PROJECT_NOT_FOUND');
    assert.equal(room.size().projects, 1);
  });
});
