/**
 * `/api/w2m/chat` — the browser-facing half of fleet chat (v1.1.17 shipped the tool only; this
 * module is the missing host route the composer's chat panel calls).
 *
 * The route proxies the relay's device-gated `/v1/fleet/messages` endpoints with this machine's
 * device token. The browser never sees the token: it calls this same-origin route, which is inside
 * the host's authentication fence, exactly like `/api/w2m/target`.
 *
 * Wire:
 *   GET  /api/w2m/chat?session_id=…&since_ms=…&limit=…   -> relay list shape passed through
 *   POST /api/w2m/chat  { session_id, text }              -> relay send shape passed through
 *
 * Failure is a value here: `{ok:false, error, reason_code, detail}` with a non-2xx status, so the
 * panel can print the host's own words. A relay that predates the fleet-messages routes answers
 * 404, which is reported as such rather than as an empty conversation.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  decodeTranscript, extractUserMessages, sessionDirName,
} from './session-watch.mjs';
import { createSessionSync } from './session-sync.mjs';

/** Session prompts are mirrored only when the operator opts in; the default is off. */
export const DEFAULT_MIRROR_MODE = 'off';
export function mirrorModeOf(cfg) {
  const mode = cfg?.fleetChatMirror;
  return mode === 'plaintext' || mode === 'encrypted' ? mode : DEFAULT_MIRROR_MODE;
}


/**
 * The newest transcript for a cwd, or null. Reads directory listings and stat only -- this module never opens a
 * session file for writing, and \	est/session-readonly.test.mjs\ enforces that.
 */
function newestTranscript(cwd) {
  const dir = join(homedir(), '.dsh', 'sessions', sessionDirName(cwd));
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
    const file = join(dir, entry.name, 'session.v4.jsonl.zstd');
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (best === null || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
  }
  return best === null ? null : best.file;
}

export const CHAT_ROUTE_PATH = '/api/w2m/chat';

/** The light task board the panel shows beside the chat. The relay already answers GET /v1/tasks. */
export const TASKS_ROUTE_PATH = '/api/w2m/tasks';
export const MAX_SESSION_ID_LENGTH = 200;

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Attach the route to one host's fetch registry, recording the outcome on `status`.
 *
 * @param {object} ctx the plugin context (a Cordis fiber)
 * @param {{cfg: () => object, request: Function, resolveToken: () => Promise<string|null>}} deps
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerChatRoutes(ctx, deps) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  /**
   * The project this conversation belongs to.
   *
   * NOT `process.cwd()`: that is the DSH host's own directory, which differs per machine (E:\DS on one box, /root on
   * another), so the derived conversation key differed per machine and every panel saw only its own messages. The
   * operator's rule is account + project NAME; the name has to come from the project this plugin was configured for.
   */
  const projectDirOf = () => {
    const configured = deps.cfg()?.projectDir;
    return typeof configured === 'string' && configured !== '' ? configured : process.cwd();
  };
  const sync = createSessionSync({ conversationKey: 'pending', machineId: 'pending', machineName: null });

  /**
   * Which machine this is and which conversation the project belongs to.
   *
   * Resolved once. The account material is hashed with a domain label first: it is the fleet key, which is secret, but
   * hashing keeps the conversation key from ever being usable as a joining secret.
   */
  /**
   * Which machine this is and which conversation the project belongs to.
   *
   * Resolved lazily and NOT cached while it is incomplete: the fleet key may land after the first request (the account
   * join runs at stack start), and a panel opened before it did would otherwise keep a "no identity" answer for the
   * lifetime of the process -- which is exactly the bug this replaces.
   */
  let resolved = null;
  const identityOf = async () => {
    if (resolved !== null && resolved.error === null) return resolved;
    const local = typeof deps.localIdentity === 'function' ? await deps.localIdentity() : null;
    const machineId = typeof local?.machine_id === 'string' && local.machine_id !== '' ? local.machine_id : null;
    if (machineId === null) {
      // Nothing can be keyed without a machine, and inventing one would put unrelated hosts in one conversation.
      return { error: 'CHAT_NO_IDENTITY', machineId: null, machineName: null, conversationKey: null, source: null };
    }
    const basis = conversationBasis({ machineId, relayUrl: deps.cfg()?.rabbitUrl ?? null });
    resolved = {
      error: null,
      machineId,
      machineName: typeof local?.machine_name === 'string' ? local.machine_name : null,
      // One group per relay: every machine in this fleet shares this conversation, whatever its project.
      conversationKey: createHash('sha256').update('w2m-fleet-conversation-v1').update(basis.basis).digest('hex'),
      source: basis.source,
    };
    return resolved;
  };

  /**
   * The machine ids this fleet knows, cached for five seconds.
   *
   * Only the HOST can check a single recipient: the relay validates the shape of a recipient, not whether a machine
   * with that id exists. Null means the roster could not be read at all, which is deliberately a different answer from
   * "no such machine" -- a relay outage must not be reported as a typo in the recipient.
   */
  let rosterAtMs = 0;
  let rosterIds = null;
  const knownMachineIds = async (signal) => {
    if (rosterIds !== null && Date.now() - rosterAtMs < 5000) return rosterIds;
    try {
      const cfg = deps.cfg();
      const rabbitUrl = cfg?.rabbitUrl ?? null;
      if (rabbitUrl === null) return null;
      const token = await deps.resolveToken();
      if (typeof token !== 'string' || token === '') return null;
      const listed = await deps.request({ rabbitUrl, token, method: 'GET', pathname: '/v1/devices', signal });
      if (listed?.ok !== true) return null;
      const devices = Array.isArray(listed.json?.devices) ? listed.json.devices : null;
      if (devices === null) return null;
      const ids = devices.map((device) => device?.machine_id).filter((id) => typeof id === 'string');
      rosterIds = ids;
      rosterAtMs = Date.now();
      return ids;
    } catch {
      return null;
    }
  };

  /** Post one batch into the relay using the machine's device token, exactly as the browser route does. */
  const postToRelay = async (identity, payload) => {
    const cfg = deps.cfg();
    const rabbitUrl = cfg?.rabbitUrl ?? null;
    if (rabbitUrl === null) return { ok: false };
    let token;
    try { token = await deps.resolveToken(); } catch { return { ok: false }; }
    if (typeof token !== 'string' || token === '') return { ok: false };
    return deps.request({
      rabbitUrl, token, method: 'POST', pathname: '/v1/fleet/messages',
      body: { session_id: identity.conversationKey, ...payload },
    });
  };

  /**
   * v1.1.20: mirror this machine's own prompts into the fleet conversation -- READ ONLY.
   *
   * The session files are never written and nothing is injected into DSH: the transcript is read, the user's messages
   * are extracted, and only the new ones are published. A failure here must not disturb the panel or the route.
   */
  const MIRROR_MAX_BYTES = 3500;

  const truncateUtf8 = (value, max) => {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= max) return value;
    return bytes.subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '') + ' …(已截断)';
  };
  const mirrorOnce = async () => {
    const mode = mirrorModeOf(deps.cfg());
    if (mode === 'off') return;
    if (mode === 'encrypted') return; // encrypted mirroring lands with the AEAD v2 slice
    const identity = await identityOf();
    if (identity.conversationKey === null) return;
    const file = newestTranscript(projectDirOf());
    if (file === null) return;
    let messages;
    try { messages = extractUserMessages(decodeTranscript(readFileSync(file))); } catch { return; }
    for (const payload of sync.pending(messages)) {
      await postToRelay(identity, {
        text: truncateUtf8(payload.text, MIRROR_MAX_BYTES),
        machine_id: identity.machineId,
        machine_name: identity.machineName,
        origin: 'session',
      });
    }
  };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || registry === null || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    try {
      registry.register({
        path: CHAT_ROUTE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const refuse = (httpStatus, reasonCode, error, detail) =>
            Response.json({ ok: false, error, reason_code: reasonCode, detail }, { status: httpStatus, headers: NO_STORE });

          if (request.method !== 'GET' && request.method !== 'POST') {
            return refuse(405, 'CHAT_METHOD_NOT_ALLOWED', `${request.method} is not answered here`, 'GET lists a session; POST sends a message');
          }

          const url = new URL(request.url);
          const sessionIdOf = (value) => (typeof value === 'string' ? value.trim() : '');
          // "All projects in this fleet" is an explicit scope, not the default: the operator presses a button for it.
          // Its key is the relay alone -- deliberately NOT the project name -- so every machine in the fleet
          // lands in one stream. It is not a history fetch: the caller sends a floor timestamp (see the panel).
          let sessionId = '';
          const addressing = {};
          let text = null;
          if (request.method === 'GET') {
            sessionId = sessionIdOf(url.searchParams.get('session_id'));
          } else {
            let body;
            try {
              body = await request.json();
            } catch {
              return refuse(400, 'CHAT_BODY_NOT_JSON', 'body is not JSON', 'send {"session_id":"…","text":"…"}');
            }
            sessionId = sessionIdOf(body?.session_id);
            text = typeof body?.text === 'string' ? body.text : null;
            // Addressing + correlation travel as optional fields; each is validated here so a bad one is refused with a
            // name instead of being stored and never understood.
            if (typeof body?.to === 'string' && body.to.trim() !== '') {
              const to = body.to.trim();
              if (to !== 'all' && (to.length > 64 || /\s/.test(to))) {
                return refuse(400, 'CHAT_BAD_ADDRESS', 'to must be "all" or a machine id', 'a recipient is either the whole fleet or one machine');
              }
              addressing.to = to;
            }
            if (typeof body?.thread_id === 'string' && body.thread_id.trim() !== '') addressing.thread_id = body.thread_id.trim().slice(0, 64);
            if (typeof body?.reply_to === 'string' && body.reply_to.trim() !== '') addressing.reply_to = body.reply_to.trim();
          }
          const identity = await identityOf();
          if (identity.error !== null) {
            return refuse(503, identity.error, 'this machine has no fleet-chat identity yet', 'pair the machine and let it derive the fleet key');
          }
          // One group per relay: the browser sends its own session id, which is replaced here.
          sessionId = identity.conversationKey;
          if (sessionId.length > MAX_SESSION_ID_LENGTH) {
            return refuse(400, 'CHAT_SESSION_ID_TOO_LONG', `\`session_id\` must be at most ${MAX_SESSION_ID_LENGTH} characters`, 'send the id the host gave this session');
          }

          const cfg = deps.cfg();
          const rabbitUrl = cfg?.rabbitUrl ?? null;
          if (rabbitUrl === null) return refuse(503, 'CHAT_NO_RELAY', 'no relay is configured', 'set rabbitUrl in the profile patch');
          let token;
          try {
            token = await deps.resolveToken();
          } catch (error) {
            return refuse(503, 'CHAT_UNPAIRED', `this machine has no device token: ${error instanceof Error ? error.message : String(error)}`, 'pair the machine first (autoStartAgent or a pairing code)');
          }
          if (typeof token !== 'string' || token === '') {
            return refuse(503, 'CHAT_UNPAIRED', 'this machine has no device token', 'pair the machine first (autoStartAgent or a pairing code)');
          }

          try {
            if (request.method === 'GET') {
              const query = { session_id: sessionId, for_me: '1' };
              const threadOf = url.searchParams.get('thread_id');
              const toOf = url.searchParams.get('to');
              if (threadOf !== null && threadOf !== '') query.thread_id = threadOf;
              if (toOf !== null && toOf !== '') query.to = toOf;
              const sinceMs = url.searchParams.get('since_ms');
              const limit = url.searchParams.get('limit');
              if (sinceMs !== null && /^\d+$/.test(sinceMs)) query.since_ms = sinceMs;
              if (limit !== null && /^\d+$/.test(limit)) query.limit = limit;
              const listed = await deps.request({ rabbitUrl, token, method: 'GET', pathname: '/v1/fleet/messages', query, signal: request.signal });
              if (listed?.ok !== true) {
                const code = listed?.json?.error?.code ?? listed?.error?.code ?? 'CHAT_LIST_REFUSED';
                const message = listed?.json?.error?.message ?? listed?.error?.message ?? `the relay answered HTTP ${listed?.status ?? 0}`;
                return refuse(listed?.status === 404 ? 502 : 502, code, message, 'the relay must run a version with /v1/fleet/messages (>= 1.1.17) and be restarted');
              }
              return Response.json({ ...listed.json, ok: true, local_machine_id: identity.machineId, local_machine_name: identity.machineName, conversation_key: sessionId, conversation_source: identity.source }, { headers: NO_STORE });
            }
            // Addressing (v1.2.2): a single recipient must exist in THIS fleet.
            if (typeof addressing.to === 'string' && addressing.to !== 'all') {
              const roster = await knownMachineIds(request.signal);
              if (roster === null) {
                return refuse(503, 'CHAT_ROSTER_UNAVAILABLE', 'the machine roster could not be read', 'a recipient cannot be checked without the relay roster');
              }
              if (!roster.includes(addressing.to)) {
                return refuse(400, 'CHAT_UNKNOWN_RECIPIENT', 'no machine with that id is in this fleet', 'send all, or a machine_id listed by w2m_devices');
              }
            }
            const posted = await deps.request({ rabbitUrl, token, method: 'POST', pathname: '/v1/fleet/messages', body: { session_id: sessionId, text: text ?? '', machine_id: identity.machineId, machine_name: identity.machineName, origin: 'chat', ...addressing }, signal: request.signal });
            if (posted?.ok !== true) {
              const code = posted?.json?.error?.code ?? posted?.error?.code ?? 'CHAT_SEND_REFUSED';
              const message = posted?.json?.error?.message ?? posted?.error?.message ?? `the relay answered HTTP ${posted?.status ?? 0}`;
              return refuse(posted?.status === 404 ? 502 : 400, code, message, 'quota, size and non-text are each refused by name; 404 means the relay predates fleet chat');
            }
            return Response.json({ ...posted.json, ok: true }, { headers: NO_STORE });
          } catch (error) {
            return refuse(502, 'CHAT_RELAY_ERROR', `the relay call failed: ${error instanceof Error ? error.message : String(error)}`, 'check the relay and this machine token');
          }
        },
      });
      // A light task board. The relay answers GET /v1/tasks; this proxy exists so the panel can read it with the device
      // token that never leaves the host.
      registry.register({
        path: TASKS_ROUTE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const refuse = (httpStatus, reasonCode, error, detail) =>
            Response.json({ ok: false, error, reason_code: reasonCode, detail }, { status: httpStatus, headers: NO_STORE });
          if (request.method !== 'GET') {
            return refuse(405, 'TASKS_METHOD_NOT_ALLOWED', `${request.method} is not answered here`, 'GET only');
          }
          const url = new URL(request.url);
          const limitRaw = url.searchParams.get('limit');
          const limit = limitRaw !== null && /^[0-9]+$/.test(limitRaw) ? Math.min(Number(limitRaw), 50) : 20;
          const cfg = deps.cfg();
          const rabbitUrl = cfg?.rabbitUrl ?? null;
          if (rabbitUrl === null) return refuse(503, 'TASKS_NO_RELAY', 'no relay is configured', 'set rabbitUrl in the profile patch');
          let token;
          try {
            token = await deps.resolveToken();
          } catch (error) {
            return refuse(503, 'TASKS_UNPAIRED', `this machine has no device token: ${error instanceof Error ? error.message : String(error)}`, 'pair the machine first');
          }
          if (typeof token !== 'string' || token === '') {
            return refuse(503, 'TASKS_UNPAIRED', 'this machine has no device token', 'pair the machine first');
          }
          try {
            const listed = await deps.request({
              rabbitUrl, token, method: 'GET', pathname: '/v1/tasks', query: { limit: String(limit) }, signal: request.signal,
            });
            if (listed?.ok !== true) {
              const code = listed?.json?.error?.code ?? 'TASKS_LIST_REFUSED';
              return refuse(502, code, `the relay answered HTTP ${listed?.status ?? 0}`, 'the relay must run a version with /v1/tasks');
            }
            return Response.json({ ...listed.json, ok: true }, { headers: NO_STORE });
          } catch (error) {
            return refuse(502, 'TASKS_RELAY_ERROR', `the relay call failed: ${error instanceof Error ? error.message : String(error)}`, null);
          }
        },
      });

      status.mounted = true;
      status.reason = null;
      const timer = setInterval(() => { mirrorOnce().catch(() => { /* one bad tick must not stop the next */ }); }, 2000);
      if (typeof timer.unref === 'function') timer.unref();
      if (typeof ctx?.effect === 'function') ctx.effect(() => () => clearInterval(timer), 'w2m: fleet chat session mirror');
      else globalThis.__w2mChatMirrorTimer = timer;
    } catch (error) {
      status.reason = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`w2m: the fleet chat route is inactive — ${status.reason}`);
    }
  });
  return status;
}

/**
 * The material a conversation is keyed from.
 *
 * The operator's rule, in its simplest form: **one relay is one group**. Every machine talking to the same relay shares
 * one conversation, whatever project it is working on. Neither the project name nor the account key is part of the basis:
 * including either split the fleet into separate streams, which is the report this replaces.
 *
 * The machine id stays only as a last resort for a host with no relay configured, so the panel can still answer locally.
 *
 * @param {{machineId?: string|null, relayUrl?: string|null}} input
 * @returns {{basis: string, source: 'fleet'|'machine'}|null} null when there is no machine to key on
 */
export function conversationBasis({ machineId, relayUrl } = {}) {
  const machine = typeof machineId === 'string' && machineId !== '' ? machineId : null;
  if (machine === null) return null;
  const relay = typeof relayUrl === 'string' && relayUrl.trim() !== '' ? relayUrl.trim().replace(/\/+$/, '') : null;
  if (relay !== null) return { basis: 'fleet:' + relay, source: 'fleet' };
  return { basis: 'machine:' + machine, source: 'machine' };
}
