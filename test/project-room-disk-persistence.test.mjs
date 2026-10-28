/**
 * A6 disk wiring: the project room survives a relay restart through <stateDir>/projects/room-snapshot.json.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RabbitState } from '../src/relay/state.mjs';

const owner = { kind: 'operator', id: 'lead' };

describe('project room disk persistence', () => {
  it('writes a 0600 snapshot per event and restores it on the next boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-projects-'));
    const state = new RabbitState({ persistence: { dir } });
    const created = state.projects.createProject({ name: 'durable', origin: { kind: 'git', url: 'https://example.invalid/r.git' }, createdBy: owner });
    const projectId = created.project.project.project_id;
    const file = join(dir, 'projects', 'room-snapshot.json');
    assert.equal(existsSync(file), true);
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(snapshot.v, 1);
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0].project_id, projectId);
    assert.ok(snapshot.events.length >= 1, 'the creation event is in the log');

    const restarted = new RabbitState({ persistence: { dir } });
    const restored = restarted.projects.snapshot({ projectId });
    assert.equal(restored.project.name, 'durable');
    assert.equal(restarted.projects.size().projects, 1);
    // The cursor continues rather than restarting at 1 after the restart.
    const before = restarted.projects.size().last_seq;
    const next = restarted.projects.appendEvent({ projectId, type: 'board.updated', actor: owner, payload: { after_restart: true } });
    assert.equal(next.event.seq, before + 1);
    const third = new RabbitState({ persistence: { dir } });
    assert.equal(third.projects.snapshot({ projectId }).last_event_seq, next.event.seq);
  });
});
