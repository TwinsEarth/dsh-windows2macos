/**
 * Host half of the W2M self-repair subplugin:
 * `@twinsearth/w2m-dsh-plugin/dsh-fix`.
 *
 * ## The failure it repairs
 *
 * A session's history can reference an image attachment by content address
 * (`<DSH_HOME>/attachments/v1/objects/<sha256[0..2]>/<sha256>`). If that object
 * file disappears, every request that includes the message fails while the
 * adapter prepares its images: the attachment store throws
 * `ATTACHMENT_NOT_FOUND`, and the DeepSeek Messages adapter's catch turns it
 * into `TRANSPORT` ("DeepSeek Messages transport failed"). The session then
 * fails every turn, in tens of milliseconds, without sending an HTTP request -
 * retrying cannot help, because the bytes are gone.
 *
 * ## How it repairs it
 *
 * One listener on the agent loop's `agent/request-error` waterfall - the same
 * extension point the official context-overflow and image-budget recovery use:
 *
 *   1. Only `TRANSPORT` / `ATTACHMENT_NOT_FOUND` failures are inspected. Every
 *      other failure is delegated with `next()` untouched, so a real network
 *      error keeps its own diagnosis.
 *   2. The listener scans the current request surface (`session.surface.nodes`;
 *      messages shadowed by compaction are excluded because they are not sent)
 *      for image blocks whose object file is missing, skipping blocks already
 *      marked `offloaded`.
 *   3. If any exist it appends `session.append('image/offload', { targets })`,
 *      the durable mechanism the official `compaction-image-offload` plugin
 *      uses, then awaits `ctx.sessions.flush(session)` as a persistence
 *      barrier. Appends are admitted to the in-memory session; consumers that
 *      need durability are expected to await the flush.
 *   4. It returns `{ kind: 'retry' }`, which re-runs the failed step without
 *      spending provider retry budget and without logging an `llm/retry` event.
 *
 * ## Two deliberate properties
 *
 *   * **It does not guess the cause chain.** The decision is "does the view
 *     actually reference an unreadable image", not "does the error text look
 *     like an attachment failure", so genuine network errors are never masked.
 *   * **It has a convergence bound.** At most `maxRepairsPerTurn` repairs per
 *     session per turn, and a repaired image stays `offloaded`, so the next
 *     check is empty on its own.
 *
 * Ported from `dsh-fix-attachments` (MIT, Copyright (c) 2026 xuzhunzhi),
 * adapted to ship as a W2M subplugin: the plugin name is `w2m-dsh-fix`, the
 * mount marker lives under `$DSH_HOME/xclient/`, and the offline CLI is
 * documented in `docs/DSH-FIX.md`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'w2m-dsh-fix';
export const inject = ['agents', 'sessions'];

/** Default repairs per session per turn; a bound against a repeatedly broken event. */
const DEFAULT_MAX_REPAIRS_PER_TURN = 3;

/** Only these failure codes are inspected; everything else goes downstream. */
const CANDIDATE_CODES = new Set(['TRANSPORT', 'ATTACHMENT_NOT_FOUND']);

/**
 * Deliberately no message-projection registration here.
 *
 * The official `compaction-image-offload` row owns the `image/offload` type in
 * every shipped composition. Registering the same type from this plugin is not
 * a harmless fallback: measured through the real Loader, this plugin can be
 * activated BEFORE that row, its registration then makes the core row's own
 * registration throw, and the core fiber fails - which fails the whole mount.
 * So the repair only appends an event the core projection already knows. A
 * profile that disables the core row gets `next()` (the original error) rather
 * than a crash, and `docs/DSH-FIX.md` records that dependency.
 */

/** DSH home: `$DSH_HOME` when set, otherwise `~/.dsh`. */
export function resolveDshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

/**
 * Attachment object root: explicit config first, then `$DSH_HOME`.
 *
 * @param {{objectsRoot?: string}} [config]
 * @returns {string}
 */
export function resolveObjectsRoot(config = {}) {
  if (typeof config.objectsRoot === 'string' && config.objectsRoot.length > 0) return config.objectsRoot;
  return path.join(resolveDshHome(), 'attachments', 'v1', 'objects');
}

/**
 * Mount marker: proves the plugin is mounted and counts what it repaired.
 *
 * Kept under `xclient/` (W2M's state area) rather than DSH's `storages/` so an
 * operator can find every W2M state file in one directory.
 *
 * @param {{statePath?: string}} [config]
 * @returns {string}
 */
export function resolveStatePath(config = {}) {
  if (typeof config.statePath === 'string' && config.statePath.length > 0) return config.statePath;
  return path.join(resolveDshHome(), 'xclient', 'dsh-fix-state.json');
}

/**
 * Rewrite the marker file. It only holds a small fixed structure; any failure
 * is swallowed because diagnostics must never break the main flow.
 *
 * @param {string} statePath
 * @param {object} state
 */
function writeState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // best effort by design
  }
}

/**
 * Scan the current request surface for image occurrences whose attachment
 * object no longer exists.
 *
 * Only `session.surface.nodes` is read: a message shadowed by compaction is not
 * part of the request and must never be a target. Blocks already marked
 * `offloaded` are skipped because they are no longer read.
 *
 * @param {object} session live session (or a test stand-in with the same shape)
 * @param {string} objectsRoot
 * @returns {{targets: Array<{seq: number, imageIndexes: number[]}>, unreadable: number}}
 */
export function findUnreadableImages(session, objectsRoot) {
  const nodes = session?.surface?.nodes ?? [];
  const bySeq = new Map();
  let unreadable = 0;

  for (const seq of nodes) {
    const event = session?.eventAt?.(seq);
    if (!event) continue;
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue;

    let message;
    try {
      message = session.deriveEventMessage(event);
    } catch {
      continue;
    }

    let imageIndex = 0;
    for (const block of message?.content ?? []) {
      if (!block || block.type !== 'image') continue;
      if (block.offloaded !== true) {
        const id = String(block?.attachment?.attachmentId ?? '').replace(/^sha256:/, '');
        if (id.length === 64 && !fs.existsSync(path.join(objectsRoot, id.slice(0, 2), id))) {
          const set = bySeq.get(seq) ?? new Set();
          set.add(imageIndex);
          bySeq.set(seq, set);
          unreadable += 1;
        }
      }
      imageIndex += 1;
    }
  }

  const targets = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, set]) => ({ seq, imageIndexes: [...set].sort((a, b) => a - b) }));
  return { targets, unreadable };
}

/**
 * Mount the repair listener.
 *
 * @param {object} ctx Cordis plugin context (needs the `agents` and `sessions` services).
 * @param {{objectsRoot?: string, maxRepairsPerTurn?: number, statePath?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const objectsRoot = resolveObjectsRoot(config);
  const maxRepairsPerTurn = Number.isSafeInteger(config.maxRepairsPerTurn) && config.maxRepairsPerTurn > 0
    ? config.maxRepairsPerTurn
    : DEFAULT_MAX_REPAIRS_PER_TURN;

  const statePath = resolveStatePath(config);
  const state = {
    version: 1,
    mountedAt: new Date().toISOString(),
    objectsRoot,
    maxRepairsPerTurn,
    repairs: 0,
    lastRepair: null,
  };
  writeState(statePath, state);

  /** @type {WeakMap<object, {turn: number, count: number}>} */
  const repairs = new WeakMap();

  const listener = async ({ agent, turn, failure, signal }, next) => {
    const session = agent?.session;
    if (session === undefined || signal?.aborted) return next();
    if (!CANDIDATE_CODES.has(failure?.code)) return next();

    const record = repairs.get(session);
    const used = record !== undefined && record.turn === turn ? record.count : 0;
    if (used >= maxRepairsPerTurn) return next();

    const { targets, unreadable } = findUnreadableImages(session, objectsRoot);
    if (targets.length === 0) return next();

    try {
      session.append('image/offload', { targets });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`w2m-dsh-fix: could not record the offload decision: ${message}`);
      return next();
    }

    // Persistence barrier: the append is in the in-memory session, and a read
    // that survives a crash needs the flush. Failure here does not block this
    // turn's retry, so it is a warning rather than a refusal.
    try {
      await ctx.sessions?.flush?.(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`w2m-dsh-fix: offload decision is in memory but not flushed: ${message}`);
    }

    repairs.set(session, { turn, count: used + 1 });
    state.repairs += 1;
    state.lastRepair = { at: new Date().toISOString(), turn, targets };
    writeState(statePath, state);
    ctx.logger?.info?.(
      `w2m-dsh-fix: ${unreadable} unreadable image occurrence(s) in ${targets.length} message(s) marked as offloaded; retrying the request`,
    );
    return { kind: 'retry' };
  };

  ctx.on('agent/request-error', listener);
}
