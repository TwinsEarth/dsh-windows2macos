/**
 * Chunked blob session tests (M6, v1.3.10-beta.19 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBlobSessions, CHUNK_LIMITS } from '../src/relay/blob-sessions.mjs';

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');
const payload = Buffer.from('the quick brown fox jumps over the lazy dog '.repeat(500), 'utf8');
const PAYLOAD_SHA = sha256Hex(payload);

function setup(overrides = {}) {
  let t = Date.parse('2026-10-22T00:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; return t; } };
  const committed = [];
  const sessions = createBlobSessions({ now: clock.now, onCommit: (blob) => committed.push(blob), ...overrides });
  return { sessions, clock, committed };
}

const open = (sessions, overrides = {}) => sessions.create({ machineId: 'm-1', sha256: PAYLOAD_SHA, size: payload.length, chunkBytes: 1024, ...overrides });

describe('blob sessions', () => {
  it('declares a session with the chunk plan and no chunks yet', () => {
    const { sessions } = setup();
    const created = open(sessions);
    assert.equal(created.ok, true);
    assert.equal(created.session.chunks, Math.ceil(payload.length / 1024));
    assert.deepEqual(created.session.received, []);
    assert.equal(created.session.missing.length, created.session.chunks);
  });

  it('accepts chunks out of order, is idempotent per index, and reports what is missing', () => {
    const { sessions } = setup();
    const session = open(sessions).session;
    const last = session.chunks - 1;
    const first = payload.subarray(0, 1024);
    const tail = payload.subarray(last * 1024);
    sessions.putChunk({ sessionId: session.session_id, index: last, data: tail });
    sessions.putChunk({ sessionId: session.session_id, index: 0, data: first });
    sessions.putChunk({ sessionId: session.session_id, index: 0, data: first });
    const status = sessions.status({ sessionId: session.session_id });
    assert.deepEqual(status.received, [0, last]);
    assert.equal(status.missing.length, session.chunks - 2);
  });

  it('commits a fully uploaded blob and calls the store hook with the verified bytes', () => {
    const { sessions, committed } = setup();
    const session = open(sessions).session;
    for (let index = 0; index < session.chunks; index += 1) {
      const start = index * 1024;
      sessions.putChunk({ sessionId: session.session_id, index, data: payload.subarray(start, Math.min(start + 1024, payload.length)) });
    }
    const committedResult = sessions.commit({ sessionId: session.session_id });
    assert.equal(committedResult.ok, true);
    assert.equal(committedResult.sha256, PAYLOAD_SHA);
    assert.equal(committedResult.bytes, payload.length);
    assert.equal(committed.length, 1);
    assert.equal(committed[0].bytes.toString('utf8'), payload.toString('utf8'));
    assert.equal(sessions.size().open_sessions, 0);
  });

  it('refuses to commit with chunks missing, naming them', () => {
    const { sessions } = setup();
    const session = open(sessions).session;
    sessions.putChunk({ sessionId: session.session_id, index: 0, data: payload.subarray(0, 1024) });
    const result = sessions.commit({ sessionId: session.session_id });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BLOB_INCOMPLETE');
    assert.ok(result.missing.length === session.chunks - 1);
  });

  it('deletes the session when the assembled bytes do not hash to the declared sha', () => {
    const { sessions } = setup();
    const wrong = Buffer.alloc(payload.length, 0x61);
    const session = sessions.create({ machineId: 'm-1', sha256: PAYLOAD_SHA, size: payload.length, chunkBytes: 1024 }).session;
    for (let index = 0; index < session.chunks; index += 1) {
      const start = index * 1024;
      sessions.putChunk({ sessionId: session.session_id, index, data: wrong.subarray(start, Math.min(start + 1024, wrong.length)) });
    }
    const result = sessions.commit({ sessionId: session.session_id });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BLOB_SHA_MISMATCH');
    assert.throws(() => sessions.status({ sessionId: session.session_id }), (error) => error.code === 'SESSION_NOT_FOUND');
  });

  it('rejects a chunk longer than chunk_bytes or with the wrong length', () => {
    const { sessions } = setup();
    const session = open(sessions).session;
    assert.throws(() => sessions.putChunk({ sessionId: session.session_id, index: 0, data: Buffer.alloc(2048) }), (error) => error.code === 'CHUNK_TOO_LARGE');
    assert.throws(() => sessions.putChunk({ sessionId: session.session_id, index: 0, data: Buffer.alloc(10) }), (error) => error.code === 'INVALID_CHUNK');
  });

  it('enforces per-machine session and byte quotas', () => {
    const { sessions } = setup({ limits: { ...CHUNK_LIMITS, maxSessionsPerMachine: 1 } });
    open(sessions);
    assert.throws(() => open(sessions, { sha256: 'b'.repeat(64) }), (error) => error.code === 'BLOB_QUOTA');
    assert.equal(CHUNK_LIMITS.maxSessionsPerMachine, 2);
  });

  it('expires a session after its TTL', () => {
    const { sessions, clock } = setup();
    const session = open(sessions).session;
    clock.advance(CHUNK_LIMITS.ttlMs + 1);
    assert.throws(() => sessions.status({ sessionId: session.session_id }), (error) => error.code === 'SESSION_NOT_FOUND');
  });

  it('refuses a blob over the configured maximum or too many chunks', () => {
    const { sessions } = setup({ limits: { ...CHUNK_LIMITS, maxBlobBytes: 2048 } });
    assert.throws(() => sessions.create({ machineId: 'm-1', sha256: PAYLOAD_SHA, size: 4096 }), (error) => error.code === 'BLOB_TOO_LARGE');
    const small = setup({ limits: { ...CHUNK_LIMITS, maxChunks: 2 } });
    assert.throws(() => small.sessions.create({ machineId: 'm-1', sha256: PAYLOAD_SHA, size: payload.length, chunkBytes: 1024 }), (error) => error.code === 'CHUNK_TOO_LARGE');
  });
});
