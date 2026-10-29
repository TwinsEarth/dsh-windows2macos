#!/usr/bin/env node
/**
 * 文件 E2E 演练（步骤 5）：loopback / sender / receiver 三种角色。
 *
 *   sender   : chunkFile → publishRef → 绑定 UDP 端口 → 应答 xfer.want → 收到 xfer.done 退出
 *   receiver : 解析 ref（--root 或最新发布）→ createReceiver → 向候选地址发 want →
 *              writeChunk → finalize → 发布 artifact.ready → 通知 sender
 *   loopback : 同机双端点，保持原有自检（无参数时的默认）
 *
 * 地址来源：--address a:port,b:port 或 --peer <machine_id> --port <udp_port>
 *          （候选来自 relay /v1/peer/<id>，私网优先，逐个 try，失败显式 P2P_* 错误）。
 *
 * 注意：P2P 加密握手未修好前，跨机直连会失败；本脚本先保证角色/地址逻辑可回归。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunkFile, createReceiver, createRefV2, publishRef, listPublishedRefs } from '../src/agent/transfer/index.mjs';
import { createChunkSource, createWantClient } from '../src/agent/transfer/want-block.mjs';
import { readOperatorToken } from '../src/plugin/operator-token.mjs';
import { deviceFilePath } from '../src/agent/identity.mjs';

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const dev = JSON.parse(readFileSync(deviceFilePath({}), 'utf8'));
const relay = dev.rabbit_url;
const operator = readOperatorToken();

function json(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function fail(code, detail) { json({ ok: false, code, detail: detail ?? null }); process.exit(4); }
function parseAddress(value) {
  const match = /^([^:]+):(\d{1,5})$/.exec(String(value));
  if (match === null) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? { host: match[1], port } : null;
}

async function resolveAddresses() {
  const direct = arg('address');
  if (direct !== null) {
    const parsed = direct.split(',').map((entry) => parseAddress(entry.trim()));
    if (parsed.some((entry) => entry === null)) fail('ADDRESS_INVALID', direct);
    return parsed;
  }
  const peer = arg('peer');
  const port = Number(arg('port', 0));
  if (peer === null || !Number.isInteger(port) || port < 1) fail('ADDRESS_REQUIRED', 'pass --address host:port or --peer <machine_id> --port <udp_port>');
  const response = await fetch(relay + '/v1/peer/' + encodeURIComponent(peer), { headers: { authorization: 'Bearer ' + dev.device_token } });
  if (response.ok !== true) fail('PEER_LOOKUP_FAILED', { status: response.status });
  const body = await response.json();
  const candidates = Array.isArray(body?.peer?.candidates) ? body.peer.candidates : [];
  const isPrivate = (host) => /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return candidates.map((candidate) => ({ host: String(candidate.address), port })).sort((a, b) => Number(isPrivate(b.host)) - Number(isPrivate(a.host)));
}

async function readRef() {
  const root = arg('root');
  const file = arg('ref');
  if (file !== null) {
    const ref = JSON.parse(readFileSync(file, 'utf8'));
    if (root !== null && ref.rootCid !== root) fail('REF_ROOT_MISMATCH');
    return ref;
  }
  if (operator.configured !== true) fail('OPERATOR_TOKEN_REQUIRED');
  const listed = await listPublishedRefs({ relayUrl: relay, token: dev.device_token });
  if (listed.ok !== true) fail('REF_LIST_FAILED', listed);
  const refs = root === null ? listed.refs : listed.refs.filter((candidate) => candidate.rootCid === root);
  if (refs.length === 0) fail('REF_NOT_FOUND', { root });
  return refs[refs.length - 1];
}

async function publishReady(ref) {
  const response = await fetch(relay + '/v1/projects/default/decisions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + operator.token, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'artifact.ready', kind: 'artifact_ready', text: JSON.stringify({ rootCid: ref.rootCid, size: ref.size, chunkCount: ref.chunkCount }), refs: { rootCid: ref.rootCid, originPeer: ref.originPeer } }),
  }).then((res) => res.json()).catch(() => null);
  return response?.ok === true;
}

async function senderMain() {
  const file = arg('file');
  if (file === null) fail('FILE_REQUIRED', '--file <path>');
  if (operator.configured !== true) fail('OPERATOR_TOKEN_REQUIRED');
  const chunkBytes = Number(arg('chunk-bytes', 16 * 1024));
  const port = Number(arg('port', 0));
  const timeoutMs = Number(arg('timeout', 120000));
  const chunked = chunkFile(file, { chunkBytes });
  if (chunked.ok !== true) fail('CHUNK_FAILED', chunked);
  const refResult = createRefV2({ rootCid: chunked.rootCid, size: chunked.size, chunkCount: chunked.chunkCount, chunkBytes: chunked.chunkBytes, originPeer: dev.machine_id });
  if (refResult.ok !== true) fail('REF_FAILED', refResult);
  const ref = refResult.ref;
  const published = await publishRef({ relayUrl: relay, token: operator.token, ref });
  if (published.ok !== true) fail('PUBLISH_FAILED', published);
  const socket = createSocket('udp4');
  // transferId 由接收方在 want 帧里带来；每次 want 都按该 id 现场读取块。
  socket.on('message', (message, rinfo) => {
    let frame = null;
    try { frame = JSON.parse(message.toString('utf8')); } catch { return; }
    if (frame?.type === 'xfer.done') { json({ ok: true, role: 'sender', done: true }); socket.close(); process.exit(0); }
    const source = createChunkSource({ chunked, filePath: file, transferId: frame?.transferId ?? null });
    const served = source.handle(frame);
    if (served.ok !== true) { socket.send(JSON.stringify({ type: 'xfer.error', transferId: frame?.transferId ?? null, code: served.code }), rinfo.port, rinfo.address); return; }
    for (const chunk of served.frames) socket.send(Buffer.from(JSON.stringify(chunk), 'utf8'), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => socket.bind(port, '0.0.0.0', resolve));
  json({ ok: true, role: 'sender', ready: true, port: socket.address().port, rootCid: ref.rootCid, relay });
  setTimeout(() => { socket.close(); process.exit(1); }, timeoutMs).unref();
}

async function receiverMain() {
  if (operator.configured !== true) fail('OPERATOR_TOKEN_REQUIRED');
  const ref = await readRef();
  const sinkRoot = arg('sink-root', join(mkdtempSync(join(tmpdir(), 'w2m-xfer-')), 'sink'));
  const stateDir = arg('state-dir', join(mkdtempSync(join(tmpdir(), 'w2m-xfer-')), 'state'));
  const receiver = createReceiver({ stateDir, sinkRoot, ref, destination: arg('destination', 'restored.bin') });
  if (receiver.ok !== true) fail('RECEIVER_FAILED', receiver);
  const client = createWantClient({ transferId: receiver.transferId, rootCid: ref.rootCid, receiver });
  const addresses = await resolveAddresses();
  if (addresses.length === 0) fail('P2P_NO_CANDIDATES');
  const socket = createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '0.0.0.0', resolve));
  const queue = [];
  let notify = null;
  socket.on('message', (message) => { let frame = null; try { frame = JSON.parse(message.toString('utf8')); } catch { return; } queue.push(frame); if (notify !== null) { const fn = notify; notify = null; fn(); } });
  const nextFrame = (timeoutMs) => new Promise((resolve) => {
    if (queue.length > 0) { resolve(queue.shift()); return; }
    const timer = setTimeout(() => { notify = null; resolve(null); }, timeoutMs);
    notify = () => { clearTimeout(timer); resolve(queue.shift()); };
  });
  let target = null;
  for (const address of addresses) {
    const missing = client.missing();
    if (missing.length === 0) break;
    socket.send(JSON.stringify(client.requestFrames(missing)[0]), address.port, address.host);
    let frame = await nextFrame(3000);
    if (frame === null) continue;
    target = address;
    while (frame !== null) {
      const accepted = client.accept(frame);
      if (accepted.ok !== true) { socket.close(); fail(accepted.code, accepted); }
      if (receiver.progress().complete) break;
      const next = client.missing();
      if (next.length === 0) break;
      socket.send(JSON.stringify(client.requestFrames(next)[0]), target.port, target.host);
      frame = await nextFrame(8000);
      if (frame === null) { socket.close(); fail('P2P_TIMEOUT', { address: target }); }
    }
    if (receiver.progress().complete) break;
  }
  if (target === null || receiver.progress().complete !== true) { socket.close(); fail('P2P_UNREACHABLE', { tried: addresses }); }
  const finalized = receiver.finalizeTransfer(ref.rootCid);
  if (finalized.ok !== true) { socket.close(); fail('FINALIZE_FAILED', finalized); }
  const ready = await publishReady(ref);
  socket.send(JSON.stringify({ type: 'xfer.done' }), target.port, target.host);
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.close();
  const expected = arg('file');
  json({ ok: true, role: 'receiver', path: finalized.path, bytes: ref.size, rootCid: ref.rootCid, address: target, verified: expected === null ? null : sha256(readFileSync(expected)) === sha256(readFileSync(finalized.path)), artifact_ready_published: ready });
  process.exit(0);
}

const role = arg('role');
if (role === 'sender') { await senderMain(); }
else if (role === 'receiver') { await receiverMain(); }
else {
  const chunkBytes = Number(arg('chunk-bytes', 16 * 1024));
  const dir = mkdtempSync(join(tmpdir(), 'w2m-xfer-loop-'));
  const data = randomBytes(512 * 1024);
  const file = join(dir, 'artifact.bin');
  writeFileSync(file, data);
  const chunked = chunkFile(file, { chunkBytes });
  if (chunked.ok !== true) fail('CHUNK_FAILED', chunked);
  const refResult = createRefV2({ rootCid: chunked.rootCid, size: chunked.size, chunkCount: chunked.chunkCount, chunkBytes: chunked.chunkBytes, originPeer: dev.machine_id });
  if (refResult.ok !== true) fail('REF_FAILED', refResult);
  const ref = refResult.ref;
  if (operator.configured !== true) fail('OPERATOR_TOKEN_REQUIRED');
  const published = await publishRef({ relayUrl: relay, token: operator.token, ref });
  if (published.ok !== true) fail('PUBLISH_FAILED', published);
  const listed = await listPublishedRefs({ relayUrl: relay, token: dev.device_token });
  if (listed.ok !== true || !listed.refs.some((candidate) => candidate.rootCid === ref.rootCid)) fail('REF_LIST_FAILED');
  const stateDir = join(dir, 'state'); const sinkRoot = join(dir, 'sink');
  const receiver = createReceiver({ stateDir, sinkRoot, ref, destination: 'restored.bin' });
  if (receiver.ok !== true) fail('RECEIVER_FAILED', receiver);
  const source = createChunkSource({ chunked, filePath: file, transferId: receiver.transferId });
  const client = createWantClient({ transferId: receiver.transferId, rootCid: ref.rootCid, receiver });
  const senderSocket = createSocket('udp4'); const receiverSocket = createSocket('udp4');
  await new Promise((resolve) => senderSocket.bind(0, '127.0.0.1', resolve));
  await new Promise((resolve) => receiverSocket.bind(0, '127.0.0.1', resolve));
  const senderPort = senderSocket.address().port;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LOOP_TIMEOUT')), 30000);
    senderSocket.on('message', (message, rinfo) => {
      let frame = null; try { frame = JSON.parse(message.toString('utf8')); } catch { return; }
      const served = source.handle(frame);
      if (served.ok !== true) { senderSocket.send(JSON.stringify({ type: 'xfer.error', transferId: receiver.transferId, code: served.code }), rinfo.port, rinfo.address); return; }
      for (const chunk of served.frames) senderSocket.send(Buffer.from(JSON.stringify(chunk), 'utf8'), rinfo.port, rinfo.address);
    });
    receiverSocket.on('message', (message) => {
      let frame = null; try { frame = JSON.parse(message.toString('utf8')); } catch { return; }
      const accepted = client.accept(frame);
      if (accepted.ok !== true) { clearTimeout(timer); senderSocket.close(); receiverSocket.close(); reject(new Error(accepted.code)); return; }
      if (receiver.progress().complete) { clearTimeout(timer); resolve(); return; }
      const missing = client.missing();
      if (missing.length > 0) receiverSocket.send(JSON.stringify(client.requestFrames(missing)[0]), senderPort, '127.0.0.1');
    });
    receiverSocket.send(JSON.stringify(client.requestFrames(client.missing())[0]), senderPort, '127.0.0.1');
  });
  senderSocket.close(); receiverSocket.close();
  const finalized = receiver.finalizeTransfer(ref.rootCid);
  if (finalized.ok !== true) fail('FINALIZE_FAILED', finalized);
  const ready = await publishReady(ref);
  json({ ok: true, role: 'loopback', transport: 'udp-loopback', rootCid: ref.rootCid, verified: sha256(readFileSync(finalized.path)) === sha256(data), artifact_ready_published: ready });
  process.exit(0);
}
