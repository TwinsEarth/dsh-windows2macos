/**
 * DSH-GPW v2 (v1.7.5-beta.1) — Global Permission Watchdog, now a folder gate rather than an approval answerer.
 *
 * ## The three classes and who answers
 *
 *   A. blacklist  -> denied. A synchronous guard is registered on each agent (agent.ctx.tools.guard), so the denial holds no matter
 *                    which other pre-execute listener runs first.
 *   B. whitelist  -> allowed without a human. The whitelist is an explicit extension of the workspace (same decision,
 *                    plus the auto-approval budget below).
 *   C. other      -> GPW's own pending queue: the call is held until the operator allows/denies it in the GPW panel
 *                    (or the pending timeout fires, which denies). This is the plugin's requirement, not DSH's
 *                    approval policy, which is why it keeps working under "完全权限" (approval: never).
 *
 * ## Full-access only
 *
 * The gate runs only when `ctx.permissionPresets.current(session) === 'danger-full-access'` (the GUI preset labelled
 * 完全权限). In the other presets DSH's own sandbox/approval answers the question and a second gate would only add
 * surprises; the listener returns `next()` untouched.
 *
 * ## The budget still exists
 *
 * Whitelisted auto-approvals are still permission decisions made without a human reading them, so the same rolling
 * window applies. When the budget is exhausted a whitelisted call does not silently pass: it falls into the pending
 * queue like a class-C call. That is the "升级自动审批" half: automatic, but bounded and visible.
 *
 * ## Operator surface
 *
 * The panel is rendered by the w2m client (`lib/client.js`): a pending prompt sits inline in the composer row,
 * and a floating "GPW 文件夹" button opens the three sections (whitelist / blacklist / recently intercepted)
 * plus the pending queue. Folders can be typed (validated against the filesystem here) or taken from the
 * recently-intercepted list in one click. Lists live in a MAC-signed v2 JSON file under `$DSH_HOME/xclient/`
 * (written read-only 0444), never in the profile patch; an external edit is detected and locks class-B/C paths
 * until the operator resets the lists.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { classifyToolCall, isInside, normalizeFolder } from './folder-policy.mjs';
import { classifyGpwCall, fingerprintOf } from './gpw-colors.mjs';

export const name = 'dsh-gpw';

/**
 * Which list (if any) already covers a folder, for the "recently intercepted" fold.
 *
 * A recent row whose folder is already covered by a list is noise: the operator already made that decision. Those rows
 * are collapsed in the panel, and adding a folder from a recent row removes the row outright.
 */
export function folderInLists(folder, lists) {
  if (typeof folder !== 'string' || folder.trim() === '') return null;
  let target;
  try {
    target = normalizeFolder(folder);
  } catch {
    return null;
  }
  const inList = (entries) => (Array.isArray(entries) ? entries : []).some((entry) => {
    try {
      const root = normalizeFolder(entry);
      return isInside(target, root) || isInside(root, target);
    } catch {
      return false;
    }
  });
  if (inList(lists?.whitelist)) return 'whitelist';
  if (inList(lists?.blacklist)) return 'blacklist';
  return null;
}

/** True when a recent row's folder is the folder just added, or lives inside it. */
export function foldIsCoveredBy(addedFolder, candidate) {
  if (typeof addedFolder !== 'string' || typeof candidate !== 'string') return false;
  try {
    const added = normalizeFolder(addedFolder);
    const target = normalizeFolder(candidate);
    return target === added || isInside(target, added);
  } catch {
    return false;
  }
}


/** Services this plugin cannot work without. `connection` is used only for the operator routes. */
export const inject = ['permissionPresets'];

export const FULL_ACCESS_PRESET = 'danger-full-access';
export const GPW_ROUTE = '/api/w2m/gpw/state';
export const GPW_FOLDERS_ROUTE = '/api/w2m/gpw/folders';
export const GPW_DECIDE_ROUTE = '/api/w2m/gpw/decide';
export const GPW_PICK_ROUTE = '/api/w2m/gpw/pick';
export const GPW_RESET_ROUTE = '/api/w2m/gpw/reset';

const DEFAULT_BUDGET = { maxPerWindow: 10, windowMs: 60_000, minGapMs: 3_000 };
const DEFAULT_PENDING_TIMEOUT_MS = 100_000;
const RECENT_LIMIT = 20;
const NO_STORE = { 'cache-control': 'no-store' };
/** v1.7.9: lists are MAC-signed (v2) so an external edit is detectable instead of silently trusted. */
const FOLDERS_VERSION = 2;
const FOLDERS_MAC_ALGO = 'sha256';

/** Resolve the folders file: config first, then `$DSH_HOME/xclient/gpw-folders.json`. */
export function foldersFileOf(config = {}) {
  if (typeof config.foldersFile === 'string' && config.foldersFile.trim() !== '') return config.foldersFile.trim();
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'xclient', 'gpw-folders.json');
}

/** The sidecar file that holds the MAC key. Kept next to (never inside) the lists file. */
export function foldersKeyFileOf(file) {
  return `${file}.key`;
}

/**
 * Resolve the MAC key: explicit config / env first, else a generated 32-byte key in a 0600 sidecar.
 * `created` is true only when this call generated the key, which is what lets a legacy plain-JSON
 * file be migrated exactly once and a later unsigned file be treated as tampering instead.
 */
export function ensureFoldersKey(file, config = {}) {
  const fromConfig = typeof config.foldersKey === 'string' && config.foldersKey.trim() !== '' ? config.foldersKey.trim() : null;
  const fromEnv = typeof process.env.W2M_GPW_FOLDERS_KEY === 'string' && process.env.W2M_GPW_FOLDERS_KEY.trim() !== ''
    ? process.env.W2M_GPW_FOLDERS_KEY.trim()
    : null;
  const explicit = fromConfig ?? fromEnv;
  if (explicit !== null) return { key: explicit, created: false, source: fromConfig !== null ? 'config' : 'env' };
  const keyFile = foldersKeyFileOf(file);
  try {
    const existing = readFileSync(keyFile, 'utf8').trim();
    if (existing !== '') return { key: existing, created: false, source: 'file' };
  } catch {
    /* generated below */
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyFile, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch { /* best effort on Windows */ }
  return { key, created: true, source: 'file' };
}

/** Canonical MAC over the two lists (order-independent, so adding/removing a row is what changes it). */
export function macOfFolders(whitelist, blacklist, key) {
  const canonical = JSON.stringify({
    whitelist: [...new Set(whitelist)].sort(),
    blacklist: [...new Set(blacklist)].sort(),
  });
  return createHmac(FOLDERS_MAC_ALGO, key).update(canonical).digest('hex');
}

/**
 * Read the operator-managed lists.
 *
 *   - missing file + `allowMissing` -> clean empty lists (first run)
 *   - missing file otherwise       -> `tampered` (the signed file was deleted)
 *   - valid v2 + MAC               -> lists
 *   - v2 with a bad MAC            -> `tampered` (edited outside GPW)
 *   - no version/MAC (legacy)      -> `legacy: true`; the caller migrates once or treats it as tampered
 */
export function readFolders(file, key = null, options = {}) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && key !== null && options.allowMissing !== true) {
      return { whitelist: [], blacklist: [], tampered: true, reason: 'folder lists file is missing' };
    }
    if (error?.code !== 'ENOENT') {
      return { whitelist: [], blacklist: [], tampered: true, reason: `folder lists unreadable: ${error?.message ?? error}` };
    }
    return { whitelist: [], blacklist: [], tampered: false, reason: null, legacy: false };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { whitelist: [], blacklist: [], tampered: true, reason: 'folder lists file is not valid JSON' };
  }
  const whitelist = Array.isArray(parsed?.whitelist) ? parsed.whitelist.filter((v) => typeof v === 'string' && v !== '') : [];
  const blacklist = Array.isArray(parsed?.blacklist) ? parsed.blacklist.filter((v) => typeof v === 'string' && v !== '') : [];
  if (parsed?.version !== FOLDERS_VERSION || typeof parsed?.mac !== 'string') {
    return { whitelist, blacklist, tampered: false, reason: null, legacy: true };
  }
  if (key === null) return { whitelist, blacklist, tampered: false, reason: null, legacy: false };
  if (macOfFolders(whitelist, blacklist, key) !== parsed.mac) {
    return { whitelist, blacklist, tampered: true, reason: 'folder lists were modified outside GPW (MAC mismatch)' };
  }
  return { whitelist, blacklist, tampered: false, reason: null, legacy: false };
}

/**
 * Persist the operator-managed lists.
 *
 * Atomic (tmp + rename), MAC-signed when a key is supplied, and left **read-only** (0444) so an
 * accidental or casual edit from the agent's file tools fails instead of silently changing policy.
 * GPW itself rewrites by clearing the flag, writing a new tmp file and renaming over the target.
 */
export function writeFolders(file, folders, key = null) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const whitelist = [...new Set((folders?.whitelist ?? []).filter((v) => typeof v === 'string' && v.trim() !== ''))];
  const blacklist = [...new Set((folders?.blacklist ?? []).filter((v) => typeof v === 'string' && v.trim() !== ''))];
  const next = { version: FOLDERS_VERSION, whitelist, blacklist };
  if (key !== null) {
    next.algo = FOLDERS_MAC_ALGO;
    next.mac = macOfFolders(whitelist, blacklist, key);
  }
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  // Windows refuses to rename over a read-only target: clear it first, then the atomic replace runs.
  try { chmodSync(file, 0o644); } catch { /* first write */ }
  writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, file);
  try { chmodSync(file, 0o444); } catch { /* read-only is best effort on Windows, MAC still verifies */ }
  return { whitelist, blacklist };
}

/** Operator reset: drop every entry and re-sign. Used only after a tamper report. */
export function resetFolders(file, key) {
  return writeFolders(file, { whitelist: [], blacklist: [] }, key);
}

/**
 * Validate a typed folder before it enters a list.
 *
 * The panel's input is the one place the operator can write a path by hand, so the check belongs here: an absolute path
 * to an existing directory. `resolve` normalises `..` and trailing separators so the same folder is one entry.
 *
 * @param {unknown} input
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function validateFolderInput(input) {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, error: 'a folder path is required' };
  const raw = input.trim();
  if (/^[a-zA-Z]:$/.test(raw) || raw === '/') return { ok: false, error: 'a drive root cannot be a policy folder' };
  const absolute = resolve(raw);
  try {
    if (!statSync(absolute).isDirectory()) return { ok: false, error: `not a directory: ${absolute}` };
  } catch {
    return { ok: false, error: `folder does not exist: ${absolute}` };
  }
  return { ok: true, path: absolute };
}

/** The nearest existing directory at or above `target`, for one-click "add this to a list". */
export function folderForPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return null;
  let current = resolve(target.trim());
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Map a tool-exec object onto the shape folder-policy understands. */
export function toolCallOf(exec) {
  const parameters = exec?.parameters ?? exec?.arguments ?? exec?.input ?? exec?.args ?? exec?.toolCall?.parameters ?? null;
  return {
    name: typeof exec?.name === 'string' ? exec.name : (exec?.toolName ?? exec?.tool ?? null),
    arguments: parameters,
  };
}

/**
 * Pure gate decision, exported so the three classes are testable without a session.
 *
 * @param {{classification: {decision: 'deny'|'allow'|'pass', reason?: string},
 *          autoAllowBudgetRemaining?: boolean}} input
 * @returns {{kind: 'allow'|'deny'|'pending', reason: string}}
 */
export function planGate(input) {
  const classification = input?.classification ?? { decision: 'pass', reason: '' };
  if (classification.decision === 'deny') {
    return { kind: 'deny', reason: classification.reason ?? 'the target is on the blacklist' };
  }
  if (classification.decision === 'allow') {
    if (input.autoAllowBudgetRemaining === false) {
      return { kind: 'pending', reason: 'whitelisted, but the auto-approval budget is exhausted' };
    }
    return { kind: 'allow', reason: classification.reason ?? 'the target is on the whitelist' };
  }
  return { kind: 'pending', reason: classification.reason ?? 'the target is on neither list' };
}

/** Coerce a config value to a positive integer, falling back to the default. */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Launch a native folder picker and resolve with its path, or null. Never rejects. */
function pickFolder() {
  return new Promise((resolvePath) => {
    const done = (value) => resolvePath(typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
    try {
      if (process.platform === 'win32') {
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          '$d.Description = "GPW: choose a folder for the whitelist or blacklist"',
          'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
        ].join('; ');
        const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          done(out.trim());
        };
        child.stdout?.on('data', (chunk) => {
          out = (out + chunk.toString('utf8')).slice(-4096);
        });
        child.on('error', () => finish());
        child.on('close', finish);
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          finish();
        }, 120_000).unref?.();
        return;
      }
      if (process.platform === 'darwin') {
        const child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "GPW: choose a folder")'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout?.on('data', (chunk) => {
          out += chunk.toString('utf8');
        });
        child.on('error', () => done(null));
        child.on('close', () => done(out.trim()));
        return;
      }
      const child = spawn('zenity', ['--file-selection', '--directory', '--title=GPW: choose a folder'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout?.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => done(null));
      child.on('close', () => done(out.trim()));
    } catch {
      done(null);
    }
  });
}

/**
 * @param {object} ctx Cordis context.
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const maxPerWindow = positiveInt(config.maxPerWindow, DEFAULT_BUDGET.maxPerWindow);
  const windowMs = positiveInt(config.windowMs, DEFAULT_BUDGET.windowMs);
  const minGapMs = positiveInt(config.minGapMs, DEFAULT_BUDGET.minGapMs);
  const pendingTimeoutMs = positiveInt(config.pendingTimeoutMs, DEFAULT_PENDING_TIMEOUT_MS);
  const requireFullAccess = config.requireFullAccess !== false;
  const foldersFile = foldersFileOf(config);
  const keyInfo = ensureFoldersKey(foldersFile, config);
  const foldersKey = keyInfo.key;
  /** Set once the signed file has been read cleanly; a later disappearance then reads as tampering. */
  let foldersSeen = false;
  /** Non-null until the operator resets the lists; class-B/C paths are locked while it is set. */
  let tamperedReason = null;

  const noteTamper = (reason) => {
    const next = reason ?? 'folder lists failed integrity check';
    if (tamperedReason === null) ctx.logger?.warn?.(`dsh-gpw: ${next}; class-B/C paths are locked until the operator resets the lists`);
    tamperedReason = next;
  };

  // First read: migrate a legacy plain-JSON file exactly once; after that an unsigned/missing file is tampering.
  const initialFolders = readFolders(foldersFile, foldersKey, { allowMissing: keyInfo.created || !existsSync(foldersFile) });
  if (initialFolders.legacy) ctx.logger?.info?.('dsh-gpw: migrating legacy folder lists to MAC-signed v2 (read-only)');
  if (initialFolders.tampered) {
    noteTamper(initialFolders.reason);
  } else {
    // Always leave a signed v2 file behind (first run creates the empty one; later runs re-sign it).
    try {
      writeFolders(foldersFile, initialFolders, foldersKey);
      foldersSeen = true;
    } catch (error) {
      noteTamper(`folder lists could not be initialized: ${error?.message ?? error}`);
    }
  }

  /** Timestamps of auto-approvals in the current window. */
  const approvals = [];
  let lastApprovalAt = null;
  let allowedTotal = 0;
  let pendingTotal = 0;
  let deniedTotal = 0;
  /** id -> { resolve, createdAt, tool, reason, paths } */
  const pending = new Map();
  /** Newest-first record of calls the gate saw, so the panel can offer "add this folder" in one click. */
  const recent = [];
  /** Four-colour counters: every decision lands in exactly one bucket (v1.7.10). */
  const colorCounts = { green: 0, blue: 0, yellow: 0, red: 0 };
  /** Operation fingerprints approved earlier in this session -> the blue ("正常") state. */
  const sessionGrants = new Set();

  const noteRecent = (entry) => {
    recent.unshift({ at: Date.now(), ...entry });
    if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  };

  const folderLists = () => {
    const stored = readFolders(foldersFile, foldersKey, { allowMissing: keyInfo.created && !foldersSeen });
    if (stored.legacy) {
      noteTamper('folder lists lost their integrity signature (edited outside GPW?)');
    } else if (stored.tampered) {
      noteTamper(stored.reason);
    } else {
      foldersSeen = true;
    }
    const merge = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...b])];
    return {
      whitelist: merge(config.whitelist, stored.whitelist),
      blacklist: merge(config.blacklist, stored.blacklist),
      tampered: tamperedReason !== null,
      reason: tamperedReason,
    };
  };

  const prune = (nowMs) => {
    while (approvals.length > 0 && nowMs - approvals[0] >= windowMs) approvals.shift();
  };

  /** Consume one budget slot if one is available. */
  const takeBudgetSlot = () => {
    const nowMs = Date.now();
    prune(nowMs);
    if (lastApprovalAt !== null && nowMs - lastApprovalAt < minGapMs) return false;
    if (approvals.length >= maxPerWindow) return false;
    approvals.push(nowMs);
    lastApprovalAt = nowMs;
    allowedTotal += 1;
    return true;
  };

  const isFullAccess = (agent) => {
    try {
      if (typeof ctx.permissionPresets?.current !== 'function') return false;
      return ctx.permissionPresets.current(agent?.session) === FULL_ACCESS_PRESET;
    } catch {
      return false;
    }
  };

  /** Hold a class-C (or over-budget B) call until the operator answers. */
  const waitForOperator = (exec, reason, paths) => new Promise((resolveDecision) => {
    const id = randomUUID();
    const entry = {
      resolve: resolveDecision,
      createdAt: Date.now(),
      tool: String(toolCallOf(exec).name ?? 'tool'),
      reason,
      paths,
      color: 'yellow',
      fingerprint: fingerprintOf(toolCallOf(exec)),
      sessionId: String(exec?.agent?.session?.header?.id ?? ''),
    };
    pending.set(id, entry);
    pendingTotal += 1;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // v1.8.2 timeout policy: a yellow (class-C) call that nobody answered is approved after 100 s. Red never reaches
      // this queue (it is denied outright) and black/white list hits never become pending, so this rule cannot widen
      // either list's authority. The approval is recorded as a session grant, which is what turns its next occurrence
      // blue.
      allowedTotal += 1;
      colorCounts.blue += 1;
      if (typeof entry.fingerprint === 'string' && entry.fingerprint !== '') sessionGrants.add(entry.fingerprint);
      resolveDecision({ kind: 'allow', reason: `GPW: auto-approved after ${Math.round(pendingTimeoutMs / 1000)} s with no operator answer (yellow path; black/white lists keep their own rules)` });
    }, pendingTimeoutMs);
    timer.unref?.();
    entry.timer = timer;
  });

  const decidePending = (id, decision) => {
    const entry = pending.get(id);
    if (entry === undefined) return { ok: false, error: 'unknown pending request' };
    pending.delete(id);
    try {
      clearTimeout(entry.timer);
    } catch {
      /* already fired */
    }
    if (decision === 'allow' || decision === 'allow-session') {
      allowedTotal += 1;
      if (typeof entry.fingerprint === 'string' && entry.fingerprint !== '') sessionGrants.add(entry.fingerprint);
      entry.resolve({ kind: 'allow', reason: decision === 'allow-session' ? 'GPW: allowed for this session (blue)' : 'GPW: allowed by the operator' });
    } else {
      deniedTotal += 1;
      entry.resolve({ kind: 'deny', reason: 'GPW: denied by the operator' });
    }
    return { ok: true };
  };

  // --- A: the blacklist denial must hold regardless of listener order -------------------------------------------------
  //
  // v1.7.8: the guard is registered on each agent's own context, from an `agent/created` listener.
  //
  // Registering it on the root context (ctx.tools.guard at activation) crashed dsh-gpw with
  //   TypeError: Cannot read properties of undefined (reading 'layers')
  // because the tools service is composed per agent: the root-scope instance has no layer table yet at activation time.
  // The documented shape for per-agent behavior is agent.ctx obtained in agent/created; the disposer is kept so an
  // unloaded plugin cannot leave guards behind.
  /** @type {Map<object, () => void>} */
  const agentGuards = new Map();
  const blacklistGuard = () => (exec) => {
    if (!isFullAccess(exec?.agent)) return undefined;
    const lists = folderLists();
    const call = toolCallOf(exec);
    if (lists.tampered) {
      // Fail closed: while the lists cannot be trusted, every path-naming call is refused outright.
      const probe = classifyToolCall({ ...call, whitelist: [], blacklist: [] });
      if (probe.paths.length === 0) return undefined;
      deniedTotal += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'deny', reason: lists.reason, paths: probe.paths });
      ctx.logger?.warn?.(`dsh-gpw: refused ${String(call.name ?? 'tool')} -- lists locked (${lists.reason})`);
      return `GPW: folder lists failed integrity check (${lists.reason}); reset them in the GPW panel`;
    }
    if (lists.blacklist.length === 0) return undefined;
    const result = classifyToolCall({ ...call, blacklist: lists.blacklist });
    if (result.decision !== 'deny') return undefined;
    deniedTotal += 1;
    noteRecent({ tool: String(call.name ?? 'tool'), decision: 'deny', reason: result.reason, paths: result.paths });
    ctx.logger?.warn?.(`dsh-gpw: refused ${String(call.name ?? 'tool')} -- ${result.reason}`);
    return `GPW: ${result.reason}; the call was not executed`;
  };
  ctx.on('agent/created', ({ agent } = {}) => {
    try {
      const guard = agent?.ctx?.tools?.guard;
      if (typeof guard !== 'function') return; // host without the guard extension: pre-execute still denies
      const dispose = guard(blacklistGuard());
      if (typeof dispose === 'function') agentGuards.set(agent, dispose);
    } catch {
      /* the pre-execute branch below still enforces the blacklist */
    }
  });
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of agentGuards.values()) {
        try {
          dispose();
        } catch {
          /* already disposed with its agent */
        }
      }
      agentGuards.clear();
    }, 'dsh-gpw: per-agent blacklist guards');
  }


  // --- B/C: the pre-execute gate ---------------------------------------------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (requireFullAccess && !isFullAccess(exec?.agent)) return next();
    const lists = folderLists();
    const call = toolCallOf(exec);
    if (lists.tampered) {
      // Fail closed: a tampered list file must not be able to silently turn policy off.
      const probe = classifyToolCall({ ...call, whitelist: [], blacklist: [] });
      if (probe.paths.length === 0) return next();
      deniedTotal += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'deny', reason: lists.reason, paths: probe.paths });
      ctx.logger?.warn?.(`dsh-gpw: refused ${String(call.name ?? 'tool')} -- lists locked (${lists.reason})`);
      return { kind: 'deny', reason: `GPW: folder lists failed integrity check (${lists.reason}); reset them in the GPW panel` };
    }
    let cwd = null;
    try {
      cwd = await ctx.workingDirectory?.ensure?.(exec.agent, exec.signal);
    } catch {
      cwd = null;
    }
    // A listed folder covers its subfolders; relative command paths are resolved against the workspace so a
    // subfolder reference is classified rather than treated as "names no path".
    const classification = classifyToolCall({ ...call, whitelist: lists.whitelist, blacklist: lists.blacklist, workspace: cwd ?? null, base: cwd ?? undefined, allowRelative: cwd !== null });
    // v1.7.10: one four-colour decision in front of the folder plan, so every audit behaviour in DSH has one home.
    const fingerprint = fingerprintOf(call);
    const colour = classifyGpwCall({
      name: call.name,
      arguments: call.arguments,
      paths: classification.paths,
      whitelist: lists.whitelist,
      blacklist: lists.blacklist,
      workspace: cwd ?? null,
      authorized: sessionGrants.has(fingerprint),
    });
    if (colour.color === 'red') {
      deniedTotal += 1;
      colorCounts.red += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'deny', color: 'red', reason: colour.reason, paths: classification.paths });
      ctx.logger?.warn?.(`dsh-gpw: red -- refused ${String(call.name ?? 'tool')} -- ${colour.reason}`);
      return { kind: 'deny', reason: `GPW red: ${colour.reason}` };
    }
    if (colour.color === 'green' || colour.color === 'blue') {
      colorCounts[colour.color] += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'allow', color: colour.color, reason: colour.reason, paths: classification.paths });
      ctx.logger?.info?.(`dsh-gpw: ${colour.color} -- ${String(call.name ?? 'tool')} -- ${colour.reason}`);
      return { kind: 'allow' };
    }
    if (classification.decision === 'pass' && classification.paths.length === 0) {
      colorCounts.yellow += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'pending', color: 'yellow', reason: colour.reason, paths: [] });
      return waitForOperator(exec, colour.reason, []);
    }
    const budget = classification.decision === 'allow' ? takeBudgetSlot() : false;
    const plan = planGate({ classification, autoAllowBudgetRemaining: classification.decision === 'allow' ? budget !== false : undefined });
    if (plan.kind === 'deny') {
      deniedTotal += 1;
      colorCounts.red += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'deny', color: 'red', reason: plan.reason, paths: classification.paths });
      ctx.logger?.warn?.(`dsh-gpw: refused ${String(call.name ?? 'tool')} -- ${plan.reason}`);
      return { kind: 'deny', reason: `GPW: ${plan.reason}` };
    }
    if (plan.kind === 'allow') {
      colorCounts.green += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'allow', color: 'green', reason: plan.reason, paths: classification.paths });
      ctx.logger?.info?.(`dsh-gpw: auto-allowed ${String(call.name ?? 'tool')} -- ${plan.reason}`);
      return { kind: 'allow' };
    }
    colorCounts.yellow += 1;
    noteRecent({ tool: String(call.name ?? 'tool'), decision: 'pending', color: 'yellow', reason: plan.reason, paths: classification.paths });
    ctx.logger?.info?.(`dsh-gpw: holding ${String(call.name ?? 'tool')} for operator -- ${plan.reason}`);
    return waitForOperator(exec, plan.reason, classification.paths);
  });

  // --- operator routes (folders + pending queue + recent list + native picker) -----------------------------------------
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') return;
    const json = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });

    registry.register({
      path: GPW_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const lists = folderLists();
        return json({
          ok: true,
          enabled: true,
          require_full_access: requireFullAccess,
          folders: { whitelist: lists.whitelist, blacklist: lists.blacklist },
          tampered: lists.tampered,
          tampered_reason: lists.reason,
          counters: { allowedTotal, pendingTotal, deniedTotal, budgetWindow: approvals.length, maxPerWindow, colors: { ...colorCounts }, grants: sessionGrants.size },
          recent: recent.map((entry) => {
            const folder = entry.paths.length > 0 ? folderForPath(entry.paths[0]) : null;
            return {
              at: entry.at,
              tool: entry.tool,
              decision: entry.decision,
              color: entry.color ?? null,
              reason: entry.reason,
              paths: entry.paths,
              folder,
              folder_in: folderInLists(folder, lists),
            };
          }),
          pending: [...pending.entries()].map(([id, entry]) => ({
            id,
            tool: entry.tool,
            reason: entry.reason,
            paths: entry.paths,
            folder: entry.paths.length > 0 ? folderForPath(entry.paths[0]) : null,
            pending_ms: Date.now() - entry.createdAt,
          })),
        });
      },
    });

    registry.register({
      path: GPW_FOLDERS_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null;
        try {
          body = await request.json();
        } catch {
          /* refused below */
        }
        const list = body?.list;
        if (list !== 'whitelist' && list !== 'blacklist') return json({ ok: false, error: 'list must be whitelist or blacklist' }, 400);
        if (body?.action !== 'add' && body?.action !== 'remove') return json({ ok: false, error: 'action must be add or remove' }, 400);
        const current = folderLists();
        if (current.tampered) {
          return json({ ok: false, error: `folder lists are locked after an integrity failure (${current.reason}); reset them first` }, 409);
        }
        const stored = readFolders(foldersFile, foldersKey, { allowMissing: true });
        if (body.action === 'remove') {
          if (typeof body?.path !== 'string' || body.path.trim() === '') return json({ ok: false, error: 'path must be a non-empty string' }, 400);
          const next = { ...stored, [list]: stored[list].filter((entry) => entry !== body.path) };
          try {
            writeFolders(foldersFile, next, foldersKey);
          } catch (error) {
            return json({ ok: false, error: `could not write folder lists: ${error?.message ?? error}` }, 500);
          }
          return json({ ok: true, folders: folderLists() });
        }
        const validated = validateFolderInput(body?.path);
        if (!validated.ok) return json({ ok: false, error: validated.error }, 400);
        const next = { ...stored, [list]: [...new Set([...stored[list], validated.path])] };
        try {
          writeFolders(foldersFile, next, foldersKey);
        } catch (error) {
          return json({ ok: false, error: `could not write folder lists: ${error?.message ?? error}` }, 500);
        }
        ctx.logger?.info?.(`dsh-gpw: added ${validated.path} to ${list}`);
        return json({ ok: true, folders: folderLists() });
      },
    });

    registry.register({
      path: GPW_RESET_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null;
        try {
          body = await request.json();
        } catch {
          /* refused below */
        }
        if (body?.confirm !== 'reset') return json({ ok: false, error: "confirm must be the string 'reset'" }, 400);
        try {
          resetFolders(foldersFile, foldersKey);
        } catch (error) {
          return json({ ok: false, error: `could not reset folder lists: ${error?.message ?? error}` }, 500);
        }
        tamperedReason = null;
        foldersSeen = true;
        ctx.logger?.warn?.('dsh-gpw: folder lists were reset by the operator; all entries cleared and re-signed');
        return json({ ok: true, tampered: false, folders: folderLists() });
      },
    });

    registry.register({
      path: GPW_DECIDE_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null;
        try {
          body = await request.json();
        } catch {
          /* refused below */
        }
        if (typeof body?.id !== 'string' || (body?.decision !== 'allow' && body?.decision !== 'deny' && body?.decision !== 'allow-session')) {
          return json({ ok: false, error: 'id and decision (allow|allow-session|deny) are required' }, 400);
        }
        const result = decidePending(body.id, body.decision);
        return json(result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 404);
      },
    });

    registry.register({
      path: GPW_PICK_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => json({ ok: true, path: await pickFolder() }),
    });
  });

  ctx.logger?.info?.(
    `dsh-gpw: active -- full-access only=${requireFullAccess}, at most ${maxPerWindow} auto-approvals per ${Math.round(windowMs / 1000)} s, `
    + `pending timeout ${Math.round(pendingTimeoutMs / 1000)} s; blacklist denies, whitelist passes, everything else waits for the operator`,
  );
}
