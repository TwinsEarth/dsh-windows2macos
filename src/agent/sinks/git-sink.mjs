/**
 * Git sink (S4/D3): artifacts land in a user-run git worktree and are committed there.
 *
 * The sink never carries plaintext: callers hand it the sealed object bytes. Writes are
 * object-id-addressed (`<object_id>.json`), hash-verified on the way in and out, and committed so
 * the same directory can be synced by the operator's own git remote (no relay data plane).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const OBJECT_ID = /^[0-9a-f]{32,64}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * @param {{root: string, run?: Function, commitPrefix?: string, remote?: string|null, branch?: string|null}} input
 */
export function createGitSink({ root, run = null, commitPrefix = 'w2m artifact', remote = null, branch = null }) {
  if (typeof root !== 'string' || root === '') throw new Error('SINK_ROOT_REQUIRED');
  if (!existsSync(join(root, '.git'))) throw new Error('GIT_SINK_NOT_A_REPO');
  mkdirSync(root, { recursive: true });
  const git = (args) => (run === null ? execFileSync('git', args, { cwd: root, stdio: 'pipe' }) : run(args));
  const pathOf = (objectId) => join(root, objectId + '.json');

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
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    try {
      git(['add', '--', objectId + '.json']);
      git(['commit', '-m', commitPrefix + ' ' + objectId, '--', objectId + '.json']);
      if (remote !== null && branch !== null) git(['push', remote, 'HEAD:' + branch]);
    } catch (error) {
      return { ok: false, code: 'GIT_SINK_COMMIT_FAILED', detail: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, objectId, path, rel_path: objectId + '.json', sha256: actual, bytes: bytes.length };
  }

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
    kind: 'lan-git',
    writeObject,
    readObject,
    async listObjects() {
      return readdirSync(root).filter((name) => name.endsWith('.json') && OBJECT_ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
    },
    async removeObject(objectId) {
      if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) return { ok: false, code: 'OBJECT_ID_INVALID' };
      try {
        unlinkSync(pathOf(objectId));
        git(['rm', '--cached', '--ignore-unmatch', '--', objectId + '.json']);
        git(['commit', '-m', commitPrefix + ' remove ' + objectId, '--', objectId + '.json']);
        return { ok: true };
      } catch { return { ok: false, code: 'OBJECT_NOT_FOUND' }; }
    },
  };
}
