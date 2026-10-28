/**
 * Relay ledger repair: quarantine corrupt JSONL lines and atomically rewrite the rest.
 *
 * The relay's ledger is append-only (`<state>/ledger.jsonl`, one JSON object per line). A crash
 * during an append can leave a torn line, and `Persistence` reports it rather than guessing:
 * `ledger_lines_skipped` and a `warn(ledger.jsonl, ...)` entry survive every restart. This tool is
 * the operator half of that report.
 *
 * Rules (deliberately conservative):
 *   - a line that `JSON.parse` rejects is NEVER repaired by guessing; it is moved to a quarantine
 *     file byte for byte, so the operator can inspect what was lost
 *   - dry-run is the default; writing needs `apply: true`
 *   - the original is copied to `<file>.bak-<timestamp>` (mode 0600) before the atomic rename
 *   - the read is bracketed by `stat`: if the relay appended while we were reading, the tool
 *     refuses with `LEDGER_BUSY` instead of silently dropping the new line
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const LEDGER_REPAIR_CODES = Object.freeze({
  MISSING: 'LEDGER_MISSING',
  BUSY: 'LEDGER_BUSY',
  NOT_A_FILE: 'LEDGER_NOT_A_FILE',
  WRITE_FAILED: 'LEDGER_WRITE_FAILED',
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Write bytes and fsync them, so a rename cannot publish a page the disk has not seen. */
function writeDurable(file, data, mode) {
  const fd = openSync(file, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Inspect (and optionally repair) a ledger file.
 *
 * @param {string} file absolute or relative path to `ledger.jsonl`
 * @param {{apply?: boolean, now?: number, quarantineDir?: string}} [options]
 * @returns {object} report; `ok:false` carries one of {@link LEDGER_REPAIR_CODES}
 */
export function repairLedger(file, options = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('repairLedger: a file path is required');
  if (!existsSync(file)) return { ok: false, code: LEDGER_REPAIR_CODES.MISSING, path: file };
  const before = statSync(file);
  if (!before.isFile()) return { ok: false, code: LEDGER_REPAIR_CODES.NOT_A_FILE, path: file };

  const raw = readFileSync(file);
  const afterRead = statSync(file);
  if (afterRead.mtimeMs !== before.mtimeMs || afterRead.size !== before.size) {
    return { ok: false, code: LEDGER_REPAIR_CODES.BUSY, path: file, size: before.size, size_now: afterRead.size };
  }

  const text = raw.toString('utf8');
  const hasFinalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const valid = [];
  const invalid = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      // A blank line carries no record; dropping it changes no replay outcome.
      invalid.push({ line: index + 1, reason: 'EMPTY_LINE', raw: line });
      return;
    }
    try {
      JSON.parse(line);
      valid.push(line);
    } catch (error) {
      invalid.push({ line: index + 1, reason: error instanceof Error ? error.message : String(error), raw: line });
    }
  });

  const changed = invalid.length > 0;
  const base = {
    ok: true,
    path: file,
    bytes_before: raw.length,
    sha256_before: sha256(raw),
    total_lines: lines.length,
    valid_lines: valid.length,
    invalid_count: invalid.length,
    invalid: invalid.map((entry) => ({ line: entry.line, reason: entry.reason })),
    changed,
  };
  if (!changed) return { ...base, dry_run: options.apply !== true, written: false };
  if (options.apply !== true) {
    return {
      ...base,
      dry_run: true,
      written: false,
      note: 'dry run: pass apply:true (CLI --apply) to quarantine the invalid lines and rewrite the file',
    };
  }

  const now = Number.isInteger(options.now) ? options.now : Date.now();
  const backup = `${file}.bak-${now}`;
  try {
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
  } catch (error) {
    return { ...base, dry_run: false, written: false, ok: false, code: LEDGER_REPAIR_CODES.WRITE_FAILED, error: String(error) };
  }

  const quarantineDir = options.quarantineDir ?? dirname(file);
  const quarantine = join(quarantineDir, `ledger.corrupt-${now}.jsonl`);
  try {
    writeDurable(quarantine, Buffer.from(invalid.map((entry) => entry.raw).join('\n') + '\n', 'utf8'), 0o600);
  } catch (error) {
    return { ...base, dry_run: false, written: false, ok: false, code: LEDGER_REPAIR_CODES.WRITE_FAILED, error: String(error), backup };
  }

  const next = valid.length === 0 ? '' : valid.join('\n') + (hasFinalNewline ? '\n' : '');
  const tmp = `${file}.repair-${now}.tmp`;
  try {
    writeDurable(tmp, Buffer.from(next, 'utf8'), 0o600);
    renameSync(tmp, file);
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return { ...base, dry_run: false, written: false, ok: false, code: LEDGER_REPAIR_CODES.WRITE_FAILED, error: String(error), backup, quarantine };
  }

  const written = readFileSync(file);
  const reread = written.toString('utf8').split('\n').filter((line) => line.trim() !== '');
  for (const line of reread) {
    try { JSON.parse(line); } catch (error) {
      return {
        ...base, dry_run: false, written: true, backup, quarantine,
        ok: false, code: LEDGER_REPAIR_CODES.WRITE_FAILED,
        error: 'post-write verification failed: ' + (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  return {
    ...base,
    dry_run: false,
    written: true,
    backup,
    quarantine,
    bytes_after: written.length,
    sha256_after: sha256(written),
    lines_after: reread.length,
    verified: true,
  };
}
