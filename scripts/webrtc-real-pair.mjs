/**
 * Real WebRTC engine smoke test for `webrtc-v1`.
 *
 * Two real `PeerConnection`s (separate `node-datachannel` provider processes), one real WebSocket
 * signaling server, real ICE/DTLS, real Noise handshake, real fragmentation. This is deliberately
 * *not* part of `npm test`: the published package has no WebRTC dependency, and the addon must be
 * installed separately:
 *
 *   npm --prefix E:\DB\w2m-webrtc-provider install node-datachannel
 *   node scripts/webrtc-real-pair.mjs
 *
 * Environment overrides:
 *   W2M_WEBRTC_PROVIDER_CWD   directory containing node_modules/node-datachannel
 *   W2M_WEBRTC_PROVIDER_SCRIPT path to providers/node-datachannel-provider.mjs
 *   W2M_WEBRTC_STUN           comma-separated STUN URLs (optional; host candidates work on a LAN)
 */

import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';
import { createWebRtcTransportPool } from '../src/agent/webrtc/pool.mjs';
import { createDirSink } from '../src/agent/sinks/dir-sink.mjs';
import { TeamsDataPlane } from '../src/plugin/teams/data-plane.mjs';

const providerCwd = process.env.W2M_WEBRTC_PROVIDER_CWD || 'E:\\DB\\w2m-webrtc-provider';
const providerScript =
  process.env.W2M_WEBRTC_PROVIDER_SCRIPT ||
  fileURLToPath(new URL('../src/agent/webrtc/providers/node-datachannel-provider.mjs', import.meta.url));
const iceServers = (process.env.W2M_WEBRTC_STUN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((urls) => ({ urls }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForMessage(bucket, from, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = bucket.find((entry) => entry.from === from && predicate(entry.payload));
      if (found !== undefined) return resolve(found.payload);
      if (Date.now() > deadline) return reject(new Error(`no matching frame from ${from} within ${timeoutMs} ms`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const a = DeviceKey.generate('machine-a');
const b = DeviceKey.generate('machine-b');

const server = await createSignalingServer({ port: 0, heartbeatMs: 0 });
const received = [];
const optionsFor = (machineId, peerId, key, peerPublicKey) =>
  createWebRtcTransportPool({
    machineId,
    signalUrl: server.url,
    deviceKey: key,
    resolvePeerKey: async (asked) => {
      if (asked === peerId) return { key: peerPublicKey, error: null };
      return { key: null, error: `unknown peer ${asked}` };
    },
    providerCommand: process.execPath,
    providerArgs: [providerScript],
    providerCwd,
    iceServers,
    preferP2p: true,
    allowRelay: false,
    connectTimeoutMs: 20_000,
    handshakeTimeoutMs: 20_000,
    peerTimeoutMs: 25_000,
    statsPollMs: 500,
  });

const hostBuilt = optionsFor('machine-a', 'machine-b', a, b.publicKeyBase64);
const clientBuilt = optionsFor('machine-b', 'machine-a', b, a.publicKeyBase64);
if (hostBuilt.ok !== true || clientBuilt.ok !== true) {
  throw new Error(`pool construction failed: host=${JSON.stringify(hostBuilt)} client=${JSON.stringify(clientBuilt)}`);
}
const host = hostBuilt.pool;
const client = clientBuilt.pool;
host.onMessage((event) => received.push({ from: event.peer, payload: Buffer.from(event.payload) }));
client.onMessage((event) => received.push({ from: event.peer, payload: Buffer.from(event.payload) }));

const startedAt = Date.now();
try {
  const [hostReady, clientReady] = await Promise.all([host.ensure('machine-b'), client.ensure('machine-a')]);
  if (hostReady.ok !== true || clientReady.ok !== true) {
    throw new Error(`pair did not open: host=${JSON.stringify(hostReady)} client=${JSON.stringify(clientReady)}`);
  }
  console.log(`PAIR open in ${Date.now() - startedAt} ms host=${hostReady.role} client=${clientReady.role}`);

  const small = Buffer.from(JSON.stringify({ type: 'probe', direction: 'host-to-client', at: Date.now() }));
  const sentSmall = await host.send('machine-b', small);
  if (sentSmall.ok !== true) throw new Error(`host send failed: ${JSON.stringify(sentSmall)}`);
  const gotSmall = await waitForMessage(received, 'machine-a', (payload) => payload.equals(small));
  console.log(`SMALL host->client ${gotSmall.length} bytes`);

  const large = Buffer.alloc(256 * 1024);
  for (let index = 0; index < large.length; index += 1) large[index] = index % 251;
  const sentLarge = await client.send('machine-a', large);
  if (sentLarge.ok !== true) throw new Error(`client send failed: ${JSON.stringify(sentLarge)}`);
  const gotLarge = await waitForMessage(received, 'machine-b', (payload) => payload.equals(large), 30_000);
  console.log(`LARGE client->host ${gotLarge.length} bytes fragments=${sentLarge.fragments ?? 'n/a'}`);

  const teamsRoot = mkdtempSync(join(tmpdir(), 'w2m-real-teams-sink-'));
  const hostPlane = new TeamsDataPlane({
    pool: host,
    sink: createDirSink({ root: teamsRoot }),
    dataRetryDelayMs: 25,
  });
  const clientPlane = new TeamsDataPlane({ pool: client, dataRetryDelayMs: 25 });
  const artifactDone = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Teams artifact did not reach the host sink')), 30_000);
    hostPlane.onEvent((event) => {
      if (event.type === 'artifact-received') {
        clearTimeout(timer);
        resolve(event);
      }
      if (event.type === 'artifact-not-delivered') {
        clearTimeout(timer);
        reject(new Error(`Teams artifact not delivered: ${JSON.stringify(event.delivered)}`));
      }
    });
  });
  const artifact = Buffer.alloc(1024 * 1024 + 7);
  for (let index = 0; index < artifact.length; index += 1) artifact[index] = index % 241;
  const artifactSent = await clientPlane.sendArtifact({
    peer: 'machine-a',
    bytes: artifact,
    taskId: 'real-teams-artifact',
    kind: 'artifact',
    name: 'real.bin',
  });
  if (artifactSent.ok !== true) throw new Error(`Teams send failed: ${JSON.stringify(artifactSent)}`);
  const artifactReceived = await artifactDone;
  const ref = artifactReceived.delivered.ref;
  const stored = ref === null || ref === undefined ? null : readFileSync(join(teamsRoot, ref.sink.rel_path));
  if (stored === null || !stored.equals(artifact)) throw new Error('Teams sink bytes do not match the sent artifact');
  console.log(
    `TEAMS artifact ${artifactSent.bytes} bytes in ${artifactSent.chunks} frames attempts=${artifactSent.attempts} ` +
      `transport=${artifactSent.transport} sink=${ref.sink.rel_path}`,
  );

  const hostDiag = host.diagnostics();
  const clientDiag = client.diagnostics();
  await sleep(1_200);
  const hostSettled = host.diagnostics();
  const clientSettled = client.diagnostics();
  console.log(JSON.stringify({
    ok: true,
    elapsed_ms: Date.now() - startedAt,
    host: hostSettled.peers,
    client: clientSettled.peers,
    host_path: hostDiag.peers.map((peer) => peer.path),
    client_path: clientDiag.peers.map((peer) => peer.path),
    host_stats: hostSettled.stats,
    client_stats: clientSettled.stats,
  }, null, 2));
} finally {
  await host.stop();
  await client.stop();
  await server.close();
}
