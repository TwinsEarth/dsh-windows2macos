/**
 * A6: project-room replay is pageable and truncation is explicit.
 *
 * The old events() shape returned at most `limit` events with no signal that more existed, so a
 * client that reconnected after a long gap believed it had caught up. The room now reports
 * `truncated`, `remaining`, `latest_seq` and `oldest_available_seq`, and a page is resumed with
 * `next_seq`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProjectRoom } from '../src/relay/project-room.mjs';

const owner = { kind: 'operator', id: 'lead' };

function seeded(count) {
  const room = createProjectRoom();
  const created = room.createProject({ name: 'demo', origin: { kind: 'git', url: 'https://example.invalid/repo.git' }, createdBy: owner });
  const projectId = created.project.project.project_id;
  for (let i = 0; i < count; i += 1) room.appendEvent({ projectId, type: 'board.updated', actor: owner, payload: { index: i } });
  return { room, projectId };
}

describe('project room truncation', () => {
  it('reports truncation and pages with next_seq', () => {
    const { room, projectId } = seeded(10);
    const first = room.events({ projectId, sinceSeq: 0, limit: 4 });
    assert.equal(first.events.length, 4);
    assert.equal(first.truncated, true);
    assert.ok(first.remaining > 0);
    assert.ok(first.latest_seq >= first.next_seq);
    assert.equal(first.oldest_available_seq, 1);
    const second = room.events({ projectId, sinceSeq: first.next_seq, limit: 4 });
    assert.equal(second.events.length, 4);
    assert.equal(second.events[0].seq, first.next_seq + 1);
    // Paging forward until the end yields a non-truncated final page.
    let cursor = second.next_seq;
    let page = second;
    for (let i = 0; i < 10 && page.truncated; i += 1) {
      page = room.events({ projectId, sinceSeq: cursor, limit: 4 });
      cursor = page.next_seq;
    }
    assert.equal(page.truncated, false);
    assert.equal(page.next_seq, page.latest_seq);
  });

  it('returns an empty, non-truncated page when the cursor is current', () => {
    const { room, projectId } = seeded(3);
    const latest = room.events({ projectId, sinceSeq: 0, limit: 100 }).latest_seq;
    const current = room.events({ projectId, sinceSeq: latest, limit: 100 });
    assert.equal(current.events.length, 0);
    assert.equal(current.truncated, false);
    assert.equal(current.next_seq, latest);
  });
});
