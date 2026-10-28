/**
 * Offer journal (v2 R8): the command an in-flight task will be offered with lives HERE, not in the
 * ledger.
 *
 * The ledger must never carry `command_argv` (it is the relay's durable, copyable record), yet a
 * relay restart still needs the command to re-offer unclaimed work. The journal is that narrow,
 * short-lived control-plane store: one 0600 file per task, written before the task is announced,
 * removed when the task settles or is cancelled. It is not an artifact and carries no output.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const journalDir = (stateDir) => join(stateDir, 'offers');
const journalPath = (stateDir, taskId) => join(journalDir(stateDir), String(taskId).replace(/[^A-Za-z0-9._-]/g, '_') + '.json');

export function writeOfferJournal(stateDir, taskId, payload) {
  if (typeof stateDir !== 'string' || stateDir === '' || typeof taskId !== 'string' || taskId === '') {
    return { ok: false, code: 'JOURNAL_INPUT_INVALID' };
  }
  mkdirSync(journalDir(stateDir), { recursive: true });
  const path = journalPath(stateDir, taskId);
  const tmp = path + '.tmp-' + process.pid;
  const text = JSON.stringify({
    v: 1,
    task_id: taskId,
    argv: Array.isArray(payload?.argv) ? payload.argv : [],
    stages: Array.isArray(payload?.stages) ? payload.stages : null,
    reduce_argv: Array.isArray(payload?.reduce_argv) ? payload.reduce_argv : null,
    written_at: new Date().toISOString(),
  });
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return { ok: true, path };
}

export function readOfferJournal(stateDir, taskId) {
  const path = journalPath(stateDir, taskId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.task_id !== taskId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteOfferJournal(stateDir, taskId) {
  try { unlinkSync(journalPath(stateDir, taskId)); return true; } catch { return false; }
}

/** Remove journals whose task no longer exists (settled, cancelled, or lost). */
export function pruneOfferJournals(stateDir, liveTaskIds) {
  const dir = journalDir(stateDir);
  if (!existsSync(dir)) return 0;
  const live = liveTaskIds instanceof Set ? liveTaskIds : new Set(liveTaskIds ?? []);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const taskId = name.slice(0, -5);
    if (live.has(taskId)) continue;
    try { unlinkSync(join(dir, name)); removed += 1; } catch { /* best effort */ }
  }
  return removed;
}
