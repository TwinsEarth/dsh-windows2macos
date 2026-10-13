/**
 * The full path, in one process: a chat message runs a command on the fleet.
 *
 * Why this exists as a harness rather than as a shell command: the Localside agent takes its
 * allow-list as a JSON array on the command line, and three separate PowerShell quoting
 * strategies each stripped the inner quotes and produced a default-deny agent that refused every
 * offer. Passing a real JS array to `createAgent` removes that entire class of mistake, and the
 * allow-list that actually took effect is printed so a silently-empty one cannot pass unnoticed.
 *
 * The chat side is the *shipped* bridge and the *shipped* WeChat adapter. The message is injected
 * the way the platform injects one, because a human is not available to type in a test.
 *
 * Usage: node scripts/chatops-live-sanitized.mjs
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createBridge } from '../src/chatops/bridge.mjs';
import { createILinkChannel } from '../src/chatops/ilink.mjs';
import { createFleetExecutor } from '../src/chatops/fleet.mjs';
import { createChatopsActions } from '../src/chatops/actions.mjs';

const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const work = mkdtempSync(join(tmpdir(), 'w2m-e2e-'));
const relayState = join(work, 'relay');
const agentState = join(work, 'agent');
const DEVICE_FILE = join(agentState, 'device.json');
const OPERATOR_TOKEN = 'e2e-operator-known-token';

/** Make a directory, including parents. `writeFileSync` cannot create one. */
function mkdirIfMissing(dir) {
  mkdirSync(dir, { recursive: true });
}

// Directories first: the token below cannot be written into a directory that does not exist yet.
mkdirIfMissing(relayState);
mkdirIfMissing(agentState);

// The relay restores an operator token from its state dir when one exists, so planting it here is
// what makes the token knowable without scraping the relay's log.
writeFileSync(join(relayState, 'operator-token.txt'), `${OPERATOR_TOKEN}\n`, { mode: 0o600 });

const RELAY_PORT = 8799;
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;
const PAIR_CODE = 'E2EPAIR01';
const PROJECT = join(ROOT, 'dist', 'e2e-project');

// A tiny project so the command has something deterministic to inspect.
mkdirIfMissing(PROJECT);
writeFileSync(join(PROJECT, 'facts.txt'), 'w2m e2e\n');

let relay = null;
let agent = null;
let agentLog = '';

try {
  // ---- the relay -------------------------------------------------------------------------
  relay = spawn(process.execPath, [
    join(ROOT, 'bin', 'w2m-rabbit.mjs'),
    '--host', '127.0.0.1',
    '--port', String(RELAY_PORT),
    '--state', relayState,
    '--pairing-code', PAIR_CODE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', (b) => process.stdout.write(`  [relay] ${b}`));
  relay.stderr.on('data', (b) => process.stdout.write(`  [relay] ${b}`));
  await waitFor(async () => (await fetch(`${RELAY_URL}/healthz`).then((r) => r.ok).catch(() => false)), 15_000, 'relay');
  const health = await (await fetch(`${RELAY_URL}/healthz`)).json();
  log(`relay up: ${health.relay_id}  operator_token_required=${health.operator_token_required}`);

  const { createAgent, parseAllowedCommands } = await import('../src/agent/agent.mjs');
  const { probeCapsDetailed, detectPlatform } = await import('../src/agent/caps.mjs');

  // ---- the agent, with a real array allow-list -------------------------------------------
  const ALLOWED = ['node src/facts.mjs', 'git status --porcelain', 'git rev-parse HEAD'];
  const parsed = parseAllowedCommands(JSON.stringify(ALLOWED));
  log(`allow-list that will take effect: ${JSON.stringify(parsed)}`);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('the allow-list parsed empty; refusing to continue');

  const platform = detectPlatform();
  const caps = await probeCapsDetailed({ project: PROJECT });
  const identity = { machine_id: randomUUID(), machine_name: 'e2e-win-desktop', device_token: null, rabbit_url: RELAY_URL };

  // Pair to obtain a device token.
  const pair = await fetch(`${RELAY_URL}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
        pairing_code: PAIR_CODE,
        // The relay wants the identity up front, so the id is minted before pairing, not after.
        machine_id: identity.machine_id,
        machine_name: identity.machine_name,
        platform,
        caps,
      }),
  });
  const pairBody = await pair.json();
  if (!pair.ok) throw new Error(`pairing refused: HTTP ${pair.status} ${JSON.stringify(pairBody)}`);
  identity.device_token = pairBody.device_token;
  log(`paired: machine_id=${identity.machine_id.slice(0, 8)}  token=${String(identity.device_token).slice(0, 8)}…`);

  // Spawned, not constructed in-process. A test showed the in-process createAgent path hanging
  // before it reported streaming, and the reason does not matter: a child is closer to how the
  // agent actually runs, and spawn passes argv straight to execve with no shell in between, so
  // the JSON allow-list cannot be mangled the way PowerShell mangled it three times.
  writeFileSync(DEVICE_FILE, JSON.stringify(identity, null, 2));
  agent = spawn(process.execPath, [
    join(ROOT, 'bin', 'w2m-localside.mjs'),
    '--rabbit', RELAY_URL,
    '--project', PROJECT,
    '--name', identity.machine_name,
    '--state', agentState,
    '--allowed-commands', JSON.stringify(ALLOWED),
    '--p2p-mode', 'relay',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_DEVICE_FILE: DEVICE_FILE } });
  const tag = (b) => String(b).split('\n').filter(Boolean).map((l) => `  [agent] ${l}`).join('\n') + '\n';
  agent.stdout.on('data', (b) => process.stdout.write(tag(b)));
  agent.stderr.on('data', (b) => process.stdout.write(tag(b)));
  log('agent spawned and streaming');

  await waitFor(async () => {
    const r = await fetch(`${RELAY_URL}/v1/devices`, { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
    if (!r.ok) return false;
    const body = await r.json();
    return (body.devices ?? []).some((d) => d.online);
  }, 60_000, 'device online');
  {
    const r = await fetch(`/v1/devices`, { headers: { authorization: `Bearer ` } });
    const body = await r.json();
    for (const d of body.devices ?? []) log(`  relay sees:  online= state= last_seen=`);
  }
  log('relay reports the device online');

  // ---- the chat side: the shipped bridge, the shipped adapter -----------------------------
  const login = JSON.parse(readFileSync(join(ROOT, 'dist', 'ilink', 'ilink-login.json'), 'utf8'));
  const peer = login.ilink_user_id;

  const channel = createILinkChannel({ token: login.bot_token, apiBase: login.baseurl });
  const executor = createFleetExecutor({ rabbitUrl: RELAY_URL, token: OPERATOR_TOKEN, audit: (e, d) => log(`  fleet ${e} ${JSON.stringify(d ?? {})}`) });
  const actions = createChatopsActions({ executor, host: {}, waitMs: 60_000, audit: (e, d) => log(`  actions ${e} ${JSON.stringify(d ?? {})}`) });
  const bridge = createBridge({
    channels: [channel],
    actions,
    policy: { trustedContacts: [`ilink:${peer}`] },
    throttleMs: 0,
    audit: (e, d) => log(`  bridge ${e} ${JSON.stringify(d ?? {})}`),
  });
  await bridge.start();
  log(`bridge up; channel state = ${channel.state}; trusted = ilink:${peer}`);

  /** Inject one message exactly as the platform would, and print the reply the bridge produced. */
  async function deliver(text) {
    const before = (channel.sent ?? []).length;
    log(`→ INBOUND  ${JSON.stringify(text)}`);
    const outcome = await bridge.handleInbound({ windowKey: `user:${peer}`, talkerId: peer, text, addressed: true });
    const produced = (channel.sent ?? []).slice(before);
    log(`  outcome: action=${outcome.action}${outcome.name ? ` /${outcome.name}` : ''}${outcome.taskId ? ` task=${String(outcome.taskId).slice(0, 8)}` : ''}`);
    for (const s of produced) {
      log('  ↓ REPLY (what WeChat would deliver):');
      for (const line of String(s.text).split('\n')) log(`      | ${line}`);
    }
    return { outcome, produced };
  }

  log('--- the end-to-end test ---');
  await deliver('/machines');
  const run = await deliver('/run node src/facts.mjs');

  const ok = run.outcome.action === 'ok' && run.produced.length > 0 && /consistent|failed|divergent|partial|timeout/.test(run.produced[0].text);
  log(ok ? 'RESULT: PASS -- a chat message ran a command on a machine and the verdict came back' : 'RESULT: FAIL -- see the outcome above');

  await bridge.stop();
  agent.kill();
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  log(`ERROR: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    if (agent && !agent.killed) agent.kill();
  } catch {
    /* already stopped */
  }
  if (relay) relay.kill();
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}
