/**
 * Node-code-execution capability: the machine-local switch behind the plugin UI.
 *
 * The allow-list is a standing decision made by the machine owner in a config file. This module is the
 * *UI-activated* form of the same decision, scoped to one dangerous ability -- running arbitrary Node code
 * (`node -e`) -- with an explicit state: denied, temporary (24 h by default) or permanent. The DSH plugin
 * client renders the switch; the host route writes this file; the agent reads it before every task and
 * treats an active capability exactly like an additional allow-list prefix.
 *
 * Fail-closed rules:
 *   * a missing, unreadable or malformed file means `denied` (the standing default), never "on";
 *   * `temporary` whose `expires_at_ms` has passed reads as `denied` and says `expired`, so an expiry
 *     cannot be mistaken for a configuration error;
 *   * the only prefix a capability can ever add is `node -e` -- a fixed constant, not caller input.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const EXEC_CAPABILITY_PROTOCOL = 'w2m-exec-capability/v1';
export const EXEC_CAPABILITY_ROUTE_PATH = '/api/w2m/capability';
/** The one ability the switch can turn on. Fixed here, never supplied by a request. */
export const EXEC_CAPABILITY_PREFIXES = Object.freeze([Object.freeze(['node', '-e'])]);
export const EXEC_CAPABILITY_STATES = Object.freeze(['denied', 'temporary', 'permanent']);
export const DEFAULT_TEMPORARY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TEMPORARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXEC_CAPABILITY_WARNING = 'node code execution: allows any Node code on this machine (RCE)';

export function defaultExecCapabilityFile(home = homedir()) {
  return join(home, '.w2m', 'exec-capability.json');
}

/** Normalise one state string; anything unknown is `null` (a caller error, not a default). */
export function normalizeExecCapabilityState(value) {
  return typeof value === 'string' && EXEC_CAPABILITY_STATES.includes(value) ? value : null;
}

/**
 * Read the capability state. Never throws: a broken file is `denied` with reason `unreadable`/`invalid`.
 *
 * @param {string} file
 * @param {number} [nowMs]
 * @returns {{state: string, effective: boolean, expires_at_ms: number|null, activated_at_ms: number|null, actor: object|null, reason: string|null}}
 */
export function readExecCapability(file, nowMs = Date.now()) {
  const denied = (reason) => ({ state: 'denied', effective: false, expires_at_ms: null, activated_at_ms: null, actor: null, reason });
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return denied(error?.code === 'ENOENT' ? 'absent' : 'unreadable');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return denied('invalid');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return denied('invalid');
  const state = normalizeExecCapabilityState(raw.state);
  if (state === null) return denied('invalid');
  if (state === 'denied') return denied(null);
  const expiresAt = Number.isFinite(raw.expires_at_ms) ? raw.expires_at_ms : null;
  const activatedAt = Number.isFinite(raw.activated_at_ms) ? raw.activated_at_ms : null;
  if (state === 'temporary') {
    if (expiresAt === null) return denied('invalid');
    if (expiresAt <= nowMs) return { state: 'denied', effective: false, expires_at_ms: expiresAt, activated_at_ms: activatedAt, actor: null, reason: 'expired' };
  }
  if (state === 'permanent' && expiresAt !== null) return denied('invalid');
  return {
    state,
    effective: true,
    expires_at_ms: state === 'temporary' ? expiresAt : null,
    activated_at_ms: activatedAt,
    actor: typeof raw.actor === 'object' && raw.actor !== null ? { ...raw.actor } : null,
    reason: null,
  };
}

/** The prefixes an active capability adds, or an empty array when it is denied/expired. */
export function effectiveExecCapabilityPrefixes(file, nowMs = Date.now()) {
  return readExecCapability(file, nowMs).effective === true ? EXEC_CAPABILITY_PREFIXES.map((prefix) => [...prefix]) : [];
}

/**
 * Write one capability decision. `temporary` requires a TTL and records an absolute expiry.
 *
 * @returns {{ok: boolean, code?: string, detail?: string, capability?: object}}
 */
export function writeExecCapability(file, input, nowMs = Date.now()) {
  const state = normalizeExecCapabilityState(input?.state);
  if (state === null) return { ok: false, code: 'CAPABILITY_STATE_INVALID', detail: 'state must be denied, temporary or permanent' };
  if (state === 'denied') {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ protocol: EXEC_CAPABILITY_PROTOCOL, state: 'denied', activated_at_ms: nowMs, actor: input.actor ?? null }, null, 2) + '\n');
    } catch (error) {
      return { ok: false, code: 'CAPABILITY_WRITE_FAILED', detail: error?.message ?? String(error) };
    }
    return { ok: true, capability: readExecCapability(file, nowMs) };
  }
  let ttlMs = input?.ttl_ms;
  if (state === 'temporary') {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) ttlMs = DEFAULT_TEMPORARY_TTL_MS;
    if (ttlMs > MAX_TEMPORARY_TTL_MS) return { ok: false, code: 'CAPABILITY_TTL_TOO_LONG', detail: 'temporary activation is limited to ' + MAX_TEMPORARY_TTL_MS + ' ms' };
    ttlMs = Math.floor(ttlMs);
  }
  const record = {
    protocol: EXEC_CAPABILITY_PROTOCOL,
    state,
    activated_at_ms: nowMs,
    expires_at_ms: state === 'temporary' ? nowMs + ttlMs : null,
    actor: typeof input?.actor === 'object' && input.actor !== null ? { ...input.actor } : null,
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  } catch (error) {
    return { ok: false, code: 'CAPABILITY_WRITE_FAILED', detail: error?.message ?? String(error) };
  }
  return { ok: true, capability: readExecCapability(file, nowMs) };
}

/** The JSON the UI renders: state, effective, remaining time and the one prefix it would allow. */
export function describeExecCapability(file, nowMs = Date.now()) {
  const capability = readExecCapability(file, nowMs);
  return {
    protocol: EXEC_CAPABILITY_PROTOCOL,
    state: capability.state,
    effective: capability.effective,
    reason: capability.reason,
    activated_at_ms: capability.activated_at_ms,
    expires_at_ms: capability.expires_at_ms,
    remaining_ms: capability.state === 'temporary' && capability.expires_at_ms !== null ? Math.max(0, capability.expires_at_ms - nowMs) : null,
    allows: capability.effective === true ? EXEC_CAPABILITY_PREFIXES.map((prefix) => prefix.join(' ')) : [],
    warning: EXEC_CAPABILITY_WARNING,
  };
}
