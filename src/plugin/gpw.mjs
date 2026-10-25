/**
 * DSH-GPW v2 (v1.7.5-beta.1) — Global Permission Watchdog, now a folder gate rather than an approval answerer.
 *
 * ## The three classes and who answers
 *
 *   A. blacklist  -> denied. A synchronous `ctx.tools.guard()` is registered as well, so the denial holds no matter
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
 * The panel is rendered by the w2m client (`lib/client.js`): a floating "GPW 文件夹" button opens the three sections
 * (whitelist / blacklist / recently intercepted) plus the pending queue. Folders can be typed (validated against the
 * filesystem here) or taken from the recently-intercepted list in one click. Lists live in a JSON file under
 * `$DSH_HOME/xclient/`, never in the profile patch.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { classifyToolCall } from './folder-policy.mjs';

export const name = 'dsh-gpw';

/** Services this plugin cannot work without. `connection` is used only for the operator routes. */
export const inject = ['permissionPresets'];

export const FULL_ACCESS_PRESET = 'danger-full-access';
export const GPW_ROUTE = '/api/w2m/gpw/state';
export const GPW_FOLDERS_ROUTE = '/api/w2m/gpw/folders';
export const GPW_DECIDE_ROUTE = '/api/w2m/gpw/decide';
export const GPW_PICK_ROUTE = '/api/w2m/gpw/pick';

const DEFAULT_BUDGET = { maxPerWindow: 10, windowMs: 60_000, minGapMs: 3_000 };
const DEFAULT_PENDING_TIMEOUT_MS = 120_000;
const RECENT_LIMIT = 20;
const NO_STORE = { 'cache-control': 'no-store' };

/** Resolve the folders file: config first, then `$DSH_HOME/xclient/gpw-folders.json`. */
export function foldersFileOf(config = {}) {
  if (typeof config.foldersFile === 'string' && config.foldersFile.trim() !== '') return config.foldersFile.trim();
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'xclient', 'gpw-folders.json');
}

/** Read the operator-managed lists. A missing or corrupt file is empty lists, never a crash on mount. */
export function readFolders(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      whitelist: Array.isArray(parsed?.whitelist) ? parsed.whitelist.filter((v) => typeof v === 'string' && v !== '') : [],
      blacklist: Array.isArray(parsed?.blacklist) ? parsed.blacklist.filter((v) => typeof v === 'string' && v !== '') : [],
    };
  } catch {
    return { whitelist: [], blacklist: [] };
  }
}

/** Persist the operator-managed lists. */
export function writeFolders(file, folders) {
  mkdirSync(dirname(file), { recursive: true });
  const next = {
    whitelist: [...new Set((folders?.whitelist ?? []).filter((v) => typeof v === 'string' && v.trim() !== ''))],
    blacklist: [...new Set((folders?.blacklist ?? []).filter((v) => typeof v === 'string' && v.trim() !== ''))],
  };
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
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

  const noteRecent = (entry) => {
    recent.unshift({ at: Date.now(), ...entry });
    if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  };

  const folderLists = () => {
    const stored = readFolders(foldersFile);
    const merge = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...b])];
    return {
      whitelist: merge(config.whitelist, stored.whitelist),
      blacklist: merge(config.blacklist, stored.blacklist),
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
    };
    pending.set(id, entry);
    pendingTotal += 1;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      deniedTotal += 1;
      resolveDecision({ kind: 'deny', reason: `GPW: no operator answer within ${Math.round(pendingTimeoutMs / 1000)} s for ${entry.tool}` });
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
    if (decision === 'allow') {
      allowedTotal += 1;
      entry.resolve({ kind: 'allow', reason: 'GPW: allowed by the operator' });
    } else {
      deniedTotal += 1;
      entry.resolve({ kind: 'deny', reason: 'GPW: denied by the operator' });
    }
    return { ok: true };
  };

  // --- A: the blacklist denial must hold regardless of listener order -------------------------------------------------
  ctx.tools?.guard?.((exec) => {
    if (!isFullAccess(exec?.agent)) return undefined;
    const lists = folderLists();
    if (lists.blacklist.length === 0) return undefined;
    const call = toolCallOf(exec);
    const result = classifyToolCall({ ...call, blacklist: lists.blacklist });
    if (result.decision !== 'deny') return undefined;
    deniedTotal += 1;
    noteRecent({ tool: String(call.name ?? 'tool'), decision: 'deny', reason: result.reason, paths: result.paths });
    ctx.logger?.warn?.(`dsh-gpw: refused ${String(call.name ?? 'tool')} -- ${result.reason}`);
    return `GPW: ${result.reason}; the call was not executed`;
  });

  // --- B/C: the pre-execute gate ---------------------------------------------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (requireFullAccess && !isFullAccess(exec?.agent)) return next();
    const lists = folderLists();
    if (lists.blacklist.length === 0 && lists.whitelist.length === 0) return next();
    const call = toolCallOf(exec);
    let cwd = null;
    try {
      cwd = await ctx.workingDirectory?.ensure?.(exec.agent, exec.signal);
    } catch {
      cwd = null;
    }
    const classification = classifyToolCall({ ...call, whitelist: lists.whitelist, blacklist: lists.blacklist, workspace: cwd ?? null });
    if (classification.decision === 'pass' && classification.paths.length === 0) return next();
    const budget = classification.decision === 'allow' ? takeBudgetSlot() : false;
    const plan = planGate({ classification, autoAllowBudgetRemaining: classification.decision === 'allow' ? budget !== false : undefined });
    if (plan.kind === 'deny') {
      deniedTotal += 1;
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'deny', reason: plan.reason, paths: classification.paths });
      ctx.logger?.warn?.(`dsh-gpw: refused ${String(call.name ?? 'tool')} -- ${plan.reason}`);
      return { kind: 'deny', reason: `GPW: ${plan.reason}` };
    }
    if (plan.kind === 'allow') {
      noteRecent({ tool: String(call.name ?? 'tool'), decision: 'allow', reason: plan.reason, paths: classification.paths });
      ctx.logger?.info?.(`dsh-gpw: auto-allowed ${String(call.name ?? 'tool')} -- ${plan.reason}`);
      return { kind: 'allow' };
    }
    noteRecent({ tool: String(call.name ?? 'tool'), decision: 'pending', reason: plan.reason, paths: classification.paths });
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
      fetch: async () => json({
        ok: true,
        enabled: true,
        require_full_access: requireFullAccess,
        folders: folderLists(),
        counters: { allowedTotal, pendingTotal, deniedTotal, budgetWindow: approvals.length, maxPerWindow },
        recent: recent.map((entry) => ({
          at: entry.at,
          tool: entry.tool,
          decision: entry.decision,
          reason: entry.reason,
          paths: entry.paths,
          folder: entry.paths.length > 0 ? folderForPath(entry.paths[0]) : null,
        })),
        pending: [...pending.entries()].map(([id, entry]) => ({
          id,
          tool: entry.tool,
          reason: entry.reason,
          paths: entry.paths,
          pending_ms: Date.now() - entry.createdAt,
        })),
      }),
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
        if (body.action === 'remove') {
          if (typeof body?.path !== 'string' || body.path.trim() === '') return json({ ok: false, error: 'path must be a non-empty string' }, 400);
          const stored = readFolders(foldersFile);
          const next = { ...stored, [list]: stored[list].filter((entry) => entry !== body.path) };
          writeFolders(foldersFile, next);
          return json({ ok: true, folders: folderLists() });
        }
        const validated = validateFolderInput(body?.path);
        if (!validated.ok) return json({ ok: false, error: validated.error }, 400);
        const stored = readFolders(foldersFile);
        const next = { ...stored, [list]: [...new Set([...stored[list], validated.path])] };
        writeFolders(foldersFile, next);
        ctx.logger?.info?.(`dsh-gpw: added ${validated.path} to ${list}`);
        return json({ ok: true, folders: folderLists() });
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
        if (typeof body?.id !== 'string' || (body?.decision !== 'allow' && body?.decision !== 'deny')) {
          return json({ ok: false, error: 'id and decision (allow|deny) are required' }, 400);
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
