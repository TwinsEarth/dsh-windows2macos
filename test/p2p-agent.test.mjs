/**
 * The agent as a P2P peer (v0.4.0): an offer that arrives over a channel, and a result that leaves
 * over one.
 *
 * Everything here is real, and that is why this suite exists next to `test/agent.test.mjs`'s fake
 * relay: a real relay with the real P2P routes, a real Localside agent, a real dispatcher built from
 * a bare `P2PNode`, and **real UDP sockets on the loopback interface**. The offer is sent as a real
 * `task.offer` frame over a real punched channel, and the result comes back over that same channel.
 *
 * HONEST LIMIT, stated where it matters (the repo says this in writing, and it is true here): a
 * loopback punch crosses **no NAT**. Both ends share one host and one address family, so nothing in
 * this file is evidence of traversal. What it does prove is the agent's own contracts -- which path
 * an offer arrived on, that a duplicate delivery of one attempt executes once, that the relay copy is
 * posted whatever the direct path does, and that `relay` mode touches no socket at all.
 *
 * Harness: the relay helpers follow the style of `test/p2p-signaling.test.mjs` and
 * `test/p2p-transport-fields.test.mjs` (suites must not break each other by editing a shared module),
 * and the agent fixtures follow `test/e2e.test.mjs` -- real identity, real caps, real git project,
 * real commands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRelayServer } from '../src/relay/server.mjs';
import { AGENT_STATE_FILE, createAgent } from '../src/agent/agent.mjs';
import { loadOrCreateIdentity } from '../src/agent/identity.mjs';
import { bindUdpSocket } from '../src/agent/stun.mjs';
import { deriveSession } from '../src/agent/p2p.mjs';
import { P2PNode, P2P_DEFAULTS, SHARED_SERVER } from '../src/agent/p2p-node.mjs';

const NODE = process.execPath;

const OP = 'p2p-agent-operator-token';
const PLATFORM = { os: 'windows', os_version: '10.0.26100', arch: 'x64', shell: 'pwsh', shell_version: '7.4.0' };
const CAPS = {
  case_sensitive_fs: false,
  symlinks: false,
  exec_bit: false,
  python: null,
  npm: null,
  node: 'v24.21.0',
  write: true,
};

/**
 * The dispatcher's machine id (the plugin's role).
 *
 * A documented placeholder, not the real one: the dispatcher's id lives in `dispatcher.device`
 * (`makeDispatcher` pairs a real machine and returns its token and id), because the relay has to
 * know a machine before it can be dialled. This constant is only the *origin* the task body claims
 * and the label a test that has no dispatcher uses for an unannounced observer.
 */
const DISPATCHER = 'plugin-dispatcher';

/**
 * The machine the agent runs as, taken from the agent's own P2P status.
 *
 * The agent's `machine_id` comes from `loadOrCreateIdentity`, which generates a UUID -- so
 * hard-coding one in the test would be testing a machine that does not exist. Asking the agent is
 * also the only *unambiguous* answer: a relay may hold devices from another run (see
 * `nextDispatcherId`), and picking "the roster entry that is not the dispatcher" would then pick
 * somebody else's machine.
 */
function agentMachineId(agent) {
  return agent.state.p2p.machine_id;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const scratch = [];

function scratchDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `w2m-p2p-agent-${name}-`));
  scratch.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows keeps a busy directory a little longer; the OS cleans tmp up. */
    }
  }
});

/** A one-commit git repository, so the agent's anchors are real rather than warnings. */
function makeRepo(name) {
  const dir = scratchDir(`repo-${name}`);
  const git = (args) => {
    const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr || out.stdout}`);
    return out.stdout.trim();
  };
  git(['init', '--initial-branch=main']);
  writeFileSync(join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(dir, 'tracked.txt'), 'line one\n');
  git(['add', '-A']);
  git(['-c', 'user.name=w2m-test', '-c', 'user.email=w2m@test.invalid', 'commit', '-m', 'base']);
  return { dir, commit: git(['rev-parse', 'HEAD']) };
}

function request(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, json, text });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

/** Poll a predicate with a deadline. Only used where no event reports the fact. */
async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

/**
 * A real relay, in memory.
 *
 * `persist: false` is deliberate and load-bearing: with the default persistence the relay loads the
 * devices and tasks of a **previous** run, and a task posted here would then be leased to machines
 * that belong to somebody else's test -- which is exactly how the first version of this file failed
 * (`pending` forever, because the offer had gone to a machine from an earlier suite).
 */
async function startRelay() {
  const relay = createRelayServer({
    logger: null,
    operatorToken: OP,
    stateDir: scratchDir('relay-state'),
    persist: false,
  });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  return { relay, url: relay.url, operatorToken: relay.operatorToken ?? OP };
}

async function pairDevice(relay, machineId) {
  const res = await request(`${relay.url}/v1/pair`, {
    method: 'POST',
    body: {
      pairing_code: relay.state.createPairingCode(),
      machine_id: machineId,
      machine_name: machineId,
      platform: PLATFORM,
      caps: CAPS,
    },
  });
  assert.equal(res.status, 200, `pair failed: ${res.text}`);
  return { token: res.json.device_token, machineId };
}

/**
 * The two relay calls a `P2PNode` needs, over real HTTP, with a real device token.
 *
 * `ok` is part of the node's documented response shape and is what it branches on, so it is
 * derived from the status here rather than left out -- a wrapper that returned only `{status, json}`
 * would make every announcement look refused and every candidate lookup look like a 404.
 */
function relayTransport(baseUrl, token) {
  const call = async (method, path, body) => {
    const res = await request(`${baseUrl}${path}`, { method, token, body });
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: res.json, text: res.text, error: null };
  };
  return {
    postJson: (path, body) => call('POST', path, body),
    getJson: (path) => call('GET', path),
  };
}

/**
 * Post one task the way the plugin does, and return the offer material for its lease.
 *
 * The returned `offer` is the shape a real dispatcher pushes over a channel: `task.offer` plus the
 * lease's own `task_id`, `index`, `attempt` and `dedupe_key` -- taken from `POST /v1/task`'s
 * `leases[]`, never invented, because the exactly-once argument depends on both copies carrying the
 * same identity. `originMachineId` is that same dispatcher machine, because an offer which claims
 * an origin that never announced is exactly the fallback case under test.
 */
async function dispatchTask(agent, relay, { commandArgv, machineId, originMachineId, p2pMode = 'auto', baseCommit }) {
  // The stream must be attached before the task is posted, or the offer waits for the relay's
  // re-offer path (`redeliverPendingOffers`) instead of arriving as the live event these tests are
  // about. Waiting for the observable fact beats sleeping and hoping.
  await waitForOnline(relay, machineId ?? agentMachineId(agent), agent.identity.device_token);
  const target = machineId ?? agentMachineId(agent);
  const body = {
    mode: 'replicate',
    command_argv: commandArgv,
    index_total: 1,
    timeout_ms: 60_000,
    write: false,
    // Deliberately not anchored to a tree: this suite is about transport, and an anchor mismatch
    // would only make the verdict `unverifiable` without changing anything asserted here.
    base_commit: baseCommit,
    requirements: {},
    compare_policy: {},
    origin_machine_id: originMachineId ?? DISPATCHER,
    p2p: { mode: p2pMode },
  };
  const res = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body });
  assert.equal(res.status, 200, `POST /v1/task failed: ${res.text}`);
  const task = res.json;
  const lease = task.leases.find((l) => l.machine_id === target);
  assert.ok(
    lease,
    `the task must have a lease for ${target}: ${JSON.stringify(task.leases)}`,
  );
  return {
    taskId: task.task_id,
    machineId: target,
    lease,
    offer: {
      type: 'task.offer',
      task_id: task.task_id,
      machine_id: target,
      index: lease.index,
      index_total: 1,
      attempt: lease.attempt,
      dedupe_key: lease.dedupe_key,
      mode: 'replicate',
      command_argv: commandArgv,
      cwd_rel: '.',
      write: false,
      timeout_ms: 60_000,
      base_commit: baseCommit,
      base_tree: null,
      requirements: {},
      compare_policy: {},
      origin_machine_id: originMachineId ?? DISPATCHER,
      p2p: { mode: p2pMode },
    },
  };
}

/**
 * The stored record for one machine, straight from the relay's own aggregate.
 *
 * Read from the relay rather than from the agent's log because the relay is the ledger: "what did
 * the ledger record about this machine's result" is the question these tests answer.
 */
async function taskView(relay, taskId, token) {
  const res = await request(`${relay.url}/v1/tasks/${taskId}`, { token });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

/** Verdicts that mean the relay has stopped waiting for anything. */
const SETTLED = new Set([
  'consistent',
  'divergent',
  'divergent-platform',
  'failed',
  'refused',
  'unverifiable',
  'degraded',
]);

async function waitForAggregate(relay, taskId, token, { timeoutMs = 30_000 } = {}) {
  return waitFor(
    async () => {
      const res = await request(`${relay.url}/v1/tasks/${taskId}`, { token });
      if (res.status !== 200) return null;
      const aggregate = res.json.aggregate ?? res.json;
      if (!aggregate?.status || !SETTLED.has(aggregate.status)) return null;
      return aggregate;
    },
    { timeoutMs, label: `aggregate for ${taskId}` },
  );
}

/** A command that appends one byte to `marker`: the observable side effect the dedupe tests count. */
function appendCommand(marker) {
  return [NODE, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`];
}

function countLines(file) {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8');
  return text === '' ? 0 : text.split('\n').filter((line) => line !== '').length;
}

/**
 * Discovery that reports the socket's own port as the reflexive address.
 *
 * Two ends on one host have no NAT between them, so the address a peer can reach us on *is* the
 * socket's own loopback address. Using the real `discoverReflexive` here would query four public
 * STUN servers to learn nothing this test can use, and would make the suite depend on the public
 * internet -- which is exactly what the injected-discovery points in `test/p2p-node.test.mjs` are
 * for. The *real* STUN path is covered by `test/p2p-stun.test.mjs` and by the CLI itself.
 */
function loopbackDiscovery() {
  return async ({ socket }) => {
    const bound = socket.address();
    return {
      ok: true,
      reflexive: { address: '127.0.0.1', port: bound.port },
      mapping: 'none',
      local: { address: bound.address, port: bound.port },
      servers: [],
      error: null,
    };
  };
}

/**
 * Timings for a suite that runs on loopback: no announcement refresh, short accepts, real punches.
 *
 * The refresh is pushed far out rather than left at 20s so no test sees an unexpected second
 * announcement; `punchTimeoutMs` stays generous, because a real punch has to complete.
 */
function testTuning(over = {}) {
  return {
    refreshMs: 600_000,
    announceTtlMs: 600_000,
    punchTimeoutMs: 3_000,
    acceptTimeoutMs: 100,
    ...over,
  };
}

/** Build an agent for this machine: a real relay, a real UDP socket, a deterministic discovery. */
async function makeAgent({ relay, project, stateDir, mode = 'auto', options = {} }) {
  const identity = loadOrCreateIdentity({ dir: stateDir, name: `p2p-${mode}`, rabbitUrl: relay.url }).identity;
  const paired = await request(`${relay.url}/v1/pair`, {
    method: 'POST',
    body: {
      pairing_code: relay.state.createPairingCode(),
      machine_id: identity.machine_id,
      machine_name: identity.machine_name,
      platform: PLATFORM,
      caps: CAPS,
    },
  });
  assert.equal(paired.status, 200, plain(paired));
  identity.device_token = paired.json.device_token;

  return createAgent({
    rabbitUrl: relay.url,
    project,
    stateDir,
    identity,
    caps: CAPS,
    platform: PLATFORM,
    allowedCommands: [['node', '-e']],
    p2pMode: mode,
    p2pNodeOptions: { discover: loopbackDiscovery(), tuning: testTuning() },
    heartbeatIntervalMs: 5_000,
    idleHeartbeatIntervalMs: 0,
    // Set W2M_TEST_LOG=1 to see the agent's own narration while debugging a case in this file. It is
    // off by default because a passing suite should be quiet, and noise in a passing run is how a
    // real warning gets ignored.
    ...(process.env.W2M_TEST_LOG
      ? {
          // eslint-disable-next-line no-console -- this is the debug channel the flag exists for
          log: (level, message, fields) => console.log(`    [${level}] ${message}`, fields ? JSON.stringify(fields) : ''),
        }
      : {}),
    ...options,
  });
}

/**
 * Wait until the relay considers one machine online.
 *
 * A task's lease set is the online machines at dispatch time, and an offer is emitted into the SSE
 * stream only for a device the relay can reach -- a task posted before the stream attached would
 * wait for the relay's re-offer path instead. This waits for the observable fact rather than for a
 * wall clock, and gives up rather than failing, because a machine without a stream still gets its
 * offer.
 */
async function waitForOnline(relay, machineId, token, { timeoutMs = 15_000 } = {}) {
  try {
    await waitFor(
      async () => {
        const res = await request(`${relay.url}/v1/devices`, { token });
        if (res.status !== 200) return null;
        const device = (res.json?.devices ?? []).find((d) => d.machine_id === machineId);
        return device?.online === true ? device : null;
      },
      { timeoutMs, label: `${machineId} to be online` },
    );
    return true;
  } catch {
    return false;
  }
}

/** A machine id no other test can collide with, for a dispatcher that has to be unique per test. */
let dispatcherSeq = 0;

function dispatcherId() {
  dispatcherSeq += 1;
  return `plugin-dispatcher-${process.pid}-${dispatcherSeq}`;
}

/** The same, for the paired-but-never-announced origin machine the fallback cases need. */
function observerId(name) {
  return `${name}-${process.pid}`;
}

/**
 * A second real machine that answers the relay and nothing else.
 *
 * The fallback cases need a task whose origin machine never announced a candidate -- but a *paired*
 * machine is a real lease holder, and the relay's verdict does not settle while any lease is still
 * `pending`. So the observer is not a fixture that sits there: it dials out, accepts its own offer
 * and returns a result, in `relay` mode (no socket, no candidates, no punch). That is also the
 * deployment this release must keep working: one machine on P2P, one that is not.
 *
 * It is paired with an id the test chooses, and then handed that same identity, so the machine that
 * holds the token is the machine in the lease.
 */
async function makeObserver({ relay, project, name }) {
  const id = observerId(name);
  const device = await pairDevice(relay, id);
  const stateDir = scratchDir(`observer-${name}`);
  const identity = loadOrCreateIdentity({ dir: stateDir, name: id, rabbitUrl: relay.url }).identity;
  identity.machine_id = id;
  identity.machine_name = id;
  identity.device_token = device.token;
  const agent = createAgent({
    rabbitUrl: relay.url,
    project,
    stateDir,
    identity,
    caps: CAPS,
    platform: PLATFORM,
    // An observer is here to make a verdict settle, not to run anything: a marker assertion in this
    // file counts executions, and a second machine running the same absolute command would make every
    // "ran exactly once" claim a claim about two machines. Refusing everything is deterministic, is
    // fast, and is the case `refused` exists for.
    allowedCommands: [['node', '--not-a-command-this-suite-uses']],
    p2pMode: 'relay',
    heartbeatIntervalMs: 5_000,
    idleHeartbeatIntervalMs: 0,
  });
  startAgentLoop(agent);
  await waitForOnline(relay, id, device.token);
  return { agent, machineId: id, token: device.token };
}

/**
 * A dispatcher: a bare `P2PNode`, a device token, and an announced candidate list.
 *
 * Built from `P2PNode` directly rather than from the plugin, because this checkout has no plugin
 * and because the point is the *framing contract*: whatever the plugin does, the agent must behave
 * the same for a frame that looks like this.
 *
 * The id is unique per test on purpose: a relay started with persistence on loads the devices of a
 * previous run, and a fixed id would collide with a roster entry this test never created -- which
 * the task's *lease* would then be attached to, taking the offer somewhere else entirely. That is
 * not a hypothetical: it is what the first version of this file did.
 */
async function makeDispatcher({ relay, url, machineId = null, mode = 'auto', startAgent = true }) {
  const id = machineId ?? dispatcherId();
  const device = await pairDevice(relay, id);
  const transport = relayTransport(url, device.token);
  const node = new P2PNode({
    machineId: id,
    mode,
    rabbitUrl: url,
    postJson: transport.postJson,
    getJson: transport.getJson,
    discover: loopbackDiscovery(),
    tuning: testTuning(),
  });
  const started = await node.start();
  assert.equal(started.ok, true, `dispatcher node must start: ${started.error ?? ''}`);
  // Announced before anyone dials: the agent looks the dispatcher up by machine id, so an
  // unannounced dispatcher is a 404 and a `P2P_NO_CANDIDATES`, not a punch.
  const announced = await waitFor(() => (node.status.announced_at !== null ? node.status : null), {
    timeoutMs: 5000,
    label: 'dispatcher announcement',
  });
  assert.ok(announced.candidates.length >= 1, 'the dispatcher must announce a reachable candidate');

  /**
   * The dispatcher as a *machine of the group*: its own agent, so it answers its own lease.
   *
   * A paired device is a lease holder, and the relay's verdict does not settle while any lease is
   * `pending`. Without this, every task in this file is leased to a machine that never answers, the
   * verdict stays `partial` for the whole lease window, and the tests measure the relay's sweep
   * instead of the transport. In relay mode, so it holds one device token, one stream and no socket.
   *
   * `startAgent: false` holds its stream back, and that is how an arrival *order* is forced: with no
   * stream, the relay cannot deliver this machine's own copy of the offer, so nothing runs until the
   * test calls `join()`. That turns "wait for the direct copy to have executed" from a race into a
   * fact the test controls.
   */
  const agent = createAgent({
    rabbitUrl: url,
    project: scratchDir('dispatcher-project'),
    stateDir: scratchDir('dispatcher-state'),
    identity: { machine_id: id, machine_name: id, device_token: device.token, rabbit_url: url },
    caps: CAPS,
    platform: PLATFORM,
    // This agent exists for one reason: a paired-but-silent machine leaves a lease `pending` and the
    // verdict never settles. It must therefore NOT run the command under test -- every marker
    // assertion in this file counts executions of one command, and a second machine writing to the
    // same absolute path would make "ran exactly once" a statement about two machines. An
    // allow-list that matches nothing makes it refuse deterministically and immediately, which is
    // also the case `refused` exists for.
    allowedCommands: [['node', '--not-a-command-this-suite-uses']],
    p2pMode: 'relay',
    heartbeatIntervalMs: 5_000,
    idleHeartbeatIntervalMs: 0,
  });
  let joined = false;
  const join = async () => {
    if (joined) return;
    joined = true;
    startAgentLoop(agent);
    await waitForOnline(relay, id, device.token);
  };
  if (startAgent) await join();

  return { node, agent, device, transport, machineId: id, token: device.token, join };
}

/** Watch one channel's frames, and acknowledge the results on it the way a dispatcher does. */
function watchChannel(channel) {
  const frames = [];
  channel.on('message', (payload) => {
    try {
      frames.push(JSON.parse(payload.toString('utf8')));
    } catch {
      frames.push({ type: 'unparseable' });
    }
  });
  return {
    frames,
    of: (type) => frames.filter((frame) => frame?.type === type),
    async count(type, count, timeoutMs = 20_000) {
      await waitFor(() => frames.filter((f) => f?.type === type).length >= count, {
        timeoutMs,
        label: `${count} ${type} frame(s)`,
      });
      return frames.filter((f) => f?.type === type);
    },
    /** Acknowledge every `task.result` frame -- what the plugin does in production. */
    async ackAll() {
      const results = this.of('task.result');
      for (const frame of results) {
        await channel.send(JSON.stringify({ type: 'result.ack', task_id: frame.task_id }));
      }
      return results;
    },
  };
}

/** One dialled channel plus everything needed to assert on it and to close it. */
async function dialAgent(dispatcher, dispatched, channels) {
  const session = deriveSession('task', dispatched.taskId, dispatched.machineId, dispatcher.machineId);
  const dialled = await dispatcher.node.dial(dispatched.machineId, { session });
  assert.equal(dialled.ok, true, `the loopback punch must succeed: ${dialled.error ?? ''}`);
  channels.push(dialled.channel);
  return { channel: dialled.channel, session, watch: watchChannel(dialled.channel) };
}

/** `JSON.stringify` once, for assertion messages that would otherwise be unreadable. */
function plain(value) {
  return JSON.stringify(value);
}

/**
 * The agent main loops started in this file, so `teardown` can settle them.
 *
 * Module scope, and reset by `teardown`: a loop is a promise that only settles after `stop()`, and
 * an unsettled promise at the end of a test is an unhandled rejection waiting to happen.
 *
 * @type {Promise<void>[]}
 */
const agentLoops = [];

/**
 * Start an agent's long-running loop without awaiting it.
 *
 * `start()` is the agent's main loop: it does not resolve until `stop()` is called, so awaiting it
 * is a deadlock rather than a wait -- the same trap `test/e2e.test.mjs` documents in its
 * `startPromises` comment. `stop()` also brings the direct path up, so this is safe to call before
 * or after `startP2P()`; both are idempotent.
 */
function startAgentLoop(agent) {
  agentLoops.push(agent.start());
}

/**
 * Close everything a test opened, in the order that lets the nodes release their sockets.
 *
 * The agents (the machine under test and any observer) are stopped first: `stop()` is what lets an
 * agent's loop finish, so settling the loops before stopping would wait out the reconnect backoff.
 */
async function teardown({ agent, observers = [], dispatcher, relay, channels = [] }) {
  for (const channel of channels) {
    try {
      channel.close('test-over');
    } catch {
      /* already gone */
    }
  }
  if (agent) await agent.stop();
  for (const observer of observers) if (observer) await observer.stop();
  const loops = agentLoops.splice(0, agentLoops.length);
  if (dispatcher) { await dispatcher.agent.stop(); await dispatcher.node.close(); }
  if (relay) await relay.close();
  await Promise.allSettled(loops);
}

/* -------------------------------------------------------------------------- */
/* Direct offer, direct result                                                 */
/* -------------------------------------------------------------------------- */

describe('v0.4.0 agent: an offer that arrives over a direct channel', () => {
  it('executes, answers on the same channel, and the ledger records both paths as p2p', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('direct');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    const dispatcher = await makeDispatcher({ relay, url: relay.url });
    const channels = [];

    try {
      startAgentLoop(agent);
      await waitFor(() => agent.state.p2p.running, { label: 'agent p2p node running' });
      assert.equal(agent.p2pMode, 'auto');
      const stunServers = agent.p2pStunServers();
      assert.ok(Array.isArray(stunServers) && stunServers.length > 0);
      assert.equal(stunServers[0], SHARED_SERVER.stun, 'the shared server leads the list');

      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: dispatcher.machineId,
      });
      const { channel, watch } = await dialAgent(dispatcher, dispatched, channels);

      await channel.send(JSON.stringify(dispatched.offer));
      const [result] = await watch.count('task.result', 1);
      assert.equal(result.task_id, dispatched.taskId);

      await watch.ackAll();

      const aggregate = await waitForAggregate(relay, dispatched.taskId, dispatcher.device.token);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);

      assert.equal(stored.transport, 'p2p', `transport records how the offer arrived: ${plain(stored)}`);
      assert.equal(stored.p2p.offer_path, 'p2p');
      assert.equal(stored.p2p.result_path, 'p2p', 'the direct copy was acknowledged, so the ledger may say p2p');
      assert.equal(stored.p2p.mode, 'auto');
      assert.equal('reason' in stored.p2p, false, 'a direct offer has no reason to explain');
      assert.equal(typeof stored.p2p.rtt_ms, 'number');
      // The responder half of a punch has no peer address to report: it answered a HELLO that
      // arrived, and a HELLO carries a session, not an identity. `session` is what correlates the
      // two sides' logs, and reporting an address here would be inventing one.
      assert.equal(stored.p2p.peer, null);
      // ... and neither has the responder a peer session to publish: it adopted the initiator's, and
      // the published field describes the *outbound* channel this machine opened. Null is the honest
      // value here, not a number.
      assert.equal(stored.p2p.session, null);      assert.equal(stored.p2p.mapping, 'none');
      assert.equal(stored.status, 'ok');
      assert.equal(stored.exit_code, 0);

      // The command really ran, exactly once.
      assert.equal(countLines(marker), 1);
    } finally {
      await teardown({ agent, dispatcher, relay, channels });
    }
  });

  it('answers a re-delivered attempt from cache instead of running the command again', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('redeliver');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    const dispatcher = await makeDispatcher({ relay, url: relay.url });
    const channels = [];

    try {
      startAgentLoop(agent);
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: dispatcher.machineId,
      });
      const { channel, watch } = await dialAgent(dispatcher, dispatched, channels);

      await channel.send(JSON.stringify(dispatched.offer));
      await watch.count('task.result', 1);
      await watch.ackAll();
      await waitForAggregate(relay, dispatched.taskId, dispatcher.device.token);
      assert.equal(countLines(marker), 1);

      // The same attempt again, over the same channel: `enqueue` answers from the cache.
      await channel.send(JSON.stringify(dispatched.offer));
      await watch.count('task.result', 2);
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      assert.equal(countLines(marker), 1, 'a re-delivered offer must not run the command twice');

      const view = await taskView(relay, dispatched.taskId, dispatcher.device.token);
      const records = view.aggregate.machines.filter((m) => m.machine_id === dispatched.machineId);
      assert.equal(records.length, 1, 'a re-delivery must not add a second machine record');
    } finally {
      await teardown({ agent, dispatcher, relay, channels });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Fallback: the relay's own offer                                             */
/* -------------------------------------------------------------------------- */

describe('v0.4.0 agent: an offer that arrives over the relay', () => {
  it('runs the task and names why the direct path was not the answer', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('fallback');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    // The origin machine announces nothing, so the agent has nothing to punch at -- the exact case
    // the relay fallback exists for.
    const { agent: observer, machineId: observerMachineId, token: observerToken } = await makeObserver({ relay, project: repo.dir, name: 'observer-1' });

    try {
      startAgentLoop(agent);
      await waitFor(() => agent.state.p2p.running, { label: 'agent p2p node running' });

      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: observerMachineId,
      });
      const aggregate = await waitForAggregate(relay, dispatched.taskId, observerToken);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);

      assert.equal(stored.transport, 'relay', 'the offer arrived on the SSE stream');
      assert.equal(stored.p2p.offer_path, 'relay');
      assert.equal('result_path' in stored.p2p, false, 'nothing was acknowledged over a channel');
      assert.match(
        stored.p2p.reason,
        /^(P2P_NO_CANDIDATES|P2P_PUNCH_TIMEOUT|P2P_DISABLED|P2P_UNREACHABLE)/,
        `the reason must name why: ${stored.p2p.reason}`,
      );
      assert.equal(stored.status, 'ok', 'the fallback must still run the task');
      assert.equal(countLines(marker), 1, 'the command ran over the relay path');
    } finally {
      await teardown({ agent, observers: [observer], relay });
    }
  });

  it('records P2P_NO_CANDIDATES when the origin machine never announced', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('nocandidates');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    const { agent: observer, machineId: observerMachineId, token: observerToken } = await makeObserver({ relay, project: repo.dir, name: 'observer-2' });

    try {
      startAgentLoop(agent);
      await waitFor(() => agent.state.p2p.running, { label: 'agent p2p node running' });
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: [NODE, '-e', 'process.stdout.write("ok")'],
        baseCommit: repo.commit,
        originMachineId: observerMachineId,
      });
      const aggregate = await waitForAggregate(relay, dispatched.taskId, observerToken);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);
      assert.equal(stored.transport, 'relay');
      assert.equal(stored.p2p.offer_path, 'relay');
      assert.match(
        stored.p2p.reason,
        /^P2P_NO_CANDIDATES/,
        `an origin with no live announcement has its own code: ${stored.p2p.reason}`,
      );
    } finally {
      await teardown({ agent, observers: [observer], relay });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* direct mode                                                                 */
/* -------------------------------------------------------------------------- */

describe("v0.4.0 agent: p2pMode 'direct'", () => {
  it('refuses a relay offer with P2P_UNAVAILABLE, and runs nothing', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('direct-refuse');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({
      relay,
      project: repo.dir,
      stateDir: scratchDir('agent-state'),
      mode: 'direct',
    });
    const { agent: observer, machineId: observerMachineId, token: observerToken } = await makeObserver({ relay, project: repo.dir, name: 'observer-3' });

    try {
      startAgentLoop(agent);
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: observerMachineId,
      });
      const aggregate = await waitForAggregate(relay, dispatched.taskId, observerToken);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);

      assert.equal(stored.status, 'refused', plain(stored));
      assert.equal(stored.refusal_reason, 'P2P_UNAVAILABLE');
      assert.equal(stored.transport, 'relay');
      assert.equal(stored.p2p.offer_path, 'relay');
      assert.equal(existsSync(marker), false, 'a refused offer must not execute anything');
    } finally {
      await teardown({ agent, observers: [observer], relay });
    }
  });

  it('refuses nothing when the offer arrives over the direct path', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('direct-accept');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({
      relay,
      project: repo.dir,
      stateDir: scratchDir('agent-state'),
      mode: 'direct',
    });
    const dispatcher = await makeDispatcher({ relay, url: relay.url });
    const channels = [];

    try {
      startAgentLoop(agent);
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        p2pMode: 'direct',
        originMachineId: dispatcher.machineId,
      });
      const { channel, watch } = await dialAgent(dispatcher, dispatched, channels);

      await channel.send(JSON.stringify(dispatched.offer));
      await watch.count('task.result', 1);
      await watch.ackAll();

      const aggregate = await waitForAggregate(relay, dispatched.taskId, dispatcher.device.token);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);
      assert.equal(stored.status, 'ok', plain(stored));
      assert.equal(stored.refusal_reason, null);
      assert.equal(stored.transport, 'p2p');
      assert.equal(stored.p2p.result_path, 'p2p');
      assert.equal(countLines(marker), 1);
    } finally {
      await teardown({ agent, dispatcher, relay, channels });
    }
  });

  it('allows the command in `auto` where `direct` refuses, so the refusal is the mode and not the offer', async () => {
    // The control for the refusal test above: the same relay offer, the same missing announcement,
    // one setting different. Without it, a relay that never delivered the offer at all would pass.
    const { relay } = await startRelay();
    const repo = makeRepo('auto-control');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    const { agent: observer, machineId: observerMachineId, token: observerToken } = await makeObserver({ relay, project: repo.dir, name: 'observer-4' });

    try {
      startAgentLoop(agent);
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: observerMachineId,
      });
      const aggregate = await waitForAggregate(relay, dispatched.taskId, observerToken);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);
      assert.equal(stored.status, 'ok', plain(stored));
      assert.equal(stored.transport, 'relay');
      assert.equal(countLines(marker), 1);
    } finally {
      await teardown({ agent, observers: [observer], relay });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Exactly once, in both arrival orders                                        */
/* -------------------------------------------------------------------------- */

describe('v0.4.0 agent: one attempt delivered twice executes once', () => {
  it('counts one execution when the direct copy arrives first', async () => {
    // THE ORDER IS FORCED, NOT HOPED FOR, on both sides. The agent's direct path is brought up
    // without attaching its event stream, so the relay's own copy of the offer is published into the
    // replay ring and cannot reach it yet; and the dispatcher's agent is held back too, so nothing
    // runs anywhere until this test says so. The direct copy is therefore necessarily first, and the
    // relay's copy afterwards -- which is the "duplicate arrives after the first copy already ran,
    // over the other transport" case, made deterministic.
    const { relay } = await startRelay();
    const repo = makeRepo('p2p-first');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    const dispatcher = await makeDispatcher({ relay, url: relay.url, startAgent: false });
    const channels = [];

    try {
      // 1. the direct path only.
      const started = await agent.startP2P();
      assert.equal(started.ok, true, started.error ?? '');
      assert.equal(agent.state.connected, false, 'the stream must not be attached yet');

      // 2. the task, published by the relay to a machine whose stream is down.
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: dispatcher.machineId,
      });
      // v0.4.0 holds the relay's own offer for a bounded grace period while the dispatcher pushes the
      // direct copy (`p2pOfferGraceMs`), so the relay "really holds the offer" is now observable one
      // grace period later rather than immediately. Waiting for the fact beats asserting the old
      // timing: the point of this step is that the relay copy exists and has NOT reached this
      // machine, which is exactly what `offered` with a detached stream means.
      await waitFor(
        async () => {
          const view = await taskView(relay, dispatched.taskId, dispatcher.token);
          return view.leases.find((l) => l.machine_id === dispatched.machineId)?.state === 'offered';
        },
        { timeoutMs: 10_000, label: 'the relay to publish its own copy of the offer' },
      );

      // 3. the direct copy: a real frame on a real punched channel.
      const { channel, watch } = await dialAgent(dispatcher, dispatched, channels);
      await channel.send(JSON.stringify(dispatched.offer));
      await watch.count('task.result', 1);
      await watch.ackAll();
      await waitFor(() => countLines(marker) === 1, { label: 'the direct copy to execute' });
      // `handled` is incremented when the attempt is *complete* (the envelope delivered), and the
      // marker is written when the command runs -- so the counter is one step behind the file.
      // Waiting for the counter is what makes this an assertion about exactly-once rather than about
      // which of the two facts happened to land first.
      await waitFor(() => agent.state.handled === 1, { label: 'the attempt to be accounted for' });

      // 4. the relay's copy, now that the attempt is finished. It must be answered from the cache.
      startAgentLoop(agent);
      await waitFor(() => agent.state.connected === true, { label: 'the agent stream to attach' });
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      assert.equal(countLines(marker), 1, 'the relay copy must not execute the command a second time');
      assert.equal(agent.state.handled, 1, 'and it must not count as a second handled offer');

      // 5. and the other lease holder joins last, so the verdict can settle.
      await dispatcher.join();
      const aggregate = await waitForAggregate(relay, dispatched.taskId, dispatcher.token);
      const records = aggregate.machines.filter((m) => m.machine_id === dispatched.machineId);
      assert.equal(records.length, 1, 'one machine, one record');
      assert.equal(records[0].status, 'ok');
      assert.equal(records[0].transport, 'p2p', 'the copy that ran arrived over the channel');
      assert.equal(records[0].p2p.result_path, 'p2p');
    } finally {
      await teardown({ agent, dispatcher, relay, channels });
    }
  });

  it('counts one execution when the relay copy arrives first', async () => {
    // The mirror image, and just as deterministic: the stream is attached from the start, so the
    // relay's copy runs the command; the direct copy is pushed afterwards.
    const { relay } = await startRelay();
    const repo = makeRepo('relay-first');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    const dispatcher = await makeDispatcher({ relay, url: relay.url });
    const channels = [];

    try {
      startAgentLoop(agent);
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: dispatcher.machineId,
      });
      await waitFor(() => countLines(marker) === 1, { label: 'the relay copy to execute' });
      const first = await waitForAggregate(relay, dispatched.taskId, dispatcher.token);
      const before = first.machines.find((m) => m.machine_id === dispatched.machineId);
      assert.equal(before.transport, 'relay', 'the copy that ran arrived over the relay');
      assert.equal(agent.state.handled, 1, 'exactly one offer handled so far');

      // The duplicate, over the channel this time. It is the same attempt -- `task_id`, `attempt` and
      // `dedupe_key` all come from the lease -- so it must be answered, not executed.
      const { channel, watch } = await dialAgent(dispatcher, dispatched, channels);
      await channel.send(JSON.stringify(dispatched.offer));
      await watch.count('task.result', 1);
      await watch.ackAll();
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      assert.equal(countLines(marker), 1, 'the direct copy must not execute the command again');
      assert.equal(agent.state.handled, 1, 'and it must not count as a second handled offer');
      const aggregate = await waitForAggregate(relay, dispatched.taskId, dispatcher.token);
      const records = aggregate.machines.filter((m) => m.machine_id === dispatched.machineId);
      assert.equal(records.length, 1, 'one machine, one record');
      assert.equal(records[0].status, 'ok');
      // The relay copy was produced by the relay-delivered offer and is already stored, so the
      // stored envelope still describes that path -- which is the honest answer: it is the copy the
      // ledger holds.
      assert.equal(records[0].transport, 'relay');
      assert.equal('result_path' in records[0].p2p, false);
    } finally {
      await teardown({ agent, dispatcher, relay, channels });
    }
  });

  it('ignores a duplicate that arrives while the first copy is still running', async () => {
    // The in-flight window is the one `completed` and the spool cannot cover, so it is tested
    // directly: two copies of the same attempt, the second while the first still holds the run, and
    // exactly one execution. Both copies go through the real dispatcher (`ingest`), so the dedupe
    // path under test is the production one; only the arrival *order* is forced.
    const { relay } = await startRelay();
    const repo = makeRepo('inflight');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({ relay, project: repo.dir, stateDir: scratchDir('agent-state') });
    const dispatcher = await makeDispatcher({ relay, url: relay.url, startAgent: false });
    const sent = [];

    try {
      startAgentLoop(agent);
      // A command that takes long enough to be caught in the act, so the second copy really does
      // arrive mid-run rather than being scheduled behind a finished one.
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: [NODE, '-e', "require('fs').appendFileSync(process.argv[1], 'x'); setTimeout(()=>{}, 600)", marker],
        baseCommit: repo.commit,
        originMachineId: dispatcher.machineId,
      });

      const channel = {
        on() {},
        removeListener() {},
        async send(frame) {
          sent.push(frame);
        },
        close() {},
      };

      agent.ingest(
        { type: 'task.offer', ...dispatched.offer, p2p_transport: 'relay' },
        { transport: 'relay' },
      );
      await waitFor(() => agent.state.current !== null, { label: 'the running task slot' });
      // The slot is claimed before the spawn completes, so the marker is the fact that proves the
      // command has actually started -- waiting for it is what makes "already run its command" true.
      await waitFor(() => countLines(marker) === 1, { label: 'the first copy to write its marker' });

      // The second copy, over the direct path, while the first is in flight.
      agent.ingest({ type: 'task.offer', ...dispatched.offer }, { transport: 'p2p', channel });
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      assert.equal(countLines(marker), 1, 'an in-flight duplicate must not start a second run');
      assert.equal(agent.state.current.task_id, dispatched.taskId, 'the first copy still owns the slot');

      // The other lease holder joins so the verdict can settle; it runs in its own scratch project,
      // so it can never touch this test's marker.
      await dispatcher.join();
      const aggregate = await waitForAggregate(relay, dispatched.taskId, dispatcher.token, { timeoutMs: 30_000 });
      const records = aggregate.machines.filter((m) => m.machine_id === dispatched.machineId);
      assert.equal(records.length, 1, 'one machine, one record');
      assert.equal(records[0].transport, 'relay', 'the copy that ran came off the relay stream');
      assert.equal(countLines(marker), 1);
    } finally {
      await teardown({ agent, dispatcher, relay });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A dispatcher that stops answering                                           */
/* -------------------------------------------------------------------------- */

describe('v0.4.0 agent: a dispatcher that stops answering', () => {
  it('costs the ledger one bounded wait and nothing else', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('dead-dispatcher');
    const marker = join(repo.dir, 'ran.txt');
    // A short bound, so "the relay copy was not delayed beyond it" is a measurable claim rather
    // than a description of the default.
    const agent = await makeAgent({
      relay,
      project: repo.dir,
      stateDir: scratchDir('agent-state'),
      // Short bounds, so "the relay copy was not delayed beyond the dispatcher's silence" and "the
      // channel is released afterwards" are measurable claims rather than descriptions of defaults.
      options: { p2pAckTimeoutMs: 150, p2pChannelLingerMs: 200 },
    });
    const dispatcher = await makeDispatcher({ relay, url: relay.url, startAgent: false });
    const channels = [];

    try {
      startAgentLoop(agent);
      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: dispatcher.machineId,
      });
      const { channel } = await dialAgent(dispatcher, dispatched, channels);

      // The offer arrives over the channel, and then the dispatcher stops answering: no
      // `result.ack`, ever. The channel is closed as well, which is the harsher case.
      await channel.send(JSON.stringify(dispatched.offer));
      await waitFor(() => agent.state.handled >= 1, { timeoutMs: 30_000, label: 'the offer to be handled' });
      channel.close('dispatcher-died');

      // The dispatcher's *relay* stream is a different question from the channel that just died, and
      // its lease has to settle or the verdict waits out the lease window instead of measuring
      // anything. Joining it is not "answering": the direct channel stays dead, which is the case
      // under test.
      await dispatcher.join();

      const startedAt = Date.now();
      const aggregate = await waitForAggregate(relay, dispatched.taskId, dispatcher.device.token, {
        timeoutMs: 30_000,
      });
      const elapsed = Date.now() - startedAt;
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);

      assert.equal(stored.status, 'ok', plain(stored));
      assert.equal(stored.transport, 'p2p', 'the offer did arrive over the channel');
      assert.equal(
        'result_path' in stored.p2p,
        false,
        'the envelope was never acknowledged, so the ledger must not claim the direct path',
      );
      assert.equal(stored.p2p.offer_path, 'p2p');
      assert.equal(countLines(marker), 1, 'the task completed over the relay as usual');
      assert.ok(elapsed < 15_000, `the relay copy must not wait on the dispatcher (${elapsed}ms)`);

      await waitFor(() => agent.state.p2p.channels === 0, { label: 'the channel to be released' });
      assert.equal(agent.state.p2p.running, true, 'a dead peer must not stop the node');
    } finally {
      await teardown({ agent, dispatcher, relay, channels });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* relay mode                                                                  */
/* -------------------------------------------------------------------------- */

describe("v0.4.0 agent: p2pMode 'relay'", () => {
  it('binds no UDP socket at all and behaves exactly as v0.3.9 did', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('relay-mode');
    const marker = join(repo.dir, 'ran.txt');
    const binds = [];
    const agent = await makeAgent({
      relay,
      project: repo.dir,
      stateDir: scratchDir('agent-state'),
      mode: 'relay',
      options: {
        // The same counting stand-in `test/outbound-only.test.mjs` uses: a real binder, plus the
        // fact under test (whether it was called at all).
        p2pNodeOptions: {
          bindUdpSocket: async (...args) => {
            binds.push(Date.now());
            return bindUdpSocket(...args);
          },
        },
      },
    });
    const { agent: observer, machineId: observerMachineId, token: observerToken } = await makeObserver({ relay, project: repo.dir, name: 'observer-6' });

    try {
      startAgentLoop(agent);
      assert.equal(agent.p2pNode, null, 'relay mode must not even build a node');
      assert.deepEqual(await agent.startP2P(), { ok: true, enabled: false, error: null });
      assert.equal(binds.length, 0, 'no dgram socket may exist in relay mode');

      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: observerMachineId,
      });
      const aggregate = await waitForAggregate(relay, dispatched.taskId, observerToken);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);

      assert.equal(stored.status, 'ok');
      assert.equal(stored.exit_code, 0);
      assert.equal(stored.transport, 'relay');
      assert.equal(stored.p2p.offer_path, 'relay');
      assert.equal('result_path' in stored.p2p, false);
      assert.match(stored.p2p.reason, /^P2P_DISABLED/, 'relay mode says so, rather than staying silent');
      assert.equal(countLines(marker), 1);

      // v0.3.9's own shape is untouched: the P2P facts are additive, and nothing that was there
      // before is missing or renamed.
      assert.equal(stored.refusal_reason, null);
      assert.equal(stored.p2p.peer, null);
      assert.equal(stored.p2p.session, null);
      assert.equal(stored.p2p.rtt_ms, null);
      assert.equal(stored.p2p.mapping, null);
      assert.equal(agent.state.p2p.enabled, false);
      assert.equal(agent.state.p2p.running, false);
      assert.equal(agent.state.p2p.channels, 0);
      assert.equal(binds.length, 0, 'nothing may bind during a task either');
    } finally {
      await teardown({ agent, observers: [observer], relay });
    }
  });

  it('reports the mode without a node, and keeps the relay-only status surface intact', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('relay-status');
    const agent = await makeAgent({
      relay,
      project: repo.dir,
      stateDir: scratchDir('agent-state'),
      mode: 'relay',
    });

    try {
      const status = agent.state.p2p;
      assert.equal(status.mode, 'relay');
      assert.equal(status.enabled, false);
      assert.equal(status.running, false);
      assert.equal(status.start_error, null);
      assert.equal(status.local, null);
      assert.equal(status.reflexive, null);
      assert.deepEqual(status.candidates, []);
      assert.equal(agent.p2pStunServers(), null, 'no node means no queried list');
      assert.equal(agent.p2pMode, 'relay');

      // The published file is what a plugin on another host reads.
      startAgentLoop(agent);
      const published = JSON.parse(
        await waitFor(
          () => {
            try {
              return readFileSync(agent.stateFile, 'utf8');
            } catch {
              return null; // the first publish has not landed yet
            }
          },
          { label: `${AGENT_STATE_FILE} to appear` },
        ),
      );
      assert.equal(published.p2p.mode, 'relay');
      assert.equal(published.p2p.enabled, false);
      assert.equal(published.p2p.running, false);
      assert.equal(published.p2p.candidates, 0);
    } finally {
      await teardown({ agent, relay });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Start failures are recorded, never fatal                                    */
/* -------------------------------------------------------------------------- */

describe('v0.4.0 agent: a node that cannot start', () => {
  it('records the failure in the status and still runs the task over the relay', async () => {
    const { relay } = await startRelay();
    const repo = makeRepo('bind-failure');
    const marker = join(repo.dir, 'ran.txt');
    const agent = await makeAgent({
      relay,
      project: repo.dir,
      stateDir: scratchDir('agent-state'),
      options: {
        p2pNodeOptions: {
          bindUdpSocket: async () => {
            throw new Error('EACCES: no UDP for you');
          },
        },
      },
    });
    const { agent: observer, machineId: observerMachineId, token: observerToken } = await makeObserver({ relay, project: repo.dir, name: 'observer-7' });

    try {
      // `start()` must not reject: a machine that cannot punch is still a working W2M machine.
      startAgentLoop(agent);
      // The failure is recorded a moment after `start()` is called (it is an awaited bind), so this
      // waits for the verdict rather than for a wall clock.
      await waitFor(() => agent.state.p2p.start_error !== null, { label: 'the bind failure to be recorded' });
      assert.equal(agent.state.p2p.running, false);
      assert.match(agent.state.p2p.start_error, /^P2P_BIND_FAILED: EACCES/);
      assert.equal(agent.state.p2p.last_error, agent.state.p2p.start_error);

      const dispatched = await dispatchTask(agent, relay, {
        commandArgv: appendCommand(marker),
        baseCommit: repo.commit,
        originMachineId: observerMachineId,
      });
      const aggregate = await waitForAggregate(relay, dispatched.taskId, observerToken);
      const stored = aggregate.machines.find((m) => m.machine_id === dispatched.machineId);
      assert.equal(stored.status, 'ok', 'the relay path must be unaffected by a P2P failure');
      assert.match(stored.p2p.reason, /^P2P_UNREACHABLE/);
      assert.equal(countLines(marker), 1);
    } finally {
      await teardown({ agent, observers: [observer], relay });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Honest limit                                                                */
/* -------------------------------------------------------------------------- */

describe('v0.4.0 agent: loopback is not a NAT traversal test', () => {
  it('documents what the punches above cannot prove', () => {
    // Every channel in this file runs between two processes on ONE host over 127.0.0.1, with no
    // translator in the path. So "the punch succeeded" here is evidence about the agent's own
    // contracts and about the framing, and *not* evidence that a real NAT can be crossed -- see the
    // same note in test/p2p-node.test.mjs and test/p2p-transport.test.mjs, and the v0.4.0 section of
    // PROTOCOL-v0.4.0.md for what is measured and what is explicitly not.
    assert.equal(P2P_DEFAULTS.punchTimeoutMs > 0, true);
    assert.equal(P2P_DEFAULTS.acceptTimeoutMs > 0, true);
  });
});
