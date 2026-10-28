/**
 * Relay-side ToFuture whitelist (S2): rows are HMACs only, never identifiers.
 *
 * The admin provisions `<stateDir>/tofuture-whitelist.json` offline:
 *   { "v": 1, "rows": [ { "kind": "mac", "hmac": "<64hex>", "salt_id": "<16hex>" }, ... ] }
 *
 * `compare(entries)` is intentionally silent: it returns only whether ANY entry matched, never
 * which row, which kind, or how many; callers must not send that boolean to the client.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;

export function loadWhitelist(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return { ok: true, rows: [], empty: true };
  const path = join(stateDir, 'tofuture-whitelist.json');
  if (!existsSync(path)) return { ok: true, rows: [], empty: true, path };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, code: 'TOFUTURE_WHITELIST_INVALID', path }; }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const clean = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (!HEX64.test(String(row.hmac ?? ''))) continue;
    if (!HEX16.test(String(row.salt_id ?? ''))) continue;
    // Only the HMAC and its salt id are kept; any extra field (a leaked identifier) is dropped.
    clean.push({ kind: typeof row.kind === 'string' ? row.kind.slice(0, 8) : 'any', hmac: String(row.hmac), salt_id: String(row.salt_id) });
  }
  return { ok: true, rows: clean, empty: clean.length === 0, path };
}

/** @returns {boolean} true when at least one entry matches a whitelisted HMAC. */
export function whitelistMatches(whitelist, entries) {
  if (whitelist === null || whitelist.ok !== true || Array.isArray(whitelist.rows) !== true) return false;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const byHmac = new Set(whitelist.rows.map((row) => row.hmac + '|' + row.salt_id));
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (!HEX64.test(String(entry.hmac ?? ''))) continue;
    if (!HEX16.test(String(entry.salt_id ?? ''))) continue;
    if (byHmac.has(String(entry.hmac) + '|' + String(entry.salt_id))) return true;
  }
  return false;
}
