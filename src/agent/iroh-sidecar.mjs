/**
 * W1 spike: iroh sidecar transport (JSON over length-prefixed stdio).
 *
 * The real binary is intentionally not bundled or auto-downloaded: the sidecar
 * command/args come from configuration and are verified by the caller. This
 * module owns only the process lifecycle and the frame contract, so a fake
 * sidecar can exercise every failure path in CI without Rust or a TLS relay.
 *
 * Wire (parent -> child and child -> parent): 4-byte big-endian length + UTF-8 JSON.
 *   { id, method, params }            request
 *   { id, result } / { id, error }    response
 *   { type: 'ready' }                 child is listening
 *   { type: 'message', peer, data }   inbound payload (base64)
 *   { type: 'status', paths, ... }    diagnostics
 */
import { spawn as nodeSpawn } from 'node:child_process';

export const IROH_TRANSPORT = 'iroh-v1';
export const IROH_CODE = Object.freeze({
  START_FAILED: 'IROH_SIDECAR_START_FAILED',
  TIMEOUT: 'IROH_TIMEOUT',
  EXITED: 'IROH_SIDECAR_EXITED',
  CLOSED: 'IROH_CLOSED',
  BAD_FRAME: 'IROH_BAD_FRAME',
});

function encode(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function createIrohSidecarTransport({ command, args = [], env = {}, timeoutMs = 2500, spawnImpl = nodeSpawn } = {}) {
  if (typeof command !== 'string' || command === '') {
    return { ok: false, code: IROH_CODE.START_FAILED, detail: 'iroh sidecar command is required' };
  }
  const handlers = new Set();
  const pending = new Map();
  let child = null;
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let ready = null;
  let closed = false;
  let lastStatus = { paths: [] };

  const failPending = (code, detail) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(detail ?? code), { code }));
      pending.delete(id);
    }
  };

  const onFrame = (message) => {
    if (message?.type === 'ready') { ready?.(); ready = null; return; }
    if (message?.type === 'message') {
      const payload = Buffer.from(String(message.data ?? ''), 'base64');
      for (const handler of handlers) handler({ peer: message.peer ?? null, payload });
      return;
    }
    if (message?.type === 'status') { lastStatus = { paths: Array.isArray(message.paths) ? message.paths : [] }; return; }
    if (typeof message?.id === 'number' && pending.has(message.id)) {
      const entry = pending.get(message.id);
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(String(message.error.message ?? message.error)), { code: message.error.code ?? IROH_CODE.EXITED }));
      else entry.resolve(message.result ?? null);
    }
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try { onFrame(JSON.parse(body.toString('utf8'))); } catch { /* a bad frame is dropped, not fatal */ }
    }
  };

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed || child === null) { reject(Object.assign(new Error(IROH_CODE.CLOSED), { code: IROH_CODE.CLOSED })); return; }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(IROH_CODE.TIMEOUT), { code: IROH_CODE.TIMEOUT }));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(encode({ id, method, params }));
  });

  const transport = {
    name: IROH_TRANSPORT,
    async start() {
      return new Promise((resolve) => {
        try {
          child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
        } catch (error) {
          resolve({ ok: false, code: IROH_CODE.START_FAILED, detail: error instanceof Error ? error.message : String(error) });
          return;
        }
        const timer = setTimeout(() => { resolve({ ok: false, code: IROH_CODE.START_FAILED, detail: IROH_CODE.TIMEOUT }); }, timeoutMs);
        ready = () => { clearTimeout(timer); resolve({ ok: true, name: IROH_TRANSPORT }); };
        child.stdout.on('data', onData);
        child.stderr.on('data', () => {});
        child.on('exit', () => {
          closed = true;
          clearTimeout(timer);
          failPending(IROH_CODE.EXITED, 'iroh sidecar exited');
          if (ready !== null) { ready = null; resolve({ ok: false, code: IROH_CODE.START_FAILED, detail: 'sidecar exited before ready' }); }
        });
        child.on('error', (error) => {
          closed = true;
          clearTimeout(timer);
          resolve({ ok: false, code: IROH_CODE.START_FAILED, detail: error.message });
        });
      });
    },
    async send(peer, payload) {
      if (closed || child === null) return { ok: false, code: IROH_CODE.CLOSED };
      try {
        await rpc('send', { peer, data: Buffer.from(payload).toString('base64') });
        return { ok: true, peer };
      } catch (error) {
        return { ok: false, code: error.code ?? IROH_CODE.EXITED, detail: error.message };
      }
    },
    onMessage(handler) {
      if (typeof handler !== 'function') return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    paths() { return lastStatus.paths.map((path) => ({ ...path, transport: IROH_TRANSPORT })); },
    diagnostics() { return { name: IROH_TRANSPORT, closed, pending: pending.size, paths: lastStatus.paths.length }; },
    async stop() {
      if (closed) return { ok: true };
      closed = true;
      failPending(IROH_CODE.CLOSED, 'transport stopped');
      try { child?.stdin.end(); child?.kill(); } catch { /* already gone */ }
      child = null;
      return { ok: true };
    },
  };
  return { ok: true, transport };
}
