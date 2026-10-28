/**
 * 红线审计落盘：JSONL + fsync + 哈希链 + 校验。
 * 只接受元数据字段（内容字段直接拒绝），链断裂/篡改可被定位。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const AUDIT_FORBIDDEN = new Set(['content', 'data', 'file', 'files', 'patch', 'stdout', 'stderr', 'diff', 'blob', 'bytes', 'text', 'base64']);

/** Recursively collect forbidden content keys: a nested payload must not slip past the top level. */
function contentKeysDeep(value, path = '', hits = []) {
  if (value === null || typeof value !== 'object') return hits;
  if (Array.isArray(value)) { value.forEach((entry, index) => contentKeysDeep(entry, path + '[' + index + ']', hits)); return hits; }
  for (const [key, child] of Object.entries(value)) {
    const keyPath = path === '' ? key : path + '.' + key;
    if (AUDIT_FORBIDDEN.has(key.toLowerCase())) hits.push(keyPath);
    else contentKeysDeep(child, keyPath, hits);
  }
  return hits;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, fn) {
  const lock = file + '.lock';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { unlinkSync(lock); continue; } } catch { /* raced */ }
      sleep(20);
    }
  }
  return { ok: false, code: 'AUDIT_BUSY' };
}


function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 追加一条审计；写盘后 fsync。返回写入的记录。 */
export function appendAudit(file, event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, code: 'AUDIT_EVENT_INVALID' };
  }
  const bad = contentKeysDeep(event);
  if (bad.length > 0) return { ok: false, code: 'AUDIT_CONTENT_FORBIDDEN', detail: { keys: bad } };
  return withLock(file, () => {
    let previous = null;
    let seq = 1;
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
      if (lines.length > 0) {
        // A corrupt tail is refused, never treated as "a new file": resetting the chain hides tampering.
        let last;
        try { last = JSON.parse(lines[lines.length - 1]); } catch { return { ok: false, code: 'AUDIT_TAIL_CORRUPT', detail: { line: lines.length } }; }
        previous = last.record_sha256 ?? null;
        seq = Number(last.seq ?? lines.length) + 1;
      }
    }
    const body = {
      v: 1,
      seq,
      at: event.at ?? new Date().toISOString(),
      event: typeof event.event === 'string' ? event.event : 'joint.event',
      plan_sha256: event.plan_sha256 ?? null,
      step_id: event.step_id ?? null,
      task_id: event.task_id ?? null,
      machine_id: event.machine_id ?? null,
      outcome: event.outcome ?? null,
      reason_code: event.reason_code ?? null,
      control_bytes: Number.isInteger(event.control_bytes) ? event.control_bytes : null,
      control_sha256: typeof event.control_sha256 === 'string' ? event.control_sha256 : null,
      prev_sha256: previous,
    };
    const record = { ...body, record_sha256: sha256(stable(body)) };
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ok: true, record };
  });
}

/** 校验整条链；返回第一处问题的 seq。 */
export function verifyAuditFile(file) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return { ok: true, count: 0, head: null };
  }
  let expectedPrev = null;
  let head = null;
  lines.forEach((line, index) => {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error('AUDIT_JSON_BROKEN at line ' + (index + 1)); }
    const { record_sha256: stored, ...body } = record;
    if (body.prev_sha256 !== expectedPrev) throw new Error('AUDIT_CHAIN_BROKEN at seq ' + body.seq);
    if (sha256(stable(body)) !== stored) throw new Error('AUDIT_ENTRY_TAMPERED at seq ' + body.seq);
    expectedPrev = stored;
    head = stored;
  });
  return { ok: true, count: lines.length, head };
}
