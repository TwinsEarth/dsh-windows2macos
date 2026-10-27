/**
 * relay 红线守卫（relay 专用；字段表唯一来源 util/redline-core）。
 * C7：深层递归扫描 + 16KiB 语义上限 + 协议错误形状（protocol_version/error.code）。
 */
import { FORBIDDEN_DATA_KEYS } from '../util/redline-core.mjs';

export const MAX_CONTROL_BYTES = 16 * 1024;
const PROTOCOL_VERSION = 1;

const MESSAGES = {
  DATA_PLANE_FORBIDDEN: 'the payload carries data-plane content; relay stores metadata only',
  CONTROL_TOO_LARGE: 'the control message exceeds the 16 KiB limit',
  BAD_REQUEST: 'the request body is not a JSON object',
};

function refuse(status, code, detail = {}) {
  return {
    status,
    body: {
      protocol_version: PROTOCOL_VERSION,
      ok: false,
      code,
      reason: code,
      detail,
      error: { code, message: MESSAGES[code] ?? code, detail },
    },
  };
}

function scan(value, path, hits) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry, path + '[' + index + ']', hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const keyPath = path === '' ? key : path + '.' + key;
    if (FORBIDDEN_DATA_KEYS.includes(key.toLowerCase())) hits.push(keyPath);
    scan(child, keyPath, hits);
  }
}

export function guardTaskBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'BAD_REQUEST');
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > MAX_CONTROL_BYTES) return refuse(413, 'CONTROL_TOO_LARGE', { bytes, limit_bytes: MAX_CONTROL_BYTES });
  const hits = [];
  scan(body, '', hits);
  if (hits.length > 0) return refuse(422, 'DATA_PLANE_FORBIDDEN', { fields: hits.filter((hit) => !hit.includes('.')), paths: hits.slice(0, 8) });
  return { ok: true };
}

export function guardResultEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return refuse(400, 'BAD_REQUEST');
  const explicit = ['stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail', 'command_argv', 'blob_sha256', 'output_mode'].filter((key) => key in envelope);
  const hits = [];
  scan(envelope, '', hits);
  if (explicit.length > 0 || hits.length > 0) return refuse(422, 'DATA_PLANE_FORBIDDEN', { fields: [...explicit, ...hits.filter((hit) => !hit.includes('.'))], paths: hits.slice(0, 8) });
  return { ok: true };
}

export function guardBlobRoute(method) {
  return {
    status: 403,
    body: {
      protocol_version: PROTOCOL_VERSION,
      ok: false,
      code: 'DATA_PLANE_REFUSED',
      error: { code: 'DATA_PLANE_REFUSED', message: 'relay never stores data-plane objects', detail: { method } },
    },
  };
}
