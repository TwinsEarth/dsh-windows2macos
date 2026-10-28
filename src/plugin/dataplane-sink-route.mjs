/**
 * `/api/w2m/dataplane-sink` (A3): the settings-page half of the S4 data-plane authorization.
 *
 *   GET  -> { ok, configured, kind, root|host/user/dir, saved_at }
 *   POST -> { ok, configured: true, kind, ... } and writes <stateDir>/dataplane/sink.json (0600)
 *
 * Authorization is a LOCAL USER action through this host route. Model/tool parameters can never
 * authorize a sink: the tool schemas do not expose this path, and this route does not accept an
 * operator/device token as the authority (the host's same-origin fence is the boundary).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DATAPLANE_SINK_ROUTE_PATH = '/api/w2m/dataplane-sink';
const NO_STORE = { 'cache-control': 'no-store' };
const KINDS = new Set(['dir', 'lan-git', 'ssh']);
const CREDENTIAL_KEYS = /^(?:password|passphrase|key|private_key|token|secret|credential|identity)$/i;

function configPath(stateDir) {
  return join(stateDir, 'dataplane', 'sink.json');
}

function readConfig(stateDir) {
  const file = configPath(stateDir);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function insideStateDir(stateDir, target) {
  const rel = relative(stateDir, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Strip anything that looks like a secret; the file only holds references, never credentials. */
function publicView(config) {
  if (config === null) return { configured: false, kind: null };
  if (config.kind === 'ssh') return { configured: true, kind: config.kind, host: config.host ?? null, user: config.user ?? null, dir: config.dir ?? null, port: config.port ?? null, saved_at: config.saved_at ?? null };
  return { configured: true, kind: config.kind, root: config.root ?? null, remote: config.remote ?? null, branch: config.branch ?? null, saved_at: config.saved_at ?? null };
}

/**
 * @param {object} ctx Cordis context
 * @param {{stateDir?: () => string|null}} [deps]
 */
export function registerDataplaneSinkRoute(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const stateDirOf = () => (typeof deps?.stateDir === 'function' ? deps.stateDir() : null);
    registry.register({
      path: DATAPLANE_SINK_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const stateDir = stateDirOf();
        if (typeof stateDir !== 'string' || stateDir === '') {
          return Response.json({ ok: false, code: 'DATAPLANE_STATE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
        }
        if (request.method === 'GET') {
          return Response.json({ ok: true, ...publicView(readConfig(stateDir)) }, { headers: NO_STORE });
        }
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        if (body === null || typeof body !== 'object') return Response.json({ ok: false, code: 'SINK_BODY_REQUIRED' }, { status: 400, headers: NO_STORE });
        for (const key of Object.keys(body)) {
          if (CREDENTIAL_KEYS.test(key)) return Response.json({ ok: false, code: 'SINK_CREDENTIALS_NOT_ACCEPTED', detail: key }, { status: 400, headers: NO_STORE });
        }
        const kind = typeof body.kind === 'string' ? body.kind : '';
        if (!KINDS.has(kind)) return Response.json({ ok: false, code: 'SINK_KIND_INVALID' }, { status: 400, headers: NO_STORE });
        const config = { v: 1, kind, saved_at: new Date().toISOString(), approved_by: 'local-user' };
        if (kind === 'ssh') {
          if (typeof body.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(body.host)) return Response.json({ ok: false, code: 'SINK_SSH_HOST_INVALID' }, { status: 400, headers: NO_STORE });
          if (typeof body.user !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.user)) return Response.json({ ok: false, code: 'SINK_SSH_USER_INVALID' }, { status: 400, headers: NO_STORE });
          if (typeof body.dir !== 'string' || !isAbsolute(body.dir)) return Response.json({ ok: false, code: 'SINK_SSH_DIR_INVALID' }, { status: 400, headers: NO_STORE });
          if (body.port !== undefined && !(Number.isInteger(body.port) && body.port >= 1 && body.port <= 65535)) return Response.json({ ok: false, code: 'SINK_SSH_PORT_INVALID' }, { status: 400, headers: NO_STORE });
          config.host = body.host;
          config.user = body.user;
          config.dir = body.dir;
          if (body.port !== undefined) config.port = body.port;
        } else {
          if (typeof body.root !== 'string' || !isAbsolute(body.root)) return Response.json({ ok: false, code: 'SINK_ROOT_INVALID' }, { status: 400, headers: NO_STORE });
          const resolved = realpathSync.native ? (() => { try { return realpathSync.native(body.root); } catch { return null; } })() : null;
          if (resolved === null) return Response.json({ ok: false, code: 'SINK_ROOT_NOT_FOUND' }, { status: 400, headers: NO_STORE });
          const stat = statSync(resolved);
          if (!stat.isDirectory()) return Response.json({ ok: false, code: 'SINK_ROOT_NOT_DIRECTORY' }, { status: 400, headers: NO_STORE });
          if (insideStateDir(stateDir, resolved)) return Response.json({ ok: false, code: 'SINK_ROOT_INSIDE_STATE' }, { status: 400, headers: NO_STORE });
          if (kind === 'lan-git' && !existsSync(join(resolved, '.git'))) return Response.json({ ok: false, code: 'SINK_GIT_NOT_A_REPO' }, { status: 400, headers: NO_STORE });
          config.root = resolved;
          if (kind === 'lan-git') {
            if (typeof body.remote === 'string' && body.remote !== '') config.remote = body.remote;
            if (typeof body.branch === 'string' && body.branch !== '') config.branch = body.branch;
          }
        }
        const file = configPath(stateDir);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
        writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, file);
        try { chmodSync(file, 0o600); } catch { /* Windows ACL */ }
        return Response.json({ ok: true, ...publicView(config) }, { headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}
