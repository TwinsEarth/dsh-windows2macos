/**
 * Write-ahead spool: "先落盘再回传" (§0).
 *
 * Ordering that the contract requires:
 *
 *   1. an offer is written to the spool **before** anything executes;
 *   2. the finished envelope is written to the spool **before** it is POSTed;
 *   3. the spool entry is deleted only after Rabbit confirms receipt.
 *
 * A crash between (2) and (3) therefore leaves a replayable envelope on disk,
 * and a lost Rabbit (or a laptop lid closing mid-run) cannot silently swallow a
 * result.  Everything lives under the `--state` directory: read-only mode must
 * never write into the project, and the spool is not part of the project.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Sub-directory of the state dir that holds spooled tasks. */
export const SPOOL_DIR_NAME = 'spool';

/** Entry states, in the order they occur. */
export const SPOOL_STATES = ['claimed', 'completed', 'acked'];

/**
 * @typedef {object} SpoolRecord
 * @property {string} task_id
 * @property {number} attempt
 * @property {string|null} dedupe_key
 * @property {'claimed'|'completed'|'acked'} state
 * @property {string} dir
 * @property {string} created_at
 * @property {string} updated_at
 * @property {object|null} task
 * @property {object|null} envelope
 */

/** @param {string} value */
function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/** Atomic file write: temp file in the same directory, then rename. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Create a spool rooted at `<stateDir>/spool`.
 *
 * @param {string} stateDir
 * @returns {object} Spool handle.
 */
export function createSpool(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') {
    throw new TypeError('createSpool: stateDir must be a non-empty string');
  }
  const root = join(stateDir, SPOOL_DIR_NAME);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  /** @param {string} taskId @param {number} attempt */
  const taskDir = (taskId, attempt) => join(root, `${sanitize(taskId)}__a${Number(attempt) || 1}`);

  /** @param {string} dir */
  const readJson = (dir, name) => {
    try {
      return JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      return null;
    }
  };

  /** @param {string} dir @returns {SpoolRecord|null} */
  const readRecord = (dir) => {
    const meta = readJson(dir, 'meta.json');
    if (!meta || typeof meta.task_id !== 'string') return null;
    return {
      task_id: meta.task_id,
      attempt: Number(meta.attempt) || 1,
      dedupe_key: meta.dedupe_key ?? null,
      state: meta.state ?? 'claimed',
      dir,
      created_at: meta.created_at ?? null,
      updated_at: meta.updated_at ?? null,
      task: readJson(dir, 'task.json'),
      envelope: readJson(dir, 'envelope.json'),
    };
  };

  const spool = {
    /** Absolute spool root. */
    root,
    /** State directory the spool belongs to. */
    stateDir,
    taskDir,

    /**
     * Step 1: persist the offer before doing anything with it.
     *
     * @param {{task_id: string, attempt?: number, dedupe_key?: string|null, offer?: object|null}} entry
     * @returns {SpoolRecord}
     */
    saveTask(entry) {
      if (!entry || typeof entry.task_id !== 'string' || entry.task_id === '') {
        throw new TypeError('spool.saveTask: task_id is required');
      }
      const attempt = Number(entry.attempt) || 1;
      const dir = taskDir(entry.task_id, attempt);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const now = new Date().toISOString();
      const existing = readJson(dir, 'meta.json');
      if (entry.offer) writeAtomic(join(dir, 'task.json'), `${JSON.stringify(entry.offer, null, 2)}\n`);
      const meta = {
        task_id: entry.task_id,
        attempt,
        dedupe_key: entry.dedupe_key ?? existing?.dedupe_key ?? null,
        state: 'claimed',
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      writeAtomic(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
      return readRecord(dir);
    },

    /**
     * Step 2: persist the envelope before the POST.
     *
     * @param {{task_id: string, attempt?: number, envelope: object}} entry
     * @returns {SpoolRecord}
     */
    saveEnvelope(entry) {
      if (!entry || typeof entry.task_id !== 'string' || entry.task_id === '') {
        throw new TypeError('spool.saveEnvelope: task_id is required');
      }
      if (!entry.envelope || typeof entry.envelope !== 'object') {
        throw new TypeError('spool.saveEnvelope: envelope is required');
      }
      const attempt = Number(entry.attempt) || 1;
      const dir = taskDir(entry.task_id, attempt);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(join(dir, 'envelope.json'), `${JSON.stringify(entry.envelope, null, 2)}\n`);
      const existing = readJson(dir, 'meta.json') ?? {};
      const now = new Date().toISOString();
      const meta = {
        task_id: entry.task_id,
        attempt,
        dedupe_key: entry.dedupe_key ?? entry.envelope.dedupe_key ?? existing.dedupe_key ?? null,
        state: 'completed',
        created_at: existing.created_at ?? now,
        updated_at: now,
      };
      writeAtomic(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
      return readRecord(dir);
    },

    /**
     * Every spool entry, oldest first.
     *
     * @returns {SpoolRecord[]}
     */
    list() {
      let names;
      try {
        names = readdirSync(root);
      } catch {
        return [];
      }
      const records = [];
      for (const name of names) {
        const dir = join(root, name);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const record = readRecord(dir);
        if (record) records.push(record);
      }
      records.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return records;
    },

    /**
     * Entries whose envelope has not been acknowledged yet.
     *
     * @returns {SpoolRecord[]}
     */
    pendingResults() {
      return spool.list().filter((record) => record.envelope !== null);
    },

    /**
     * Entries claimed but never completed (a crash mid-run).
     *
     * @returns {SpoolRecord[]}
     */
    interruptedTasks() {
      return spool.list().filter((record) => record.envelope === null);
    },

    /**
     * Step 3: drop the entry once Rabbit confirmed it.
     *
     * @param {{task_id: string, attempt?: number}} entry
     * @returns {boolean} Whether an entry was removed.
     */
    ack(entry) {
      const dir = taskDir(entry.task_id, Number(entry.attempt) || 1);
      try {
        statSync(dir);
      } catch {
        return false;
      }
      rmSync(dir, { recursive: true, force: true });
      return true;
    },

    /**
     * Acknowledge by dedupe key (Rabbit may answer `deduped: true`).
     *
     * @param {string} dedupeKey
     * @returns {number} Count removed.
     */
    ackByDedupeKey(dedupeKey) {
      let removed = 0;
      for (const record of spool.list()) {
        if (record.dedupe_key && record.dedupe_key === dedupeKey) {
          rmSync(record.dir, { recursive: true, force: true });
          removed += 1;
        }
      }
      return removed;
    },

    /** @returns {number} Entry count. */
    size() {
      return spool.list().length;
    },

    /** Remove everything (tests, `--reset-spool`). */
    clear() {
      const records = spool.list();
      for (const record of records) rmSync(record.dir, { recursive: true, force: true });
      return records.length;
    },
  };

  return spool;
}
