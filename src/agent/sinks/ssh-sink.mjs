/**
 * SSH sink (S4/D3): artifacts are written to a directory on a user-owned host over SSH.
 *
 * No relay data plane: the operator supplies the host and directory; every path component is
 * validated before it is embedded in the remote command, and the local side verifies the object
 * hash again after a read. The transport is delegated to the system `ssh` binary (optionally
 * injected for tests), so key handling stays with the user's existing SSH configuration.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const OBJECT_ID = /^[0-9a-f]{32,64}$/;
const HOST = /^[A-Za-z0-9._:[\]-]+$/;
const USER = /^[A-Za-z0-9._-]+$/;
const DIR = /^\/[A-Za-z0-9._/-]*$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function defaultRun(args, input) {
  const result = spawnSync('ssh', args, { input, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) return { ok: false, code: 'SSH_SPAWN_FAILED', detail: result.error.message };
  if (result.status !== 0) return { ok: false, code: 'SSH_COMMAND_FAILED', detail: String(result.stderr ?? '').slice(0, 400) };
  return { ok: true, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '') };
}

/**
 * @param {{host: string, user: string, dir: string, port?: number, keyPath?: string|null, run?: Function}} input
 */
export function createSshSink({ host, user, dir, port = null, keyPath = null, run = null }) {
  if (typeof host !== 'string' || !HOST.test(host)) throw new Error('SSH_SINK_HOST_INVALID');
  if (typeof user !== 'string' || !USER.test(user)) throw new Error('SSH_SINK_USER_INVALID');
  if (typeof dir !== 'string' || !DIR.test(dir) || dir.includes('..')) throw new Error('SSH_SINK_DIR_INVALID');
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('SSH_SINK_PORT_INVALID');
  if (keyPath !== null && (typeof keyPath !== 'string' || keyPath === '')) throw new Error('SSH_SINK_KEY_INVALID');
  const exec = run ?? defaultRun;
  const target = user + '@' + host;
  const baseArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (port !== null) baseArgs.push('-p', String(port));
  if (keyPath !== null) baseArgs.push('-i', keyPath);
  const pathOf = (objectId) => dir.replace(/\/$/, '') + '/' + objectId + '.json';
  const ssh = (remoteCommand, input = undefined) => exec([...baseArgs, '--', target, remoteCommand], input);

  async function writeObject({ objectId, body, expectSha256 = null }) {
    if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) return { ok: false, code: 'OBJECT_ID_INVALID' };
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const actual = sha256(bytes);
    if (typeof expectSha256 === 'string' && expectSha256 !== '' && expectSha256 !== actual) {
      return { ok: false, code: 'OBJECT_HASH_MISMATCH', detail: { expected: expectSha256, actual } };
    }
    const final = pathOf(objectId);
    const tmp = final + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    const written = ssh('mkdir -p ' + dir + ' && cat > ' + tmp + ' && mv ' + tmp + ' ' + final, bytes);
    if (written.ok !== true) return written;
    return { ok: true, objectId, rel_path: objectId + '.json', remote_path: final, sha256: actual, bytes: bytes.length };
  }

  async function readObject({ objectId, expectSha256 = null }) {
    if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) return { ok: false, code: 'OBJECT_ID_INVALID' };
    const read = ssh('cat ' + pathOf(objectId));
    if (read.ok !== true) return read;
    const bytes = read.stdout;
    const actual = sha256(bytes);
    if (typeof expectSha256 === 'string' && expectSha256 !== '' && expectSha256 !== actual) {
      return { ok: false, code: 'OBJECT_HASH_MISMATCH', detail: { expected: expectSha256, actual } };
    }
    return { ok: true, objectId, sha256: actual, bytes };
  }

  return {
    kind: 'ssh',
    writeObject,
    readObject,
    async listObjects() {
      const listed = ssh('ls -1 ' + dir);
      if (listed.ok !== true) return [];
      return listed.stdout.toString('utf8').split('\n').map((name) => name.trim()).filter((name) => name.endsWith('.json') && OBJECT_ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
    },
    async removeObject(objectId) {
      if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) return { ok: false, code: 'OBJECT_ID_INVALID' };
      const removed = ssh('rm -f ' + pathOf(objectId));
      return removed.ok === true ? { ok: true } : removed;
    },
  };
}
