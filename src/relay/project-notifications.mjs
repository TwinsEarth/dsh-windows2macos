/**
 * Project notifications (M5, v1.3.10-beta.17 slice).
 *
 * Notifications answer "what happened while I was away" without a websocket: every one is an event on the project stream
 * (live) and a row returned by the list route (catch-up), and each reader has a watermark rather than per-row read flags.
 *
 * Rules (docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md §4):
 *  - a notification is (project, kind, target, subject, refs, requires_action), addressed to a member or broadcast;
 *  - the same (kind, primary ref, target) inside 60s is one notification, not two;
 *  - more than 120 in a minute for one project collapses into a digest row carrying the count;
 *  - retention is 7 days or 2000 rows per project, whichever cuts first;
 *  - reading is a watermark per reader: unread = rows after the watermark; a watermark never moves backwards.
 */
export const NOTIFICATION_KINDS = Object.freeze([
  'task.assigned', 'review.requested', 'review.decided', 'lock.conflict', 'merge.conflict',
  'merge.merged', 'ref.updated', 'mention', 'maintenance.result', 'digest',
]);
export const DEFAULT_NOTIFICATION_LIMITS = Object.freeze({
  dedupeWindowMs: 60 * 1000,
  ratePerMinute: 120,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxPerProject: 2000,
});

export class NotificationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
    this.detail = detail;
  }
}

const memberKey = (member) => (member && typeof member.kind === 'string' && typeof member.id === 'string' ? member.kind + ':' + member.id : null);

export function createProjectNotifications({ now = () => Date.now(), onEvent = null, limits = DEFAULT_NOTIFICATION_LIMITS } = {}) {
  const rows = new Map(); // notification_id -> row
  const dedupe = new Map(); // dedupe key -> { id, at_ms }
  const watermarks = new Map(); // member key -> { ms, updated_at }
  const digests = new Map(); // project_id -> { window_start_ms, id, count }
  let counter = 0;
  let seq = 0;

  const emit = (type, payload) => {
    seq += 1;
    const event = { seq, type, at: new Date(now()).toISOString(), payload };
    if (typeof onEvent === 'function') onEvent(event);
    return event;
  };

  const primaryRef = (refs) => {
    if (!refs || typeof refs !== 'object') return '';
    for (const key of ['task_id', 'review_id', 'lock_id', 'merge_queue_id', 'sha256']) if (typeof refs[key] === 'string' && refs[key] !== '') return key + ':' + refs[key];
    return '';
  };

  const targetKey = (target) => (!target || typeof target !== 'object' ? 'none' : target.kind === 'broadcast' ? 'broadcast' : memberKey(target) ?? 'none');

  /** Drop rows the retention rule no longer keeps; oldest first. Called before every write. */
  const prune = (projectId) => {
    const mine = [...rows.values()].filter((row) => row.project_id === projectId).sort((a, b) => a.created_at_ms - b.created_at_ms);
    const cutoff = now() - limits.retentionMs;
    const keep = [];
    for (const row of mine) {
      if (row.created_at_ms >= cutoff) keep.push(row);
      else rows.delete(row.notification_id);
    }
    while (keep.length > limits.maxPerProject) {
      const dropped = keep.shift();
      rows.delete(dropped.notification_id);
    }
  };

  /** The digest row for this minute, created on demand and updated in place. */
  const digestFor = (projectId, target) => {
    const windowStart = Math.floor(now() / 60000) * 60000;
    const current = digests.get(projectId);
    if (current !== undefined && current.window_start_ms === windowStart) return rows.get(current.id);
    counter += 1;
    const id = 'nt-' + String(counter).padStart(6, '0');
    const row = {
      notification_id: id,
      project_id: projectId,
      kind: 'digest',
      target: target ?? { kind: 'broadcast' },
      subject: 'digest',
      refs: {},
      requires_action: false,
      created_at: new Date(windowStart).toISOString(),
      created_at_ms: windowStart,
      count: 1,
    };
    rows.set(id, row);
    digests.set(projectId, { window_start_ms: windowStart, id, count: 1 });
    emit('notification.digest', { notification_id: id, project_id: projectId, count: row.count, window_start_ms: windowStart });
    return row;
  };

  return {
    notify({ projectId, kind, target = { kind: 'broadcast' }, subject = null, refs = {}, requiresAction = false }) {
      if (typeof projectId !== 'string' || projectId === '') throw new NotificationError('INVALID_PROJECT', 'project_id is required');
      if (!NOTIFICATION_KINDS.includes(kind)) throw new NotificationError('INVALID_KIND', 'unknown notification kind', { kind });
      if (kind !== 'digest' && (!target || typeof target !== 'object')) throw new NotificationError('INVALID_TARGET', 'target is required');
      prune(projectId);
      const at = now();
      const dedupeKey = projectId + '|' + kind + '|' + targetKey(target) + '|' + primaryRef(refs);
      const seen = dedupe.get(dedupeKey);
      if (seen !== undefined && at - seen.at_ms <= limits.dedupeWindowMs && rows.has(seen.id)) {
        return { ok: true, duplicate: true, notification: rows.get(seen.id) };
      }
      // Rate limit: one digest rows carries the overflow instead of 120 individual rows.
      const minuteStart = at - 60000;
      const recent = [...rows.values()].filter((row) => row.project_id === projectId && row.kind !== 'digest' && row.created_at_ms > minuteStart);
      if (recent.length >= limits.ratePerMinute) {
        counter += 1;
        const digest = digestFor(projectId, target);
        digest.count += 1;
        digests.set(projectId, { window_start_ms: digest.created_at_ms, id: digest.notification_id, count: digest.count });
        return { ok: true, digest: true, notification: digest };
      }
      counter += 1;
      const id = 'nt-' + String(counter).padStart(6, '0');
      const row = {
        notification_id: id,
        project_id: projectId,
        kind,
        target,
        subject,
        refs: { ...refs },
        requires_action: requiresAction === true,
        created_at: new Date(at).toISOString(),
        created_at_ms: at,
      };
      rows.set(id, row);
      dedupe.set(dedupeKey, { id, at_ms: at });
      emit('notification.created', { notification_id: id, project_id: projectId, kind, target, subject, refs: row.refs, requires_action: row.requires_action });
      return { ok: true, notification: row };
    },
    /** Notifications after a millisecond watermark, oldest first, bounded by limit. */
    list({ projectId, sinceMs = 0, limit = 200 }) {
      prune(projectId);
      const slice = [...rows.values()]
        .filter((row) => row.project_id === projectId && row.created_at_ms > sinceMs)
        .sort((a, b) => a.created_at_ms - b.created_at_ms || a.notification_id.localeCompare(b.notification_id))
        .slice(0, Math.max(1, limit))
        .map((row) => ({ ...row, refs: { ...row.refs } }));
      return { notifications: slice, next_since_ms: slice.length === 0 ? sinceMs : slice[slice.length - 1].created_at_ms };
    },
    /** Count and summarise what this reader has not acknowledged yet. */
    unread({ projectId, reader }) {
      const key = memberKey(reader);
      if (key === null) throw new NotificationError('INVALID_READER', 'reader needs kind and id');
      const watermark = watermarks.get(projectId + '|' + key)?.ms ?? 0;
      const pending = [...rows.values()].filter((row) => row.project_id === projectId && row.created_at_ms > watermark);
      return {
        count: pending.length,
        since_ms: watermark,
        requires_action: pending.filter((row) => row.requires_action === true).length,
        summary: pending.slice(-10).map((row) => ({ notification_id: row.notification_id, kind: row.kind, subject: row.subject, created_at: row.created_at })),
      };
    },
    /** Advance a reader's watermark; it never moves backwards. */
    markRead({ projectId, reader, watermarkMs = null }) {
      const key = memberKey(reader);
      if (key === null) throw new NotificationError('INVALID_READER', 'reader needs kind and id');
      if (!Number.isFinite(watermarkMs)) throw new NotificationError('INVALID_WATERMARK', 'watermark_ms must be finite');
      const storageKey = projectId + '|' + key;
      const previous = watermarks.get(storageKey)?.ms ?? 0;
      const next = Math.max(previous, watermarkMs);
      watermarks.set(storageKey, { ms: next, updated_at: new Date(now()).toISOString() });
      return { ok: true, watermark_ms: next, advanced: next !== previous };
    },
    readWatermark({ projectId, reader }) {
      const key = memberKey(reader);
      return watermarks.get(projectId + '|' + key)?.ms ?? 0;
    },
    size({ projectId = null } = {}) {
      const all = [...rows.values()];
      return { rows: projectId === null ? all.length : all.filter((row) => row.project_id === projectId).length, events: seq };
    },
  };
}
