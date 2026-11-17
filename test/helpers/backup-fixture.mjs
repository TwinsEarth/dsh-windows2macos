/**
 * Fixtures for the backup suites: a throwaway `$DSH_HOME` shaped like the real one.
 *
 * The logs are built with the same frame writer the repair path uses (`src/fix/zstd.mjs#compressFrame`), and the
 * header is alone in the first frame, because that is the invariant the 2026-11-17 recovery drill broke and
 * `scripts/session-doctor.mjs` now checks. A fixture that compressed the header together with events would let
 * the backup suites pass against logs the app would refuse.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { compressFrame } from '../../src/fix/zstd.mjs';

/**
 * A correct v4 header for one session.
 *
 * `isSeeded` and `delegationDepth` are required by the installed Harness's own v4 header validation
 * (`assertReleasedV4Header`); a header without them is interpreted as an older physical format and refused. The
 * fixture therefore carries them, so a fixture log is *format-valid* even before it is content-valid.
 */
export function header(sessionId, overrides = {}) {
  return {
    type: 'session',
    version: 4,
    id: sessionId,
    cwd: 'E:\\GPT',
    createdAt: 1794842804375,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  };
}

/** One durable event line. */
export function event(seq, type = 'turn/start', data = { turn: 1 }) {
  return { type, seq, time: 1794842804375 + seq, data };
}

/**
 * Concatenate JSON lines into zstd frames: frame 1 is the header alone, every further line is its own frame.
 *
 * @param {object[]} lines
 * @returns {Buffer}
 */
export function framesFor(lines) {
  const frames = lines.map((line) => compressFrame(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')));
  return Buffer.concat(frames);
}

/**
 * Build one session log buffer from a header and a list of events.
 *
 * @param {string} sessionId
 * @param {object[]} [events]
 * @param {object} [headerOverrides]
 * @returns {Buffer}
 */
export function sessionLog(sessionId, events = [event(0), event(1)], headerOverrides = {}) {
  return framesFor([header(sessionId, headerOverrides), ...events]);
}

/** Write a file, creating parents. */
export function put(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

/** A temporary directory that `cleanup()` destroys. */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A registry document, in the shape the DSH client writes. */
export function registryDocument({ workspace = 'E:\\GPT', workspaceId = 'w1', sessionIds = [], archived = [], pinned = [] } = {}) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: workspaceId,
      workspaceIds: [workspaceId],
      archivedSessionIds: archived,
      pinnedSessionIds: pinned,
    },
    tables: { workspaces: { [workspaceId]: { path: workspace, title: 'GPT', sessionIds } } },
  };
}

/**
 * A complete throwaway DSH home.
 *
 * @param {{
 *   sessions?: Array<{workspace: string, id: string, events?: object[], headerId?: string|null,
 *     noLog?: boolean, logFile?: string}>,
 *   registry?: object|null,
 *   attachments?: Array<{id: string, bytes?: Buffer, fanout?: string}>,
 *   caches?: boolean
 * }} spec
 * @returns {{home: string, files: Record<string, string>, cleanup: () => void}}
 */
export function makeHome(spec = {}) {
  const { dir, cleanup } = tempDir('w2m-backup-home-');
  const files = {};
  const sessions = spec.sessions ?? [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }];
  for (const session of sessions) {
    const sessionDir = join(dir, 'sessions', session.workspace, session.id);
    mkdirSync(sessionDir, { recursive: true });
    if (session.noLog === true) continue;
    const log = session.headerId === null
      ? sessionLog(session.id, session.events ?? [event(0), event(1)], { id: 'session-elsewhere-9999' })
      : sessionLog(session.id, session.events ?? [event(0), event(1)]);
    const file = join(sessionDir, session.logFile ?? 'session.v4.jsonl.zstd');
    writeFileSync(file, log);
    files[session.id] = file;
  }
  if (spec.registry !== null) {
    const document = spec.registry ?? registryDocument({ sessionIds: sessions.filter((s) => s.noLog !== true).map((s) => s.id) });
    put(join(dir, 'storages', 'workspace.json'), JSON.stringify(document, null, 2));
  }
  for (const attachment of spec.attachments ?? []) {
    const id = attachment.id;
    const fanout = attachment.fanout ?? id.slice(0, 2);
    put(join(dir, 'attachments', 'v1', 'objects', fanout, id), attachment.bytes ?? Buffer.from('attachment-bytes'));
  }
  if (spec.caches !== false) {
    put(join(dir, 'sessions', '.event-cache', 'whatever.json'), '{"cache":true}');
    put(join(dir, 'storages', 'session_projcache', 'projection.json'), '{"projection":true}');
  }
  return { home: dir, files, cleanup };
}

/** A 64-character content address for fixtures. */
export function attachmentId(seed = 0) {
  return `${String(seed).padStart(2, '0')}${'ab'.repeat(31)}`;
}

/**
 * A session log the installed Harness's own validator accepts.
 *
 * Minimal on purpose: one turn with a start and an end. It is the smallest artifact that passes
 * `sessionFormatCatalog.createRestore` with `validation: 'current'` (verified against the installed Harness), which
 * is exactly what restore's G5 gate needs: a candidate whose runtime validity is a measured fact, not a hope.
 *
 * The general-purpose {@link sessionLog} above stays deliberately minimal-and-not-runtime-valid for suites that
 * only need *format* validity (scan, manifest, engine dedup) -- making every fixture a model-generated conversation
 * would hide which tests depend on the runtime gate.
 *
 * @param {string} sessionId
 * @returns {Buffer}
 */
export function runtimeValidSessionLog(sessionId) {
  return framesFor([
    header(sessionId),
    { type: 'turn/start', seq: 0, time: 1794842804375, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 1794842804376, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
}

/** A DSH home holding one runtime-valid session plus one format-only session. */
export function runtimeValidHome() {
  const spec = makeHome({
    sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001', events: [] }],
    registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001'] }),
  });
  // Replace the log with one the installed Harness accepts.
  put(spec.files['session-aaaaaaaa-0001'], runtimeValidSessionLog('session-aaaaaaaa-0001'));
  return spec;
}
