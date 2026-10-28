/**
 * Secure storage for the relay operator token (v2 G0-1).
 *
 * The token must not travel through chat, argv, logs or environment dumps. This module stores it in
 * a single 0600 file under the per-user W2M directory (or W2M_OPERATOR_TOKEN_FILE), and every read
 * returns metadata plus at most a short fingerprint — never the value in logs.
 *
 * Resolution order used by the plugin: profile config (legacy) → this file → W2M_OPERATOR_TOKEN
 * (legacy compatibility; discouraged). The file is the recommended source: it is not visible in the
 * process environment and not echoed by any status output.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MIN_LENGTH = 16;
const MAX_LENGTH = 4096;

/** Where the token file lives. */
export function operatorTokenPath(env = process.env) {
  const explicit = typeof env.W2M_OPERATOR_TOKEN_FILE === 'string' ? env.W2M_OPERATOR_TOKEN_FILE.trim() : '';
  if (explicit !== '') return explicit;
  return join(homedir(), '.w2m', 'operator-token');
}

/** A stable, non-reversible fingerprint for display ("configured, id 3f2a1c..."). */
export function fingerprintOf(token) {
  if (typeof token !== 'string' || token === '') return null;
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
}

export function validateOperatorToken(token) {
  if (typeof token !== 'string') return { ok: false, code: 'OPERATOR_TOKEN_INVALID' };
  const value = token.trim();
  if (value.length < MIN_LENGTH) return { ok: false, code: 'OPERATOR_TOKEN_TOO_SHORT', detail: { min: MIN_LENGTH } };
  if (value.length > MAX_LENGTH) return { ok: false, code: 'OPERATOR_TOKEN_TOO_LONG', detail: { max: MAX_LENGTH } };
  if (/[\r\n]/.test(value)) return { ok: false, code: 'OPERATOR_TOKEN_INVALID', detail: 'token must be a single line' };
  return { ok: true, token: value };
}

/**
 * Read the token file.
 *
 * @returns {{configured: false, path: string}
 *   | {configured: true, token: string, path: string, fingerprint: string, mode: number|null}}
 */
export function readOperatorToken(options = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? operatorTokenPath(env);
  if (!existsSync(path)) return { configured: false, path };
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (error) {
    return { configured: false, path, error: error instanceof Error ? error.message : String(error) };
  }
  const checked = validateOperatorToken(raw);
  if (checked.ok !== true) return { configured: false, path, error: checked.code };
  return { configured: true, token: checked.token, path, fingerprint: fingerprintOf(checked.token) };
}

export function writeOperatorToken(token, options = {}) {
  const checked = validateOperatorToken(token);
  if (checked.ok !== true) return checked;
  const env = options.env ?? process.env;
  const path = options.path ?? operatorTokenPath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, checked.token + '\n', { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows: the file ACL carries the protection */ }
  } catch (error) {
    return { ok: false, code: 'OPERATOR_TOKEN_WRITE_FAILED', detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, path, fingerprint: fingerprintOf(checked.token) };
}

export function clearOperatorToken(options = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? operatorTokenPath(env);
  try { rmSync(path, { force: true }); } catch (error) {
    return { ok: false, code: 'OPERATOR_TOKEN_CLEAR_FAILED', detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, path };
}
