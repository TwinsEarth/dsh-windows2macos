/**
 * Archive packs: archived sessions (or all of them) as one `.tar.zst` with its own manifest.
 *
 * ## What an archive is for
 *
 * "旧版本迁移" needs a self-contained file a person can copy to another machine: sessions, their attachment
 * objects, and a manifest that says what is inside. The tar is uncompressed ustar (`tar.mjs`); the whole thing is
 * zstd-compressed once, which keeps it self-describing (a `tar` extraction after `zstd -d` yields the tree).
 *
 * ## How it is produced
 *
 * The bytes come **out of the repository**, not from the live home: every file is reassembled from its
 * content-addressed blocks and checked against the snapshot's manifest before it goes into the tar. A pack built
 * from the repository can be verified against the same digests it carries.
 *
 * ## Encryption
 *
 * The archive is a plain tar: it contains plaintext session logs. It is written **inside the repository**, whose
 * directory is the user's own disk location, and the manifest records that it is plaintext. Encrypting the pack
 * too (wrapping it as another object) is a v2 question, listed in `docs/BACKUP-DESIGN.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { repoPaths } from './layout.mjs';
import { openRepo, readSnapshot } from './repo.mjs';
import { openRepoKey } from './keystore.mjs';
import { readTar, writeTar } from './tar.mjs';
import { rebuildFile } from './materialize.mjs';
import { sha256Hex } from './manifest.mjs';
import { writeFileAtomic } from './atomic.mjs';

/** Format string of the archive's own manifest. */
export const ARCHIVE_FORMAT = 'w2m-session-backup/archive';

/** Archive manifest version. */
export const ARCHIVE_VERSION = 1;

/** Named archive refusals. */
export const ARCHIVE_CODES = Object.freeze({
  NOT_INITIALIZED: 'BACKUP_REPO_NOT_INITIALIZED',
  NO_PERMISSION: 'BACKUP_NO_PERMISSION',
  NO_SNAPSHOT: 'BACKUP_REPO_SNAPSHOT_MISSING',
  EMPTY: 'BACKUP_ARCHIVE_EMPTY',
  WRITE_FAILED: 'BACKUP_WRITE_FAILED',
  READ_FAILED: 'BACKUP_ARCHIVE_UNREADABLE',
  DIGEST_MISMATCH: 'BACKUP_MANIFEST_DIGEST_MISMATCH',
});

/** `archive/<YYYY-MM-DD>/archived-sessions-<compact>.tar.zst` inside the repository. */
export function archivePath(root, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const compact = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(repoPaths(root).archive, day, `archived-sessions-${compact}.tar.zst`);
}

/**
 * Choose the files a pack contains.
 *
 * @param {{manifest: object, scope?: 'archived'|'all'|'selected', sessionIds?: string[]}} input
 * @returns {{sessions: Array<object>, attachments: Array<object>}}
 */
export function selectArchiveFiles(input) {
  const sessions = input.manifest.files.filter((entry) => entry.kind === 'session');
  const attachments = input.manifest.files.filter((entry) => entry.kind === 'attachment');
  const scope = input.scope ?? 'archived';
  const chosen = scope === 'all'
    ? sessions
    : scope === 'selected'
      ? sessions.filter((entry) => (input.sessionIds ?? []).includes(entry.session_id))
      : sessions.filter((entry) => entry.flags?.archived === true);
  return { sessions: chosen, attachments };
}

/**
 * Build one archive from a repository snapshot.
 *
 * @param {{root: string, dshHome: string, snapshotId?: string|null, scope?: 'archived'|'all'|'selected',
 *   sessionIds?: string[], accountId?: string|null, password?: string|Buffer|null, machineKey?: boolean, platform?: string,
 *   runner?: Function, now?: Date}} input
 * @returns {object} `{ok, reason_code?, detail?, file, bytes, compressed_bytes, sessions, files, source_snapshot}`
 */
export function buildArchive(input) {
  const now = input.now ?? new Date();
  const state = openRepo({ root: input.root, dshHome: input.dshHome });
  if (state.initialized !== true) {
    return { ok: false, reason_code: ARCHIVE_CODES.NOT_INITIALIZED, detail: state.error?.detail ?? 'the repository is not initialised' };
  }
  const key = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    accountId: input.accountId ?? null,
    password: input.password ?? null,
    machineKey: input.machineKey,
    platform: input.platform,
    runner: input.runner,
  });
  if (key.ok !== true) return { ok: false, reason_code: ARCHIVE_CODES.NO_PERMISSION, detail: key.detail };
  const snapshotId = input.snapshotId ?? state.latest?.snapshot_id ?? null;
  if (snapshotId === null) return { ok: false, reason_code: ARCHIVE_CODES.NO_SNAPSHOT, detail: 'the repository has no valid snapshot yet' };

  let snapshot;
  try {
    snapshot = readSnapshot({ root: input.root, snapshotId });
  } catch (error) {
    return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: error?.detail ?? String(error?.message ?? error) };
  }
  const selection = selectArchiveFiles({ manifest: snapshot.manifest, scope: input.scope, sessionIds: input.sessionIds });
  const chosen = [...selection.sessions, ...selection.attachments];
  if (chosen.length === 0) {
    return {
      ok: false,
      reason_code: ARCHIVE_CODES.EMPTY,
      detail: `snapshot ${snapshotId} has no session matching scope ${input.scope ?? 'archived'}`,
    };
  }

  const entries = [];
  const files = [];
  for (const entry of chosen) {
    const rebuilt = rebuildFile({ root: input.root, entry, dek: key.dek });
    if (rebuilt.ok !== true) return { ok: false, reason_code: rebuilt.code, detail: rebuilt.detail };
    const digest = sha256Hex(rebuilt.buffer);
    if (rebuilt.buffer.length !== entry.size || digest !== entry.sha256) {
      return { ok: false, reason_code: ARCHIVE_CODES.DIGEST_MISMATCH, detail: `${entry.rel}: the repository bytes do not match the manifest` };
    }
    entries.push({ name: entry.rel, data: rebuilt.buffer, mtimeMs: entry.mtime_ms ?? now.getTime() });
    files.push({ rel: entry.rel, kind: entry.kind, size: entry.size, sha256: entry.sha256, session_id: entry.session_id ?? null, attachment_id: entry.attachment_id ?? null, flags: entry.flags ?? null });
  }

  const manifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    created_at: now.toISOString(),
    source_snapshot: snapshotId,
    source_digest: snapshot.digest,
    dsh_home: input.dshHome,
    scope: input.scope ?? 'archived',
    counts: { files: files.length, sessions: files.filter((file) => file.kind === 'session').length, attachments: files.filter((file) => file.kind === 'attachment').length },
    files,
    notes: [
      'This pack is a plaintext tar of session logs and attachment objects, compressed with zstd.',
      'Extract with: zstd -d <file>.tar.zst && tar -xf <file>.tar',
      'Each file can be verified against the sha256 recorded here and in the source snapshot manifest.',
    ],
  };
  const readme = [
    'W2M session archive',
    `created_at : ${manifest.created_at}`,
    `snapshot   : ${snapshotId}`,
    `scope      : ${manifest.scope}`,
    `sessions   : ${manifest.counts.sessions}`,
    `attachments: ${manifest.counts.attachments}`,
    '',
    'manifest.json lists every file with its size and sha256.',
    'The pack is not encrypted: it is a copy of the repository content, written inside the repository directory.',
  ].join('\n');
  const tar = writeTar([
    { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n`, mtimeMs: now.getTime() },
    { name: 'README.txt', data: `${readme}\n`, mtimeMs: now.getTime() },
    ...entries,
  ]);
  const compressed = zlib.zstdCompressSync(tar);
  const file = archivePath(input.root, now);
  try {
    writeFileAtomic(file, compressed);
  } catch (error) {
    return { ok: false, reason_code: error?.code ?? ARCHIVE_CODES.WRITE_FAILED, detail: error?.detail ?? String(error?.message ?? error) };
  }
  return {
    ok: true,
    file,
    bytes: tar.length,
    compressed_bytes: compressed.length,
    sessions: manifest.counts.sessions,
    files: files.length,
    source_snapshot: snapshotId,
  };
}

/**
 * Read one archive back: decompress, parse the tar, validate its manifest against the bytes it carries.
 *
 * @param {string|Buffer} source path or archive bytes
 * @returns {{ok: boolean, reason_code: string|null, detail: string|null, manifest: object|null,
 *   entries: Array<{name: string, data: Buffer, size: number}>, problems: Array<{rel: string, detail: string}>}}
 */
export function readArchive(source) {
  let buffer;
  if (Buffer.isBuffer(source)) {
    buffer = source;
  } else {
    try {
      buffer = fs.readFileSync(source);
    } catch (error) {
      return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: `${source}: ${error?.code ?? 'unreadable'}`, manifest: null, entries: [], problems: [] };
    }
  }
  let tar;
  try {
    tar = zlib.zstdDecompressSync(buffer);
  } catch (error) {
    return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: `not a zstd stream: ${error instanceof Error ? error.message : String(error)}`, manifest: null, entries: [], problems: [] };
  }
  let entries;
  try {
    entries = readTar(tar);
  } catch (error) {
    return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: error instanceof Error ? error.message : String(error), manifest: null, entries: [], problems: [] };
  }
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  if (manifestEntry === undefined) {
    return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: 'the archive has no manifest.json', manifest: null, entries, problems: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (error) {
    return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: `manifest.json is not JSON: ${error instanceof Error ? error.message : String(error)}`, manifest: null, entries, problems: [] };
  }
  if (manifest?.format !== ARCHIVE_FORMAT) {
    return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: `manifest format is ${JSON.stringify(manifest?.format)}`, manifest: null, entries, problems: [] };
  }
  const problems = [];
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const file of manifest.files ?? []) {
    const entry = byName.get(file.rel);
    if (entry === undefined) {
      problems.push({ rel: file.rel, detail: 'missing from the archive' });
      continue;
    }
    if (entry.data.length !== file.size) problems.push({ rel: file.rel, detail: `size is ${entry.data.length}, manifest says ${file.size}` });
    else if (sha256Hex(entry.data) !== file.sha256) problems.push({ rel: file.rel, detail: 'sha256 does not match the manifest' });
  }
  return {
    ok: problems.length === 0,
    reason_code: problems.length === 0 ? null : ARCHIVE_CODES.DIGEST_MISMATCH,
    detail: problems.length === 0 ? null : `${problems.length} archive problem(s)`,
    manifest,
    entries: entries.filter((entry) => entry.name !== 'manifest.json' && entry.name !== 'README.txt'),
    problems,
  };
}

/**
 * Extract an archive into a directory (which must not already hold files).
 *
 * @param {{file: string, destDir: string, allowExisting?: boolean}} input
 * @returns {{ok: boolean, reason_code: string|null, detail: string|null, dir: string, files: number, bytes: number, problems: Array<object>}}
 */
export function extractArchive(input) {
  const archive = readArchive(input.file);
  if (archive.manifest === null) {
    return { ok: false, reason_code: archive.reason_code, detail: archive.detail, dir: input.destDir, files: 0, bytes: 0, problems: [] };
  }
  if (archive.ok !== true) {
    return { ok: false, reason_code: archive.reason_code, detail: archive.detail, dir: input.destDir, files: 0, bytes: 0, problems: archive.problems };
  }
  const dest = path.resolve(input.destDir);
  fs.mkdirSync(dest, { recursive: true });
  let bytes = 0;
  let files = 0;
  const writes = [];
  for (const entry of archive.entries) {
    const target = path.resolve(dest, entry.name);
    const relative = path.relative(dest, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, reason_code: ARCHIVE_CODES.READ_FAILED, detail: `refusing to write outside the destination: ${entry.name}`, dir: dest, files, bytes, problems: [] };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    files += 1;
    bytes += entry.data.length;
    writes.push(entry.name);
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify(archive.manifest, null, 2)}\n`);
  return { ok: true, reason_code: null, detail: null, dir: dest, files, bytes, problems: [] , writes };
}
