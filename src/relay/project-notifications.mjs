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
  // v1.3.14-beta.3: shared-object events that a client must learn about.
  'decision.recorded', 'artifact.registered', 'memory.updated',
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

export function createProjectNotifications({ now = () => Date.now(), onEvent = null, limits = DEFAULT_NOTIFICATION_LIMITS, idPrefix = '' } = {}) {
  const rows = new Map(); // notification_id -> row
  const dedupe = new Map(); // dedupe key -> { id, at_ms }
  const watermarks = new Map(); // member key -> { ms, updated_at }
  const digests = new Map(); // project_id -> { window_start_ms, id, count }
  const idScope = typeof idPrefix === 'string' && idPrefix !== '' ? idPrefix + '-' : '';
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

  const asIso = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const idCounter = (id) => {
    const match = /(\d+)$/.exec(id);
    return match === null ? 0 : Number(match[1]);
  };
  const parseWatermarkKey = (storageKey) => {
    const bar = storageKey.indexOf('|');
    const colon = storageKey.indexOf(':', bar + 1);
    if (bar < 0 || colon < 0) return null;
    const projectId = storageKey.slice(0, bar);
    const readerKind = storageKey.slice(bar + 1, colon);
    const readerId = storageKey.slice(colon + 1);
    if (projectId === '' || readerKind === '' || readerId === '') return null;
    return { project_id: projectId, reader_kind: readerKind, reader_id: readerId };
  };
  /** Rebuild one notification row from a serialised row; null when it cannot be a notification. */
  const normalizeNotificationRow = (row) => {
    if (row === null || typeof row !== 'object') return null;
    if (typeof row.notification_id !== 'string' || row.notification_id === '') return null;
    if (typeof row.project_id !== 'string' || row.project_id === '') return null;
    if (!NOTIFICATION_KINDS.includes(row.kind)) return null;
    const createdAt = asIso(row.created_at);
    const createdAtMs = Number.isFinite(row.created_at_ms) ? row.created_at_ms : (createdAt === null ? null : Date.parse(createdAt));
    if (createdAtMs === null) return null;
    const target = row.target !== null && typeof row.target === 'object' ? copy(row.target) : { kind: 'broadcast' };
    const normalized = {
      ...copy(row),
      notification_id: row.notification_id,
      project_id: row.project_id,
      kind: row.kind,
      target,
      subject: typeof row.subject === 'string' ? row.subject : null,
      refs: row.refs !== null && typeof row.refs === 'object' ? copy(row.refs) : {},
      requires_action: row.requires_action === true,
      created_at: createdAt ?? new Date(createdAtMs).toISOString(),
      created_at_ms: createdAtMs,
    };
    if (row.kind === 'digest') normalized.count = Number.isInteger(row.count) && row.count >= 1 ? row.count : 1;
    return normalized;
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
    const id = 'nt-' + idScope + String(counter).padStart(6, '0');
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
      const id = 'nt-' + idScope + String(counter).padStart(6, '0');
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
    /** Serialisable copy of every notification row (cross-relay merge / restart persistence). */
    snapshot() {
      return [...rows.values()]
        .map((row) => copy(row))
        .sort((left, right) => (left.created_at_ms - right.created_at_ms) || (left.notification_id < right.notification_id ? -1 : left.notification_id > right.notification_id ? 1 : 0));
    },
    /**
     * Replace the notification rows with rows produced by `snapshot()` or a merge of snapshots.
     *
     * Reader watermarks are deliberately kept: they are not part of `rows`, and clearing them would
     * silently reset every unread count on a restart or a peer merge.
     */
    restore(rowsToRestore) {
      if (!Array.isArray(rowsToRestore)) return { ok: false, code: 'BAD_SNAPSHOT' };
      const rebuilt = new Map();
      let skipped = 0;
      let maxCounter = counter;
      for (const row of rowsToRestore) {
        const notification = normalizeNotificationRow(row);
        if (notification === null) { skipped += 1; continue; }
        rebuilt.set(notification.notification_id, notification);
        maxCounter = Math.max(maxCounter, idCounter(notification.notification_id));
      }
      rows.clear();
      for (const [notificationId, notification] of rebuilt) rows.set(notificationId, notification);
      counter = maxCounter;
      seq = Math.max(seq, rebuilt.size);
      dedupe.clear();
      digests.clear();
      return { ok: true, restored: rebuilt.size, skipped };
    },
    /** Reader watermarks as a flat serialisable list (they are not notification rows). */
    snapshotReadMarks() {
      const out = [];
      for (const [storageKey, mark] of watermarks) {
        const parsed = parseWatermarkKey(storageKey);
        if (parsed === null || mark === null || typeof mark !== 'object' || !Number.isFinite(mark.ms)) continue;
        out.push({
          project_id: parsed.project_id,
          reader_kind: parsed.reader_kind,
          reader_id: parsed.reader_id,
          watermark_ms: mark.ms,
          updated_at: typeof mark.updated_at === 'string' ? mark.updated_at : null,
        });
      }
      return out.sort((left, right) => {
        const leftKey = left.project_id + '|' + left.reader_kind + ':' + left.reader_id;
        const rightKey = right.project_id + '|' + right.reader_kind + ':' + right.reader_id;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    },
    /** Restore reader watermarks from `snapshotReadMarks()` output; a watermark never moves backwards. */
    restoreReadMarks(readMarkRows) {
      if (!Array.isArray(readMarkRows)) return { ok: false, code: 'BAD_SNAPSHOT', restored: 0 };
      let restored = 0;
      for (const row of readMarkRows) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.project_id !== 'string' || row.project_id === '') continue;
        if (typeof row.reader_kind !== 'string' || row.reader_kind === '') continue;
        if (typeof row.reader_id !== 'string' || row.reader_id === '') continue;
        if (!Number.isFinite(row.watermark_ms)) continue;
        const storageKey = row.project_id + '|' + row.reader_kind + ':' + row.reader_id;
        const previous = watermarks.get(storageKey)?.ms ?? 0;
        const next = Math.max(previous, row.watermark_ms);
        const updatedAt = asIso(row.updated_at) ?? watermarks.get(storageKey)?.updated_at ?? new Date(now()).toISOString();
        watermarks.set(storageKey, { ms: next, updated_at: updatedAt });
        restored += 1;
      }
      return { ok: true, restored };
    },
  };
}



