/**
 * A6 persistence foundation: the project room can serialize itself and be restored exactly.
 * (Disk wiring at relay start is the next step; this test pins the snapshot format that wiring uses.)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProjectRoom } from '../src/relay/project-room.mjs';

const owner = { kind: 'operator', id: 'lead' };
const worker = { kind: 'machine', id: 'm-1' };

describe('project room snapshot/restore', () => {
  it('round-trips projects, members, events and sequence exactly', () => {
    const room = createProjectRoom();
    const created = room.createProject({ name: 'persisted', origin: { kind: 'git', url: 'https://example.invalid/r.git' }, createdBy: owner });
    const projectId = created.project.project.project_id;
    room.addMember({ projectId, member: worker, role: 'worker' });
    room.appendEvent({ projectId, type: 'board.updated', actor: owner, payload: { index: 1 } });

    const snapshot = room.toSnapshot();
    const restored = createProjectRoom();
    const result = restored.restore(snapshot);
    assert.equal(result.ok, true);
    assert.equal(restored.size().projects, room.size().projects);
    assert.equal(restored.size().events, room.size().events);
    assert.equal(restored.size().last_seq, room.size().last_seq);
    assert.deepEqual(restored.toSnapshot(), snapshot);
    assert.equal(restored.memberOf({ projectId, member: worker }).role, 'worker');
    assert.equal(restored.snapshot({ projectId }).project.name, 'persisted');
    // The cursor continues rather than restarting.
    const next = restored.appendEvent({ projectId, type: 'board.updated', actor: owner, payload: { index: 2 } });
    assert.equal(next.event.seq, room.size().last_seq + 1);
  });

  it('refuses a snapshot that is not shaped like v1', () => {
    const room = createProjectRoom();
    for (const bad of [null, {}, { v: 2, projects: [], events: [] }, { v: 1, projects: [{}], events: [] }, { v: 1, projects: [], events: [{}] }]) {
      assert.throws(() => room.restore(bad), (error) => error.code === 'BAD_SNAPSHOT', JSON.stringify(bad));
    }
  });
});
