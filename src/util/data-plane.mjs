/**
 * S0 — 数据面端口（DataPlaneSink）。P0 止血的地基。
 *
 * 红线（2026-10-27 冻结）：
 *  · 用户数据只允许去用户自己选择的第三方（GitHub / 局域网 Git / SSH 云盘等）；
 *  · 我们的 Relay 只承载类型化元数据（指令/状态/hash/size/count/Ref ≤4KiB）；
 *  · 任何 push/fetch 目标解析后指向 relay → 一律拒绝；
 *  · 无 sink 时统一返回 ARTIFACT_NOT_DELIVERED，绝不回退 relay。
 *
 * 本模块无 I/O：只做 Ref 校验、sink 目标判定与端口分发。真实适配器（git/ssh/dir）
 * 与 NullSink 由调用方注入，这样单测不碰网络与磁盘。
 */

export const REF_MAX_BYTES = 4096;
export const REF_FIELDS = Object.freeze([
  'v', 'sink', 'locator', 'kind', 'task_id', 'machine_id',
  'plain', 'cipher', 'enc', 'zip', 'sig',
]);
export const REF_KINDS = Object.freeze(['stdout', 'stderr', 'patch', 'memory', 'artifact', 'reduce-input']);
export const SINK_KINDS = Object.freeze(['github', 'lan-git', 'ssh', 'dir']);
export const REF_HEX = /^[0-9a-f]{64}$/;

const DATA_FIELDS = new Set([
  'data', 'content', 'contents', 'patch', 'patch_text', 'stdout', 'stderr',
  'text', 'blob', 'base64', 'body', 'raw',
]);

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function parseHost(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;
  const scpLike = /^[^@\s]+@([^:\s]+):/.exec(endpoint.trim());
  if (scpLike !== null) return { host: scpLike[1].toLowerCase(), port: '', href: endpoint, scheme: 'ssh' };
  try {
    const url = new URL(endpoint);
    return { host: url.hostname.toLowerCase(), port: url.port, href: url.href, scheme: url.protocol.replace(':', '') };
  } catch {
    return null;
  }
}

function isPrivateOrLocal(host) {
  return /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === 'localhost'
    || host.endsWith('.local')
    || /^\[fd[0-9a-f]{2}:/i.test(host)
    || /^\[fe80:/i.test(host);
}

/**
 * 判断一个数据面目标是否获准（只做字符串/URL 级判定；DNS 解析后校验由适配器负责）。
 * @returns {{ok: true, sink: string} | {ok: false, code: string, detail: object}}
 */
export function assertDataPlaneTarget({ endpoint, relayBase }) {
  const target = parseHost(endpoint);
  if (target === null) return { ok: false, code: 'DATA_PLANE_ENDPOINT_INVALID', detail: {} };
  if (typeof relayBase === 'string' && relayBase !== '') {
    const relay = parseHost(relayBase);
    if (relay !== null && target.host === relay.host) {
      return { ok: false, code: 'DATA_PLANE_POINTS_AT_RELAY', detail: { endpoint, relay: relay.host } };
    }
  }
  if (target.host === 'github.com' || target.host.endsWith('.github.com')) {
    return { ok: true, sink: 'github' };
  }
  if (target.scheme === 'ssh' || target.scheme === 'git') {
    return { ok: true, sink: isPrivateOrLocal(target.host) ? 'lan-git' : 'ssh' };
  }
  if (target.scheme === 'http' || target.scheme === 'https') {
    if (isPrivateOrLocal(target.host)) return { ok: true, sink: 'lan-git' };
    return { ok: false, code: 'DATA_PLANE_SCHEME_FORBIDDEN', detail: { scheme: target.scheme, host: target.host } };
  }
  return { ok: false, code: 'DATA_PLANE_SCHEME_FORBIDDEN', detail: { scheme: target.scheme } };
}

function scanForContent(value, path, hits) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForContent(entry, path + '[' + index + ']', hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const keyPath = path === '' ? key : path + '.' + key;
    if (DATA_FIELDS.has(key.toLowerCase())) hits.push(keyPath);
    scanForContent(child, keyPath, hits);
  }
}

/**
 * 校验进入控制面的 Ref：纯元数据、≤4KiB、无内容字段、哈希形状正确。
 * @returns {{ok: true} | {ok: false, code: string, detail: object}}
 */
export function inspectRef(ref) {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
    return { ok: false, code: 'REF_NOT_OBJECT', detail: {} };
  }
  const bytes = utf8Bytes(ref);
  if (bytes > REF_MAX_BYTES) {
    return { ok: false, code: 'REF_TOO_LARGE', detail: { bytes, limit_bytes: REF_MAX_BYTES } };
  }
  const hits = [];
  scanForContent(ref, '', hits);
  if (hits.length > 0) return { ok: false, code: 'DATA_PLANE_FORBIDDEN', detail: { paths: hits.slice(0, 8) } };
  const unknown = Object.keys(ref).filter((key) => !REF_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, code: 'REF_FIELD_UNKNOWN', detail: { unknown, allowed: REF_FIELDS.slice() } };
  }
  if (ref.v !== 1) return { ok: false, code: 'REF_VERSION', detail: { expected: 1, got: ref.v ?? null } };
  if (!SINK_KINDS.includes(ref.sink)) {
    return { ok: false, code: 'REF_SINK_UNKNOWN', detail: { allowed: SINK_KINDS.slice(), got: ref.sink ?? null } };
  }
  if (!REF_KINDS.includes(ref.kind)) {
    return { ok: false, code: 'REF_KIND_UNKNOWN', detail: { allowed: REF_KINDS.slice(), got: ref.kind ?? null } };
  }
  if (typeof ref.locator !== 'string' || ref.locator.trim() === '' || ref.locator.length > 512) {
    return { ok: false, code: 'REF_LOCATOR_INVALID', detail: {} };
  }
  if (ref.plain !== undefined) {
    if (typeof ref.plain !== 'object' || !REF_HEX.test(String(ref.plain.sha256 ?? ''))) {
      return { ok: false, code: 'REF_PLAIN_INVALID', detail: {} };
    }
  }
  if (ref.cipher !== undefined) {
    if (typeof ref.cipher !== 'object' || !REF_HEX.test(String(ref.cipher.sha256 ?? ''))) {
      return { ok: false, code: 'REF_CIPHER_INVALID', detail: {} };
    }
  }
  return { ok: true };
}

/**
 * NullSink：永不上传，统一降级码。用于"无数据面"的合规默认值。
 */
export function createNullSink() {
  return {
    kind: 'null',
    async pushObject() {
      return { ok: false, code: 'ARTIFACT_NOT_DELIVERED', detail: { reason: 'no data plane sink configured' } };
    },
    async fetchObject() {
      return { ok: false, code: 'ARTIFACT_NOT_DELIVERED', detail: { reason: 'no data plane sink configured' } };
    },
  };
}

/**
 * 端口分发：调用方注入 sinks（github/lan-git/ssh/dir），未命中一律 NullSink。
 * @param {{sinks?: Record<string, object>, relayBase?: string}} [options]
 */
export function createDataPlane(options = {}) {
  const sinks = options.sinks ?? {};
  const relayBase = options.relayBase ?? '';
  function pick(endpoint) {
    const target = assertDataPlaneTarget({ endpoint, relayBase });
    if (target.ok !== true) return { ok: false, result: target };
    const sink = sinks[target.sink];
    if (sink === undefined) return { ok: true, sink: createNullSink() };
    return { ok: true, sink };
  }
  return {
    async pushObject({ endpoint, ref, ...rest }) {
      const refCheck = inspectRef(ref);
      if (refCheck.ok !== true) return refCheck;
      const chosen = pick(endpoint);
      if (chosen.ok !== true) return chosen.result;
      return chosen.sink.pushObject({ ref, ...rest });
    },
    async fetchObject({ endpoint, ref, ...rest }) {
      const refCheck = inspectRef(ref);
      if (refCheck.ok !== true) return refCheck;
      const chosen = pick(endpoint);
      if (chosen.ok !== true) return chosen.result;
      return chosen.sink.fetchObject({ ref, ...rest });
    },
  };
}
