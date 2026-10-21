/**
 * Chunked blob sessions (M6, v1.3.10-beta.19 slice).
 *
 * The current blob endpoint is one PUT with a frame cap: an interrupted upload loses everything, and a large patch cannot be
 * sent at all. A blob session fixes both: the client declares the final sha256 and size once, uploads chunks in any order (each
 * PUT is idempotent), asks what is missing, and commits. Only a commit whose assembled bytes hash to the declared sha256 creates
 * a blob; anything else leaves no artifact behind.
 *
 * The store is injected as a set of in-memory sessions here; the relay binds it to its blob store in the wiring slice.
 */
import { createHash } from 'node:crypto';

export const CHUNK_LIMITS = Object.freeze({
  defaultChunkBytes: 1024 * 1024,
  maxChunkBytes: 8 * 1024 * 1024,
  maxChunks: 256,
  maxBlobBytes: 64 * 1024 * 1024,
  maxSessionsPerMachine: 2,
  maxUnfinishedBytesPerMachine: 512 * 1024 * 1024,
  ttlMs: 24 * 60 * 60 * 1000,
});

export class BlobSessionError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'BlobSessionError';
    this.code = code;
    this.detail = detail;
  }
}

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function createBlobSessions({ now = () => Date.now(), limits = CHUNK_LIMITS, onCommit = null } = {}) {
  const sessions = new Map();
  let counter = 0;

  const purgeExpired = () => {
    const at = now();
    for (const session of [...sessions.values()]) if (session.expires_at_ms <= at) sessions.delete(session.session_id);
  };

  const requireSession = (sessionId) => {
    purgeExpired();
    const session = sessions.get(sessionId);
    if (session === undefined) throw new BlobSessionError('SESSION_NOT_FOUND', 'session missing or expired', { session_id: sessionId });
    return session;
  };

  const describe = (session) => {
    const received = [...session.chunks.keys()].sort((a, b) => a - b);
    const missing = [];
    for (let index = 0; index < session.chunks_total; index += 1) if (!session.chunks.has(index)) missing.push(index);
    return {
      session_id: session.session_id,
      sha256: session.sha256,
      size: session.size,
      chunk_bytes: session.chunk_bytes,
      chunks: session.chunks_total,
      received,
      missing,
      expires_at: new Date(session.expires_at_ms).toISOString(),
      completed: session.state === 'committed',
    };
  };

  return {
    create({ machineId, sha256, size, chunkBytes = limits.defaultChunkBytes }) {
      if (typeof machineId !== 'string' || machineId === '') throw new BlobSessionError('INVALID_MACHINE', 'machine_id is required');
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new BlobSessionError('INVALID_SHA', 'sha256 must be 64 lowercase hex characters');
      if (!Number.isInteger(size) || size <= 0) throw new BlobSessionError('INVALID_SIZE', 'size must be a positive integer');
      if (size > limits.maxBlobBytes) throw new BlobSessionError('BLOB_TOO_LARGE', 'blob exceeds the configured maximum', { size, max_bytes: limits.maxBlobBytes });
      if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > limits.maxChunkBytes) throw new BlobSessionError('INVALID_CHUNK_BYTES', 'chunk_bytes out of range', { chunk_bytes: chunkBytes, max: limits.maxChunkBytes });
      const chunksTotal = Math.ceil(size / chunkBytes);
      if (chunksTotal > limits.maxChunks) throw new BlobSessionError('CHUNK_TOO_LARGE', 'too many chunks for one blob', { chunks: chunksTotal, max: limits.maxChunks });
      purgeExpired();
      const mine = [...sessions.values()].filter((session) => session.machine_id === machineId);
      if (mine.length >= limits.maxSessionsPerMachine) {
        throw new BlobSessionError('BLOB_QUOTA', 'too many open sessions for this machine', { open: mine.length, max: limits.maxSessionsPerMachine });
      }
      const unfinishedBytes = mine.reduce((sum, session) => sum + session.size, 0);
      if (unfinishedBytes + size > limits.maxUnfinishedBytesPerMachine) {
        throw new BlobSessionError('BLOB_QUOTA', 'unfinished session bytes exceed the machine allowance', { unfinished_bytes: unfinishedBytes, size, max_bytes: limits.maxUnfinishedBytesPerMachine });
      }
      counter += 1;
      const session = {
        session_id: 'bs-' + String(counter).padStart(6, '0'),
        machine_id: machineId,
        sha256,
        size,
        chunk_bytes: chunkBytes,
        chunks_total: chunksTotal,
        chunks: new Map(),
        state: 'open',
        created_at: new Date(now()).toISOString(),
        expires_at_ms: now() + limits.ttlMs,
      };
      sessions.set(session.session_id, session);
      return { ok: true, session: describe(session) };
    },
    /** Upload one chunk; re-uploading an index is an overwrite, and order does not matter. */
    putChunk({ sessionId, index, data }) {
      const session = requireSession(sessionId);
      if (session.state === 'committed') throw new BlobSessionError('SESSION_COMMITTED', 'session already committed', { session_id: sessionId });
      if (!Number.isInteger(index) || index < 0 || index >= session.chunks_total) {
        throw new BlobSessionError('INVALID_CHUNK_INDEX', 'chunk index out of range', { index, chunks: session.chunks_total });
      }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
      if (buffer.length === 0) throw new BlobSessionError('INVALID_CHUNK', 'chunk is empty', { index });
      if (buffer.length > session.chunk_bytes) throw new BlobSessionError('CHUNK_TOO_LARGE', 'chunk exceeds chunk_bytes', { index, bytes: buffer.length, chunk_bytes: session.chunk_bytes });
      const isLast = index === session.chunks_total - 1;
      const expected = isLast ? session.size - session.chunk_bytes * (session.chunks_total - 1) : session.chunk_bytes;
      if (buffer.length !== expected) throw new BlobSessionError('INVALID_CHUNK', 'chunk length does not match the declared size', { index, bytes: buffer.length, expected });
      session.chunks.set(index, buffer);
      return { ok: true, session: describe(session) };
    },
    status({ sessionId }) {
      return { ok: true, session: describe(requireSession(sessionId)) };
    },
    /** Commit only if every chunk arrived and the assembled sha256 equals the declared one. */
    commit({ sessionId }) {
      const session = requireSession(sessionId);
      if (session.state === 'committed') throw new BlobSessionError('SESSION_COMMITTED', 'session already committed', { session_id: sessionId });
      const detail = describe(session);
      if (detail.missing.length > 0) {
        return { ok: false, code: 'BLOB_INCOMPLETE', missing: detail.missing, session_id: sessionId };
      }
      const ordered = [];
      for (let index = 0; index < session.chunks_total; index += 1) ordered.push(session.chunks.get(index));
      const assembled = Buffer.concat(ordered);
      if (assembled.length !== session.size) return { ok: false, code: 'BLOB_SIZE_MISMATCH', size: assembled.length, expected: session.size };
      const actual = sha256Hex(assembled);
      if (actual !== session.sha256) {
        sessions.delete(sessionId);
        return { ok: false, code: 'BLOB_SHA_MISMATCH', expected: session.sha256, actual };
      }
      session.state = 'committed';
      session.chunks.clear();
      sessions.delete(sessionId);
      if (typeof onCommit === 'function') onCommit({ machineId: session.machine_id, sha256: session.sha256, size: session.size, bytes: assembled });
      return { ok: true, sha256: session.sha256, bytes: assembled.length };
    },
    size() {
      purgeExpired();
      return { open_sessions: sessions.size };
    },
  };
}
