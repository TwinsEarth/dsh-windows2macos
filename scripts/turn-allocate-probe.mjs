/**
 * Relay-only Allocate probe for one or more TURN servers.
 *
 * It creates one `node-datachannel` PeerConnection per TURN URL, offers a DataChannel and waits
 * for candidate gathering. A `typ relay` candidate with the TURN server's public address is the
 * only pass condition; a host or srflx candidate alone is a failed deployment even if the socket
 * connected.
 *
 * Usage:
 *   node scripts/turn-allocate-probe.mjs \
 *     --provider-cwd /path/to/node-datachannel \
 *     --turn turn:user:pass@turn-a:3479,turn:user:pass@turn-b:3479 \
 *     --out .matrix/turn-allocate.json
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const providerCwd = arg('provider-cwd', join(process.env.HOME ?? '', 'w2m-webrtc-provider'));
const requireFromProvider = createRequire(join(providerCwd, 'package.json'));
const ndc = requireFromProvider('node-datachannel');
const urls = String(arg('turn', '') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const waitMs = Number(arg('wait-ms', '15000'));
const out = arg('out');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function probe(url, index) {
  const candidates = [];
  const pc = new ndc.PeerConnection(`turn-probe-${index}`, {
    iceServers: [url],
    maxMessageSize: 4 * 1024 * 1024,
  });
  pc.onLocalCandidate((candidate) => candidates.push(candidate));
  pc.createDataChannel('probe');
  pc.setLocalDescription();
  await sleep(waitMs);
  const relay = candidates.filter((candidate) => /\btyp relay\b/.test(candidate));
  const result = {
    url: url.replace(/^(turn|turns):[^@]*@/i, '$1:<redacted>@'),
    ok: relay.length > 0,
    relay_count: relay.length,
    relay_candidates: relay,
    candidate_count: candidates.length,
  };
  try {
    pc.close();
  } catch {
    // Probe cleanup must not hide the evidence.
  }
  return result;
}

if (urls.length === 0) {
  console.error('--turn is required (comma-separated turn:/turns: URLs)');
  process.exit(2);
}

const results = [];
for (let index = 0; index < urls.length; index += 1) results.push(await probe(urls[index], index));
try {
  ndc.cleanup();
} catch {
  // A library cleanup failure is not a probe result.
}
const payload = {
  ok: results.every((result) => result.ok),
  checked_at: new Date().toISOString(),
  wait_ms: waitMs,
  results,
};
const text = `${JSON.stringify(payload, null, 2)}\n`;
if (out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), text);
}
process.stdout.write(text);
process.exit(payload.ok ? 0 : 2);
