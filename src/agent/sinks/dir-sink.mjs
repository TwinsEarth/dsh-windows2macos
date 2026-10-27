/**
 * 目录 sink（本地/局域网共享盘）：密封对象落盘、按内容哈希取回。
 * 数据面适配器的最小实现；git/ssh 适配器同契约，后续补。
 * 对象已经是 sealObject() 的密文，sink 不接触明文与密钥。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function createDirSink({ root }) {
  if (typeof root !== 'string' || root === '') throw new Error('SINK_ROOT_REQUIRED');
  mkdirSync(root, { recursive: true });
  return {
    kind: 'dir',
    async pushObject({ sealed }) {
      if (sealed === null || typeof sealed !== 'object') return { ok: false, code: 'OBJECT_INVALID' };
      const body = JSON.stringify(sealed);
      const id = createHash('sha256').update(body, 'utf8').digest('hex');
      const path = join(root, id + '.json');
      writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
      return { ok: true, objectId: id, path, bytes: Buffer.byteLength(body, 'utf8') };
    },
    async fetchObject({ objectId }) {
      if (typeof objectId !== 'string' || !/^[0-9a-f]{64}$/.test(objectId)) return { ok: false, code: 'OBJECT_ID_INVALID' };
      const path = join(root, objectId + '.json');
      if (!existsSync(path)) return { ok: false, code: 'OBJECT_NOT_FOUND' };
      return { ok: true, sealed: JSON.parse(readFileSync(path, 'utf8')), path };
    },
    async listObjects() {
      return readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''));
    },
  };
}
