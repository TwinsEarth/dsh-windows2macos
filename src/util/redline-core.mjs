/**
 * R1–R4 红线守卫（可独立测试；不接线、不影响现有功能）。
 *
 * R1 控制面只允许类型化元数据：字段白名单 + 禁止数据面字段 + 禁止大块 base64/二进制。
 * R2 数据面只允许直连通道：p2p / ssh / git，且 endpoint 不得指向 relay。
 * R3 单条控制消息 ≤ 16 KiB（原始 UTF-8 字节），拒绝而不拆包。
 * R4 审计只记元数据，并维护哈希链；记录中出现内容字段即拒绝。
 *
 * PRIVATE 设计模块：目前无生产调用方；接入 tools.mjs 时再打开 orphan/reachability 门。
 */
import { createHash } from 'node:crypto';

export const MAX_CONTROL_BYTES = 16 * 1024;
export const CONTROL_VERSION = 1;
export const CONTROL_TYPES = Object.freeze(['joint.plan', 'joint.dispatch', 'joint.merge', 'joint.verify']);
export const DATA_PLANES = Object.freeze(['p2p', 'ssh', 'git']);

/** 控制信封允许的顶层键。没有自由透传袋。 */
export const CONTROL_ALLOWED_KEYS = Object.freeze(['v', 'type', 'body']);

/** 计划/分发/合并/验证 body 的字段白名单（并集）。 */
export const BODY_ALLOWED_KEYS = Object.freeze([
  'title', 'summary', 'branch', 'base_commit', 'steps', 'merge',
  'allow_scope_overlap', 'include_offline', 'plan_sha256', 'step_ids',
  'manifest_sha256', 'executor_machine_id', 'head_commit', 'verifier_machine_id',
  'command_argv', 'command_hash', 'cwd_rel', 'timeout_ms',
  'step_id', 'step_ids', 'machine_id', 'write_scope', 'depends_on',
  'task_id', 'mode', 'approval_sha256', 'write', 'target_machines',
]);

/** 这些字段一律视为数据面内容，出现在控制消息里即拒绝（R1）。 */
export const FORBIDDEN_DATA_KEYS = Object.freeze([
  'data', 'file', 'files', 'content', 'contents', 'patch', 'patch_text', 'diff',
  'blob', 'blob_sha256', 'bytes', 'buffer', 'base64', 'tarball', 'artifact',
  'artifacts', 'stdout', 'stderr', 'script', 'env', 'token', 'secret', 'password',
]);

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_DATA_KEYS);
const BASE64_BLOCK = /(?:[A-Za-z0-9+/]{256,}={0,2})/;
const HEX_BLOCK = /(?:[0-9a-fA-F]{512,})/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function walkKeys(value, path, hits) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkKeys(entry, path + '[' + index + ']', hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const keyPath = path === '' ? key : path + '.' + key;
    if (FORBIDDEN_KEY_SET.has(key.toLowerCase())) hits.push(keyPath);
    walkKeys(child, keyPath, hits);
  }
}

function findLargeBlock(value, path, hits) {
  if (typeof value === 'string') {
    if (BASE64_BLOCK.test(value)) hits.push(path + ' (base64-like block)');
    if (HEX_BLOCK.test(value)) hits.push(path + ' (hex block)');
    if (CONTROL_CHAR.test(value)) hits.push(path + ' (control characters)');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findLargeBlock(entry, path + '[' + index + ']', hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) findLargeBlock(child, path === '' ? key : path + '.' + key, hits);
}

/**
 * 校验一条控制消息。
 * @returns {{ok: true} | {ok: false, code: string, detail: object}}
 */
export function inspectControlMessage(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, code: 'CONTROL_NOT_OBJECT', detail: {} };
  }
  const bytes = utf8Bytes(envelope);
  if (bytes > MAX_CONTROL_BYTES) {
    return { ok: false, code: 'CONTROL_TOO_LARGE', detail: { bytes, limit_bytes: MAX_CONTROL_BYTES } };
  }
  const unknown = Object.keys(envelope).filter((key) => !CONTROL_ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, code: 'FIELD_UNKNOWN', detail: { unknown, allowed: CONTROL_ALLOWED_KEYS.slice() } };
  }
  if (envelope.v !== CONTROL_VERSION) {
    return { ok: false, code: 'CONTROL_VERSION', detail: { expected: CONTROL_VERSION, got: envelope.v ?? null } };
  }
  if (!CONTROL_TYPES.includes(envelope.type)) {
    return { ok: false, code: 'CONTROL_TYPE', detail: { allowed: CONTROL_TYPES.slice(), got: envelope.type ?? null } };
  }
  const forbidden = [];
  walkKeys(envelope, '', forbidden);
  if (forbidden.length > 0) {
    return { ok: false, code: 'DATA_PLANE_FORBIDDEN', detail: { paths: forbidden.slice(0, 8) } };
  }
  if (envelope.body !== undefined) {
    if (envelope.body === null || typeof envelope.body !== 'object' || Array.isArray(envelope.body)) {
      return { ok: false, code: 'CONTROL_BODY_INVALID', detail: {} };
    }
    const bodyUnknown = Object.keys(envelope.body).filter((key) => !BODY_ALLOWED_KEYS.includes(key));
    if (bodyUnknown.length > 0) {
      return { ok: false, code: 'FIELD_UNKNOWN', detail: { unknown: bodyUnknown, allowed: BODY_ALLOWED_KEYS.slice() } };
    }
  }
  const blocks = [];
  findLargeBlock(envelope, '', blocks);
  if (blocks.length > 0) {
    return { ok: false, code: 'CONTROL_CONTENT_SUSPECT', detail: { paths: blocks.slice(0, 8) } };
  }
  return { ok: true };
}

/**
 * R2：数据面只允许直连通道，且目标不得是 relay。
 * @returns {{ok: true} | {ok: false, code: string, detail: object}}
 */
export function assertPlane({ plane, endpoint, relayBase }) {
  if (!DATA_PLANES.includes(plane)) {
    return { ok: false, code: 'PLANE_FORBIDDEN', detail: { allowed: DATA_PLANES.slice(), got: plane ?? null } };
  }
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    return { ok: false, code: 'PLANE_ENDPOINT_INVALID', detail: {} };
  }
  let target;
  try {
    target = new URL(endpoint);
  } catch {
    return { ok: false, code: 'PLANE_ENDPOINT_INVALID', detail: { endpoint } };
  }
  if (typeof relayBase === 'string' && relayBase !== '') {
    try {
      const relay = new URL(relayBase);
      if (target.host === relay.host) {
        return { ok: false, code: 'PLANE_POINTS_AT_RELAY', detail: { endpoint, relay: relay.host } };
      }
    } catch {
      return { ok: false, code: 'PLANE_ENDPOINT_INVALID', detail: { relayBase } };
    }
  }
  return { ok: true };
}

const AUDIT_FORBIDDEN_KEYS = new Set(['content', 'data', 'file', 'files', 'patch', 'stdout', 'stderr', 'diff', 'blob', 'bytes']);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * R4：只记元数据 + 哈希链。
 * @param {{now?: () => number}} [options]
 * @returns {{append: Function, records: Function, verify: Function, head: Function}}
 */
export function createAudit(options = {}) {
  const now = options.now ?? Date.now;
  const records = [];
  let prev = null;

  function append(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return { ok: false, code: 'AUDIT_EVENT_INVALID' };
    }
    const bad = Object.keys(event).filter((key) => AUDIT_FORBIDDEN_KEYS.has(key.toLowerCase()));
    if (bad.length > 0) return { ok: false, code: 'AUDIT_CONTENT_FORBIDDEN', detail: { keys: bad } };
    const body = {
      v: 1,
      seq: records.length + 1,
      at: event.at ?? new Date(now()).toISOString(),
      event: typeof event.event === 'string' && event.event !== '' ? event.event : 'joint.event',
      plan_sha256: event.plan_sha256 ?? null,
      step_id: event.step_id ?? null,
      task_id: event.task_id ?? null,
      machine_id: event.machine_id ?? null,
      outcome: event.outcome ?? null,
      reason_code: event.reason_code ?? null,
      control_bytes: Number.isInteger(event.control_bytes) ? event.control_bytes : null,
      control_sha256: typeof event.control_sha256 === 'string' ? event.control_sha256 : null,
      prev_sha256: prev,
    };
    const record_sha256 = sha256Hex(stableJson(body));
    const record = { ...body, record_sha256 };
    records.push(record);
    prev = record_sha256;
    return { ok: true, record };
  }

  function verify() {
    let expectedPrev = null;
    for (const record of records) {
      const { record_sha256: stored, ...body } = record;
      if (body.prev_sha256 !== expectedPrev) return { ok: false, code: 'AUDIT_CHAIN_BROKEN', detail: { seq: record.seq } };
      if (sha256Hex(stableJson(body)) !== stored) return { ok: false, code: 'AUDIT_ENTRY_TAMPERED', detail: { seq: record.seq } };
      expectedPrev = stored;
    }
    return { ok: true, count: records.length, head: expectedPrev };
  }

  return {
    append,
    records: () => records.map((record) => ({ ...record })),
    verify,
    head: () => prev,
  };
}
