#!/usr/bin/env node
/**
 * Standalone signaling server for the `webrtc-v1` transport.
 *
 * It is intentionally separate from the relay process: signaling is control-plane state (rooms,
 * SDP, ICE), while the relay is the existing task/SSE plane. Running it separately means a relay
 * restart does not drop an established WebRTC DataChannel, and the signaling server can sit behind
 * its own reverse proxy/TLS terminator.
 *
 * Usage:
 *   w2m-webrtc-signal --port 8788 --host 0.0.0.0 --token-file ./signal-token.txt
 *   W2M_WEBRTC_SIGNAL_TOKEN=... w2m-webrtc-signal --port 8788
 *
 * The printed URL never includes the token. A client appends `?token=...` (or `wss://` behind TLS).
 */

import { readFileSync } from 'node:fs';

import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';

/**
 * Parse `--key value` and `--key=value`; booleans are flags. No third-party parser.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) {
      out[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * @param {Record<string, string|boolean>} args
 * @returns {string}
 */
function tokenFrom(args) {
  if (typeof args.token === 'string' && args.token !== '') return args.token;
  if (typeof args['token-file'] === 'string' && args['token-file'] !== '') {
    return readFileSync(args['token-file'], 'utf8').trim();
  }
  return process.env.W2M_WEBRTC_SIGNAL_TOKEN ?? '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
  const port = Number.parseInt(typeof args.port === 'string' ? args.port : '8788', 10);
  const path = typeof args.path === 'string' ? args.path : '/w2m/webrtc';
  const token = tokenFrom(args);
  const maxRooms = Number.parseInt(typeof args['max-rooms'] === 'string' ? args['max-rooms'] : '1024', 10);
  const heartbeatMs = Number.parseInt(
    typeof args['heartbeat-ms'] === 'string' ? args['heartbeat-ms'] : '30000',
    10,
  );
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('w2m-webrtc-signal: --port must be 0..65535');
    process.exitCode = 2;
    return;
  }
  const created = await createSignalingServer({
    host,
    port,
    path,
    token,
    maxRooms: Number.isInteger(maxRooms) && maxRooms > 0 ? maxRooms : 1024,
    heartbeatMs: Number.isInteger(heartbeatMs) && heartbeatMs >= 0 ? heartbeatMs : 30_000,
  });
  if (created.ok !== true) {
    console.error(`w2m-webrtc-signal: ${created.code}: ${created.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `w2m-webrtc-signal: listening ${created.url}${token !== '' ? ' (token required)' : ' (no token)'}`,
  );
  console.log('w2m-webrtc-signal: health endpoint /health; rooms are one host + one client');
  const shutdown = async (signal) => {
    console.log(`w2m-webrtc-signal: ${signal}, closing`);
    await created.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(`w2m-webrtc-signal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
