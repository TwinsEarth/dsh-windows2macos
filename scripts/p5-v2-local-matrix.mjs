/**
 * P5 local 2-seed + 2-leecher matrix over real WebTorrent and real node-datachannel.
 *
 * Four worker processes, four WebTorrent clients, four `webrtc-v1` pools. This is the process
 * layout that P2 could not run in one process (three real WebTorrent clients in one process
 * triggered a native OOM). Every leecher downloads the same 1 MiB payload from both seeds and its
 * SHA-256 must equal the source digest.
 *
 * The signal server must already be running, for example:
 *   node .matrix/p5-signal.mjs
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKER = join(REPO, 'scripts/p5-v2-worker.mjs');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const SIGNAL = arg('signal', 'ws://127.0.0.1:8788/w2m/webrtc');
const ROOT = resolve(arg('work', join(REPO, '.matrix', `p5-local-${Date.now().toString(36)}`)));
const BYTES = Number(arg('bytes', String(1024 * 1024)));
const TIMEOUT_MS = Number(arg('timeout-ms', '300000'));
const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function waitForFile(file, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readJson(file);
    if (value !== null && predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${file}`);
}

function child(name, args) {
  const logDir = join(ROOT, 'logs');
  mkdirSync(logDir, { recursive: true });
  const out = spawn(process.execPath, [WORKER, ...args], {
    cwd: REPO,
    env: { ...process.env, W2M_WEBTORRENT_MODULE: process.env.W2M_WEBTORRENT_MODULE ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  out.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  out.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const record = { name, child: out, stdout, stderr, log: join(logDir, `${name}.log`) };
  out.on('close', () => {
    writeFileSync(record.log, `# stdout\n${stdout.join('')}\n# stderr\n${stderr.join('')}\n`, 'utf8');
  });
  return record;
}

async function waitExit(record, timeoutMs) {
  if (record.child.exitCode !== null) return record.child.exitCode;
  return Promise.race([
    new Promise((resolvePromise) => { record.child.once('close', resolvePromise); }),
    sleep(timeoutMs).then(() => {
      throw new Error(`${record.name} did not exit within ${timeoutMs} ms`);
    }),
  ]);
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  const keys = join(ROOT, 'keys.json');
  const keygen = child('keygen', ['keygen', '--ids', 'node-1,node-2,node-3,node-4', '--keys', keys]);
  const keyCode = await waitExit(keygen, 30_000);
  if (keyCode !== 0) throw new Error(`keygen failed: ${keygen.stderr.join('')}`);

  const payload = join(ROOT, 'payload.bin');
  const content = Buffer.alloc(BYTES);
  for (let index = 0; index < content.length; index += 1) content[index] = (index * 31 + 17) % 251;
  writeFileSync(payload, content);
  const digest = sha256(content);

  const seedCommon = [
    'seed',
    '--signal', SIGNAL,
    '--keys', keys,
    '--file', payload,
    '--hold-ms', '180000',
  ];
  const seed1Out = join(ROOT, 'seed-1.json');
  const seed2Out = join(ROOT, 'seed-2.json');
  const seed1 = child('seed-1', [...seedCommon, '--id', 'node-1', '--attach', 'node-3', '--attach-delay-ms', '10000', '--out', seed1Out, '--work', join(ROOT, 'seed-1')]);
  const seed2 = child('seed-2', [...seedCommon, '--id', 'node-2', '--attach', 'node-4', '--attach-delay-ms', '60000', '--out', seed2Out, '--work', join(ROOT, 'seed-2')]);

  const seeded1 = await waitForFile(seed1Out, (value) => value.share?.magnet_uri !== undefined, 60_000);
  const seeded2 = await waitForFile(seed2Out, (value) => value.share?.magnet_uri !== undefined, 60_000);
  if (seeded1.share.info_hash !== seeded2.share.info_hash) {
    throw new Error(`seeds disagree on info hash: ${seeded1.share.info_hash} vs ${seeded2.share.info_hash}`);
  }
  const magnet = seeded1.share.magnet_uri;

  const leechCommon = [
    'leech',
    '--signal', SIGNAL,
    '--keys', keys,
    '--magnet', magnet,
    '--expected-sha256', digest,
    '--timeout-ms', String(TIMEOUT_MS),
  ];
  const leech3Out = join(ROOT, 'leech-3.json');
  const leech4Out = join(ROOT, 'leech-4.json');
  const leech3 = child('leech-3', [...leechCommon, '--id', 'node-3', '--seeds', 'node-1', '--out', leech3Out, '--work', join(ROOT, 'leech-3')]);
  const leech4 = child('leech-4', [...leechCommon, '--id', 'node-4', '--seeds', 'node-2', '--start-delay-ms', '50000', '--out', leech4Out, '--work', join(ROOT, 'leech-4')]);
  const result3 = await waitForFile(leech3Out, (value) => value.mode === 'leech' && value.ok === true, TIMEOUT_MS + 30_000);
  const result4 = await waitForFile(leech4Out, (value) => value.mode === 'leech' && value.ok === true, TIMEOUT_MS + 30_000);

  for (const seed of [seed1, seed2]) {
    writeFileSync(join(ROOT, seed.name, 'stop'), '1');
  }
  await waitExit(leech3, 10_000);
  await waitExit(leech4, 10_000);
  await Promise.allSettled([waitExit(seed1, 10_000), waitExit(seed2, 10_000)]);

  const summary = {
    ok:
      seeded1.share.info_hash === seeded2.share.info_hash &&
      result3.sha256 === digest &&
      result4.sha256 === digest,
    signal: SIGNAL,
    work: ROOT,
    bytes: BYTES,
    sha256: digest,
    magnet,
    seeds: [
      { id: 'node-1', info_hash: seeded1.share.info_hash, attached: seeded1.attached ?? [] },
      { id: 'node-2', info_hash: seeded2.share.info_hash, attached: seeded2.attached ?? [] },
    ],
    leechers: [
      { id: 'node-3', sha256: result3.sha256, peers: result3.peers, file: join(ROOT, 'leech-3', 'dest', 'payload.bin') },
      { id: 'node-4', sha256: result4.sha256, peers: result4.peers, file: join(ROOT, 'leech-4', 'dest', 'payload.bin') },
    ],
    finished_at: new Date().toISOString(),
  };
  writeFileSync(join(ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 2;
  if (!KEEP) {
    // Keep evidence by default; `--clean` removes it, so the summary is never lost by accident.
  }
  await sleep(2_000);
  for (const record of [seed1, seed2, leech3, leech4]) {
    if (record.child.exitCode === null) record.child.kill();
  }
  rmSync(join(tmpdir(), 'w2m-p5-noop'), { force: true, recursive: true });
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({ ok: false, code: 'P5_LOCAL_MATRIX_FAILED', detail: error?.stack ?? String(error) }, null, 2) + '\n',
  );
  process.exitCode = 2;
});
