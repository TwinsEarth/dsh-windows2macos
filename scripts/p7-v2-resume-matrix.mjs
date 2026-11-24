/** P7 resume: SIGKILL a real WebTorrent leecher mid-transfer, then finish from staging with a fresh seed. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKER = join(REPO, 'scripts/p5-v2-worker.mjs');
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}
const SIGNAL = arg('signal', 'ws://127.0.0.1:8791/w2m/webrtc');
const WORK = resolve(arg('work', join(REPO, '.matrix', 'p7-v2-resume')));
const PAYLOAD = resolve(arg('payload', '/home/user/p7-real/payload.bin'));
const KILL_AT = Number(arg('kill-at-bytes', String(20 * 1024 * 1024)));
const timeout = 240_000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
async function waitJson(file, predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = readJson(file);
    if (v && predicate(v)) return v;
    await sleep(100);
  }
  throw new Error(`timeout ${file}`);
}
function run(name, args) {
  mkdirSync(join(WORK, 'logs'), { recursive: true });
  const child = spawn(process.execPath, [WORKER, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      W2M_WEBTORRENT_MODULE: process.env.W2M_WEBTORRENT_MODULE ?? '/home/user/w2m-p7-deps/node_modules/webtorrent/index.js',
      W2M_WEBRTC_PROVIDER_CWD: process.env.W2M_WEBRTC_PROVIDER_CWD ?? '/home/user/w2m-p7-deps',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  child.stdout.on('data', (c) => out.push(String(c)));
  child.stderr.on('data', (c) => out.push(String(c)));
  return { name, child, out };
}
async function exit(record) {
  if (record.child.exitCode !== null) return record.child.exitCode;
  return new Promise((r) => { record.child.once('close', r); });
}
async function main() {
  rmSync(WORK, { force: true, recursive: true });
  mkdirSync(WORK, { recursive: true });
  const keys = join(WORK, 'keys.json');
  const kg = run('keygen', ['keygen', '--ids', 'seed-r1,seed-r2,leech-r', '--keys', keys]);
  if ((await exit(kg)) !== 0) throw new Error(`keygen failed: ${kg.out.join('')}`);
  const seedArgs = ['seed', '--signal', SIGNAL, '--keys', keys, '--file', PAYLOAD, '--hold-ms', '180000'];
  const seed1Out = join(WORK, 'seed-r1.json');
  const seed1 = run('seed-r1', [...seedArgs, '--id', 'seed-r1', '--attach', 'leech-r', '--attach-delay-ms', '3000', '--out', seed1Out, '--work', join(WORK, 'seed-r1')]);
  const seeded = await waitJson(seed1Out, (v) => v.share?.magnet_uri !== undefined, 120_000);
  const infoHash = seeded.share.info_hash;
  const digest = createHash('sha256').update(readFileSync(PAYLOAD)).digest('hex');
  const stagingDir = join(WORK, 'leech-r', `.w2m-partial-${infoHash}`);
  const stagingFile = join(stagingDir, 'payload.bin');
  const leechArgs = ['leech', '--id', 'leech-r', '--signal', SIGNAL, '--keys', keys, '--magnet', seeded.share.magnet_uri, '--expected-sha256', digest, '--timeout-ms', String(timeout), '--work', join(WORK, 'leech-r')];
  const firstOut = join(WORK, 'leech-r-first.json');
  const first = run('leech-r-first', [...leechArgs, '--seeds', 'seed-r1', '--out', firstOut]);
  let killedAt = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && first.child.exitCode === null) {
    await sleep(20);
    try {
      const size = statSync(stagingFile).size;
      if (size >= KILL_AT) {
        killedAt = size;
        first.child.kill('SIGKILL');
        break;
      }
    } catch {}
  }
  if (killedAt === null) throw new Error('first transfer completed before kill');
  await exit(first);
  const stagingAfterFirst = existsSync(stagingFile) ? statSync(stagingFile).size : null;
  await sleep(2_000);
  const seed2Out = join(WORK, 'seed-r2.json');
  const seed2 = run('seed-r2', [...seedArgs, '--id', 'seed-r2', '--attach', 'leech-r', '--attach-delay-ms', '3000', '--out', seed2Out, '--work', join(WORK, 'seed-r2')]);
  await waitJson(seed2Out, (v) => v.share?.magnet_uri !== undefined, 120_000);
  const secondOut = join(WORK, 'leech-r-second.json');
  run('leech-r-second', [...leechArgs, '--seeds', 'seed-r2', '--out', secondOut]);
  let result;
  try {
    result = await waitJson(secondOut, (v) => v.mode === 'leech' && typeof v.sha256 === 'string', timeout + 30_000);
  } finally {
    for (const r of [seed1, seed2]) r.child.kill();
  }
  const summary = {
    ok: result.ok === true && result.sha256 === digest,
    killed_at_staging_bytes: killedAt,
    staging_after_first: stagingAfterFirst,
    second_run: { ok: result.ok, code: result.code ?? null, sha256: result.sha256 ?? null, bytes: result.bytes, progress: result.progress },
    expected_sha256: digest,
    signal: SIGNAL,
    work: WORK,
  };
  writeFileSync(join(WORK, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 2;
}
main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, code: 'P7_RESUME_FAILED', detail: error?.stack ?? String(error) }, null, 2) + '\n');
  process.exitCode = 2;
});
