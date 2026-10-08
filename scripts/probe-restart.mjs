/**
 * Diagnostic probe for the crossnetwork scenario-3 failure.
 *
 * Reproduces the failing sequence in isolation and prints what actually happens
 * across a hard relay restart: whether devices are revived, whether the machines
 * re-establish their streams, what cursor they send, and whether the
 * post-restart offer reaches them.
 *
 * This is a probe, not a test. It is deliberately verbose.
 *
 * Usage: node scripts/probe-restart.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const TMP = join(REPO, '..', '_work', 'w2m', 'restart-probe');
const NODE = process.execPath;

const say = (m) => process.stdout.write(`[probe] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(join(TMP, 'run-'));
const relayState = join(root, 'relay-state');
mkdirSync(relayState, { recursive: true });

const AGENT = await import(pathToFileURL(join(REPO, 'src/agent/agent.mjs')).href);
const IDENT = await import(pathToFileURL(join(REPO, 'src/agent/identity.mjs')).href);
const CAPS = await import(pathToFileURL(join(REPO, 'src/agent/caps.mjs')).href);

const PORT = 8901 + Math.floor(Math.random() * 200);
const OPERATOR = 'probe-operator-token';

function startRelay() {
  const args = [
    join(REPO, 'bin', 'w2m-rabbit.mjs'),
    '--host', '127.0.0.1', '--port', String(PORT),
    '--state', relayState, '--json',
    '--operator-token', OPERATOR,
    '--pair-rate-limit', '0',
  ];
  const proc = spawn(NODE, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const h = { proc, stdout: '', stderr: '', info: null };
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c) => { h.stdout += c; });
  proc.stderr.on('data', (c) => { h.stderr += c; });
  return h;
}

async function waitListening(h) {
  for (let i = 0; i < 100; i += 1) {
    await sleep(150);
    const line = h.stdout.split('\n').find((l) => l.includes('"event":"listening"'));
    if (line) { h.info = JSON.parse(line); return h.info; }
    if (h.proc.exitCode !== null) throw new Error(`relay exited: ${h.stderr}`);
  }
  throw new Error(`relay never reported listening; stderr=${h.stderr}`);
}

const baseUrl = `http://127.0.0.1:${PORT}`;

/* ---- two machine checkouts ---- */
function git(args, cwd) {
  const o = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (o.status !== 0) throw new Error(`git ${args.join(' ')}: ${o.stderr}`);
  return o.stdout.trim();
}
const origin = join(root, 'origin');
mkdirSync(origin, { recursive: true });
git(['init', '--initial-branch=main', '.'], origin);
await import('node:fs').then(({ writeFileSync }) => {
  writeFileSync(join(origin, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(origin, 'app.mjs'), 'export const a = 1;\n');
});
git(['add', '-A'], origin);
git(['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-m', 'base'], origin);
const dirs = [join(root, 'ma'), join(root, 'mb')];
for (const d of dirs) git(['clone', '--quiet', '--no-hardlinks', origin, d], root);

let relay = startRelay();
let info = await waitListening(relay);
say(`relay up on ${baseUrl} relay_id=${info.relayId}`);

/* ---- two in-process agents, exactly like the scenario ---- */
const caps = await CAPS.probeCaps({});
const platform = await CAPS.detectPlatform({});
const agents = [];
const running = [];
let pairingCode = info.pairingCode;
for (const [i, dir] of dirs.entries()) {
  const sd = join(root, `state-${i}`);
  mkdirSync(sd, { recursive: true });
  const identity = IDENT.loadOrCreateIdentity({ dir: sd, name: `probe-${i}`, rabbitUrl: baseUrl }).identity;
  const agent = AGENT.createAgent({
    rabbitUrl: baseUrl, project: dir, stateDir: sd, identity, caps, platform,
    allowedCommands: [['node', '-e']],
    log: (lvl, msg, extra) => {
      if (lvl !== 'info') say(`  a${i} ${lvl}: ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
    },
  });
  agents.push(agent);
  const paired = await agent.pair(pairingCode);
  pairingCode = paired?.next_pairing_code ?? pairingCode;
  running.push(agent.start());
  say(`agent ${i} paired, stream starting`);
}
await sleep(2500);

const token = agents[0].identity.device_token;
const auth = { authorization: `Bearer ${token}` };

async function submit(label) {
  const r = await fetch(`${baseUrl}/v1/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify({
      mode: 'replicate',
      command_argv: [process.execPath, '-e', 'console.log("ok")'],
      index_total: 1, timeout_ms: 30_000, write: false,
    }),
  });
  const t = await r.json();
  say(`${label}: task ${t.task_id}`);
  return t.task_id;
}

async function verdict(taskId, budgetMs = 25_000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(300);
    const r = await fetch(`${baseUrl}/v1/tasks/${taskId}`, { headers: auth });
    if (!r.ok) continue;
    const b = await r.json();
    last = b.aggregate ?? b;
    if (last.status && last.status !== 'pending') return last;
  }
  return last;
}

const t1 = await submit('before');
const v1 = await verdict(t1);
say(`before  -> ${v1.status}  ${JSON.stringify(v1.machines.map((m) => `${m.machine_name}:${m.outcome}`))}`);

/* ---- hard kill + restart on the same port and state ---- */
say('SIGKILL relay');
relay.proc.kill('SIGKILL');
for (let i = 0; i < 40 && relay.proc.exitCode === null; i += 1) await sleep(100);
say(`relay exited code=${relay.proc.exitCode}`);

relay = startRelay();
info = await waitListening(relay);
say(`relay restarted relay_id=${info.relayId}`);

// Deliberately submit IMMEDIATELY, with no sleep: this is the window the
// failing scenario targets, where the offer is published while the machines'
// streams are still down. The re-offer-on-reconnect path is supposed to recover
// it; the question is whether it does.
const t2 = await submit('after (immediate)');

const health = await fetch(`${baseUrl}/healthz`).then((r) => r.json());
say(`healthz: devices=${health.devices} tasks=${health.tasks} results=${health.results} persistence=${JSON.stringify(health.persistence)}`);
const devices = await fetch(`${baseUrl}/v1/devices`, { headers: auth }).then((r) => r.json());
say(`devices after restart: ${JSON.stringify((devices.devices ?? []).map((d) => `${d.machine_name}:online=${d.online}`))}`);

say('waiting up to 60s for the post-restart verdict...');
const v2 = await verdict(t2, 60_000);
say(`after   -> ${v2.status}`);
for (const m of v2.machines ?? []) {
  say(`   ${m.machine_name} lease=${m.lease_state} outcome=${m.outcome} status=${m.status} reasons=${JSON.stringify(m.reasons)}`);
}

/* ---- the cursor question: what is the agent holding? ---- */
for (const [i, a] of agents.entries()) {
  const st = a.state ?? {};
  say(`agent ${i} state: seq=${st.seq} relayId=${st.relayId} connected=${st.connected} reconnects=${st.reconnectAttempts} relayIdChanges=${st.relayIdChanges} replayTruncated=${st.replayTruncated}`);
}

say('--- relay stderr (last 20 lines) ---');
for (const l of relay.stderr.split('\n').slice(-20)) if (l.trim()) say(`  ${l}`);

for (const a of agents) {
  try {
    await a.stop();
  } catch {
    /* teardown races are not failures */
  }
}
await Promise.allSettled(running);
relay.proc.kill('SIGKILL');
say(`done; scratch kept at ${root}`);
void existsSync; void readFileSync;
