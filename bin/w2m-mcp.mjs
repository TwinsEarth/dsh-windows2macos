#!/usr/bin/env node
/**
 * Publish this fleet as an MCP server, read-only (v0.54.0).
 *
 * ## Why read-only, and why that is the whole design
 *
 * The point of exposing the fleet to Claude Code, Cursor and anything else that speaks MCP is that a *different*
 * agent can ask what the fleet is. **`w2m_run` is deliberately absent.** A server that hands `w2m_run` to any
 * process able to start it gives away fleet execution rights, and this project has already learned that a guard
 * which is merely *named* well is not a guard -- the `--dry-run` flag in `scripts/ilink-fleet-bridge.mjs`
 * dispatched for real while its name promised otherwise.
 *
 * **So the first version exposes five tools that cannot change anything**, and each one is a thin wrapper over
 * an endpoint the plugin already calls. **Nothing new is invented here**; if a tool is not already a read the
 * plugin performs, it is not in this file.
 *
 * ## Two protocol eras, because the clients in the wild are on the older one
 *
 * The current revision (`2026-07-28`) is **modern**: version, identity and capabilities travel as per-request
 * `_meta`, and there is **no handshake**. Every earlier revision (`2025-11-25` and back) is **legacy**: an
 * `initialize` handshake, then `notifications/initialized`, then requests.
 *
 * **A server that implements only the modern contract is unreachable from most deployed clients**, which is
 * exactly the population this exists to serve. So this is **dual-era**: `initialize` is answered for legacy
 * clients, a request carrying `_meta` is answered for modern ones, and an unknown version gets the
 * `-32022 UnsupportedProtocolVersionError` the specification requires, listing what is supported.
 *
 * ## stdout carries protocol messages and nothing else
 *
 * Over stdio, **one stray `console.log` corrupts the stream** and the failure looks like a hung client rather
 * than a chatty server. So every diagnostic in this file goes to **stderr**, and `log()` is the only way to
 * write one. There is no `console.log` here by construction, and the test asserts that.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Versions this server can speak, newest first. */
export const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25']);
/** The version assumed when a legacy client sends no `_meta` at all. */
export const LEGACY_VERSION = '2025-11-25';
export const SERVER_NAME = 'w2m-dsh-fleet';
export const SERVER_VERSION = '0.54.0';

/** JSON-RPC and MCP error codes this server can return. */
export const ERROR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
});

/** Diagnostics, on stderr only. */
const log = (message) => process.stderr.write(`[w2m-mcp] ${message}\n`);

/**
 * Where the relay and this machine's identity come from.
 *
 * Read from the same sources the plugin uses, so an MCP client sees the fleet the rest of the tooling sees
 * rather than a second, separately configured one.
 */
export function readConfig(env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh');
  const deviceFile = env.W2M_DEVICE_FILE ?? join(home, 'xclient', 'device.json');
  let device = null;
  if (existsSync(deviceFile)) {
    try { device = JSON.parse(readFileSync(deviceFile, 'utf8')); } catch (error) { log(`device.json unreadable: ${error.message}`); }
  }
  return {
    relayUrl: env.W2M_RABBIT_URL ?? 'http://202.182.123.154:8787',
    operatorToken: env.W2M_OPERATOR_TOKEN ?? '',
    device,
    deviceFile,
  };
}

/** Headers for a relay call: the device token identifies this machine, the operator token authorises reads. */
const headers = (config) => {
  const h = { 'content-type': 'application/json' };
  if (config.device?.device_token) h['x-w2m-device-token'] = config.device.device_token;
  if (config.operatorToken !== '') h.authorization = `Bearer ${config.operatorToken}`;
  return h;
};

/**
 * The five read-only tools.
 *
 * ## Every route here was read out of `src/relay/server.mjs`, not guessed
 *
 * The relay's complete GET surface is `/healthz`, `/metrics`, `/v1/stream`, `/v1/devices`, `/v1/tasks`,
 * `/v1/tasks/{id}`, `/v1/tasks/{id}/report` and `/v1/agents/{id}/status`. **My first draft of this file
 * invented `/v1/stats` and `/v1/status`, which do not exist** -- and a tool whose route is fabricated returns
 * a 404 that reads as a broken relay rather than as a bug in this file.
 *
 * ## These are relay reads, not the DSH tools
 *
 * `w2m_stats` and `w2m_status` in the plugin both begin from `/healthz`, and each adds context the relay
 * cannot know: which profile directory is in play, where `rabbitUrl` came from, whether a bundled runtime
 * resolved. **That context lives in the plugin's process, so an MCP client calling this server gets the relay's
 * half of the answer.** The descriptions say so rather than implying parity.
 *
 * `routes` names the paths a tool may call, and `scripts/mcp-check.mjs` asserts each one appears in the
 * relay's router -- **so a fabricated route fails the pre-flight instead of failing in someone's client.**
 */
export const TOOLS = Object.freeze([
  {
    name: 'w2m_devices',
    description: 'List the machines the relay holds a lease for: id, name, platform, online state and last-seen. Read-only. Answers "who is in the fleet" without running anything.',
    routes: ['/v1/devices'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    requests: () => ['/v1/devices'],
  },
  {
    name: 'w2m_stats',
    description: "The relay's own snapshot of the fleet: relay identity, uptime, device and task counts, aggregate round-trip times, and whether the relay restarted. Read-only. This is the relay's half of the answer -- the parts of the plugin's w2m_stats that come from the local profile are not reachable over MCP.",
    routes: ['/healthz'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    requests: () => ['/healthz'],
  },
  {
    name: 'w2m_history',
    description: 'List recent tasks newest first: id, mode, shard count, which machines hold leases, and whether each was cancelled. Read-only, and deliberately narrower than w2m_status: it names what ran without fetching any result.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many tasks to return, newest first. Defaults to 20.' },
      },
      additionalProperties: false,
    },
    routes: ['/v1/tasks'],
    requests: (args) => {
      const raw = args.limit;
      if (raw === undefined) return ['/v1/tasks'];
      if (!Number.isInteger(raw) || raw < 1) throw new Error(`limit must be a positive integer, got ${JSON.stringify(raw)}`);
      return [`/v1/tasks?limit=${raw}`];
    },
  },
  {
    name: 'w2m_report',
    description: 'Fetch the rendered report for one finished task as markdown or json. Markdown is the human summary; json is the same aggregate shape w2m_status returns. Read-only, and does not start, resume or cancel anything.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, description: 'Task id returned by a dispatch.' },
        format: { type: 'string', enum: ['md', 'json'], description: 'md for the rendered report, json for the aggregate. Defaults to md.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    routes: ['/v1/tasks/{id}/report'],
    requests: (args) => {
      // A task id is opaque, but it lands in a URL path -- so anything that could change which endpoint is
      // addressed is refused rather than escaped into place.
      const id = String(args.task_id ?? '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`task_id ${JSON.stringify(id)} is not a plausible task id`);
      return [`/v1/tasks/${id}/report?format=${args.format === 'json' ? 'json' : 'md'}`];
    },
  },
  {
    name: 'w2m_status',
    description: "This plugin's own view of itself: the machine identity on disk, which relay it is talking to and where that address came from, whether the relay answers, and this machine's round-trip time. Read-only, and usable while the configuration is still broken.",
    routes: ['/v1/agents/{id}/status'],
    inputSchema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string', minLength: 1, description: 'Machine id, as listed by w2m_devices.' },
      },
      required: ['machine_id'],
      additionalProperties: false,
    },
    requests: (args) => {
      const id = String(args.machine_id ?? '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`machine_id ${JSON.stringify(id)} is not a plausible machine id`);
      return [`/v1/agents/${id}/status`];
    },
  },
]);

/** Tool names, for the tests and for a caller that wants the list without the schemas. */
export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));

/**
 * Perform one tool call.
 *
 * Returns the MCP `tools/call` result shape. **A failure is reported as `isError: true` with the reason in the
 * text rather than as a JSON-RPC error**, because the model can act on the former and a transport-level error
 * reads as a broken server.
 *
 * @param {string} name
 * @param {object} args
 * @param {{config: object, fetchImpl: Function}} deps
 */
export async function callTool(name, args, deps) {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) {
    return { content: [{ type: 'text', text: `no such tool: ${name}. This server exposes ${TOOL_NAMES.join(', ')}.` }], isError: true };
  }
  let paths;
  try {
    paths = tool.requests(args ?? {});
  } catch (error) {
    return { content: [{ type: 'text', text: `bad arguments: ${error.message}` }], isError: true };
  }
  const base = deps.config.relayUrl.replace(/\/+$/, '');
  try {
    // Sequential rather than concurrent: a tool that reads two endpoints should report the first failure rather
    // than racing two errors against each other.
    const parts = [];
    for (const path of paths) {
      const response = await deps.fetchImpl(`${base}${path}`, { headers: headers(deps.config) });
      const body = await response.text();
      if (!response.ok) {
        return { content: [{ type: 'text', text: `the relay answered ${response.status} for ${name} ${path}: ${body.slice(0, 400)}` }], isError: true };
      }
      parts.push(paths.length === 1 ? body : `${path}\n${body}`);
    }
    return { content: [{ type: 'text', text: parts.join('\n\n') }], isError: false };
  } catch (error) {
    return { content: [{ type: 'text', text: `could not reach the relay at ${deps.config.relayUrl}: ${error.message}` }], isError: true };
  }
}

/** Build a JSON-RPC success or error envelope. */
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** The protocol version a request declares, from `_meta`, or null for a legacy client. */
const declaredVersion = (request) => {
  const meta = request?.params?._meta;
  const v = meta?.['io.modelcontextprotocol/protocolVersion'];
  return typeof v === 'string' ? v : null;
};

/**
 * Answer one JSON-RPC message, or return null when nothing should be written.
 *
 * A notification has no `id` and **MUST NOT** be answered -- writing a reply to one is a protocol violation
 * that some clients treat as a desynchronised stream.
 *
 * @param {object} request
 * @param {{config: object, fetchImpl: Function}} deps
 * @returns {Promise<object|null>}
 */
export async function handleMessage(request, deps) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return fail(null, ERROR.INVALID_REQUEST, 'not a JSON-RPC request object');
  }
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;

  const version = declaredVersion(request);
  if (version !== null && !SUPPORTED_VERSIONS.includes(version)) {
    // The specification requires the supported list, so a client can retry rather than give up.
    return isNotification ? null : fail(id, ERROR.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: version });
  }

  switch (method) {
    case 'initialize': {
      // Legacy handshake. `protocolVersion` echoes the client's choice when it is one this server speaks.
      const asked = params?.protocolVersion;
      const chosen = SUPPORTED_VERSIONS.includes(asked) ? asked : LEGACY_VERSION;
      return ok(id, {
        protocolVersion: chosen,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Read-only view of a W2M fleet. These tools report; none of them can dispatch a command or change any machine.',
      });
    }

    case 'notifications/initialized':
      // A notification: acknowledged by doing nothing, never answered.
      return null;

    case 'server/discover':
      // Required of every server by the current revision: name the versions supported.
      return ok(id, { protocolVersion: SUPPORTED_VERSIONS[0], supportedVersions: [...SUPPORTED_VERSIONS], serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });

    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });

    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || name === '') return fail(id, ERROR.INVALID_PARAMS, 'tools/call requires a tool name');
      return ok(id, await callTool(name, params?.arguments ?? {}, deps));
    }

    case 'ping':
      return ok(id, {});

    default:
      if (isNotification) return null;
      return fail(id, ERROR.METHOD_NOT_FOUND, `method not found: ${String(method)}`);
  }
}

/**
 * Read newline-delimited JSON from `input` and answer each message on `output`.
 *
 * Exported so the test drives the same loop the process runs, without spawning anything -- a suite that needs a
 * subprocess is skipped wherever piped stdio is refused, which is exactly where this needs to be testable.
 */
export function serve({ input, output, deps }) {
  let buffer = '';
  let pending = Promise.resolve();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          output.write(`${JSON.stringify(fail(null, ERROR.PARSE, `invalid JSON: ${error.message}`))}\n`);
          newline = buffer.indexOf('\n');
          continue;
        }
        // Serialised so two calls cannot interleave their frames on stdout.
        pending = pending.then(async () => {
          const reply = await handleMessage(parsed, deps);
          if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
        }).catch((error) => {
          log(`handler threw: ${error?.stack ?? error}`);
          output.write(`${JSON.stringify(fail(parsed?.id ?? null, ERROR.INTERNAL, String(error?.message ?? error)))}\n`);
        });
      }
      newline = buffer.indexOf('\n');
    }
  });
  return pending;
}

/**
 * Start the server on the transport the caller asked for.
 *
 * **stdio is the default because it is what `mcp.json` declares and what a client launches.** `--http` is for
 * the clients that require an HTTP endpoint -- one of them is known to insist on a local HTTP server with a
 * discovery file rather than a subprocess -- and it is an explicit flag rather than a guess, because the two
 * transports have different threat models: a subprocess talks to its parent, a socket talks to whatever can
 * reach the port.
 */
async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const config = readConfig();
  log(`starting; relay ${config.relayUrl}; device ${config.device?.machine_name ?? '(none)'}`);
  log(`read-only tools: ${TOOL_NAMES.join(', ')}`);

  if (argv.includes('--http')) {
    const { createMcpHttpServer } = await import('../src/mcp/http-transport.mjs');
    const host = flag('--host', '127.0.0.1');
    const port = Number(flag('--port', 8766));
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      log(`--port ${flag('--port')} is not a port number`);
      process.exit(2);
    }
    const running = await createMcpHttpServer({ host, port, deps: { config, fetchImpl: fetch } });
    // Printed so a launcher can read the port when it asked for 0, and on stderr so it never touches a protocol
    // stream -- this binding has no stdout protocol, but the rule is the same one the stdio binding follows.
    log(`streamable-http listening on ${running.url}`);
    const stop = async () => { await running.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  serve({ input: process.stdin, output: process.stdout, deps: { config, fetchImpl: fetch } });
}

// Only when run as a program, so importing this module in a test starts no server.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
