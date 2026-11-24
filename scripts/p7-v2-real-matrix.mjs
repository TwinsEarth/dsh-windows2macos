/**
 * P7 real matrix: three-plus logical nodes, two seeds, multi-seed leecher, 100 MiB,
 * and memory sampling. The separate resume runner covers process-kill recovery.
 *
 * This runner is deliberately local-process based. It proves the V2 data plane and
 * orchestration; it does not claim cross-physical-machine NAT traversal.
 *
 * Usage:
 *   node scripts/p7-v2-real-matrix.mjs \
 *     --signal ws://127.0.0.1:8791/w2m/webrtc \
 *     --work .matrix/p7-v2-real
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const SIGNAL = arg('signal', 'ws://127.0.0.1:8791/w2m/webrtc');
const WORK = resolve(arg('work', join(REPO, '.matrix', `p7-v2-real-${Date.now().toString(36)}`)));
const BYTES = Number(arg('bytes', String(100 * 1024 * 1024)));
const TIMEOUT_MS = Number(arg('timeout-ms', '600000'));
const MODULE = process.env.W2M_WEBTORRENT_MODULE ?? '';
const PROVIDER_CWD = process.env.W2M_WEBRTC_PROVIDER_CWD ?? '';

const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });

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

function rssKb(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/im);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function child(name, args) {
  const logDir = join(WORK, 'logs');
  mkdirSync(logDir, { recursive: true });
  const out = spawn(process.execPath, [WORKER, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      ...(MODULE === '' ? {} : { W2M_WEBTORRENT_MODULE: MODULE }),
      ...(PROVIDER_CWD === '' ? {} : { W2M_WEBRTC_PROVIDER_CWD: PROVIDER_CWD }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  out.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  out.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const record = { name, child: out, pid: out.pid, stdout, stderr, log: join(logDir, `${name}.log`) };
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

function writeSizedFile(file, bytes) {
  const chunks = Math.ceil(bytes / (1024 * 1024));
  let remaining = bytes;
  const digest = createHash('sha256');
  const out = [];
  for (let index = 0; index < chunks; index += 1) {
    const size = Math.min(1024 * 1024, remaining);
    const buffer = Buffer.alloc(size);
    for (let offset = 0; offset < size; offset += 1) {
      buffer[offset] = ((index * 131 + offset) * 31 + 17) % 251;
    }
    digest.update(buffer);
    out.push(buffer);
    remaining -= size;
  }
  writeFileSync(file, Buffer.concat(out));
  return digest.digest('hex');
}

async function main() {
  rmSync(WORK, { force: true, recursive: true });
  mkdirSync(WORK, { recursive: true });
  const keys = join(WORK, 'keys.json');
  const ids = 'seed-1,seed-2,seed-3,leech-a,leech-b,leech-c';
  const keygen = child('keygen', ['keygen', '--ids', ids, '--keys', keys]);
  const keyCode = await waitExit(keygen, 30_000);
  if (keyCode !== 0) throw new Error(`keygen failed: ${keygen.stderr.join('')}`);

  const payload = join(WORK, 'payload.bin');
  const digest = writeSizedFile(payload, BYTES);
  const seedCommon = [
    'seed',
    '--signal', SIGNAL,
    '--keys', keys,
    '--file', payload,
    '--hold-ms', '300000',
  ];
  const seed1Out = join(WORK, 'seed-1.json');
  const seed2Out = join(WORK, 'seed-2.json');
  const seed1 = child('seed-1', [...seedCommon, '--id', 'seed-1', '--attach', 'leech-a', '--attach-delay-ms', '8000', '--out', seed1Out, '--work', join(WORK, 'seed-1')]);
  const seed2 = child('seed-2', [...seedCommon, '--id', 'seed-2', '--attach', 'leech-a,leech-b', '--attach-delay-ms', '8000', '--out', seed2Out, '--work', join(WORK, 'seed-2')]);
  const seeded1 = await waitForFile(seed1Out, (value) => value.share?.magnet_uri !== undefined, 120_000);
  const seeded2 = await waitForFile(seed2Out, (value) => value.share?.magnet_uri !== undefined, 120_000);
  if (seeded1.share.info_hash !== seeded2.share.info_hash) {
    throw new Error(`seeds disagree on info hash: ${seeded1.share.info_hash} vs ${seeded2.share.info_hash}`);
  }
  const magnet = seeded1.share.magnet_uri;

  const peaks = new Map();
  const sampler = setInterval(() => {
    for (const record of [seed1, seed2]) {
      const kb = rssKb(record.pid);
      if (kb !== null) peaks.set(record.name, Math.max(peaks.get(record.name) ?? 0, kb));
    }
  }, 250);

  const leechCommon = [
    'leech',
    '--signal', SIGNAL,
    '--keys', keys,
    '--magnet', magnet,
    '--expected-sha256', digest,
    '--timeout-ms', String(TIMEOUT_MS),
  ];
  const leechAOut = join(WORK, 'leech-a.json');
  const leechBOut = join(WORK, 'leech-b.json');
  const leechA = child('leech-a', [...leechCommon, '--id', 'leech-a', '--seeds', 'seed-1,seed-2', '--out', leechAOut, '--work', join(WORK, 'leech-a')]);
  const leechB = child('leech-b', [...leechCommon, '--id', 'leech-b', '--seeds', 'seed-2', '--start-delay-ms', '3000', '--out', leechBOut, '--work', join(WORK, 'leech-b')]);
  const leechSampler = setInterval(() => {
    for (const record of [leechA, leechB]) {
      const kb = rssKb(record.pid);
      if (kb !== null) peaks.set(record.name, Math.max(peaks.get(record.name) ?? 0, kb));
    }
  }, 250);

  let resultA;
  let resultB;
  try {
    resultA = await waitForFile(leechAOut, (value) => value.mode === 'leech' && value.ok === true, TIMEOUT_MS + 60_000);
    resultB = await waitForFile(leechBOut, (value) => value.mode === 'leech' && value.ok === true, TIMEOUT_MS + 60_000);
  } finally {
    clearInterval(sampler);
    clearInterval(leechSampler);
  }

  const summary = {
    ok:
      resultA.sha256 === digest &&
      resultB.sha256 === digest,
    signal: SIGNAL,
    work: WORK,
    bytes: BYTES,
    sha256: digest,
    nodes: 4,
    seeds: 2,
    multi_seed_leecher: { id: 'leech-a', seeds: ['seed-1', 'seed-2'], sha256: resultA.sha256, peers: resultA.peers },
    single_seed_leecher: { id: 'leech-b', seeds: ['seed-2'], sha256: resultB.sha256, peers: resultB.peers },
    peak_rss_kb: Object.fromEntries(peaks),
    finished_at: new Date().toISOString(),
  };

  for (const seed of [seed1, seed2]) writeFileSync(join(WORK, seed.name, 'stop'), '1');

  writeFileSync(join(WORK, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 2;

  await sleep(1_000);
  for (const record of [seed1, seed2, leechA, leechB]) {
    if (record.child.exitCode === null) record.child.kill();
  }
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({ ok: false, code: 'P7_REAL_MATRIX_FAILED', detail: error?.stack ?? String(error) }, null, 2) + '\n',
  );
  process.exitCode = 2;
});
