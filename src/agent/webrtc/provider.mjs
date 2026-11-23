/**
 * The WebRTC engine boundary.
 *
 * The repository has a deliberate zero-runtime-dependency policy (`CONTRIBUTING.md`): the published
 * package must not pull in a WebRTC stack. That policy is not negotiable from inside a feature, and
 * a native WebRTC addon is exactly the kind of dependency it exists to refuse. So the transport
 * speaks to an **external WebRTC engine process** over a small JSON-line protocol, in the same
 * spirit as `src/agent/iroh-sidecar.mjs`:
 *
 *   - the package ships the protocol and the policy, not a binary;
 *   - an operator supplies `providerCommand` (for example a Node script that imports
 *     `node-datachannel`) or a test supplies an in-process `providerFactory`;
 *   - the engine owns only PeerConnection/DataChannel. SDP, ICE negotiation policy, path
 *     accounting and the Noise boundary stay in this repository.
 *
 * This is deliberately a *provider* boundary rather than a hidden dynamic `import()`: an optional
 * dependency that is silently absent produces a transport that looks installed and cannot connect.
 * A missing command is a named refusal the status tool can show.
 *
 * Protocol (one JSON object per line, both directions):
 *
 *   core -> engine   {id, method, params}
 *   engine -> core   {id, ok: true, result} | {id, ok: false, error: {code, message}}
 *   engine -> core   {event: "ready"|"local-description"|"ice-candidate"|"state"|"open"|"data"|
 *                     "stats"|"error"|"exit", ...}
 *
 * `data` is base64 because the line protocol is JSON and a DataChannel message is bytes. The engine
 * is responsible for the DataChannel's own max-message size; this transport fragments above it.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve as resolvePath } from 'node:path';

import { MAX_MESSAGE_BYTES } from './protocol.mjs';

/** Named provider failures. */
export const PROVIDER_CODE = Object.freeze({
  UNAVAILABLE: 'WEBRTC_PROVIDER_UNAVAILABLE',
  SPAWN_FAILED: 'WEBRTC_PROVIDER_SPAWN_FAILED',
  READY_TIMEOUT: 'WEBRTC_PROVIDER_READY_TIMEOUT',
  REQUEST_TIMEOUT: 'WEBRTC_PROVIDER_REQUEST_TIMEOUT',
  CLOSED: 'WEBRTC_PROVIDER_CLOSED',
  BUSY: 'WEBRTC_PROVIDER_BUSY',
  BAD_LINE: 'WEBRTC_PROVIDER_BAD_LINE',
  PROTOCOL: 'WEBRTC_PROVIDER_PROTOCOL',
});

/** Largest line the engine may emit. A base64 4 MiB payload is ~5.6 MiB, so the cap is above that. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** How much engine stderr is kept for diagnostics. */
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A JSON-line bridge to one WebRTC engine process (or an injected in-process engine for tests).
 */
export class ProviderBridge extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.command] Executable path. Required unless `factory` is supplied.
   * @param {string[]} [options.args]
   * @param {string} [options.cwd]
   * @param {Record<string,string|undefined>} [options.env]
   * @param {() => object} [options.factory] Test seam: returns `{send, on, close, pid?}`.
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.maxInflight]
   */
  constructor({
    command = '',
    args = [],
    cwd = '',
    env = undefined,
    factory = null,
    readyTimeoutMs = 10_000,
    requestTimeoutMs = 30_000,
    maxInflight = 8,
  } = {}) {
    super();
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.cwd = cwd;
    this.env = env;
    this.factory = factory;
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxInflight = maxInflight;

    this.child = null;
    this.engine = null;
    this.ready = false;
    this.closed = false;
    this.starting = null;
    this.stderr = '';
    this.inflight = 0;
    this.seq = 0;
    /** @type {Map<number, {resolve: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.stats = { requests: 0, events: 0, bytes_out: 0, bytes_in: 0, send_failures: 0, last_error: null };
  }

  /**
   * Start the engine and wait for its `ready` event.
   *
   * @returns {Promise<{ok: true, pid: number|null, provider: string|null} | {ok: false, code: string, detail: string}>}
   */
  start() {
    if (this.ready) return Promise.resolve({ ok: true, pid: this.child?.pid ?? null, provider: null });
    if (this.starting !== null) return this.starting;
    if (
      typeof this.factory !== 'function' &&
      (typeof this.command !== 'string' || this.command.trim() === '')
    ) {
      return Promise.resolve({
        ok: false,
        code: PROVIDER_CODE.UNAVAILABLE,
        detail: 'providerCommand is not configured; install a WebRTC engine and point the row at it',
      });
    }
    this.starting = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = null;
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          code: PROVIDER_CODE.READY_TIMEOUT,
          detail: `engine did not report ready within ${this.readyTimeoutMs} ms`,
        });
      }, this.readyTimeoutMs);
      timer.unref?.();

      const onReady = (event) => {
        this.ready = true;
        this.off('error', onStartError);
        finish({
          ok: true,
          pid: this.child?.pid ?? null,
          provider: typeof event.provider === 'string' ? event.provider : null,
        });
      };
      const onStartError = (error) => {
        if (this.ready) return;
        this.off('ready', onReady);
        finish({
          ok: false,
          code: error?.code ?? PROVIDER_CODE.SPAWN_FAILED,
          detail: error?.detail ?? 'engine failed before ready',
        });
      };
      const onStartClose = () => {
        if (this.ready) return;
        this.off('ready', onReady);
        this.off('error', onStartError);
        finish({ ok: false, code: PROVIDER_CODE.CLOSED, detail: 'engine exited before ready' });
      };
      this.once('ready', onReady);
      this.once('error', onStartError);
      this.once('close', onStartClose);

      try {
        this.engine = this.#spawnEngine();
      } catch (error) {
        this.#fail(PROVIDER_CODE.SPAWN_FAILED, error instanceof Error ? error.message : String(error));
        finish({
          ok: false,
          code: PROVIDER_CODE.SPAWN_FAILED,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return this.starting;
  }

  /**
   * Make one request and await the matching response.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{ok: true, result: any} | {ok: false, code: string, detail: string}>}
   */
  call(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed)
      return Promise.resolve({ ok: false, code: PROVIDER_CODE.CLOSED, detail: 'provider is closed' });
    if (this.engine === null)
      return Promise.resolve({
        ok: false,
        code: PROVIDER_CODE.UNAVAILABLE,
        detail: 'provider is not started',
      });
    const id = (this.seq += 1);
    this.stats.requests += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          code: PROVIDER_CODE.REQUEST_TIMEOUT,
          detail: `${method} did not answer within ${timeoutMs} ms`,
        });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        timer,
      });
      try {
        this.engine.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({
          ok: false,
          code: PROVIDER_CODE.SPAWN_FAILED,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Send one DataChannel message. Keeps at most `maxInflight` unacknowledged sends so a fast caller
   * cannot grow an unbounded queue in the engine.
   *
   * @param {Buffer} bytes
   * @returns {Promise<{ok: true, bytes: number, buffered_amount: number} | {ok: false, code: string, detail: string}>}
   */
  async sendData(bytes) {
    if (!Buffer.isBuffer(bytes))
      return { ok: false, code: PROVIDER_CODE.PROTOCOL, detail: 'sendData needs a Buffer' };
    if (bytes.length > MAX_MESSAGE_BYTES) {
      return {
        ok: false,
        code: 'WEBRTC_MESSAGE_TOO_LARGE',
        detail: `${bytes.length} > ${MAX_MESSAGE_BYTES}`,
      };
    }
    if (this.inflight >= this.maxInflight) {
      return { ok: false, code: PROVIDER_CODE.BUSY, detail: `${this.inflight} sends already in flight` };
    }
    this.inflight += 1;
    const result = await this.call('send', { data: bytes.toString('base64') });
    this.inflight -= 1;
    if (result.ok !== true) {
      this.stats.send_failures += 1;
      return result;
    }
    return {
      ok: true,
      bytes: bytes.length,
      buffered_amount: Number(result.result?.bufferedAmount ?? 0),
    };
  }

  /**
   * Close the engine, politely first.
   * @returns {Promise<{ok: true}>}
   */
  async close() {
    if (this.closed) return { ok: true };
    this.closed = true;
    if (this.engine !== null) {
      try {
        this.engine.send({ id: (this.seq += 1), method: 'close', params: {} });
      } catch {
        // engine may already be dead
      }
      try {
        this.engine.close();
      } catch {
        // already closed
      }
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: PROVIDER_CODE.CLOSED, detail: 'provider closed' });
    }
    this.pending.clear();
    this.engine = null;
    this.child = null;
    return { ok: true };
  }

  /** @returns {object} */
  diagnostics() {
    return {
      command: this.command === '' ? null : this.command,
      args: this.args.map((arg) =>
        typeof arg === 'string' && arg.length > 120 ? `${arg.slice(0, 117)}...` : arg,
      ),
      cwd: this.cwd || null,
      pid: this.child?.pid ?? null,
      ready: this.ready,
      closed: this.closed,
      inflight: this.inflight,
      stderr_tail: this.stderr,
      stats: { ...this.stats },
    };
  }

  #spawnEngine() {
    if (typeof this.factory === 'function') {
      const engine = this.factory();
      if (
        engine === null ||
        typeof engine !== 'object' ||
        typeof engine.send !== 'function' ||
        typeof engine.on !== 'function'
      ) {
        throw new TypeError('providerFactory must return {send, on, close}');
      }
      engine.on('message', (message) => this.#onEngineMessage(message));
      engine.on('error', (error) =>
        this.#fail(PROVIDER_CODE.PROTOCOL, error instanceof Error ? error.message : String(error)),
      );
      engine.on('close', () => this.#onEngineClose());
      return engine;
    }
    if (typeof this.command !== 'string' || this.command.trim() === '') {
      throw new Error('providerCommand is not configured');
    }
    const cwd = this.cwd ? resolvePath(this.cwd) : undefined;
    const child = spawn(this.command, this.args, {
      cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += chunk;
      const lines = out.split('\n');
      out = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (line.length > MAX_LINE_BYTES) {
          this.#fail(PROVIDER_CODE.BAD_LINE, `engine line is ${line.length} bytes`);
          continue;
        }
        this.#onEngineLine(line);
      }
      if (out.length > MAX_LINE_BYTES) {
        this.#fail(PROVIDER_CODE.BAD_LINE, `engine partial line is ${out.length} bytes`);
        out = '';
      }
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      this.stderr = `${this.stderr}${text}`.slice(-MAX_STDERR_BYTES);
      this.emit('stderr', text);
    });
    child.on('error', (error) => this.#fail(PROVIDER_CODE.SPAWN_FAILED, error.message));
    child.on('exit', (code, signal) => {
      this.stats.last_error = this.stats.last_error ?? {
        code: 'WEBRTC_PROVIDER_EXIT',
        detail: `code=${code} signal=${signal}`,
      };
      this.#onEngineClose();
    });
    return {
      send: (message) => {
        if (child.stdin === null || child.stdin.destroyed) throw new Error('engine stdin is closed');
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      close: () => {
        child.stdin?.end();
        setTimeout(() => {
          if (child.exitCode === null) child.kill();
        }, 2_000).unref?.();
      },
      on: (_event, _handler) => {
        // Real process output is parsed above; the factory seam emits `message` directly.
      },
    };
  }

  #onEngineMessage(message) {
    if (!isRecord(message)) {
      this.#fail(PROVIDER_CODE.PROTOCOL, 'engine emitted a non-object');
      return;
    }
    this.#onEngineObject(message);
  }

  #onEngineLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#fail(PROVIDER_CODE.BAD_LINE, error instanceof Error ? error.message : String(error));
      return;
    }
    this.#onEngineObject(message);
  }

  #onEngineObject(message) {
    this.stats.events += 1;
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.ok === true) entry.resolve({ ok: true, result: message.result ?? null });
      else
        entry.resolve({
          ok: false,
          code: message.error?.code ?? PROVIDER_CODE.PROTOCOL,
          detail: message.error?.message ?? 'engine refused',
        });
      return;
    }
    if (typeof message.event !== 'string') {
      this.#fail(PROVIDER_CODE.PROTOCOL, 'engine line has neither id nor event');
      return;
    }
    if (message.event === 'ready') {
      this.emit('ready', message);
      return;
    }
    if (message.event === 'error') {
      this.#fail(message.code ?? PROVIDER_CODE.PROTOCOL, message.message ?? 'engine error');
      return;
    }
    if (message.event === 'data') {
      if (typeof message.data !== 'string') {
        this.#fail(PROVIDER_CODE.PROTOCOL, 'data event without base64 data');
        return;
      }
      try {
        this.emit('data', Buffer.from(message.data, 'base64'));
      } catch (error) {
        this.#fail(PROVIDER_CODE.PROTOCOL, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    this.emit(message.event, message);
  }

  #onEngineClose() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: PROVIDER_CODE.CLOSED, detail: 'engine exited' });
    }
    this.pending.clear();
    this.emit('close', this.stats.last_error?.detail ?? 'engine closed');
  }

  #fail(code, detail) {
    this.stats.last_error = { code, detail };
    this.emit('error', this.stats.last_error);
  }
}
