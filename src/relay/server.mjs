/**
 * W2M Rabbit relay — node:http server (PROTOCOL §1 endpoints, §3 SSE, §7 errors).
 *
 * Zero third-party dependencies: only `node:` builtins.
 */

import http from 'node:http';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  RabbitState,
  rfc3339,
} from './state.mjs';
import { aggregateTask, buildReport } from './report.mjs';

export const DEFAULT_SSE_KEEPALIVE_MS = 15_000; // §3.2: every 15s a `: keepalive` line
export const DEFAULT_SWEEP_INTERVAL_MS = 1_000;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, err) {
  if (err instanceof ProtocolError) {
    sendJson(res, err.status, err.toBody());
    return;
  }
  sendJson(res, 500, {
    error: {
      code: 'INTERNAL',
      message: err?.message ? String(err.message) : 'internal error',
      detail: {},
    },
  });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Read a request body with a hard byte cap.
 * @returns {Promise<{tooLarge?:boolean, buffer?:Buffer, aborted?:boolean}>}
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        finish({ tooLarge: true });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ aborted: true }));
    req.on('aborted', () => finish({ aborted: true }));
  });
}

async function readJson(req, limit) {
  const body = await readBody(req, limit);
  if (body.tooLarge) {
    throw new ProtocolError('FRAME_TOO_LARGE', `request frame exceeds ${limit} bytes`, { limit_bytes: limit });
  }
  if (body.aborted) throw new ProtocolError('BAD_REQUEST', 'request aborted before the body was complete');
  const raw = body.buffer.toString('utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProtocolError('BAD_REQUEST', 'request body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError('BAD_REQUEST', 'request body is not valid JSON', { parse_error: String(err.message) });
  }
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

export class RelayServer {
  constructor(options = {}) {
    this.options = options;
    this.state = options.state ?? new RabbitState(options);
    this.frameLimitBytes = options.frameLimitBytes ?? MAX_FRAME_BYTES;
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_SSE_KEEPALIVE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.logger = options.logger ?? null;

    this.pairingCode = options.pairingCode ?? this.state.createPairingCode();
    this.subscribers = new Set();
    this.host = null;
    this.port = null;
    this._sweepTimer = null;
    this._startedAtMs = this.state.nowMs();

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => sendError(res, err));
    });
    // SSE connections are long-lived: never let Node time the request out.
    this.server.requestTimeout = options.requestTimeoutMs ?? 0;
    this.server.headersTimeout = options.headersTimeoutMs ?? 60_000;
  }

  get url() {
    if (this.host === null || this.port === null) return null;
    const host = this.host.includes(':') ? `[${this.host}]` : this.host;
    return `http://${host}:${this.port}`;
  }

  listen({ host = '127.0.0.1', port = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', onError);
        const addr = this.server.address();
        this.host = addr.address;
        this.port = addr.port;
        this._sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
        this._sweepTimer.unref?.();
        if (this.logger) {
          this.logger(`[w2m-rabbit] listening on ${this.url}  pairing code: ${this.pairingCode}`);
        }
        resolve({ host: this.host, port: this.port, url: this.url, pairingCode: this.pairingCode });
      });
    });
  }

  sweep() {
    return this.state.sweepExpired();
  }

  close() {
    return new Promise((resolve) => {
      if (this._sweepTimer) clearInterval(this._sweepTimer);
      this._sweepTimer = null;
      for (const sub of [...this.subscribers]) this._closeSubscriber(sub);
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  /* ---------------- request dispatch ---------------- */

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      throw new ProtocolError('BAD_REQUEST', 'malformed request URL');
    }
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    /* ---- public endpoints (§1: no bearer auth) ---- */
    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        uptime_ms: this.state.nowMs() - this._startedAtMs,
        ...this.state.stats(),
      });
    }
    if (method === 'POST' && path === '/v1/pair') {
      const body = await readJson(req, this.frameLimitBytes);
      const result = this.state.pair(body);
      return sendJson(res, 200, result);
    }

    /* ---- everything below requires `Authorization: Bearer <device_token>` ---- */
    const token = bearerToken(req);
    const device = token ? this.state.authenticate(token) : null;
    if (!device) {
      throw new ProtocolError('UNAUTHORIZED', 'missing or invalid device_token', {});
    }
    this.state.touchDevice(device.machine_id);

    if (method === 'GET' && path === '/v1/stream') {
      return this.handleStream(req, res, url, device);
    }
    if (method === 'POST' && path === '/v1/heartbeat') {
      const body = await readJson(req, this.frameLimitBytes);
      body.machine_id = body.machine_id ?? device.machine_id;
      const result = this.state.heartbeat(body);
      return sendJson(res, 200, result);
    }
    if (method === 'POST' && path === '/v1/result') {
      const body = await readJson(req, this.frameLimitBytes);
      const result = this.state.submitResult(body);
      const { _instanceKey, ...clean } = result;
      return sendJson(res, 200, clean);
    }
    if (method === 'POST' && path === '/v1/task') {
      const body = await readJson(req, this.frameLimitBytes);
      const result = this.state.createTask(body);
      return sendJson(res, 200, result);
    }
    if (method === 'GET' && path === '/v1/devices') {
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        devices: this.state.listDevices(),
      });
    }
    if (method === 'GET' && path === '/v1/tasks') {
      const rawLimit = url.searchParams.get('limit');
      let limit = 50;
      if (rawLimit !== null) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new ProtocolError('BAD_REQUEST', 'limit must be a positive integer', { limit: rawLimit });
        }
      }
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        tasks: this.state.listTasks({ limit }),
      });
    }

    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    const reportMatch = /^\/v1\/tasks\/([^/]+)\/report$/.exec(path);

    if (method === 'GET' && reportMatch) {
      const taskId = decodeURIComponent(reportMatch[1]);
      this.state.sweepExpired();
      const format = url.searchParams.get('format') ?? 'json';
      const report = buildReport(this.state, taskId, { format });
      if (res.writableEnded) return undefined;
      res.writeHead(200, {
        'content-type': report.contentType,
        'content-length': Buffer.byteLength(report.body, 'utf8'),
        'cache-control': 'no-store',
      });
      return res.end(report.body);
    }

    if (method === 'GET' && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      this.state.sweepExpired();
      const task = this.state.requireTask(taskId);
      const aggregate = aggregateTask(this.state, taskId);
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        task: this.state.taskSummary(task),
        leases: [...task.leases.values()],
        aggregate,
      });
    }

    throw new ProtocolError('NOT_FOUND', `no route for ${method} ${path}`, { method, path });
  }

  /* ---------------- SSE (§3) ---------------- */

  handleStream(req, res, url, device) {
    const machineId = device.machine_id;
    const requested = url.searchParams.get('machine_id');
    if (requested !== null && requested !== machineId) {
      throw new ProtocolError('BAD_REQUEST', 'machine_id does not match the device_token', {
        machine_id: requested, token_machine_id: machineId,
      });
    }

    let from = null;
    const seqParam = url.searchParams.get('seq');
    const lastEventId = req.headers['last-event-id'];
    if (seqParam !== null) {
      from = Number(seqParam);
      if (!Number.isInteger(from) || from < 1) {
        throw new ProtocolError('BAD_REQUEST', 'seq must be a positive integer', { seq: seqParam });
      }
    } else if (typeof lastEventId === 'string' && lastEventId.trim() !== '') {
      const last = Number(lastEventId);
      if (!Number.isInteger(last) || last < 0) {
        throw new ProtocolError('BAD_REQUEST', 'Last-Event-ID must be a non-negative integer', { last_event_id: lastEventId });
      }
      from = last + 1;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const sub = { machineId, res, write: null, timer: null, closed: false };

    const writeEvent = (event) => {
      if (res.writableEnded) return;
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    let live = false;
    const queue = [];
    const deliver = (entry) => {
      if (entry.target && entry.target !== machineId) return;
      writeEvent(entry.event);
    };
    const unsubscribe = this.state.onEvent((entry) => {
      if (!live) { queue.push(entry); return; }
      deliver(entry);
    });

    // §3.1: the first frame MUST be `ready`.
    const readySeq = this.state.reserveSeq();
    writeEvent({
      type: 'ready',
      seq: readySeq,
      protocol_version: PROTOCOL_VERSION,
      rabbit_time: this.state.nowIso(),
      machine_id: machineId,
    });

    if (from !== null) {
      const oldest = this.state.oldestBufferedSeq();
      if (from < oldest && oldest > 1) {
        writeEvent({
          type: 'notice',
          seq: this.state.reserveSeq(),
          rabbit_time: this.state.nowIso(),
          level: 'warn',
          code: 'REPLAY_TRUNCATED',
          message: `requested seq ${from} is older than the buffer head ${oldest}`,
          machine_id: machineId,
        });
      }
      for (const entry of this.state.replayEntries(from)) deliver(entry);
    }

    live = true;
    for (const entry of queue) deliver(entry);
    queue.length = 0;

    // §3.2: `: keepalive` comment every 15s.
    sub.timer = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': keepalive\n\n');
    }, this.keepaliveMs);
    sub.timer.unref?.();

    sub.write = writeEvent;
    sub.unsubscribe = unsubscribe;
    this.subscribers.add(sub);
    device.streams = (device.streams ?? 0) + 1;

    const onClose = () => this._closeSubscriber(sub);
    req.on('close', onClose);
    res.on('close', onClose);
    res.on('error', onClose);
    return undefined;
  }

  _closeSubscriber(sub) {
    if (!sub || sub.closed) return;
    sub.closed = true;
    this.subscribers.delete(sub);
    if (sub.timer) clearInterval(sub.timer);
    sub.timer = null;
    sub.unsubscribe?.();
    const device = this.state.devices.get(sub.machineId);
    if (device) {
      device.streams = Math.max(0, (device.streams ?? 1) - 1);
      if (device.streams === 0) this.state.setOnline(sub.machineId, false, 'stream_closed');
    }
    if (!sub.res.writableEnded) {
      try { sub.res.end(); } catch { /* already gone */ }
    }
  }
}

/** Convenience factory. */
export function createRelayServer(options = {}) {
  return new RelayServer(options);
}

/** Create + listen in one call. */
export async function startRelayServer(options = {}) {
  const relay = createRelayServer(options);
  await relay.listen(options);
  return relay;
}

export { ProtocolError, RabbitState, MAX_FRAME_BYTES, PROTOCOL_VERSION, rfc3339 };
export default createRelayServer;
