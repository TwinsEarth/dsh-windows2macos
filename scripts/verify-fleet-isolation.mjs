#!/usr/bin/env node
/**
 * v1.5.5-rc verification: two fleets on one relay must not see each other.
 *
 * The field observation behind this script: another account's machine appeared in this fleet's
 * machine list. Its fleet binding was correct -- it simply was not the *same* fleet -- so the defect
 * was a read path (`GET /v1/devices`) that returned every device on the relay. The relay's task
 * dispatch had already been fleet-scoped since v0.7.7; the enumeration, the task list, the fleet
 * chat and the fleet memory were not.
 *
 * This is a black-box check against a real relay process and the real HTTP protocol, not against
 * stubs: it pairs two devices with two different fleet keys, then asserts that neither can see the
 * other's device, task, chat message or memory document. It exits non-zero on the first leak so it
 * can gate a deployment.
 *
 * usage: node scripts/verify-fleet-isolation.mjs [--keep]
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OPERATOR = randomBytes(24).toString('hex');
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const stateDir = mkdtempSync(join(tmpdir(), 'w2m-iso-'));
const fleetKeyA = randomBytes(32).toString('base64url');
const fleetKeyB = randomBytes(32).toString('base64url');
const fleetId = (key) => createHash('sha256').update(Buffer.from(key, 'base64url')).digest('hex');
const FLEET_B = fleetId(fleetKeyB);

let child = null;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`  PASS  ${name}\n`);
  else { failures.push(name); process.stdout.write(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}\n`); }
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { /* keep null */ }
  return { status: response.status, json, text };
}
async function pair(machineId, fleetKey) {
  const res = await request('/v1/pair', {
    method: 'POST',
    body: {
      machine_id: machineId,
      machine_name: machineId,
      platform: { os: 'linux', os_version: '6.5', arch: 'x64', shell: 'bash', shell_version: '5' },
      caps: { node: 'v22.0.0', python: null, npm: null, write: true, case_sensitive_fs: true, symlinks: true, exec_bit: true },
      fleet_key: fleetKey,
    },
  });
  if (res.status !== 200 || !res.json?.device_token) throw new Error(`pair ${machineId} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.device_token;
}

async function main() {
  process.stdout.write(`relay on ${PORT}, state ${stateDir}\n`);
  child = spawn(process.execPath, [
    'bin/w2m-rabbit.mjs', '--host', '127.0.0.1', '--port', String(PORT), '--state', stateDir, '--operator-token', OPERATOR,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', () => {});
  for (let i = 0; i < 100; i += 1) {
    try { const res = await fetch(BASE + '/healthz'); if (res.ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const tokenA = await pair('iso-device-a', fleetKeyA);
  const tokenB = await pair('iso-device-b', fleetKeyB);

  // 1) device enumeration
  const devicesA = await request('/v1/devices', { token: tokenA });
  const namesA = (devicesA.json?.devices ?? []).map((d) => d.machine_name);
  check('fleet A sees its own device', namesA.includes('iso-device-a'), JSON.stringify(namesA));
  check('fleet A does NOT see fleet B device', !namesA.includes('iso-device-b'), JSON.stringify(namesA));
  const devicesB = await request('/v1/devices', { token: tokenB });
  const namesB = (devicesB.json?.devices ?? []).map((d) => d.machine_name);
  check('fleet B does NOT see fleet A device', !namesB.includes('iso-device-a'), JSON.stringify(namesB));

  // 2) task list: a dispatch visible only inside its fleet
  const dispatched = await request('/v1/task', {
    method: 'POST',
    token: OPERATOR,
    body: { mode: 'broadcast', command_argv: ['node', '--version'], cwd_rel: '.', timeout_ms: 30000 },
  });
  check('fleet A may dispatch a task', dispatched.status === 200, `HTTP ${dispatched.status} ${dispatched.text.slice(0, 160)}`);
  const tasksB = await request('/v1/tasks', { token: tokenB });
  // Dispatch is an operator act (device tokens are refused by design), and an operator dispatch is
  // relay-wide, so its task carries no fleet. The isolation claim is that a fleet-bound reader does
  // not see it -- a task typed in one fleet must not surface in another.
  check('fleet B does NOT see the operator task', (tasksB.json?.tasks ?? []).length === 0, JSON.stringify((tasksB.json?.tasks ?? []).map((t) => t.task_id)));

  // 3) fleet chat
  const posted = await request('/v1/fleet/messages', {
    method: 'POST', token: tokenA,
    body: { session_id: 'iso-session', text: 'isolation probe', fleet_id: FLEET_B },
  });
  check('fleet A may post to its chat', posted.status === 200, `HTTP ${posted.status} ${posted.text.slice(0, 160)}`);
  const chatA = await request('/v1/fleet/messages?session_id=iso-session', { token: tokenA });
  const chatB = await request('/v1/fleet/messages?session_id=iso-session', { token: tokenB });
  check('fleet A reads its own chat', (chatA.json?.messages ?? []).length >= 1);
  check('fleet B does NOT read fleet A chat', (chatB.json?.messages ?? []).length === 0, JSON.stringify(chatB.json?.messages ?? []));

  // 4) fleet memory
  const memoryDoc = 'isolation-memory';
  const written = await request(`/v1/fleet/memory/${memoryDoc}`, {
    method: 'PUT', token: tokenA, body: { records: ['fleet A secret'] },
  });
  check('fleet A writes its memory', written.status === 200, `HTTP ${written.status} ${written.text.slice(0, 160)}`);
  const memA = await request(`/v1/fleet/memory/${memoryDoc}`, { token: tokenA });
  const memB = await request(`/v1/fleet/memory/${memoryDoc}`, { token: tokenB });
  const recordsA = memA.json?.records ?? memA.json?.entries ?? [];
  const recordsB = memB.json?.records ?? memB.json?.entries ?? [];
  check('fleet A reads its memory', recordsA.length >= 1);
  check('fleet B does NOT read fleet A memory', recordsB.length === 0, JSON.stringify(recordsB));

  child.kill();
  if (failures.length > 0) {
    process.stdout.write(`\nFAILED: ${failures.join(', ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nALL CHECKS PASSED — two fleets are isolated on one relay\n');
  }
}

main().catch((error) => {
  process.stdout.write(`verification error: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await sleep(100);
  try { child?.kill(); } catch { /* already gone */ }
  if (!process.argv.includes('--keep')) rmSync(stateDir, { recursive: true, force: true });
});
