/**
 * Node-code-execution capability (v1.6.1 hardening): a **manual, in-process** switch.
 *
 * ## Policy
 *
 * This is the machine's highest-privilege switch: it allows `node -e`, i.e. arbitrary code. The policy
 * is deliberately stricter than "a file the operator can toggle":
 *
 *   1. **Only a human UI action may change it.** The capability lives in the host process's memory and
 *      is written exclusively by the same-origin host route (`/api/w2m/capability`) that the composer
 *      control calls. There is no file that can be edited, no relay field, no task/document that can
 *      grant it.
 *   2. **Nothing a machine or automation runs can enable it.** Agent tasks (grant or not) run in a
 *      child process; they can write any file they like, because files are no longer consulted. A
 *      remote caller, a scheduled task, a bootstrap answer, or another process on the machine cannot
 *      reach this module's memory.
 *   3. **It does not survive a restart.** "Permanent" means "until this host process exits", never
 *      "forever": a machine left unattended must not stay remote-code-executable across reboots.
 *
 * Old builds stored the state in `~/.w2m/exec-capability.json`. That file is **ignored** by this
 * implementation, and the UI reports the in-memory truth, so a stale permanent file from an older
 * version cannot silently re-grant execution.
 *
 * Fail-closed rules stay as before: absent/invalid state is `denied`; an expired `temporary` reads
 * `denied` with reason `expired`; the only prefix an active capability can add is the fixed
 * `node -e` constant.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EXEC_CAPABILITY_PROTOCOL = 'w2m-exec-capability/v1';
export const EXEC_CAPABILITY_ROUTE_PATH = '/api/w2m/capability';
/** The one ability the switch can turn on. Fixed here, never supplied by a request. */
export const EXEC_CAPABILITY_PREFIXES = Object.freeze([Object.freeze(['node', '-e'])]);
export const EXEC_CAPABILITY_STATES = Object.freeze(['denied', 'temporary', 'permanent']);
export const DEFAULT_TEMPORARY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TEMPORARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXEC_CAPABILITY_WARNING = 'node code execution: allows any Node code on this machine (RCE)';
/** Why a capability file on disk never authorises anything. Surfaced by the UI/status. */
export const EXEC_CAPABILITY_MANUAL_ONLY = 'capability is manual-only: set through the host UI, held in process memory, ignored from disk, relay or tasks';

/** Path kept for compatibility with old builds; it is never read and never written. */
export function defaultExecCapabilityFile(home = homedir()) {
  return join(home, '.w2m', 'exec-capability.json');
}

/** Normalise one state string; anything unknown is `null` (a caller error, not a default). */
export function normalizeExecCapabilityState(value) {
  return typeof value === 'string' && EXEC_CAPABILITY_STATES.includes(value) ? value : null;
}

/** The authoritative state. Module-level on purpose: one process, one switch. */
let memory = Object.freeze({ state: 'denied', activated_at_ms: null, expires_at_ms: null, actor: null, changed_at_ms: null });

/** Test/support hook: drop back to the standing default without touching any file. */
export function resetExecCapability() {
  memory = Object.freeze({ state: 'denied', activated_at_ms: null, expires_at_ms: null, actor: null, changed_at_ms: null });
}

/**
 * Read the capability state from process memory.
 *
 * @param {string} [_file] accepted for API compatibility; deliberately NOT read.
 * @param {number} [nowMs]
 * @returns {{state: string, effective: boolean, expires_at_ms: number|null, activated_at_ms: number|null,
 *            actor: object|null, reason: string|null, source: 'process-memory', file_ignored: true}}
 */
export function readExecCapability(_file, nowMs = Date.now()) {
  const base = {
    state: 'denied', effective: false, expires_at_ms: null, activated_at_ms: null, actor: null,
    reason: 'manual_default', source: 'process-memory', file_ignored: true,
  };
  if (memory.state === 'denied') return base;
  if (memory.state === 'temporary') {
    if (memory.expires_at_ms !== null && memory.expires_at_ms <= nowMs) {
      return { ...base, expires_at_ms: memory.expires_at_ms, activated_at_ms: memory.activated_at_ms, reason: 'expired' };
    }
    return { ...base, state: 'temporary', effective: true, reason: null, expires_at_ms: memory.expires_at_ms, activated_at_ms: memory.activated_at_ms, actor: memory.actor };
  }
  return { ...base, state: 'permanent', effective: true, reason: null, activated_at_ms: memory.activated_at_ms, actor: memory.actor };
}

/** The prefixes an active capability adds, or an empty array when it is denied/expired. */
export function effectiveExecCapabilityPrefixes(file, nowMs = Date.now()) {
  return readExecCapability(file, nowMs).effective === true ? EXEC_CAPABILITY_PREFIXES.map((prefix) => [...prefix]) : [];
}

/**
 * Change the capability. This is the host route's write path and the only way the switch moves.
 *
 * The `_file` argument is accepted for compatibility and ignored: a caller that expected a disk write
 * (an older route, a script, a test helper) still gets the value back, but the authority is memory.
 *
 * @returns {{ok: boolean, code?: string, detail?: string, capability?: object}}
 */
export function writeExecCapability(_file, input, nowMs = Date.now()) {
  const state = normalizeExecCapabilityState(input?.state);
  if (state === null) return { ok: false, code: 'CAPABILITY_STATE_INVALID', detail: 'state must be denied, temporary or permanent' };
  const actor = typeof input?.actor === 'object' && input.actor !== null ? { ...input.actor } : null;
  if (state === 'denied') {
    memory = Object.freeze({ state: 'denied', activated_at_ms: nowMs, expires_at_ms: null, actor, changed_at_ms: nowMs });
    return { ok: true, capability: describeExecCapability(undefined, nowMs) };
  }
  let ttlMs = input?.ttl_ms;
  if (state === 'temporary') {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) ttlMs = DEFAULT_TEMPORARY_TTL_MS;
    if (ttlMs > MAX_TEMPORARY_TTL_MS) return { ok: false, code: 'CAPABILITY_TTL_TOO_LONG', detail: 'temporary activation is limited to ' + MAX_TEMPORARY_TTL_MS + ' ms' };
    ttlMs = Math.floor(ttlMs);
  }
  memory = Object.freeze({
    state,
    activated_at_ms: nowMs,
    expires_at_ms: state === 'temporary' ? nowMs + ttlMs : null,
    actor,
    changed_at_ms: nowMs,
  });
  return { ok: true, capability: describeExecCapability(undefined, nowMs) };
}

/** The JSON the UI renders: state, effective, remaining time, the fixed prefix, and the manual-only rule. */
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
    manual_only: true,
    source: 'process-memory',
    file_ignored: true,
    policy: EXEC_CAPABILITY_MANUAL_ONLY,
    survives_restart: false,
  };
}
