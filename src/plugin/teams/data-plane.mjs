/**
 * Teams data plane: artifact bytes over the shared WebRTC pool, never the relay.
 *
 * The transport policy owns the ceiling (33) and the configured attempt count. This module owns
 * the bytes: it turns one artifact into bounded JSON frames, hands every frame to
 * `transport-policy.bulk()` (which retries up to the configured count, never above 33), and writes
 * received frames into the configured artifact sink. If every attempt fails the policy returns
 * `TEAM_DATA_P2P_EXHAUSTED` plus an alert; there is deliberately no call to `sendControl()` and
 * therefore no relay fallback in this path.
 *
 * The pool is injected, not constructed here. That is what makes this the *same* pool the agent's
 * deliver/dispatch paths use: one WebRTC connection per peer pair, not one per subsystem.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { deliverArtifact, loadArtifactSink } from '../../agent/artifact-delivery.mjs';
import { deviceFilePath } from '../../agent/identity.mjs';
import { createRelayPeerKeyResolver, WebRtcTransportPool } from '../../agent/webrtc/pool.mjs';
import {
  TEAM_DATA_CHANNEL,
  TEAM_TRANSPORT_CODE,
  createTeamTransportRouter,
} from './transport-policy.mjs';

/** Stable codes for callers that branch without parsing prose. */
export const TEAMS_DATA_CODE = Object.freeze({
  POOL_REQUIRED: 'TEAM_DATA_POOL_REQUIRED',
  PEER_REQUIRED: 'TEAM_DATA_PEER_REQUIRED',
  ARTIFACT_EMPTY: 'TEAM_DATA_ARTIFACT_EMPTY',
  ARTIFACT_TOO_LARGE: 'TEAM_DATA_ARTIFACT_TOO_LARGE',
  FRAME_INVALID: 'TEAM_DATA_FRAME_INVALID',
  DIGEST_MISMATCH: 'TEAM_DATA_DIGEST_MISMATCH',
  SINK_REQUIRED: 'TEAM_DATA_SINK_REQUIRED',
  ACK_TIMEOUT: 'TEAM_DATA_ACK_TIMEOUT',
  ACK_MISMATCH: 'TEAM_DATA_ACK_MISMATCH',
  SINK_FAILED: 'TEAM_DATA_SINK_FAILED',
  EXHAUSTED: TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED,
});

/** Largest artifact one call may carry. The transport's own cap is 4 MiB per message. */
export const TEAM_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

/** Each frame stays well under the 4 MiB logical-message cap, base64 included. */
export const TEAM_ARTIFACT_CHUNK_BYTES = 192 * 1024;

/** How long a sender waits for the receiver's sink-level ACK before failing the artifact. */
export const TEAM_DATA_ACK_TIMEOUT_MS = 30_000;

/** Receiver confirms only after SHA-256 verification and a successful sink write. */
export const TEAM_DATA_ACK_TYPE = 'team.artifact.ack';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * @param {{pool: object, stateDir?: string, sink?: object|null, onAlert?: Function,
 *   onEvent?: Function, dataRetryDelayMs?: number, dataMaxAttempts?: number, sleep?: Function, now?: Function,
 *   chunkBytes?: number, ackTimeoutMs?: number}} [options]
 */
export class TeamsDataPlane {
  constructor(options = {}) {
    this.pool = options.pool ?? null;
    this.stateDir = nonEmpty(options.stateDir);
    // An explicit sink wins; otherwise the same `<stateDir>/dataplane/sink.json` the agent's
    // deliver path uses is loaded here too, so a CLI-built data plane does not silently keep
    // received artifacts locally when the operator configured dir/lan-git/ssh.
    this.sink =
      options.sink === undefined
        ? this.stateDir === null
          ? null
          : loadArtifactSink(this.stateDir)
        : options.sink;
    this.onAlert = typeof options.onAlert === 'function' ? options.onAlert : null;
    this.eventHandlers = new Set();
    if (typeof options.onEvent === 'function') this.eventHandlers.add(options.onEvent);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.chunkBytes =
      Number.isInteger(options.chunkBytes) && options.chunkBytes >= 1024
        ? Math.min(options.chunkBytes, 1024 * 1024)
        : TEAM_ARTIFACT_CHUNK_BYTES;
    this.pending = new Map();
    this.acks = new Map();
    this.ackTimeoutMs =
      Number.isInteger(options.ackTimeoutMs) && options.ackTimeoutMs >= 0
        ? options.ackTimeoutMs
        : TEAM_DATA_ACK_TIMEOUT_MS;
    this.alerts = [];
    this.stats = {
      artifacts_sent: 0,
      chunks_sent: 0,
      attempts: 0,
      artifacts_received: 0,
      acks_sent: 0,
      acks_received: 0,
      ack_failures: 0,
    };

    this.router = createTeamTransportRouter({
      policy: {
        dataRetryDelayMs: options.dataRetryDelayMs ?? 1000,
        ...(Number.isInteger(options.dataMaxAttempts) ? { dataMaxAttempts: options.dataMaxAttempts } : {}),
      },
      ...(typeof options.sleep === 'function' ? { sleep: options.sleep } : {}),
      now: this.now,
      sendBulk: (payload) => this._sendFrame(payload),
      onAlert: (notice) => this._raiseAlert(notice),
    });

    if (this.pool !== null && typeof this.pool.onMessage === 'function') {
      this.unsubscribe = this.pool.onMessage((event) => this._onFrame(event));
    } else {
      this.unsubscribe = () => {};
    }
  }

  /** The policy object as it will be enforced, for a status tool or a test. */
  policy() {
    return { ...this.router.policy, channel: TEAM_DATA_CHANNEL };
  }

  status() {
    return {
      channel: TEAM_DATA_CHANNEL,
      transport: 'webrtc-v1',
      max_attempts: this.router.policy.data_max_attempts,
      available: this.pool !== null,
      pool: typeof this.pool?.diagnostics === 'function' ? this.pool.diagnostics() : null,
      stats: { ...this.stats },
      alerts: this.alerts.length,
      last_alert: this.alerts.length > 0 ? this.alerts[this.alerts.length - 1] : null,
    };
  }

  onEvent(handler) {
    if (typeof handler !== 'function') return () => {};
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  _emit(event) {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        /* an observer must not break the transfer */
      }
    }
  }

  _raiseAlert(notice) {
    this.alerts.push(notice);
    if (this.stateDir !== null) {
      try {
        const dir = join(this.stateDir, 'teams');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, 'data-plane-alerts.jsonl'), JSON.stringify(notice) + '\n', {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        /* the alert callback below is still the primary surface */
      }
    }
    if (this.onAlert !== null) {
      try {
        this.onAlert(notice);
      } catch {
        /* the policy already reports the failed transfer */
      }
    }
    this._emit({ type: 'alert', alert: notice });
  }

  async _sendFrame(payload) {
    if (this.pool === null || typeof this.pool.send !== 'function') {
      return { ok: false, code: TEAMS_DATA_CODE.POOL_REQUIRED };
    }
    try {
      return await this.pool.send(payload.peer, payload);
    } catch (error) {
      return {
        ok: false,
        code: 'TEAM_DATA_WEBRTC_SEND_THREW',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Wait for one receiver ACK. Returns before the first chunk is sent; the receiver may ACK as
   * soon as its sink write completes.
   *
   * `ackTimeoutMs: 0` disables the wait for unit tests and offline tools. Production callers keep
   * the default so `ok: true` means the receiver landed the bytes, not merely that they left here.
   *
   * @param {string} transferId
   * @param {string} expectedDigest
   * @returns {{promise: Promise<object>, cancel: Function}}
   */
  _waitForAck(transferId, expectedDigest) {
    if (this.ackTimeoutMs === 0) {
      return { promise: Promise.resolve({ ok: true, skipped: true }), cancel: () => {} };
    }
    let timer = null;
    let settle = null;
    const promise = new Promise((resolve) => {
      settle = (result) => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        this.acks.delete(transferId);
        resolve(result);
      };
      timer = setTimeout(() => {
        settle({ ok: false, code: TEAMS_DATA_CODE.ACK_TIMEOUT, transfer_id: transferId });
      }, this.ackTimeoutMs);
      this.acks.set(transferId, { expectedDigest, settle });
    });
    return {
      promise,
      cancel: () => settle?.({ ok: false, code: 'TEAM_DATA_ACK_CANCELLED', transfer_id: transferId }),
    };
  }

  /**
   * Send one artifact over WebRTC. Each frame goes through the policy's 33-attempt loop.
   *
   * @param {{peer: string, bytes: Buffer|string, taskId?: string, kind?: string, name?: string|null}} input
   * @returns {Promise<object>}
   */
  async sendArtifact(input = {}) {
    const peer = nonEmpty(input.peer);
    if (peer === null) return { ok: false, code: TEAMS_DATA_CODE.PEER_REQUIRED };
    if (this.pool === null) return { ok: false, code: TEAMS_DATA_CODE.POOL_REQUIRED };
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(String(input.bytes ?? ''), 'utf8');
    if (bytes.length === 0) return { ok: false, code: TEAMS_DATA_CODE.ARTIFACT_EMPTY };
    if (bytes.length > TEAM_ARTIFACT_MAX_BYTES) {
      return {
        ok: false,
        code: TEAMS_DATA_CODE.ARTIFACT_TOO_LARGE,
        detail: { bytes: bytes.length, max: TEAM_ARTIFACT_MAX_BYTES },
      };
    }
    const digest = sha256(bytes);
    const transferId = sha256(Buffer.from(`${peer}\u0000${digest}\u0000${this.now()}\u0000${Math.random()}`, 'utf8')).slice(0, 32);
    const taskId = nonEmpty(input.taskId) ?? 'unknown-task';
    const kind = nonEmpty(input.kind) ?? 'artifact';
    const name = nonEmpty(input.name);
    const total = Math.ceil(bytes.length / this.chunkBytes);
    let attempts = 0;
    // Register the waiter before the first chunk: a fast receiver can ACK before the last send
    // resolves, and a late registration would lose that ACK.
    const ackWaiter = this._waitForAck(transferId, digest);
    for (let seq = 0; seq < total; seq += 1) {
      const start = seq * this.chunkBytes;
      const chunk = bytes.subarray(start, Math.min(bytes.length, start + this.chunkBytes));
      const frame = {
        type: 'team.artifact.chunk',
        peer,
        transfer_id: transferId,
        task_id: taskId,
        kind,
        name,
        sha256: digest,
        seq,
        total,
        bytes: chunk.length,
        data: chunk.toString('base64'),
      };
      const result = await this.router.bulk({ ...frame, kind: 'artifact', bytes: chunk.length });
      attempts += result.attempts ?? 0;
      this.stats.attempts += result.attempts ?? 0;
      if (result.ok !== true) {
        ackWaiter.cancel();
        return {
          ok: false,
          code: result.code ?? TEAMS_DATA_CODE.EXHAUSTED,
          transport: 'webrtc-v1',
          channel: TEAM_DATA_CHANNEL,
          peer,
          task_id: taskId,
          name,
          sha256: digest,
          bytes: bytes.length,
          chunks: total,
          failed_seq: seq,
          attempts,
          alert: result.alert ?? null,
        };
      }
      this.stats.chunks_sent += 1;
    }
    const ack = await ackWaiter.promise;
    if (ack.ok !== true) {
      const alert = {
        code: ack.code ?? TEAMS_DATA_CODE.ACK_TIMEOUT,
        channel: TEAM_DATA_CHANNEL,
        peer,
        task_id: taskId,
        transfer_id: transferId,
        sha256: digest,
        attempts,
        relay_used: false,
      };
      this.stats.ack_failures += 1;
      this._raiseAlert(alert);
      return {
        ok: false,
        code: alert.code,
        transport: 'webrtc-v1',
        channel: TEAM_DATA_CHANNEL,
        peer,
        task_id: taskId,
        name,
        sha256: digest,
        bytes: bytes.length,
        chunks: total,
        attempts,
        ack: { ok: false, code: alert.code, transfer_id: transferId },
        alert,
      };
    }
    this.stats.artifacts_sent += 1;
    return {
      ok: true,
      transport: 'webrtc-v1',
      channel: TEAM_DATA_CHANNEL,
      peer,
      task_id: taskId,
      kind,
      name,
      sha256: digest,
      bytes: bytes.length,
      chunks: total,
      attempts,
      ack: { ok: true, transfer_id: transferId, sha256: digest, bytes: bytes.length },
    };
  }

  _onFrame(event) {
    const payload = event?.payload;
    let frame = payload;
    if (Buffer.isBuffer(payload)) {
      try {
        frame = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
    } else if (typeof payload === 'string') {
      try {
        frame = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!isRecord(frame)) return;
    if (frame.type === TEAM_DATA_ACK_TYPE) {
      if (typeof frame.transfer_id !== 'string') return;
      const waiter = this.acks.get(frame.transfer_id);
      if (waiter === undefined) return;
      this.stats.acks_received += 1;
      const digestMatches = frame.sha256 === waiter.expectedDigest;
      const ok = frame.ok === true && digestMatches;
      waiter.settle({
        ok,
        code: ok
          ? null
          : digestMatches
            ? (nonEmpty(frame.code) ?? TEAMS_DATA_CODE.SINK_FAILED)
            : TEAMS_DATA_CODE.ACK_MISMATCH,
        transfer_id: frame.transfer_id,
        sha256: typeof frame.sha256 === 'string' ? frame.sha256 : null,
        bytes: Number.isInteger(frame.bytes) ? frame.bytes : null,
      });
      this._emit({
        type: 'artifact-ack',
        peer: event?.peer ?? null,
        transfer_id: frame.transfer_id,
        ok,
        sha256: typeof frame.sha256 === 'string' ? frame.sha256 : null,
      });
      return;
    }
    if (frame.type !== 'team.artifact.chunk') return;
    if (
      typeof frame.transfer_id !== 'string' ||
      typeof frame.sha256 !== 'string' ||
      typeof frame.data !== 'string' ||
      !Number.isInteger(frame.seq) ||
      !Number.isInteger(frame.total) ||
      frame.seq < 0 ||
      frame.total < 1 ||
      frame.seq >= frame.total
    ) {
      this._emit({ type: 'invalid-frame', peer: event?.peer ?? null });
      return;
    }
    const key = frame.transfer_id;
    let entry = this.pending.get(key);
    if (entry === undefined) {
      entry = {
        transfer_id: frame.transfer_id,
        digest: frame.sha256,
        task_id: nonEmpty(frame.task_id) ?? 'unknown-task',
        kind: nonEmpty(frame.kind) ?? 'artifact',
        name: nonEmpty(frame.name),
        total: frame.total,
        chunks: new Map(),
        peer: typeof event?.peer === 'string' ? event.peer : null,
      };
      this.pending.set(key, entry);
    }
    if (entry.digest !== frame.sha256 || entry.total !== frame.total) {
      this.pending.delete(key);
      this._emit({ type: 'invalid-frame', peer: entry.peer, code: TEAMS_DATA_CODE.FRAME_INVALID });
      return;
    }
    if (entry.chunks.has(frame.seq)) return;
    entry.chunks.set(frame.seq, Buffer.from(frame.data, 'base64'));
    if (entry.chunks.size < entry.total) return;
    this.pending.delete(key);
    void this._completeArtifact(entry);
  }

  async _completeArtifact(entry) {
    const parts = [];
    for (let seq = 0; seq < entry.total; seq += 1) {
      const part = entry.chunks.get(seq);
      if (part === undefined) {
        this._emit({ type: 'artifact-incomplete', peer: entry.peer, missing: seq });
        return;
      }
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    const digest = sha256(bytes);
    if (digest !== entry.digest) {
      this._emit({ type: 'digest-mismatch', peer: entry.peer, expected: entry.digest, actual: digest });
      await this._sendAck(entry, digest, bytes.length, false, TEAMS_DATA_CODE.DIGEST_MISMATCH);
      return;
    }
    if (this.sink === null && this.stateDir === null) {
      this._emit({ type: 'artifact-no-sink', peer: entry.peer, sha256: digest });
      await this._sendAck(entry, digest, bytes.length, false, TEAMS_DATA_CODE.SINK_REQUIRED);
      return;
    }
    const delivered = await deliverArtifact({
      stateDir: this.stateDir ?? '',
      sink: this.sink,
      bytes,
      taskId: entry.task_id,
      machineId: entry.peer ?? 'unknown-machine',
      kind: entry.kind,
      name: entry.name,
    });
    this.stats.artifacts_received += 1;
    this._emit({
      type: delivered.ok === true ? 'artifact-received' : 'artifact-not-delivered',
      peer: entry.peer,
      sha256: digest,
      bytes: bytes.length,
      delivered,
    });
    // The ACK is the sender's only proof that the bytes passed SHA-256 and reached a sink. Send it
    // after deliverArtifact resolves, never before.
    await this._sendAck(
      entry,
      digest,
      bytes.length,
      delivered.ok === true,
      delivered.ok === true ? null : TEAMS_DATA_CODE.SINK_FAILED,
    );
  }

  async _sendAck(entry, sha256Hex, bytes, ok, code) {
    if (entry.peer === null || typeof this.pool?.send !== 'function') return;
    try {
      const result = await this.pool.send(entry.peer, {
        type: TEAM_DATA_ACK_TYPE,
        transfer_id: entry.transfer_id,
        task_id: entry.task_id,
        sha256: sha256Hex,
        bytes,
        ok,
        code: code ?? null,
      });
      if (result?.ok === true) {
        this.stats.acks_sent += 1;
        this._emit({
          type: 'artifact-ack-sent',
          peer: entry.peer,
          transfer_id: entry.transfer_id,
          ok,
          code: code ?? null,
        });
      } else {
        this._emit({
          type: 'artifact-ack-send-failed',
          peer: entry.peer,
          transfer_id: entry.transfer_id,
          code: result?.code ?? 'WEBRTC_SEND_FAILED',
        });
      }
    } catch (error) {
      this._emit({
        type: 'artifact-ack-send-failed',
        peer: entry.peer,
        transfer_id: entry.transfer_id,
        code: 'TEAM_DATA_ACK_SEND_THREW',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  close() {
    this.unsubscribe();
    this.pending.clear();
    for (const waiter of this.acks.values()) {
      waiter.settle({ ok: false, code: 'TEAM_DATA_ACK_CANCELLED' });
    }
    this.acks.clear();
  }
}

/**
 * Build a data plane over an existing pool. Kept separate from the class so a caller can mount it
 * without importing the class in a test.
 *
 * @param {object} options
 * @returns {TeamsDataPlane}
 */
export function createTeamsDataPlane(options = {}) {
  return new TeamsDataPlane(options);
}

/**
 * Build a data plane for a CLI (or any non-plugin caller) from the same environment the plugin
 * reads. It deliberately depends on explicit `W2M_WEBRTC_*` configuration: a CLI that silently
 * starts a second signaling role on a machine id would fight the long-running agent's pool.
 *
 * @param {{env?: object, stateDir?: string, deviceFile?: string, signalUrl?: string, signalToken?: string,
 *   providerCommand?: string, providerArgs?: string[], providerCwd?: string,
 *   dataRetryDelayMs?: number, chunkBytes?: number}} [options]
 * @returns {{ok: true, dataPlane: TeamsDataPlane, machine_id: string, pool: object}
 *          | {ok: false, code: string, detail?: any}}
 */
export function createTeamsDataPlaneFromEnv(options = {}) {
  const env = options.env ?? process.env;
  const signalUrl = nonEmpty(options.signalUrl ?? env.W2M_WEBRTC_SIGNAL_URL);
  const providerCommand = nonEmpty(options.providerCommand ?? env.W2M_WEBRTC_PROVIDER_COMMAND);
  if (signalUrl === null || providerCommand === null) {
    return {
      ok: false,
      code: 'TEAM_DATA_PLANE_NOT_CONFIGURED',
      detail: { signal_url: signalUrl !== null, provider_command: providerCommand !== null },
    };
  }
  const deviceFile = nonEmpty(options.deviceFile) ?? deviceFilePath({ env });
  const providerArgs = Array.isArray(options.providerArgs)
    ? options.providerArgs.map(String)
    : (() => {
        const encoded = nonEmpty(env.W2M_WEBRTC_PROVIDER_ARGS);
        if (encoded === null) return [];
        try {
          const parsed = JSON.parse(encoded);
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch {
          /* fall through to whitespace splitting for a shell-style value */
        }
        return encoded.split(/\s+/).filter(Boolean);
      })();
  if (!existsSync(deviceFile)) {
    return { ok: false, code: 'TEAM_DEVICE_IDENTITY_MISSING', detail: { device_file: deviceFile } };
  }
  let identity = null;
  try {
    identity = JSON.parse(readFileSync(deviceFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      ok: false,
      code: 'TEAM_DEVICE_IDENTITY_UNREADABLE',
      detail: { device_file: deviceFile, message: error instanceof Error ? error.message : String(error) },
    };
  }
  if (typeof identity?.machine_id !== 'string' || identity.machine_id === '') {
    return { ok: false, code: 'TEAM_DEVICE_IDENTITY_INVALID', detail: { device_file: deviceFile } };
  }
  const relayUrl = nonEmpty(env.W2M_RABBIT_URL) ?? nonEmpty(identity.rabbit_url);
  const deviceToken = nonEmpty(env.W2M_DEVICE_TOKEN) ?? nonEmpty(identity.device_token);
  const getJson = async (pathname) => {
    if (relayUrl === null || deviceToken === null) {
      throw new Error('relay URL or device token is missing, so peer static_key cannot be read');
    }
    const response = await fetch(relayUrl.replace(/\/+$/, '') + pathname, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`relay answered HTTP ${response.status}`);
    return { json: await response.json().catch(() => null) };
  };
  try {
    const pool = new WebRtcTransportPool({
      machineId: identity.machine_id,
      signalUrl,
      signalToken: options.signalToken ?? env.W2M_WEBRTC_SIGNAL_TOKEN ?? '',
      resolvePeerKey: createRelayPeerKeyResolver({ getJson }),
      deviceKeyDir: dirname(deviceFile),
      allowCreateDeviceKey: false,
      providerCommand,
      providerArgs,
      providerCwd: options.providerCwd ?? env.W2M_WEBRTC_PROVIDER_CWD ?? '',
    });
    const dataPlane = new TeamsDataPlane({
      pool,
      stateDir: options.stateDir,
      dataRetryDelayMs: options.dataRetryDelayMs,
      chunkBytes: options.chunkBytes,
    });
    return { ok: true, dataPlane, machine_id: identity.machine_id, pool };
  } catch (error) {
    return {
      ok: false,
      code: 'TEAM_DATA_PLANE_BUILD_FAILED',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
