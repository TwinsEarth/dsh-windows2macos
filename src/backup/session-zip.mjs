/**
 * Session-log and official-export-ZIP plumbing for the `dsh-backup-plugin` tool surface.
 *
 * ## What an official DSH session export ZIP contains
 *
 * The app's own export writes plaintext JSONL: `session.v4.jsonl` for the root session (or
 * `subagents/<child-id>/session.v4.jsonl` for a delegation) plus `media/<sha256>.<ext>` and
 * `files/<aa>/<sha256>/<name>` attachment blobs. The stored form this repository reads and writes is
 * different: `<DSH_HOME>/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`, a sequence of Zstandard
 * frames with the header ALONE in frame 0 (the rule the installed client enforces in
 * `assertZstdHeaderFrame`; `src/fix/session.mjs` and `src/fix/zstd.mjs` are the frame codecs this module
 * reuses rather than re-implementing).
 *
 * ## What this module owns
 *
 * The translation between the two shapes: decode a stored log, decode a plaintext export, allocate new
 * session ids (roots `session-<uuid>`, sub-agents `<uuid>`), rewrite parent links and the ids embedded in
 * event rows, and write the stored shape atomically. It also attaches the restored root sessions to the
 * workspace registry through the one registry writer (`registry.mjs`), never by editing the JSON itself.
 *
 * ## What it deliberately does not do
 *
 * It does not verify the archive it was handed (the caller verifies first), and it does not import a
 * backup archive: a `w2m-dsh-backup/archive` stores stored-shape logs, which `zip-archive.mjs` decodes
 * directly. The two paths share {@link writeSessionSet} so a restored session can never be written by two
 * different implementations.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compressFrame, decompressFrame, hasZstd, scanFrames } from '../fix/zstd.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { applyRegistryRestore, planRegistryRestores, workspaceSlug } from './registry.mjs';
import { scanSessions } from './scan.mjs';
import { readZip } from './zip.mjs';

/** The stored session file name this build writes. */
export const STORED_SESSION_FILE = 'session.v4.jsonl.zstd';

/** A plaintext session entry inside an official export ZIP (`session.vN.jsonl`). */
export const OFFICIAL_SESSION_RE = /^(?:subagents\/[^/]+\/)?session\.v(\d+)\.jsonl$/;

/** Named refusals for the session half. */
export const SESSION_CODES = Object.freeze({
  UNREADABLE: 'BACKUP_SESSION_UNREADABLE',
  FORMAT: 'BACKUP_SESSION_FORMAT_UNSUPPORTED',
  ID_CONFLICT: 'BACKUP_SESSION_ID_CONFLICT',
  NO_ROOT: 'BACKUP_SESSION_NO_ROOT',
  ROOT_AMBIGUOUS: 'BACKUP_SESSION_ROOT_AMBIGUOUS',
  EMPTY_ZIP: 'BACKUP_SESSION_ZIP_EMPTY',
  WORKSPACE_MISSING: 'BACKUP_IMPORT_WORKSPACE_MISSING',
  NO_ZSTD: 'BACKUP_SESSION_NO_ZSTD',
  ATTACHMENT_UNSAFE: 'BACKUP_ATTACHMENT_NAME_UNSAFE',
  WRITE_FAILED: 'BACKUP_SESSION_WRITE_FAILED',
});

/**
 * The sessions subdirectory DSH derives from a workspace path.
 *
 * This is the **storage** rule, not the registry key: runs of `/`, `\` and `:` collapse to one `-`,
 * characters outside `[A-Za-z0-9._-]` become `~XXXX` (the upper-case hex of their UTF-16 code unit), a
 * leading `-` is stripped, the result is capped at 251 characters and wrapped in `--`. Measured on real
 * homes: `E:\GPT` -> `--E-GPT--`, `E:\DSH\DS\W2M` -> `--E-DSH-DS-W2M--`.
 *
 * Deliberately **not** `workspaceSlug` from `registry.mjs`: that one keys the registry document and does
 * not escape unsafe characters, so the two disagree for a path containing a space. `workspaceSlug` is the
 * right rule for matching a registry record; this one is the right rule for where a log file goes.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '_no-cwd';
  let text = cwd.replace(/[\\/:]+/g, '-');
  text = text.replace(/[^A-Za-z0-9._-]/g, (char) => `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  text = text.replace(/^-+/, '');
  return `--${text.slice(0, 251)}--`;
}

/** `E:\GPT` -> `--E-GPT--` as a REGISTRY key (see {@link projectKey} for the storage rule). */
export function sessionWorkspaceSlug(workspacePath) {
  return workspaceSlug(workspacePath);
}

/** Canonical absolute path (a symlinked workspace still matches `header.cwd`). */
export function canonicalPath(target) {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Decode a stored (`.zstd`, frame sequence) session log.
 *
 * @param {Buffer} buffer
 * @returns {{ok: true, header: object, events: string[], frames: number}
 *   | {ok: false, reason_code: string, detail: string}}
 */
export function decodeStoredSession(buffer) {
  let frames;
  try {
    ({ frames } = scanFrames(buffer));
  } catch (error) {
    return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: error instanceof Error ? error.message : String(error) };
  }
  if (frames.length === 0) {
    return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: 'the log holds no zstd frame' };
  }
  let text;
  try {
    let offset = 0;
    const parts = [];
    for (const frame of frames) {
      const slice = buffer.subarray(frame.start, frame.end);
      parts.push(decompressFrame(slice));
      offset = frame.end;
    }
    if (offset !== buffer.length) {
      return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: 'the container ends with a partial frame' };
    }
    text = parts.join('');
  } catch (error) {
    return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: error instanceof Error ? error.message : String(error) };
  }
  return decodePlaintextSession(text, frames.length);
}

/**
 * Decode a plaintext session log (`session.vN.jsonl`): the header is the first non-empty line.
 *
 * @param {string} text
 * @param {number} [frames]
 * @returns {{ok: true, header: object, events: string[], frames: number}
 *   | {ok: false, reason_code: string, detail: string}}
 */
export function decodePlaintextSession(text, frames = 0) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: 'the log is empty' };
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: `the first row is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (header === null || typeof header !== 'object' || header.type !== 'session') {
    return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: 'the first row is not a session header' };
  }
  if (Number(header.version) !== 4) {
    return {
      ok: false,
      reason_code: SESSION_CODES.FORMAT,
      detail: `session format version ${JSON.stringify(header.version)} is not the v4 format this build writes`,
    };
  }
  return { ok: true, header, events: lines.slice(1), frames };
}

/**
 * Encode a session in the stored shape: frame 0 is the header ALONE, frame 1 carries the event rows.
 *
 * Frame 0 must be exactly one header line -- the installed client refuses anything else
 * (`assertZstdHeaderFrame`), and a restored session the app cannot open is not a restore. One bulk frame
 * for the events is the shape the client's own writer emits.
 *
 * @param {object} header
 * @param {string[]} events JSONL rows without their trailing newline
 * @returns {Buffer}
 */
export function encodeStoredSession(header, events) {
  const headerFrame = compressFrame(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'));
  if (events.length === 0) return headerFrame;
  const bodyFrame = compressFrame(Buffer.from(`${events.join('\n')}\n`, 'utf8'));
  return Buffer.concat([headerFrame, bodyFrame]);
}

/**
 * Index the ids in a home and the directory each one lives in.
 *
 * A `keepIds` collision is a fact about the whole home, not about the target workspace: `storedSessionIds` scans
 * every workspace, so a replacement has to know every directory that holds the id, not only the target one.
 *
 * @param {string} dshHome
 * @returns {{ids: Set<string>, dirs: Map<string, string[]>}}
 */
function storedSessionIndex(dshHome) {
  const ids = new Set();
  const dirs = new Map();
  try {
    for (const row of scanSessions({ dshHome }).sessions) {
      ids.add(row.session_id);
      const list = dirs.get(row.session_id) ?? [];
      const dir = path.dirname(row.file);
      if (!list.includes(dir)) list.push(dir);
      dirs.set(row.session_id, list);
    }
  } catch {
    /* an unreadable sessions root is reported as "nothing stored"; the per-target guard still refuses a write */
  }
  return { ids, dirs };
}

/** All stored session ids in a home (`[]` when the sessions directory does not exist). */
export function storedSessionIds(dshHome) {
  return storedSessionIndex(dshHome).ids;
}

/**
 * The directory one forced replacement's copy of the old session goes into.
 *
 * `<DSH_HOME>/.w2m-restore-backups/sessions-<UTC>/` mirrors the archive restore's `archive-<UTC>` recovery area:
 * same root, outside every scan root, so a later backup can never pick a replaced session up as a live one. The
 * stamp is the compact UTC form the register copies use (`20261121T101843Z`), not the archive's millisecond form.
 *
 * @param {string} dshHome
 * @param {Date} [now]
 * @returns {string}
 */
export function sessionReplaceDir(dshHome, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(path.resolve(dshHome), '.w2m-restore-backups', `sessions-${stamp}`);
}

/**
 * Rewrite one event row's id references.
 *
 * Pairs are tried longest-first so a short id can never rewrite the prefix of a longer one (the ids are
 * UUID-based in practice, but a restore must not depend on that).
 */
function rewriteLine(line, pairs) {
  let out = line;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

/**
 * Write a set of decoded session records into the store under a workspace.
 *
 * New ids are allocated unless `keepIds`; a `keepIds` collision is a refusal, never an overwrite -- unless
 * `replaceExisting` is true, which is the honest meaning of `forceRunning`. A replacement first copies the existing
 * session directory to `<DSH_HOME>/.w2m-restore-backups/sessions-<UTC>/<projectKey>/<id>/` (the whole directory, so
 * every file the client left there survives; `<projectKey>` is the workspace directory the replaced log was stored
 * under -- the target workspace in the common case), removes it, then writes the restored log and returns the entry
 * in `replaced`. A log that appears between the scan and the write is still a refusal unless `replaceExisting` was
 * asked for. Parent links are remapped through the same mapping as the ids inside event rows, so a restored
 * sub-agent still points at the restored root rather than at an id that does not exist in this home.
 *
 * @param {Array<{header: object, events: string[]}>} records
 * @param {{dshHome: string, workspace: string, keepIds?: boolean, replaceExisting?: boolean, now?: Date}} options
 * @returns {{ok: true, written: Array<object>,
 *   replaced: Array<{session_id: string, backup: string, file: string}>, idMap: Map<string,string>}
 *   | {ok: false, reason_code: string, detail: string}}
 */
export function writeSessionSet(records, options) {
  const dshHome = path.resolve(options.dshHome);
  const workspace = path.resolve(options.workspace);
  const keepIds = options.keepIds === true;
  const replaceExisting = options.replaceExisting === true;
  const stored = storedSessionIndex(dshHome);
  const existing = stored.ids;
  const idMap = new Map();
  for (const record of records) {
    const oldId = typeof record.header.id === 'string' ? record.header.id : null;
    if (oldId === null) {
      return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: 'a session header without an id cannot be restored' };
    }
    if (keepIds) {
      if (existing.has(oldId) && !replaceExisting) {
        return { ok: false, reason_code: SESSION_CODES.ID_CONFLICT, detail: `session id already exists in this home: ${oldId}` };
      }
      idMap.set(oldId, oldId);
    } else {
      idMap.set(oldId, record.header.parentSession ? randomUUID() : `session-${randomUUID()}`);
    }
  }
  const pairs = [...idMap.entries()].sort(([left], [right]) => right.length - left.length);
  const written = [];
  const replaced = [];
  let replaceBase = null;
  for (const record of records) {
    const oldId = record.header.id;
    const newId = idMap.get(oldId);
    const header = { ...record.header, id: newId, cwd: workspace };
    if (typeof record.header.parentSession === 'string' && record.header.parentSession !== '') {
      header.parentSession = idMap.get(record.header.parentSession) ?? record.header.parentSession;
    } else {
      delete header.parentSession;
    }
    const dir = path.join(dshHome, 'sessions', projectKey(workspace), newId);
    const file = path.join(dir, STORED_SESSION_FILE);
    // The target directory plus every other workspace that already holds this id. With keepIds the collision is
    // global, so leaving an untouched copy in another workspace would restore the id without resolving the collision.
    const occupants = new Set();
    if (fs.existsSync(file)) occupants.add(dir);
    if (keepIds) for (const other of stored.dirs.get(newId) ?? []) occupants.add(other);
    if (occupants.size > 0) {
      if (!replaceExisting) {
        return { ok: false, reason_code: SESSION_CODES.ID_CONFLICT, detail: `refusing to overwrite an existing session log: ${file}` };
      }
      replaceBase ??= sessionReplaceDir(dshHome, options.now ?? new Date());
      try {
        for (const occupant of occupants) {
          const backup = path.join(replaceBase, path.basename(path.dirname(occupant)), path.basename(occupant));
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.cpSync(occupant, backup, { recursive: true });
          fs.rmSync(occupant, { recursive: true, force: true });
          replaced.push({ session_id: newId, backup, file });
        }
      } catch (error) {
        return {
          ok: false,
          reason_code: SESSION_CODES.WRITE_FAILED,
          detail: `could not back up the session being replaced: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    try {
      writeFileAtomic(file, encodeStoredSession(header, record.events.map((line) => rewriteLine(line, pairs))));
    } catch (error) {
      return { ok: false, reason_code: SESSION_CODES.WRITE_FAILED, detail: error?.detail ?? String(error instanceof Error ? error.message : error) };
    }
    written.push({
      old_id: oldId,
      session_id: newId,
      parent_session: header.parentSession ?? null,
      events: record.events.length,
      workspace: projectKey(workspace),
      file,
    });
  }
  return { ok: true, written, replaced, idMap };
}

/**
 * Attach the restored root sessions to the workspace registry through the one registry writer.
 *
 * Only roots are registered (`attachRootSessions` in the sibling plugin's contract): a sub-agent is listed
 * through its parent, and registering it separately would put a delegation in the workspace's top-level
 * list. A registry that cannot be created (no workspace path, no registry file) is a refusal, not a silent
 * skip -- a session on disk that the UI never lists is the 2026-11-17 defect.
 *
 * @param {{dshHome: string, workspacePath: string, written: Array<object>}} input
 * @returns {{ok: boolean, skipped?: boolean, reason?: string, plan?: object, apply?: object}}
 */
export function attachRootSessions(input) {
  const roots = input.written.filter((entry) => entry.parent_session === null || entry.parent_session === undefined);
  if (roots.length === 0) return { ok: true, skipped: true, reason: 'no root session in the restored set' };
  const plan = planRegistryRestores({
    dshHome: input.dshHome,
    workspacePath: input.workspacePath,
    sessions: roots.map((entry) => ({
      session_id: entry.session_id,
      workspace: sessionWorkspaceSlug(input.workspacePath),
      archived: false,
      pinned: false,
    })),
    allowCreateRegistry: true,
  });
  if (plan.ok !== true) return { ok: false, reason_code: plan.reason_code, detail: plan.detail, plan };
  const applied = applyRegistryRestore({ dshHome: input.dshHome, plan });
  return { ok: applied.ok === true, plan, apply: applied };
}

/** Refuse attachment names that would escape the attachment root. */
function safeAttachmentRel(rel) {
  const normalized = String(rel).replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..' || part === '')) return null;
  if (path.isAbsolute(normalized)) return null;
  return normalized;
}

/**
 * Import an official DSH session export ZIP into a home/workspace.
 *
 * `keepIds` collisions are refused by {@link writeSessionSet}; `replaceExisting` forwards the honest
 * `forceRunning` meaning -- back the existing session directory up under `.w2m-restore-backups/sessions-<UTC>/`,
 * then replace it -- and the replaced entries come back in `replaced`.
 *
 * @param {Buffer} buffer
 * @param {{dshHome: string, workspace: string, keepIds?: boolean, replaceExisting?: boolean}} options
 * @returns {{ok: true, written: Array<object>, replaced: Array<object>, attachments: object, roots: number,
 *   skipped: Array<object>}
 *   | {ok: false, reason_code: string, detail: string}}
 */
export function importOfficialSessionZip(buffer, options) {
  if (!hasZstd()) {
    return {
      ok: false,
      reason_code: SESSION_CODES.NO_ZSTD,
      detail: `this Node (${process.version}) has no zstd support; Node >= 22.15 is required to write the stored session container`,
    };
  }
  const workspace = path.resolve(options.workspace);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    return { ok: false, reason_code: SESSION_CODES.WORKSPACE_MISSING, detail: `the workspace directory does not exist: ${workspace}` };
  }
  let zip;
  try {
    zip = readZip(buffer);
  } catch (error) {
    return { ok: false, reason_code: SESSION_CODES.UNREADABLE, detail: error instanceof Error ? error.message : String(error) };
  }
  const sessionEntries = zip.entries.filter((entry) => OFFICIAL_SESSION_RE.test(entry.name));
  if (sessionEntries.length === 0) {
    return { ok: false, reason_code: SESSION_CODES.EMPTY_ZIP, detail: 'the zip contains no session.v*.jsonl entry' };
  }
  const records = [];
  for (const entry of sessionEntries) {
    const decoded = decodePlaintextSession(entry.data.toString('utf8'));
    if (decoded.ok !== true) {
      return { ok: false, reason_code: decoded.reason_code, detail: `${entry.name}: ${decoded.detail}` };
    }
    records.push({ header: decoded.header, events: decoded.events, source: entry.name });
  }
  const roots = records.filter((record) => record.header.parentSession === undefined || record.header.parentSession === null || record.header.parentSession === '');
  // An official export has exactly one root session; more than one means the file is not the export this
  // importer claims to read, and guessing which one is the root would import a sub-agent as a workspace.
  if (roots.length !== 1) {
    return {
      ok: false,
      reason_code: roots.length === 0 ? SESSION_CODES.NO_ROOT : SESSION_CODES.ROOT_AMBIGUOUS,
      detail: `expected exactly one root session, found ${roots.length} (${records.map((record) => record.source).join(', ')})`,
    };
  }
  const written = writeSessionSet(records, {
    dshHome: options.dshHome,
    workspace,
    keepIds: options.keepIds === true,
    replaceExisting: options.replaceExisting === true,
  });
  if (written.ok !== true) return written;

  const attachmentsRoot = path.join(options.dshHome, 'attachments', 'v1');
  const attachments = { media: 0, files: 0, skipped: [] };
  for (const entry of zip.entries) {
    let target = null;
    const media = /^media\/(?:sha256:)?([a-f0-9]{64})\.(png|jpe?g|webp|gif)$/i.exec(entry.name);
    const file = /^files\/([a-f0-9]{2})\/([a-f0-9]{64})\/(.+)$/i.exec(entry.name);
    if (media !== null) {
      const digest = media[1].toLowerCase();
      target = path.join(attachmentsRoot, 'objects', digest.slice(0, 2), digest);
    } else if (file !== null) {
      const name = safeAttachmentRel(file[3]);
      if (name === null) {
        attachments.skipped.push({ name: entry.name, reason: 'unsafe file name' });
        continue;
      }
      target = path.join(attachmentsRoot, 'files', file[1].toLowerCase(), file[2].toLowerCase(), name);
    } else {
      continue;
    }
    try {
      writeFileAtomic(target, entry.data);
    } catch (error) {
      attachments.skipped.push({ name: entry.name, reason: error?.detail ?? String(error instanceof Error ? error.message : error) });
      continue;
    }
    if (media !== null) attachments.media += 1;
    else attachments.files += 1;
  }

  return {
    ok: true,
    written: written.written,
    replaced: written.replaced,
    attachments,
    roots: written.written.filter((entry) => entry.parent_session === null).length,
    skipped: [...zip.skipped, ...attachments.skipped],
  };
}
