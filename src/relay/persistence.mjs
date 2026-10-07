/**
 * W2M Rabbit relay — v0.1.2 persistence (PROTOCOL-v0.1.2 §7).
 *
 * `<state>/devices.json`  atomic snapshot (tmp file + rename)
 * `<state>/ledger.jsonl`  append-only, one JSON object per line
 * `<state>/operator-token.txt`  single line, 0600
 *
 * This is the only relay module allowed to touch the filesystem.
 * Corruption is never silent: every skipped line / unreadable snapshot is
 * recorded in `warnings` and surfaced through `/healthz`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { rfc3339 } from './state.mjs';

export const DEVICES_FILE = 'devices.json';
export const LEDGER_FILE = 'ledger.jsonl';
export const OPERATOR_TOKEN_FILE = 'operator-token.txt';

/** Ledger entry types understood by `RabbitState#restore`. */
export const LEDGER_TYPES = Object.freeze([
  'task.created',
  'lease.changed',
  'result.stored',
  'task.cancelled',
]);

export class Persistence {
  /**
   * @param {{dir?:string|null, now?:() => number}} options `dir: null` disables persistence.
   */
  constructor({ dir = null, now = Date.now } = {}) {
    this.dir = dir ? path.resolve(dir) : null;
    this._now = now;
    /** @type {{file:string, message:string, line?:number}[]} */
    this.warnings = [];
    this.devicesCorrupt = false;
    this.devicesMissing = true;
    this.revivedDevices = 0;
    this.revivedTasks = 0;
    this.ledgerLinesRead = 0;
    this.ledgerLinesSkipped = 0;
  }

  get enabled() { return this.dir !== null; }
  get devicesFile() { return this.enabled ? path.join(this.dir, DEVICES_FILE) : null; }
  get ledgerFile() { return this.enabled ? path.join(this.dir, LEDGER_FILE) : null; }
  get operatorTokenFile() { return this.enabled ? path.join(this.dir, OPERATOR_TOKEN_FILE) : null; }

  warn(file, message, extra = {}) {
    this.warnings.push({ file, message, ...extra });
    return this.warnings[this.warnings.length - 1];
  }

  ensureDir() {
    if (!this.enabled) return false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return true;
  }

  /* ---------------- devices.json ---------------- */

  /**
   * @returns {{devices: Record<string, object>, corrupt: boolean, missing: boolean}}
   * `corrupt: true` means the snapshot was unreadable — the caller starts from an
   * EMPTY table and must report that loudly (never a silent wipe).
   */
  loadDevices() {
    if (!this.enabled) return { devices: {}, corrupt: false, missing: true };
    if (!fs.existsSync(this.devicesFile)) return { devices: {}, corrupt: false, missing: true };

    let raw;
    try {
      raw = fs.readFileSync(this.devicesFile, 'utf8');
    } catch (err) {
      this.devicesCorrupt = true;
      this.warn(DEVICES_FILE, `unreadable (${err.message}); starting from an empty device table`);
      return { devices: {}, corrupt: true, missing: false };
    }
    if (raw.trim() === '') return { devices: {}, corrupt: false, missing: false };

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('snapshot must be a JSON object keyed by machine_id');
      }
      return { devices: parsed, corrupt: false, missing: false };
    } catch (err) {
      this.devicesCorrupt = true;
      this.warn(DEVICES_FILE, `corrupt snapshot ignored (${err.message}); starting from an empty device table`);
      return { devices: {}, corrupt: true, missing: false };
    }
  }

  /** Atomic snapshot: write a temp file, fsync, then rename over the target. */
  saveDevices(devices) {
    if (!this.enabled) return false;
    this.ensureDir();
    const out = {};
    const iterable = devices instanceof Map ? devices.values() : Object.values(devices ?? {});
    for (const d of iterable) {
      out[d.machine_id] = {
        machine_name: d.machine_name ?? d.machine_id,
        platform: d.platform ?? {},
        caps: d.caps ?? {},
        user_id: d.user_id ?? null,
        device_token: d.device_token ?? null,
        paired_at: rfc3339(d.paired_at_ms ?? this._now()),
        re_paired: d.re_paired === true,
      };
    }
    const body = JSON.stringify(out, null, 2);
    const tmp = `${this.devicesFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.devicesFile);
    return true;
  }

  /* ---------------- ledger.jsonl ---------------- */

  /** Replay-safe read: a single broken line is skipped and counted, never fatal. */
  loadLedger() {
    if (!this.enabled) return [];
    if (!fs.existsSync(this.ledgerFile)) return [];
    let text;
    try {
      text = fs.readFileSync(this.ledgerFile, 'utf8');
    } catch (err) {
      this.warn(LEDGER_FILE, `unreadable (${err.message}); ledger not replayed`);
      return [];
    }
    const entries = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      this.ledgerLinesRead += 1;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
          throw new Error('entry must be an object with a string `type`');
        }
        entries.push(entry);
      } catch (err) {
        this.ledgerLinesSkipped += 1;
        this.warn(LEDGER_FILE, `line ${i + 1} skipped: ${err.message}`, { line: i + 1 });
      }
    }
    return entries;
  }

  /** §7: synchronous append is enough — the volume is tiny. */
  append(entry) {
    if (!this.enabled) return false;
    this.ensureDir();
    const line = `${JSON.stringify({ ts: rfc3339(this._now()), ...entry })}\n`;
    fs.appendFileSync(this.ledgerFile, line, { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  /* ---------------- operator-token.txt ---------------- */

  readOperatorToken() {
    if (!this.enabled) return null;
    try {
      if (!fs.existsSync(this.operatorTokenFile)) return null;
      const token = fs.readFileSync(this.operatorTokenFile, 'utf8').trim();
      return token.length > 0 ? token : null;
    } catch (err) {
      this.warn(OPERATOR_TOKEN_FILE, `unreadable (${err.message}); a new token will be generated`);
      return null;
    }
  }

  writeOperatorToken(token) {
    if (!this.enabled || !token) return false;
    this.ensureDir();
    fs.writeFileSync(this.operatorTokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.operatorTokenFile, 0o600); } catch { /* best effort on Windows */ }
    return true;
  }

  /** Redacted view for `/healthz` — never contains tokens. */
  describe() {
    return {
      enabled: this.enabled,
      dir: this.dir,
      revived_devices: this.revivedDevices,
      revived_tasks: this.revivedTasks,
      devices_corrupt: this.devicesCorrupt,
      devices_missing: this.devicesMissing,
      ledger_lines_read: this.ledgerLinesRead,
      ledger_lines_skipped: this.ledgerLinesSkipped,
      warnings: this.warnings.map((w) => ({ ...w })),
    };
  }
}

export default Persistence;
