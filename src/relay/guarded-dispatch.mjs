/**
 * Commit 1 的可测试接线层：把红线守卫包在现有 handler 外层。
 * server.mjs 只需 `const handle = createGuardedDispatch({ handle: rawHandle })` 即可接入，
 * 无需把守卫散落到各路由内部。
 */
import { guardResultEnvelope, guardTaskBody } from './redline-guard.mjs';
import { blobRefusal } from './p0-projection.mjs';

const BLOB_PREFIXES = ['/v1/fleet/blob-sessions', '/v1/fleet/blobs', '/v1/fleet/blob-latest'];

function refusal(status, body) {
  return { status, body, headers: { 'cache-control': 'no-store' } };
}

/**
 * @param {{handle: Function}} options
 * @returns {Function} (request) => {status, body, headers}；request: {method, path, body}
 */
export function createGuardedDispatch({ handle }) {
  if (typeof handle !== 'function') throw new Error('HANDLE_REQUIRED');
  return function guarded(request) {
    const method = String(request?.method ?? 'GET').toUpperCase();
    const path = String(request?.path ?? '/');

    for (const prefix of BLOB_PREFIXES) {
      if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')) {
        const refusalResult = blobRefusal(method);
        return refusal(refusalResult.status, refusalResult.body);
      }
    }

    if (method === 'POST' && path === '/v1/task') {
      const guard = guardTaskBody(request?.body);
      if (guard.ok !== true) return refusal(guard.status, guard.body);
    }
    if (method === 'POST' && path === '/v1/result') {
      const guard = guardResultEnvelope(request?.body);
      if (guard.ok !== true) return refusal(guard.status, guard.body);
    }

    return handle(request);
  };
}
