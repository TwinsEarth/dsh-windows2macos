/**
 * Read-only scan of a DSH home: the session logs, their registry flags, and the attachment objects.
 *
 * ## Why a scan module exists before anything writes a backup
 *
 * A backup engine is only as good as its answer to "what is actually here". v3.4.6 freezes that answer -- and
 * the fact that it is **read-only** -- before v3.4.7 is allowed to write a repository. The 2026-11-17 recovery
 * drill is the cautionary case in the other direction: a tool that rebuilt files it had never correctly
 * enumerated produced logs that were structurally wrong in four ways.
 *
 * The scan therefore never opens a session file for writing, never creates a directory, never touches
 * `workspace.json`, and never decompresses anything unless `deep` is asked for. `test/backup-scan.test.mjs`
 * asserts that a whole scan leaves the tree byte-identical, including mtimes.
 *
 * ## What is deliberately excluded, and why the reason is in the data
 *
 * `$DSH_HOME` holds two derived caches that are large, regenerable, and wrong to restore:
 *
 *   * `sessions/.event-cache/`  -- a projection of the logs, rebuilt by the client on demand;
 *   * `storages/session_projcache/` -- the sessions-list projection, a cache of `workspace.json` plus titles.
 *
 * They are excluded by name and the exclusion is reported, so a reader can see the decision instead of
 * wondering why the repository is smaller than the home.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { decompressFrame, hasZstd, scanFrames } from '../fix/zstd.mjs';
import { listSessionDirs, readSession } from '../fix/session.mjs';
import { readWorkspaceRegistry } from '../util/dsh-workspace.mjs';

/** Session artefact name: `session.v<N>.jsonl.zstd`. */
export const SESSION_FILE_RE = /^session\.v(\d+)\.jsonl\.zstd$/;

/** Derived caches that are never backed up, with the reason reported to the caller. */
export const EXCLUSIONS = Object.freeze([
  {
    rel: 'sessions/.w2m-restore-backups',
    reason:
      'w2m restore pre-copies; they now live at the home root, and this row keeps a legacy home from being walked ' +
      'as if its backup copies were sessions',
  },
  {
    rel: 'sessions/.event-cache',
    reason: 'derived projection of the logs; the client rebuilds it, and restoring it would restore a stale view',
  },
  {
    rel: 'storages/session_projcache',
    reason: 'derived list/title projection of workspace.json; rebuilt on demand, and it is a cache, not state',
  },
]);

/** Attachment object root, relative to `$DSH_HOME`. */
export const ATTACHMENTS_REL = ['attachments', 'v1', 'objects'];

/** Read-only scan failure codes. */
export const SCAN_CODES = Object.freeze({
  HOME_MISSING: 'BACKUP_SCAN_HOME_MISSING',
  SESSION_HEADER_UNREADABLE: 'BACKUP_SCAN_HEADER_UNREADABLE',
  SESSION_NOT_ZSTD: 'BACKUP_SCAN_NOT_ZSTD',
});

/**
 * How many bytes of a session log the header reader may look at (v3.5.1).
 *
 * The DSH format puts the session envelope in the **first zstd frame**, and that frame is one JSON line: measured
 * at 255 bytes in the real 118 MB log. 3.5.0 read the whole file with `fs.readFileSync` to find those bytes --
 * 118 MB of external memory per session, and the scheduled scan walks every log. The bounded read below stops at
 * this cap and fails by name when the header frame does not fit in it, which is a format this build does not
 * understand rather than a file to buffer whole.
 */
export const SESSION_HEADER_SCAN_CAP_BYTES = 1024 * 1024;

/** Chunk size of the bounded header read: small enough that the cap, not the file size, bounds the buffer. */
const HEADER_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Convert an absolute path under `root` into a forward-slash relative path.
 *
 * `path.relative` is the platform's own parser: on POSIX it reads `C:\DSH` as a relative name, so a Windows-shaped
 * pair would turn into `../C:\DSH\...` there. The pair is recognised by shape and routed to `path.win32`, which
 * makes this conversion a fact about the paths rather than about the host running the tests.
 */
export function toRel(root, file) {
  const windowsShaped = (candidate) => /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith('\\\\');
  const relative =
    windowsShaped(root) || windowsShaped(file)
      ? path.win32.relative(root, file)
      : path.relative(path.resolve(root), path.resolve(file));
  return relative.split('\\').join('/');
}

/**
 * SHA-256 of a file, lowercase hex.
 *
 * @param {string} file
 * @returns {string}
 */
export function hashFile(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(HEADER_READ_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(read === chunk.length ? chunk : chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Read the header line of a session log **without decompressing the rest**.
 *
 * `scanFrames(buf, 1)` walks only far enough to bound the first frame; the DSH format puts the `session`
 * envelope in that first frame and nowhere else (see `docs/RETRO-SESSION-RECOVERY-20261117.md`, root cause
 * R2), so this is both cheap and the correct place to look.
 *
 * @param {string} file
 * @param {{maxBytes?: number}} [options] test/CLI seam: a smaller cap; production uses the module default.
 * @returns {{ok: true, header: object, format_version: number, read_bytes: number}
 *   | {ok: false, code: string, detail: string, read_bytes?: number}}
 */
export function readSessionHeader(file, options = {}) {
  const requestedCap = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : SESSION_HEADER_SCAN_CAP_BYTES;
  let fd;
  let size;
  try {
    fd = fs.openSync(file, 'r');
    size = fs.fstatSync(fd).size;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the unreadable answer is what matters */
      }
    }
    return { ok: false, code: SCAN_CODES.SESSION_HEADER_UNREADABLE, detail: `${file}: ${error?.code ?? 'unreadable'}` };
  }
  try {
    if (size === 0) {
      return { ok: false, code: SCAN_CODES.SESSION_HEADER_UNREADABLE, detail: `${file}: empty`, read_bytes: 0 };
    }
    const cap = Math.min(size, requestedCap);
    // One buffer, bounded by the cap (<= 1 MiB in production), never by the file size.
    const buffer = Buffer.allocUnsafe(cap);
    let filled = 0;
    let firstFrame = null;
    let sawMagic = false;
    while (filled < cap) {
      const want = Math.min(HEADER_READ_CHUNK_BYTES, cap - filled);
      let read;
      try {
        read = fs.readSync(fd, buffer, filled, want, filled);
      } catch (error) {
        return { ok: false, code: SCAN_CODES.SESSION_HEADER_UNREADABLE, detail: `${file}: ${error?.code ?? 'unreadable'}`, read_bytes: filled };
      }
      if (read <= 0) break;
      filled += read;
      if (!sawMagic) {
        if (filled < 4) continue;
        sawMagic = true;
        if (buffer.readUInt32LE(0) !== 0xfd2fb528) {
          return { ok: false, code: SCAN_CODES.SESSION_NOT_ZSTD, detail: `${file}: not a zstd container`, read_bytes: filled };
        }
        if (!hasZstd()) {
          return { ok: false, code: SCAN_CODES.SESSION_HEADER_UNREADABLE, detail: 'this Node runtime has no zstd support', read_bytes: filled };
        }
      }
      let frames;
      try {
        frames = scanFrames(buffer.subarray(0, filled), 1).frames;
      } catch (error) {
        return {
          ok: false,
          code: SCAN_CODES.SESSION_NOT_ZSTD,
          detail: `${file}: ${error instanceof Error ? error.message : String(error)}`,
          read_bytes: filled,
        };
      }
      if (frames.length === 0) continue;
      firstFrame = frames[0];
      break;
    }
    if (firstFrame === null) {
      return {
        ok: false,
        code: SCAN_CODES.SESSION_HEADER_UNREADABLE,
        detail: `${file}: no complete frame within the first ${cap} byte(s) (header scan cap ${requestedCap})`,
        read_bytes: filled,
      };
    }
    let text;
    try {
      text = decompressFrame(buffer.subarray(firstFrame.start, firstFrame.end));
    } catch (error) {
      return {
        ok: false,
        code: SCAN_CODES.SESSION_HEADER_UNREADABLE,
        detail: `${file}: ${error instanceof Error ? error.message : String(error)}`,
        read_bytes: filled,
      };
    }
    const first = text.split('\n')[0];
    let header;
    try {
      header = JSON.parse(first);
    } catch {
      return { ok: false, code: SCAN_CODES.SESSION_HEADER_UNREADABLE, detail: `${file}: the first line is not JSON`, read_bytes: filled };
    }
    if (header?.type !== 'session' || !Number.isSafeInteger(header?.version)) {
      return { ok: false, code: SCAN_CODES.SESSION_HEADER_UNREADABLE, detail: `${file}: the first line is not a session header`, read_bytes: filled };
    }
    return { ok: true, header, format_version: header.version, read_bytes: filled };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the parsed answer is what matters */
    }
  }
}

/**
 * Scan one session log. Never throws; an unreadable log is a row with `ok: false`.
 *
 * @param {string} file
 * @param {{dshHome: string, hash?: boolean, deep?: boolean, expectedSessionId?: string|null}} options
 * @returns {object}
 */
export function scanSessionFile(file, options) {
  const dshHome = path.resolve(options.dshHome);
  const dir = path.dirname(file);
  const sessionId = path.basename(dir);
  const workspace = path.basename(path.dirname(dir));
  const result = {
    kind: 'session',
    ok: false,
    session_id: sessionId,
    workspace,
    rel: toRel(dshHome, file),
    file: path.resolve(file),
    name: path.basename(file),
    size: 0,
    mtime_ms: 0,
    format_version: null,
    header: null,
    hash: null,
    detail: null,
    codes: [],
  };
  try {
    const stat = fs.statSync(file);
    result.size = stat.size;
    result.mtime_ms = stat.mtimeMs;
  } catch (error) {
    result.codes.push(SCAN_CODES.SESSION_HEADER_UNREADABLE);
    result.detail = `${file}: ${error?.code ?? 'unreadable'}`;
    return result;
  }
  const header = readSessionHeader(file);
  if (!header.ok) {
    result.codes.push(header.code);
    result.detail = header.detail;
  } else {
    result.ok = true;
    result.format_version = header.format_version;
    result.header = {
      id: typeof header.header.id === 'string' ? header.header.id : null,
      cwd: typeof header.header.cwd === 'string' ? header.header.cwd : null,
      created_at: Number.isSafeInteger(header.header.createdAt) ? header.header.createdAt : null,
      agent_preset: typeof header.header.agentPreset === 'string' ? header.header.agentPreset : null,
    };
    if (typeof options.expectedSessionId === 'string' && options.expectedSessionId !== '') {
      const declared = result.header.id;
      if (declared !== null && declared !== options.expectedSessionId) {
        result.ok = false;
        result.codes.push('SESSION_ID_MISMATCH');
        result.detail = `header id ${declared} differs from the directory name ${options.expectedSessionId}`;
      }
    }
  }
  if (options.hash === true) result.hash = hashFile(file);
  if (options.deep === true && result.ok) {
    // Full decompression, on request only: 172 MB of logs costs seconds, and a status card must not pay it.
    try {
      const parsed = readSession(file);
      result.events = Math.max(0, parsed.lines - 1);
      result.last_seq = parsed.lastSeq;
      result.frames = parsed.frames.length;
      result.text_format_supported = parsed.formatSupported;
      result.torn_frame = typeof parsed.tornStart === 'number';
      if (!parsed.formatSupported) {
        result.ok = false;
        result.codes.push('SESSION_FORMAT_UNSUPPORTED');
        result.detail = `format version ${parsed.formatVersion} is not one this build understands`;
      }
    } catch (error) {
      result.ok = false;
      result.codes.push(SCAN_CODES.SESSION_NOT_ZSTD);
      result.detail = `${file}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return result;
}

/**
 * Scan every session log under `$DSH_HOME/sessions`, with the registry flags attached.
 *
 * @param {{dshHome: string, hash?: boolean, deep?: boolean, registry?: ReturnType<typeof readWorkspaceRegistry>}} options
 * @returns {{sessions: Array<object>, registry: ReturnType<typeof readWorkspaceRegistry>}}
 */
export function scanSessions(options) {
  const dshHome = path.resolve(options.dshHome);
  const registry = options.registry ?? readWorkspaceRegistry(dshHome);
  const sessionsRoot = path.join(dshHome, 'sessions');
  const sessions = [];
  for (const dir of listSessionDirs(sessionsRoot)) {
    const name = fs
      .readdirSync(dir)
      .filter((entry) => SESSION_FILE_RE.test(entry))
      .sort((a, b) => versionOf(b) - versionOf(a))[0];
    if (name === undefined) continue;
    const row = scanSessionFile(path.join(dir, name), {
      dshHome,
      hash: options.hash === true,
      deep: options.deep === true,
      expectedSessionId: path.basename(dir),
    });
    const id = row.session_id;
    // `null`, not `{registered:false,…}`, when the registry could not be read: "unknown" and "not registered"
    // are different answers, and a restore plan must not treat a broken registry as "every session is orphaned".
    row.flags = registry.ok
      ? {
          registered: registry.registered.has(id),
          archived: registry.archived.has(id),
          pinned: registry.pinned.has(id),
        }
      : null;
    sessions.push(row);
  }
  sessions.sort((a, b) => a.rel.localeCompare(b.rel));
  return { sessions, registry };
}

/** `session.v4.jsonl.zstd` -> 4. */
function versionOf(name) {
  const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name);
  return match === null ? -1 : Number(match[1]);
}

/**
 * Enumerate the content-addressed attachment objects.
 *
 * The store is `<objectsRoot>/<aa>/<sha256>`, so the object id is the file name and `aa` is redundant -- but it
 * is verified, because a badly restored store with a wrong fan-out directory would silently never be read by
 * the client while looking fine here.
 *
 * @param {{dshHome: string, hash?: boolean}} options
 * @returns {{attachments: Array<object>, objects_root: string}}
 */
export function scanAttachments(options) {
  const dshHome = path.resolve(options.dshHome);
  const objectsRoot = path.join(dshHome, ...ATTACHMENTS_REL);
  const attachments = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const id = entry.name;
      if (!/^[0-9a-f]{64}$/.test(id)) continue;
      const parent = path.basename(path.dirname(full));
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      attachments.push({
        kind: 'attachment',
        ok: parent === id.slice(0, 2),
        attachment_id: id,
        rel: toRel(dshHome, full),
        file: full,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        hash: options.hash === true ? hashFile(full) : null,
        detail: parent === id.slice(0, 2) ? null : `object sits in ${parent}/ but its id starts with ${id.slice(0, 2)}`,
      });
    }
  };
  walk(objectsRoot);
  attachments.sort((a, b) => a.rel.localeCompare(b.rel));
  return { attachments, objects_root: objectsRoot };
}

/**
 * Summarise a home: sessions, attachments, registry counts, and the derived totals a status card needs.
 *
 * @param {{dshHome: string, hash?: boolean, deep?: boolean}} options
 * @returns {object}
 */
export function scanHome(options) {
  const dshHome = path.resolve(options.dshHome);
  const exists = fs.existsSync(dshHome);
  const registry = readWorkspaceRegistry(dshHome);
  const { sessions } = scanSessions({ dshHome, hash: options.hash === true, deep: options.deep === true, registry });
  const { attachments, objects_root: objectsRoot } = scanAttachments({ dshHome, hash: options.hash === true });
  const scan = {
    kind: 'w2m-backup-scan',
    dsh_home: dshHome,
    exists,
    scanned_at: new Date().toISOString(),
    zstd: hasZstd(),
    registry,
    attachment_objects_root: objectsRoot,
    exclusions: EXCLUSIONS.map((entry) => ({ ...entry })),
    sessions,
    attachments,
  };
  scan.totals = summarize(scan);
  return scan;
}

/**
 * The counts a route or a CLI prints. Kept separate from {@link scanHome} so a caller can ask for them
 * without holding the rows.
 *
 * @param {{sessions: Array<object>, attachments: Array<object>}} scan
 */
export function summarize(scan) {
  const sessions = scan?.sessions ?? [];
  const attachments = scan?.attachments ?? [];
  const byWorkspace = new Map();
  let sessionBytes = 0;
  let sessionBad = 0;
  let archived = 0;
  let pinned = 0;
  let unregistered = 0;
  for (const row of sessions) {
    sessionBytes += row.size;
    if (row.ok !== true) sessionBad += 1;
    if (row.flags?.archived === true) archived += 1;
    if (row.flags?.pinned === true) pinned += 1;
    if (row.flags?.registered === false) unregistered += 1;
    const key = row.workspace ?? '?';
    const bucket = byWorkspace.get(key) ?? { workspace: key, sessions: 0, bytes: 0 };
    bucket.sessions += 1;
    bucket.bytes += row.size;
    byWorkspace.set(key, bucket);
  }
  return {
    sessions: sessions.length,
    sessions_bad: sessionBad,
    session_bytes: sessionBytes,
    archived,
    pinned,
    unregistered,
    attachments: attachments.length,
    attachment_bytes: attachments.reduce((sum, row) => sum + row.size, 0),
    by_workspace: [...byWorkspace.values()].sort((a, b) => b.bytes - a.bytes),
  };
}
