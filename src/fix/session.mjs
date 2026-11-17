/**
 * Read one DSH session artifact into the pieces the offline repair needs: the
 * frame list, the durable events we care about, and - critically - the set of
 * sequence numbers that are still on the surface.
 *
 * A DSH session log lives at
 *   <DSH_HOME>/sessions/<workspace>/<session>/session.vN.jsonl.zstd
 * and is a concatenated Zstandard container: one event per frame, JSON lines
 * inside. The `compaction/summary` and `compaction/prune` events carry a
 * `shadowedSeqs` list; those messages are no longer part of the model request,
 * so a repair must never target them.
 *
 * Ported from `dsh-fix-attachments` (MIT, Copyright (c) 2026 xuzhunzhi); the
 * only changes are the comment voice and the export surface.
 */

import fs from 'node:fs';
import path from 'node:path';

import { decompressFrame, scanFrames } from './zstd.mjs';

/** Session formats this tool understands. Anything else is refused, not guessed. */
export const SUPPORTED_FORMAT_VERSIONS = new Set([4]);

const EVENT_RE = /^\{"type":"([a-z/_-]+)","seq":(\d+)/;
const HEADER_RE = /^\{"type":"session","version":(\d+)/;

/**
 * Pick the highest `session.vN.jsonl.zstd` in a session directory,
 * ignoring backups (`*.bak-*`).
 *
 * @param {string} dir
 * @returns {string|null}
 */
export function pickSessionFile(dir) {
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (name.includes('.bak-')) continue;
    const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name);
    if (!m) continue;
    const version = Number(m[1]);
    if (!best || version > best.version) best = { version, file: path.join(dir, name) };
  }
  return best?.file ?? null;
}

/**
 * Recursively list session directories (those holding a session artifact).
 *
 * @param {string} sessionsRoot
 * @returns {string[]}
 */
export function listSessionDirs(sessionsRoot) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && /^session\.v\d+\.jsonl\.zstd$/.test(e.name))) out.push(dir);
    // Dot-directories under `sessions/` are not workspaces: `.event-cache` is a derived projection and
    // `.w2m-restore-backups` is our own pre-restore copy area. Descending into them once turned a backup into a
    // 135-second run that ended with an invalid manifest rel path (measured 2026-11-17); the walker now stops at
    // them, and the backup scanner also excludes them explicitly.
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name));
    }
  };
  walk(sessionsRoot);
  return out;
}

/**
 * Parse one artifact.
 *
 * @param {string} file
 * @returns {{
 *   file: string, dir: string, id: string, size: number, lines: number,
 *   frames: Array<{start: number, end: number, hasChecksum: boolean}>, tornStart?: number,
 *   formatVersion: number | null, formatSupported: boolean,
 *   lastSeq: number, shadowed: Set<number>,
 *   offloaded: Map<number, Set<number>>, refs: Array<object>, skippedLines: number
 * }}
 */
export function readSession(file) {
  const buf = fs.readFileSync(file);
  const { frames, tornStart } = scanFrames(buf);
  const shadowed = new Set();
  const offloaded = new Map();
  const refs = [];
  let formatVersion = null;
  let lastSeq = -1;
  let lines = 0;
  let skipped = 0;

  for (const frame of frames) {
    const text = decompressFrame(buf.subarray(frame.start, frame.end));
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    lines += parts.length;

    for (const line of parts) {
      if (!line) continue;
      if (formatVersion === null) {
        const h = HEADER_RE.exec(line);
        if (h) formatVersion = Number(h[1]);
      }
      const m = EVENT_RE.exec(line);
      if (!m) {
        skipped += 1;
        continue;
      }
      const type = m[1];
      const seq = Number(m[2]);
      if (seq > lastSeq) lastSeq = seq;

      if (type === 'compaction/summary' || type === 'compaction/prune') {
        let data;
        try {
          data = JSON.parse(line).data;
        } catch {
          continue;
        }
        for (const s of data?.shadowedSeqs ?? []) shadowed.add(Number(s));
        continue;
      }

      if (type === 'image/offload') {
        let data;
        try {
          data = JSON.parse(line).data;
        } catch {
          continue;
        }
        for (const target of data?.targets ?? []) {
          if (!target || typeof target.seq !== 'number') continue;
          const set = offloaded.get(target.seq) ?? new Set();
          for (const i of target.imageIndexes ?? []) set.add(Number(i));
          offloaded.set(target.seq, set);
        }
        continue;
      }

      if (type !== 'user/message' && type !== 'tool/result') continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const message = type === 'user/message' ? ev.data : ev?.data?.message;
      let imageIndex = 0;
      for (const block of message?.content ?? []) {
        if (!block || block.type !== 'image') continue;
        const attachmentId = String(block?.attachment?.attachmentId ?? '').replace(/^sha256:/, '');
        if (attachmentId) {
          refs.push({
            seq,
            type,
            imageIndex,
            attachmentId,
            alreadyOffloaded: block.offloaded === true,
          });
        }
        imageIndex += 1;
      }
    }
  }

  return {
    file,
    dir: path.dirname(file),
    id: path.basename(path.dirname(file)),
    size: buf.length,
    lines,
    frames,
    tornStart,
    formatVersion,
    formatSupported: formatVersion !== null && SUPPORTED_FORMAT_VERSIONS.has(formatVersion),
    lastSeq,
    shadowed,
    offloaded,
    refs,
    skippedLines: skipped,
  };
}

/**
 * Absolute object path for a content-addressed attachment id.
 *
 * @param {string} storeRoot
 * @param {string} attachmentId
 * @returns {string}
 */
export function objectPath(storeRoot, attachmentId) {
  return path.join(storeRoot, attachmentId.slice(0, 2), attachmentId);
}
