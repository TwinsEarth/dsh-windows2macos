/**
 * Diagnostic probe (not part of the test suite).
 *
 * The E2E run hung. This script narrows down *where* by driving the same
 * sequence the E2E test drives, printing a line at every step so the last
 * printed line names the step that never returned.
 *
 * Usage: node scripts/probe-e2e.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/DS/w2m';
const TMP = 'E:/DS/_work/w2m/probe-tmp';
const NODE = process.execPath;

const step = (msg) => process.stdout.write(`[probe] ${msg}\n`);

function git(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(join(TMP, 'probe-'));
step(`scratch ${root}`);

const origin = join(root, 'origin');
mkdirSync(origin, { recursive: true });
git(['init', '--initial-branch=main', '.'], origin);
writeFileSync(join(origin, '.gitattributes'), '* text=auto eol=lf\n');
writeFileSync(join(origin, 'app.mjs'), 'export const answer = 42;\n');
git(['add', '-A'], origin);
git(['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-m', 'base'], origin);
const base = git(['rev-parse', 'HEAD'], origin);
step(`origin at ${base}`);

const a = join(root, 'a');
const b = join(root, 'b');
git(['worktree', 'add', '--detach', a, base], origin);
git(['worktree', 'add', '--detach', b, base], origin);
step('two worktrees ready');

const { createRelayServer } = await import(pathToFileURL(join(ROOT, 'src/relay/server.mjs')).href);
step('relay module loaded');

const relay = createRelayServer({ pairingCodeReusable: true });
const info = await relay.listen({ host: '127.0.0.1', port: 0 });
step(`relay listening ${info.url} pairing=${info.pairingCode}`);

const { createAgent } = await import(pathToFileURL(join(ROOT, 'src/agent/agent.mjs')).href);
const { loadOrCreateIdentity } = await import(pathToFileURL(join(ROOT, 'src/agent/identity.mjs')).href);
const { probeCaps, detectPlatform } = await import(pathToFileURL(join(ROOT, 'src/agent/caps.mjs')).href);
step('agent modules loaded');

const caps = await probeCaps({});
const platform = await detectPlatform({});
step(`caps=${JSON.stringify(caps)}`);
step(`platform=${JSON.stringify(platform)}`);

const agents = [];
const startPromises = [];
for (const [i, dir] of [a, b].entries()) {
  const stateDir = join(root, `state-${i}`);
  mkdirSync(stateDir, { recursive: true });
  const identity = loadOrCreateIdentity({ dir: stateDir, name: `probe-${i}`, rabbitUrl: info.url }).identity;
  step(`identity ${i}: ${identity.machine_id}`);
  const agent = createAgent({
    rabbitUrl: info.url,
    project: dir,
    stateDir,
    identity,
    caps,
    platform,
    pairingCode: info.pairingCode,
    allowedCommands: [['node', '-e'], ['node', '--test'], ['git', 'status']],
    log: (level, message, extra) => step(`agent${i} ${level}: ${message} ${extra ? JSON.stringify(extra) : ''}`),
  });
  agents.push(agent);
  // Pairing is its own step: `createAgent` takes the identity and a pairing step
  // because a machine may already be paired (token on disk) and must not be
  // re-paired on every start.
  step(`agent ${i} pairing...`);
  const paired = await agent.pair(info.pairingCode);
  step(`agent ${i} paired: ${JSON.stringify(paired)} token=${agent.identity.device_token ? 'present' : 'MISSING'}`);
  step(`agent ${i} calling start() (not awaited: it is the long-running loop)...`);
  startPromises.push(agent.start().then(
    () => step(`agent ${i} start() resolved`),
    (error) => step(`agent ${i} start() rejected: ${error?.message}`),
  ));
  step(`agent ${i} start() launched`);
}

const token = agents[0].identity.device_token;
step(`submitting task with token ${token ? 'present' : 'MISSING'}`);

const res = await fetch(`${info.url}/v1/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    mode: 'replicate',
    command_argv: [NODE, '-e', 'console.log("same")'],
    index_total: 1,
    timeout_ms: 15_000,
    write: false,
  }),
});
step(`POST /v1/task -> ${res.status} ${await res.text()}`);

for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await fetch(`${info.url}/v1/tasks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await s.json();
  const last = body.tasks?.[0];
  step(`poll ${i}: tasks=${body.tasks?.length} last=${last ? `${last.task_id} ${last.status ?? ''}` : 'none'}`);
  if (last) {
    const one = await fetch(`${info.url}/v1/tasks/${last.task_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const detail = await one.json();
    step(`  aggregate=${JSON.stringify(detail.aggregate?.status)} leases=${(detail.leases ?? []).map((l) => `${l.machine_id.slice(0, 8)}:${l.state}`).join(',')}`);
    if (detail.aggregate?.status && detail.aggregate.status !== 'pending') break;
  }
}

step('stopping agents');
for (const agent of agents) await agent.stop();
await relay.close();
step('done');
rmSync(root, { recursive: true, force: true });
