/**
 * Project notifications tests (M5, v1.3.10-beta.17 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectNotifications, DEFAULT_NOTIFICATION_LIMITS } from '../src/relay/project-notifications.mjs';

const P = 'prj-n';
const reader = { kind: 'machine', id: 'm-reader' };

function setup(overrides = {}) {
  let t = Date.parse('2026-10-22T00:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; return t; } };
  const events = [];
  const notifications = createProjectNotifications({ now: clock.now, onEvent: (event) => events.push(event), ...overrides });
  return { notifications, clock, events };
}

const notify = (notifications, overrides = {}) => notifications.notify({
  projectId: P,
  kind: 'task.assigned',
  target: { kind: 'machine', id: 'm-target' },
  subject: 'take this task',
  refs: { task_id: 't-1' },
  ...overrides,
});

describe('project notifications', () => {
  it('creates a notification, lists it after a watermark and emits the event', () => {
    const { notifications, events } = setup();
    const created = notify(notifications);
    assert.equal(created.ok, true);
    assert.equal(created.notification.kind, 'task.assigned');
    assert.equal(created.notification.refs.task_id, 't-1');
    const listed = notifications.list({ projectId: P });
    assert.equal(listed.notifications.length, 1);
    assert.equal(listed.next_since_ms, created.notification.created_at_ms);
    assert.equal(events.at(-1).type, 'notification.created');
  });

  it('deduplicates the same kind, ref and target inside the window', () => {
    const { notifications, clock } = setup();
    const first = notify(notifications);
    clock.advance(59_000);
    const second = notify(notifications);
    assert.equal(second.duplicate, true);
    assert.equal(second.notification.notification_id, first.notification.notification_id);
    clock.advance(2_000);
    const third = notify(notifications);
    assert.notEqual(third.notification.notification_id, first.notification.notification_id);
    assert.equal(notifications.size({ projectId: P }).rows, 2);
  });

  it('keeps different refs or targets as distinct notifications', () => {
    const { notifications } = setup();
    notify(notifications);
    notify(notifications, { refs: { task_id: 't-2' } });
    notify(notifications, { kind: 'review.requested', refs: { review_id: 'r-1' } });
    assert.equal(notifications.size({ projectId: P }).rows, 3);
  });

  it('collapses overflow into a digest row that carries the count', () => {
    const { notifications } = setup({ limits: { ...DEFAULT_NOTIFICATION_LIMITS, ratePerMinute: 3 } });
    for (let i = 0; i < 3; i += 1) notify(notifications, { refs: { task_id: 't-' + i } });
    const overflow = notify(notifications, { refs: { task_id: 't-3' } });
    assert.equal(overflow.digest, true);
    assert.equal(overflow.notification.kind, 'digest');
    assert.equal(overflow.notification.count, 2);
    const again = notify(notifications, { refs: { task_id: 't-4' } });
    assert.equal(again.notification.notification_id, overflow.notification.notification_id);
    assert.equal(again.notification.count, 3);
  });

  it('counts unread rows after the reader watermark and moves it monotonically', () => {
    const { notifications, clock } = setup();
    const first = notify(notifications);
    clock.advance(1_000);
    const second = notify(notifications, { refs: { task_id: 't-2' }, requiresAction: true });
    assert.equal(notifications.unread({ projectId: P, reader }).count, 2);
    assert.equal(notifications.unread({ projectId: P, reader }).requires_action, 1);
    const marked = notifications.markRead({ projectId: P, reader, watermarkMs: second.notification.created_at_ms });
    assert.equal(marked.watermark_ms, second.notification.created_at_ms);
    assert.equal(notifications.unread({ projectId: P, reader }).count, 0);
    const backwards = notifications.markRead({ projectId: P, reader, watermarkMs: first.notification.created_at_ms });
    assert.equal(backwards.advanced, false);
    assert.equal(backwards.watermark_ms, second.notification.created_at_ms);
  });

  it('returns only rows after since_ms and bounds the page', () => {
    const { notifications, clock } = setup();
    notify(notifications);
    const firstAt = notifications.list({ projectId: P }).next_since_ms;
    clock.advance(5_000);
    notify(notifications, { refs: { task_id: 't-2' } });
    clock.advance(5_000);
    notify(notifications, { refs: { task_id: 't-3' } });
    const page = notifications.list({ projectId: P, sinceMs: firstAt, limit: 1 });
    assert.equal(page.notifications.length, 1);
    assert.equal(page.notifications[0].refs.task_id, 't-2');
    assert.equal(page.next_since_ms, page.notifications[0].created_at_ms);
  });

  it('prunes rows past the retention window', () => {
    const { notifications, clock } = setup({ limits: { ...DEFAULT_NOTIFICATION_LIMITS, retentionMs: 10_000 } });
    notify(notifications);
    clock.advance(11_000);
    notify(notifications, { refs: { task_id: 't-2' } });
    assert.equal(notifications.size({ projectId: P }).rows, 1);
  });

  it('refuses unknown kinds and malformed readers', () => {
    const { notifications } = setup();
    assert.throws(() => notify(notifications, { kind: 'page.someone' }), (error) => error.code === 'INVALID_KIND');
    assert.throws(() => notifications.unread({ projectId: P, reader: { kind: 'machine' } }), (error) => error.code === 'INVALID_READER');
  });
});
