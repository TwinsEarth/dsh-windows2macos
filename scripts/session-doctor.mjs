#!/usr/bin/env node
/**
 * Session doctor — read-only diagnostics for DSH v4 session logs and the workspace index.
 *
 * ## Why this exists (measured, not imagined)
 *
 * 2026-11-16/17 a real recovery drill (`session-5faf0ea6…`, 「找回十天内历史对话」) rebuilt three
 * session logs by hand and shipped them into `$DSH_HOME/sessions`. Every attempt "looked right" in a
 * text editor and failed in the app, for four different reasons, in this order:
 *
 *   1. `storages/workspace.json` was written while the client had it in memory; the client's next save
 *      replaced it, so a restored session silently disappeared from the list.
 *   2. The **first zstd frame of a log must contain only the header line** (`assertZstdHeaderFrame`);
 *      header + first events in one frame is judged corrupt and skipped without a visible error.
 *   3. `assistant/message` without `surfaceOp: "append"` (and, in real logs, `stream` / `usage`) throws
 *      `assistant/message surfaceOp requires an object` when the session is opened.
 *   4. A `system/message` that is **not the first surface event** throws
 *      `system/message requires a protected first surface head`; a synthetic surface that starts with
 *      `user/message` has no protected head, so the client's own later append corrupts the log.
 *
 * Deleting or inserting events also breaks `seq` continuity and the references that point at seqs
 * (`sourceEventSeqs`, `messageSeqs`, `headerSeq`).
 *
 * None of those four are discoverable by reading the JSON text; all four are mechanical. This doctor
 * checks them **without writing anything**, so a restore path can validate a candidate log before it
 * is published to the live sessions tree — which is the gate the drill lacked.
 *
 * Usage:
 *   node scripts/session-doctor.mjs --root "$DSH_HOME"            # human report
 *   node scripts/session-doctor.mjs --root "$DSH_HOME" --json     # machine report
 *   node scripts/session-doctor.mjs --file <session.v4.jsonl.zstd>
 *
 * Exit codes: 0 all checked artifacts pass; 1 at least one finding; 2 usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import process from 'node:process';

/** Stable finding codes. Greppable on purpose: a report cites a code, not a sentence. */
export const CODES = Object.freeze({
  UNREADABLE: 'LOG_UNREADABLE',
  EMPTY: 'LOG_EMPTY',
  HEADER_FRAME_INVALID: 'ZSTD_HEADER_FRAME_INVALID',
  HEADER_MISSING: 'SESSION_HEADER_MISSING',
  SEQ_GAP: 'SEQ_GAP',
  SEQ_DUPLICATE: 'SEQ_DUPLICATE',
  SURFACE_OP_MISSING: 'SURFACE_OP_MISSING',
  PROTECTED_HEAD_MISSING: 'PROTECTED_HEAD_MISSING',
  DANGLE_REF: 'SEQ_REF_DANGLING',
  SESSION_ID_MISMATCH: 'SESSION_ID_MISMATCH',
  NOT_REGISTERED: 'SESSION_NOT_REGISTERED',
  REGISTRY_MISSING: 'REGISTRY_UNREADABLE',
  ARCHIVE_FLAG_MISMATCH: 'ARCHIVE_FLAG_MISMATCH',
});

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * A surface operation is either the string `append` or a compaction record
 * `{ op: 'replace', startSeq, endSeq }`. Both appear in healthy logs: the object form is what a
 * compacted checkpoint carries (measured on the real 113 MB session, 37 occurrences), so a rule that
 * only accepts the string would flag every long-lived session.
 */
function isValidSurfaceOp(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (value === null || typeof value !== 'object') return false;
  const op = value.op;
  if (typeof op !== 'string' || op === '') return false;
  if (op === 'append') return true;
  if (op === 'replace') return Number.isInteger(value.startSeq) && Number.isInteger(value.endSeq);
  return false;
}


/** Event types that belong to the conversation surface (v4 fold rules). */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message']);

/** Keys whose numeric values are event seq references. Matching is by suffix, so a new `*Seq` is covered. */
const SEQ_REF_KEY = /(?:Seq|Seqs)$/;

/** Read a UTF-8 file; null when it cannot be read. */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Split a log into zstd frames and decode each frame's lines.
 *
 * @param {Buffer} buf
 * @returns {{frames: Array<{index: number, lines: string[], events: object[], bytes: number}>, undecodable: number}}
 */
export function splitFrames(buf) {
  const frames = [];
  let undecodable = 0;
  let start = buf.indexOf(ZSTD_MAGIC);
  let index = 0;
  while (start !== -1) {
    const next = buf.indexOf(ZSTD_MAGIC, start + ZSTD_MAGIC.length);
    const frameBuf = buf.subarray(start, next === -1 ? buf.length : next);
    let text = null;
    try {
      text = zlib.zstdDecompressSync(frameBuf).toString('utf8');
    } catch {
      text = null;
    }
    if (text === null) {
      undecodable += 1;
    } else {
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* A frame whose tail is a partial line: counted, not fatal here. */
        }
      }
      frames.push({ index, lines, events, bytes: frameBuf.length });
      index += 1;
    }
    if (next === -1) break;
    start = next;
    continue;
  }
  return { frames, undecodable };
}

/**
 * Diagnose one log file.
 *
 * @param {string} file
 * @param {{expectedSessionId?: string|null}} [options]
 * @returns {{ok: boolean, file: string, codes: string[], detail: object, events: number}}
 */
export function diagnoseSessionFile(file, options = {}) {
  const codes = [];
  const detail = {};
  const raw = (() => {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      codes.push(CODES.UNREADABLE);
      detail.unreadable = String(error?.message ?? error);
      return null;
    }
  })();
  if (raw === null) return { ok: false, file, codes, detail, events: 0 };
  if (raw.length === 0) {
    codes.push(CODES.EMPTY);
    return { ok: false, file, codes, detail, events: 0 };
  }

  const { frames, undecodable } = splitFrames(raw);
  detail.frames = frames.length;
  detail.undecodable_frames = undecodable;
  if (frames.length === 0) {
    codes.push(CODES.HEADER_FRAME_INVALID);
    return { ok: false, file, codes, detail, events: 0 };
  }

  // Rule 2: the first frame carries the header line and nothing else.
  const head = frames[0];
  const headerEvents = head.events.filter((event) => event?.type === 'session');
  detail.header_frame_lines = head.lines.length;
  detail.header_frame_types = head.events.map((event) => event?.type ?? '?');
  if (head.lines.length !== 1 || headerEvents.length !== 1) {
    codes.push(CODES.HEADER_FRAME_INVALID);
    detail.header_frame_expected = 'exactly one line: the session header event';
  }
  const header = headerEvents[0] ?? null;
  if (header === null) codes.push(CODES.HEADER_MISSING);

  const expected = options.expectedSessionId ?? null;
  if (expected !== null && header !== null && String(header.id ?? '') !== expected) {
    codes.push(CODES.SESSION_ID_MISMATCH);
    detail.session_id = details(header.id);
  }

  // Events after the header frame, in file order.
  const events = [];
  for (const [frameIndex, frame] of frames.entries()) {
    if (frameIndex === 0) continue;
    for (const event of frame.events) events.push(event);
  }
  detail.events = events.length;

  // Rule: seq is contiguous from 0 and unique.
  const seqs = [];
  for (const event of events) {
    if (Number.isInteger(event?.seq)) seqs.push(event.seq);
  }
  const seen = new Set();
  let gapAt = -1;
  for (let expectedSeq = 0; expectedSeq < seqs.length; expectedSeq += 1) {
    const value = seqs[expectedSeq];
    if (value !== expectedSeq && gapAt === -1) gapAt = expectedSeq;
    if (seen.has(value)) codes.push(CODES.SEQ_DUPLICATE);
    seen.add(value);
  }
  if (gapAt !== -1) {
    codes.push(CODES.SEQ_GAP);
    detail.seq_gap_at = gapAt;
    detail.seq_first_values = seqs.slice(0, Math.max(6, gapAt + 3));
  }

  // Rule 3/4: surface invariants.
  let surfaceStart = -1;
  let protectedHead = false;
  for (const [index, event] of events.entries()) {
    if (!SURFACE_TYPES.has(event?.type)) continue;
    if (event.type === 'system/message') {
      if (surfaceStart === -1) {
        surfaceStart = index;
        protectedHead = true;
        continue;
      }
      if (!protectedHead) {
        codes.push(CODES.PROTECTED_HEAD_MISSING);
        detail.protected_head = { surface_start_index: surfaceStart, offending_index: index, seq: event?.seq ?? null };
        break;
      }
      continue;
    }
    if (surfaceStart === -1) surfaceStart = index;
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      if (!isValidSurfaceOp(event.surfaceOp)) {
        codes.push(CODES.SURFACE_OP_MISSING);
        detail.surface_op = { type: event.type, seq: event?.seq ?? null, surface_op: details(event?.surfaceOp) };
        break;
      }
    }
  }

  // Refs: any *Seq / *Seqs numeric value must address an existing seq.
  const known = new Set(seqs);
  const dangling = [];
  const walk = (value, keyPath) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${keyPath}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const here = keyPath === '' ? key : `${keyPath}.${key}`;
      if (SEQ_REF_KEY.test(key)) {
        if (Number.isInteger(entry) && !known.has(entry)) dangling.push({ at: here, seq: entry });
        else if (Array.isArray(entry)) for (const item of entry) if (Number.isInteger(item) && !known.has(item)) dangling.push({ at: here, seq: item });
      }
      walk(entry, here);
    }
  };
  walk(events, '');
  if (dangling.length > 0) {
    codes.push(CODES.DANGLE_REF);
    detail.dangling_refs = dangling.slice(0, 5);
  }

  // Turn count, for a report a human can compare with the UI.
  let turns = 0;
  for (const event of events) if (event?.type === 'turn/start') turns += 1;
  detail.turns = turns;

  const unique = [...new Set(codes)];
  return { ok: unique.length === 0, file, codes: unique, detail, events: events.length };
}

/** Format a value for a report line without dumping a whole object. */
function details(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value).slice(0, 120);
}

/** List `<sessionsRoot>/<workspace>/<session-dir>/session.v4.jsonl.zstd` files. */
export function listSessionLogs(sessionsRoot) {
  const out = [];
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(sessionsRoot, workspace.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = path.join(workspaceDir, session.name, 'session.v4.jsonl.zstd');
      try {
        if (fs.statSync(file).isFile()) out.push({ file, workspace: workspace.name, sessionId: session.name });
      } catch {
        /* not a log */
      }
    }
  }
  return out;
}

/**
 * Diagnose a whole `$DSH_HOME`: every log plus the workspace registry.
 *
 * @param {{root: string}} options
 */
export function diagnoseRoot(options) {
  const root = path.resolve(options.root);
  const sessionsRoot = path.join(root, 'sessions');
  const registryFile = path.join(root, 'storages', 'workspace.json');
  const findings = [];

  let registry = null;
  const registryText = readText(registryFile);
  if (registryText === null) {
    findings.push({ code: CODES.REGISTRY_MISSING, file: registryFile });
  } else {
    try {
      registry = JSON.parse(registryText);
    } catch (error) {
      findings.push({ code: CODES.REGISTRY_MISSING, file: registryFile, detail: String(error?.message ?? error) });
    }
  }
  const registered = new Set();
  const archived = new Set();
  const pinned = new Set();
  if (registry !== null) {
    const global = registry?.global ?? {};
    for (const id of Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []) archived.add(String(id));
    for (const id of Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []) pinned.add(String(id));
    const tables = registry?.tables?.workspaces ?? {};
    for (const record of Object.values(tables)) {
      for (const id of Array.isArray(record?.sessionIds) ? record.sessionIds : []) registered.add(String(id));
    }
  }

  const sessions = [];
  for (const entry of listSessionLogs(sessionsRoot)) {
    const result = diagnoseSessionFile(entry.file, { expectedSessionId: entry.sessionId });
    sessions.push({ ...result, session_id: entry.sessionId, workspace: entry.workspace });
    for (const code of result.codes) findings.push({ code, file: entry.file, session_id: entry.sessionId });
    if (registry !== null && !registered.has(entry.sessionId)) {
      findings.push({ code: CODES.NOT_REGISTERED, file: entry.file, session_id: entry.sessionId });
    }
  }
  return {
    root,
    sessions,
    findings,
    registry: {
      file: registryFile,
      ok: registry !== null,
      workspaces: registry === null ? 0 : Object.keys(registry?.tables?.workspaces ?? {}).length,
      registered: registered.size,
      archived: archived.size,
      pinned: pinned.size,
    },
  };
}

/** Human-readable report for `diagnoseRoot`. */
export function formatReport(report) {
  const lines = [];
  lines.push(`# session doctor`);
  lines.push('');
  lines.push(`root: ${report.root}`);
  lines.push(`registry: ${report.registry.ok ? 'readable' : 'UNREADABLE'} (${report.registry.file})`);
  lines.push(`workspaces: ${report.registry.workspaces} · registered sessions: ${report.registry.registered} · archived: ${report.registry.archived} · pinned: ${report.registry.pinned}`);
  lines.push(`logs: ${report.sessions.length} · findings: ${report.findings.length}`);
  lines.push('');
  lines.push('| session | workspace | events | turns | 判定 | codes |');
  lines.push('|---|---|---|---|---|---|');
  for (const session of report.sessions) {
    lines.push(
      `| ${session.session_id.replace('session-', '').slice(0, 8)} | ${session.workspace} | ${session.events} | ${session.detail.turns ?? '?'} | ${session.ok ? 'OK' : 'FAIL'} | ${session.codes.join(' ') || '-'} |`,
    );
  }
  if (report.findings.length > 0) {
    lines.push('');
    lines.push('## findings');
    for (const finding of report.findings) {
      lines.push(`- \`${finding.code}\`  ${finding.session_id ?? ''}  ${finding.file}`);
    }
  }
  lines.push('');
  lines.push('## 门禁含义（修复任何一条前先读 docs/RETRO-SESSION-RECOVERY-20261117.md）');
  lines.push('- `ZSTD_HEADER_FRAME_INVALID`：首帧必须只含 header 一行，header 与事件混帧会被判损坏并静默跳过。');
  lines.push('- `SURFACE_OP_MISSING`：`user/message`、`assistant/message` 必须带 `surfaceOp: "append"`（真实事件还带 `stream`/`usage`）。');
  lines.push('- `PROTECTED_HEAD_MISSING`：`system/message` 只能作为 surface 第一条事件；surface 以 `user/message` 开头时，客户端后续追加 `system/message` 即判损坏。');
  lines.push('- `SEQ_GAP` / `SEQ_DUPLICATE` / `SEQ_REF_DANGLING`：删/插事件后必须全局重编号 seq，并同步改写 `sourceEventSeqs`/`messageSeqs`/`headerSeq`。');
  lines.push('- `SESSION_NOT_REGISTERED`：日志存在但不在 `storages/workspace.json` 里 → DSH 列表看不到（客户端会用内存态回写注册表）。');
  return lines.join('\n');
}

export function usage() {
  return [
    'usage: node scripts/session-doctor.mjs [--root <DSH_HOME>] [--json]',
    '       node scripts/session-doctor.mjs --file <session.v4.jsonl.zstd> [--session-id <id>] [--json]',
    '',
    'Without --root or --file, --root defaults to $DSH_HOME (so `npm run doctor` works as-is;',
    'an explicit path is still supported). --file examines one log and ignores the registry.',
    '',
    'read-only: nothing is created, rewritten, or deleted.',
  ].join('\n');
}

/**
 * Resolve the working mode from argv.
 *
 * `--file` wins over `--root`; a bare invocation falls back to `$DSH_HOME` so the npm script does not
 * depend on the caller's shell expanding a variable (cmd.exe would pass the literal text).
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function resolveCli(argv, env) {
  const read = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1] ?? null;
  };
  const file = read('--file');
  const sessionId = read('--session-id');
  const explicitRoot = read('--root');
  const root = file === null ? explicitRoot ?? env.DSH_HOME ?? null : null;
  return { json: argv.includes('--json'), file, sessionId, root };
}

function main() {
  const { json, file, sessionId, root } = resolveCli(process.argv.slice(2), process.env);

  if (root !== null) {
    const report = diagnoseRoot({ root });
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatReport(report)}\n`);
    return report.findings.length === 0 && report.sessions.every((session) => session.ok) ? 0 : 1;
  }
  if (file !== null) {
    const result = diagnoseSessionFile(path.resolve(file), { expectedSessionId: sessionId });
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.ok ? 'OK' : 'FAIL'} ${result.file}\n${result.codes.join('\n')}\n${JSON.stringify(result.detail, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('session-doctor.mjs') === true) {
  process.exit(main());
}
