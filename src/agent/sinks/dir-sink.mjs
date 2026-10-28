/**
 * 目录 sink（本地/局域网共享盘）：ArtifactRef v1 的对象落盘与取回。
 *
 * 对象已经是调用方封装好的密文字节，sink 不接触明文与密钥。写入是原子的
 * （tmp → fsync → rename，0600），取回时校验对象 id 形状与期望的 cipher sha256。
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const OBJECT_ID = /^[0-9a-f]{32,64}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function createDirSink({ root }) {
  if (typeof root !== 'string' || root === '') throw new Error('SINK_ROOT_REQUIRED');
  mkdirSync(root, { recursive: true });

  const pathOf = (objectId) => join(root, objectId + '.json');

  /** Write the sealed object bytes atomically under `<objectId>.json`. */
  async function writeObject({ objectId, body, expectSha256 = null }) {
    if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) return { ok: false, code: 'OBJECT_ID_INVALID' };
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const actual = sha256(bytes);
    if (typeof expectSha256 === 'string' && expectSha256 !== '' && expectSha256 !== actual) {
      return { ok: false, code: 'OBJECT_HASH_MISMATCH', detail: { expected: expectSha256, actual } };
    }
    const path = pathOf(objectId);
    const tmp = path + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    return { ok: true, objectId, path, rel_path: objectId + '.json', sha256: actual, bytes: bytes.length };
  }

  /** Read the object bytes back and verify the expected cipher sha256. */
  async function readObject({ objectId, expectSha256 = null }) {
    if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) return { ok: false, code: 'OBJECT_ID_INVALID' };
    const path = pathOf(objectId);
    if (!existsSync(path)) return { ok: false, code: 'OBJECT_NOT_FOUND' };
    let bytes;
    try { bytes = readFileSync(path); } catch { return { ok: false, code: 'OBJECT_UNREADABLE' }; }
    const actual = sha256(bytes);
    if (typeof expectSha256 === 'string' && expectSha256 !== '' && expectSha256 !== actual) {
      return { ok: false, code: 'OBJECT_HASH_MISMATCH', detail: { expected: expectSha256, actual } };
    }
    return { ok: true, objectId, path, sha256: actual, bytes };
  }

  return {
    kind: 'dir',
    writeObject,
    readObject,
    // Backwards-compatible adapters for the pre-v2 callers: the object id is derived from the body.
    async pushObject({ sealed }) {
      if (sealed === null || typeof sealed !== 'object') return { ok: false, code: 'OBJECT_INVALID' };
      const body = JSON.stringify(sealed);
      const id = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32);
      const written = await writeObject({ objectId: id, body });
      return written.ok === true ? { ok: true, objectId: id, path: written.path, bytes: written.bytes } : written;
    },
    async fetchObject({ objectId }) {
      const read = await readObject({ objectId });
      if (read.ok !== true) return read;
      try { return { ok: true, sealed: JSON.parse(read.bytes.toString('utf8')), path: read.path }; } catch { return { ok: false, code: 'OBJECT_UNREADABLE' }; }
    },
    async listObjects() {
      return readdirSync(root).filter((name) => name.endsWith('.json') && OBJECT_ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
    },
    removeObject(objectId) {
      try { unlinkSync(pathOf(objectId)); return { ok: true }; } catch { return { ok: false, code: 'OBJECT_NOT_FOUND' }; }
    },
  };
}
