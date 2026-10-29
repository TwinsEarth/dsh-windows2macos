/**
 * ArtifactRef v2 + 本地引用登记（C2 的基础形状）与解析阶梯（C3 的本地分支）。
 *
 * 控制面只承载元数据：object_id / task / machine / kind / sink / 大小 / 块数 / 根哈希 / TTL。
 * 字节永远在本机对象库或用户 sink 里。resolver 不回落 relay：本地没有就明确
 * TRANSFER_UNREACHABLE（远端 P2P 拉取是下一阶段接线）。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;
const OBJECT = /^[0-9a-f]{32,64}$/;

export function createRef(manifest, { ttlMs = 24 * 3600 * 1000, now = Date.now } = {}) {
  if (manifest === null || typeof manifest !== 'object') return { ok: false, code: 'XFER_MANIFEST_INVALID' };
  if (!OBJECT.test(String(manifest.object_id ?? ''))) return { ok: false, code: 'XFER_OBJECT_ID_INVALID' };
  if (!HEX64.test(String(manifest.root_sha256 ?? ''))) return { ok: false, code: 'XFER_ROOT_INVALID' };
  if (!Number.isSafeInteger(manifest.size_bytes) || !Number.isSafeInteger(manifest.chunks)) return { ok: false, code: 'XFER_MANIFEST_INVALID' };
  return {
    ok: true,
    ref: {
      v: 2,
      object_id: manifest.object_id,
      task_id: manifest.task_id ?? null,
      machine_id: manifest.machine_id ?? null,
      kind: manifest.kind ?? 'stdout',
      sink: { kind: manifest.sink?.kind ?? 'cache', rel_path: manifest.sink?.rel_path ?? manifest.object_id + '.bin' },
      size_bytes: manifest.size_bytes,
      chunk_bytes: manifest.chunk_bytes,
      chunks: manifest.chunks,
      root_sha256: manifest.root_sha256,
      created_at: new Date(now()).toISOString(),
      expires_at: new Date(now() + ttlMs).toISOString(),
    },
  };
}

export function verifyRef(ref, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  if (ref === null || typeof ref !== 'object' || ref.v !== 2) return { ok: false, code: 'DELIVERY_REF_INVALID' };
  if (!OBJECT.test(String(ref.object_id ?? ''))) return { ok: false, code: 'DELIVERY_REF_INVALID' };
  if (!HEX64.test(String(ref.root_sha256 ?? ''))) return { ok: false, code: 'DELIVERY_REF_INVALID' };
  if (!Number.isSafeInteger(ref.size_bytes) || !Number.isSafeInteger(ref.chunks) || ref.chunks < 0) return { ok: false, code: 'DELIVERY_REF_INVALID' };
  if (typeof ref.expires_at === 'string' && Date.parse(ref.expires_at) <= nowMs) return { ok: false, code: 'DELIVERY_STALE' };
  return { ok: true };
}

export function createRefRegistry({ root }) {
  if (typeof root !== 'string' || root === '') throw new TypeError('XFER_REF_ROOT_REQUIRED');
  const dir = join(root, 'refs');
  const fileOf = (objectId) => join(dir, objectId + '.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    publish(ref) {
      const checked = verifyRef(ref);
      if (checked.ok !== true) return checked;
      const file = fileOf(ref.object_id);
      writeFileSync(file, JSON.stringify(ref), { encoding: 'utf8', mode: 0o600 });
      return { ok: true, ref, path: file };
    },
    get(objectId) {
      try {
        const ref = JSON.parse(readFileSync(fileOf(objectId), 'utf8').replace(/^\uFEFF/, ''));
        const checked = verifyRef(ref);
        return checked.ok === true ? { ok: true, ref } : checked;
      } catch {
        return { ok: false, code: 'DELIVERY_REF_NOT_FOUND' };
      }
    },
    list() {
      const refs = [];
      let names = [];
      try { names = readdirSync(dir); } catch { return { ok: true, refs }; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try { const ref = JSON.parse(readFileSync(join(dir, name), 'utf8')); if (verifyRef(ref).ok === true) refs.push(ref); } catch { /* skip corrupt */ }
      }
      return { ok: true, refs };
    },
  };
}

/**
 * 本地解析：对象已完整且根哈希匹配 → 返回路径；否则显式失败（不回落 relay）。
 * 远端 P2P 拉取（C3 的 xfer 分支）在下一阶段接入，这里保留明确的失败语义。
 */
export function resolveLocal(ref, { store }) {
  const checked = verifyRef(ref);
  if (checked.ok !== true) return checked;
  const local = store.has(ref.object_id);
  if (local.ok !== true) return { ok: false, code: 'TRANSFER_UNREACHABLE', detail: { object_id: ref.object_id, reason: 'not in local object store; remote P2P fetch not wired yet' } };
  if (local.complete !== true) return { ok: false, code: 'TRANSFER_INCOMPLETE', detail: { object_id: ref.object_id } };
  const manifestPath = join(store.root, ref.object_id + '.ref.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.root_sha256 !== ref.root_sha256) return { ok: false, code: 'DELIVERY_ROOT_MISMATCH' };
  return { ok: true, path: join(store.root, ref.object_id + '.bin'), bytes: manifest.size_bytes, object_id: ref.object_id };
}
