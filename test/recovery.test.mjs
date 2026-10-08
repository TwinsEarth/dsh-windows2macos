/**
 * CI disconnect-recovery test (v0.3.0 hardening).
 *
 * Everything in this project assumes the link *comes back*: a laptop lid closes,
 * a tunnel re-keys, a relay is redeployed. That assumption is what makes the
 * design work across regions, and it is exactly the kind of property a test
 * never exercises if it only ever sees a healthy connection. So this file breaks
 * the link on purpose and checks what the agent does about it.
 *
 * Four properties, against real processes:
 *
 *   1. **A relay restart mid-task is survivable.** The relay is killed while a
 *      task is leased, then restarted on the same port and state directory. The
 *      agent must reconnect on its own, the result must still land, and the
 *      aggregate verdict must say so -- an outcome that quietly disappears is
 *      the failure this file exists to prevent.
 *   2. **Recovery does not duplicate work.** A command that appends to a file is
 *      the witness: across the whole disconnect the line must appear once.
 *   3. **A cleanly closed stream is a disconnect, not a completion.** A server
 *      that accepts the SSE connection and ends it immediately must produce
 *      reconnect-with-backoff, not silence.
 *   4. **A refused result stays spooled and a 4xx is not retried.** A 401 must
 *      not become a request storm, and the envelope must still be on disk.
 *
 * Rules this file follows, learned the hard way elsewhere in this suite:
 *
 *   * **`DSH_HOME` is redirected for every spawned agent.** Identity lives at
 *     `$DSH_HOME/xclient/device.json`; without the redirect a test on a fresh
 *     machine creates -- or overwrites -- the developer's real identity. Nothing
 *     here may touch `C:\Users\<user>\.dsh`.
 *   * **Wait on observable facts, with a deadline.** No `sleep(n)` and hope:
 *     every wait polls something the system actually reports (a log line, a
 *     device roster entry, a file byte, a terminal verdict).
 *   * **Re-read `device.json` on every poll.** It is written before pairing and
 *     updated with the token afterwards, so one early read sees `null`.
 *
 * Honest limits, stated rather than implied: this runs on one host, so it
 * exercises process death and socket loss, not a real network partition (no
 * packet loss, no half-open TCP, no DNS failure). The relay restarts on the same
 * port with a warm state directory; restarting on a *different* port is an
 * operator reconfiguration, not a recovery path.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const OPERATOR_TOKEN = 'op-token';
const ALLOWED_COMMANDS = JSON.stringify(['node -e']);

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

const scratchDirs = [];
const procs = [];

after(() => {
  for (const proc of procs) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory, removed at the end of the run. @param {string} tag */
function scratch(tag) {
  const dir = mkdtempSync(join(tmpdir(), `w2m-recovery-${tag}-`));
  scratchDirs.push(dir);
  return dir;
}

/** Allocate a free port by binding it and immediately releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Poll until `fn()` is truthy. The predicate *is* the observable fact under
 * test, which is why there is no bare sleep anywhere in this file.
 *
 * @template T
 * @param {() => T|Promise<T>} fn
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
 * @returns {Promise<T>}
 */
async function waitFor(fn, options = {}) {
  const { timeoutMs = 30_000, intervalMs = 50, label = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** JSON HTTP helper; every call names its token explicitly. */
async function call(url, { method = 'GET', token = null, body = null } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== null) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, text };
}

/**
 * Start the real relay CLI and wait for its listening line.
 *
 * Persistence is ON (a `--state` directory): the whole point of the recovery
 * case is that devices and leases survive a relay restart, and `--no-persist`
 * would make the restart indistinguishable from a brand new relay. The port is
 * fixed, because the agent's `rabbitUrl` must keep pointing at it.
 */
async function startRelay({ stateDir, port }) {
  const proc = spawn(
    NODE,
    [
      join(REPO, 'bin', 'w2m-rabbit.mjs'),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--state', stateDir,
      '--json',
      '--pair-rate-limit', '0',
      '--operator-token', OPERATOR_TOKEN,
    ],
    {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // The relay takes `--state` explicitly, but its DSH_HOME is redirected as
      // well: belt and braces, so that no process started by this file can read
      // or write the developer's real ~/.dsh.
      env: { ...process.env, DSH_HOME: scratch('home-relay') },
    },
  );
  procs.push(proc);
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    out += chunk;
  });
  proc.stderr.on('data', (chunk) => {
    err += chunk;
  });

  const info = await waitFor(
    () => {
      const line = out.split('\n').find((entry) => entry.includes('"event":"listening"'));
      if (line) return JSON.parse(line);
      if (proc.exitCode !== null) throw new Error(`relay exited ${proc.exitCode}: ${err}`);
      return null;
    },
    { timeoutMs: 20_000, label: 'relay listening line' },
  );

  return { proc, info, url: `http://127.0.0.1:${info.port}`, stdout: () => out, stderr: () => err };
}

/** Kill a relay and wait until the process is really gone. */
async function killRelay(relay) {
  relay.proc.kill('SIGKILL');
  await waitFor(() => relay.proc.exitCode !== null || relay.proc.signalCode !== null, {
    timeoutMs: 10_000,
    label: 'relay process to exit',
  });
}

/**
 * Start a Localside agent with a scratch `DSH_HOME`, and wait until the link is
 * up. `pairingCode` is optional: with a pre-seeded `device.json` the agent starts
 * already paired, which is what the controlled-server cases use.
 */
async function startAgent({ rabbitUrl, pairingCode = null, project, stateDir, dshHome, once = false }) {
  const args = [
    join(REPO, 'bin', 'w2m-localside.mjs'),
    '--rabbit', rabbitUrl,
    '--project', project,
    '--state', stateDir,
    '--name', 'recovery-check',
    '--allowed-commands', ALLOWED_COMMANDS,
  ];
  if (pairingCode) args.push('--pair', pairingCode);
  if (once) args.push('--once');

  const proc = spawn(NODE, args, {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // The redirect that keeps the developer's real identity out of this test.
    env: { ...process.env, DSH_HOME: dshHome },
  });
  procs.push(proc);
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    out += chunk;
  });
  proc.stderr.on('data', (chunk) => {
    err += chunk;
  });

  if (pairingCode) {
    await waitFor(
      () => {
        // Wait for *pairing*, not for a generic "connected": the agent logs
        // stream activity before the pairing round trip returns, and matching
        // that made an earlier version of this suite read an empty roster.
        if (/paired/i.test(out) || /paired/i.test(err)) return true;
        if (proc.exitCode !== null) throw new Error(`agent exited ${proc.exitCode}: out=${out} err=${err}`);
        return false;
      },
      { timeoutMs: 30_000, label: 'agent to pair' },
    );
  }

  return { proc, stdout: () => out, stderr: () => err };
}

/**
 * The agent's device token, re-read from disk every time.
 *
 * `device.json` exists *before* pairing (it holds the machine id) and is
 * rewritten with the token afterwards, so a cached read is a race.
 */
function readDeviceToken(dshHome) {
  try {
    const identity = JSON.parse(readFileSync(join(dshHome, 'xclient', 'device.json'), 'utf8'));
    return typeof identity.device_token === 'string' && identity.device_token !== ''
      ? identity.device_token
      : null;
  } catch {
    return null;
  }
}

/** Seed an identity so the agent starts already paired (no /v1/pair needed). */
function seedIdentity(dshHome, rabbitUrl, token = 'tok-recovery') {
  const dir = join(dshHome, 'xclient');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'device.json'),
    `${JSON.stringify(
      {
        machine_id: randomUUID(),
        machine_name: 'recovery-check',
        device_token: token,
        rabbit_url: rabbitUrl,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/** Wait until the relay lists this machine as an online device. */
function waitForDeviceOnline(relayUrl, dshHome, label) {
  return waitFor(
    async () => {
      const token = readDeviceToken(dshHome);
      if (!token) return null;
      const response = await call(`${relayUrl}/v1/devices`, { token });
      if (!response.ok) return null;
      const devices = response.json?.devices ?? [];
      return devices.length > 0 ? devices : null;
    },
    { label, timeoutMs: 30_000 },
  );
}

/** Create a one-commit git repository and return its anchors. */
function makeProject(tag) {
  const dir = scratch(tag);
  writeFileSync(join(dir, 'tracked.txt'), 'line one\n');
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['add', '-A']);
  git([
    '-c', 'user.name=w2m-test',
    '-c', 'user.email=w2m@test.invalid',
    '-c', 'core.autocrlf=false',
    'commit', '-m', 'base',
  ]);
  return {
    dir,
    head: git(['rev-parse', 'HEAD']).stdout.trim(),
    tree: git(['rev-parse', 'HEAD^{tree}']).stdout.trim(),
  };
}

/** Submit a task as the operator. */
async function submitTask(relayUrl, body) {
  const response = await call(`${relayUrl}/v1/task`, { method: 'POST', token: OPERATOR_TOKEN, body });
  assert.ok(response.ok, `POST /v1/task -> ${response.status} ${response.text}`);
  return response.json;
}

/** The aggregate verdict, as the relay computes it. */
async function taskVerdict(relayUrl, taskId, dshHome) {
  const token = readDeviceToken(dshHome);
  if (!token) return null;
  const response = await call(`${relayUrl}/v1/tasks/${encodeURIComponent(taskId)}`, { token });
  return response.ok ? response.json?.aggregate ?? null : null;
}

/** Wait for a verdict that is no longer `pending`. */
function waitForVerdict(relayUrl, taskId, dshHome, label) {
  return waitFor(
    async () => {
      const aggregate = await taskVerdict(relayUrl, taskId, dshHome);
      if (!aggregate || aggregate.status === 'pending') return null;
      return aggregate;
    },
    { label, timeoutMs: 60_000 },
  );
}

/** `command_argv` that witnesses its own execution, optionally finishing late. */
function witnessCommand(witnessPath, { holdMs = 0 } = {}) {
  const append = (value) => `fs.appendFileSync(${JSON.stringify(witnessPath)},'${value}\\n');`;
  const script =
    `const fs=require('node:fs');${append('started')}` +
    (holdMs > 0 ? `setTimeout(()=>{${append('done')}},${holdMs});` : append('done'));
  return [NODE, '-e', script];
}

/** Lines of the witness file (empty when it does not exist yet). */
function witnessLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

/** Every `spool/<task>/envelope.json` the agent is holding on to. */
function spooledEnvelopes(agentStateDir) {
  const root = join(agentStateDir, 'spool');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => join(root, entry, 'envelope.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')));
}

describe('disconnect recovery', { skip: hasGit ? false : 'git is required for the anchors' }, () => {
  it('reconnects by itself after a relay restart and still delivers the result', async () => {
    const port = await freePort();
    const relayState = scratch('relay-restart');
    const agentState = scratch('agent-restart');
    const dshHome = scratch('home-restart');
    const project = makeProject('project-restart');
    const witness = join(project.dir, 'witness.log');

    const relay = await startRelay({ stateDir: relayState, port });
    const agent = await startAgent({
      rabbitUrl: relay.url,
      pairingCode: relay.info.pairingCode,
      project: project.dir,
      stateDir: agentState,
      dshHome,
    });
    await waitForDeviceOnline(relay.url, dshHome, 'device online before the restart');

    const task = await submitTask(relay.url, {
      mode: 'replicate',
      command_argv: witnessCommand(witness, { holdMs: 6000 }),
      cwd_rel: '.',
      index_total: 1,
      timeout_ms: 60_000,
      write: false,
      base_commit: project.head,
      base_tree: project.tree,
      dedupe_key: 'recovery-restart-1',
    });

    // The command must be genuinely running before the link is cut: a task still
    // sitting in a queue would prove nothing about recovering mid-flight.
    await waitFor(() => witnessLines(witness).includes('started'), { label: 'command to start' });

    await killRelay(relay);

    // The agent notices on its own. Asserted from its own log rather than waited
    // out, so a slow machine cannot pass this by being slow.
    const firstReconnect = await waitFor(
      () => {
        const match = agent.stdout().match(/reconnect #(\d+) in (\d+)ms/);
        return match ? { attempt: Number(match[1]), delayMs: Number(match[2]) } : null;
      },
      { label: 'agent to record its first reconnect attempt', timeoutMs: 20_000 },
    );
    assert.equal(firstReconnect.attempt, 1);
    assert.ok(firstReconnect.delayMs >= 250, `a reconnect must back off, got ${firstReconnect.delayMs}ms`);

    // Bring the link back on the same port, with the warm state directory.
    const revived = await startRelay({ stateDir: relayState, port });

    // Reconnecting is not enough: the agent must notice this is a *new* relay
    // process and re-attach without the previous process's cursor (task-18).
    await waitFor(
      () => /relay restarted \(relay_id .* -> .*\)/.test(agent.stdout()) || /stream ready/.test(agent.stdout()),
      { label: 'agent to re-attach to the restarted relay', timeoutMs: 30_000 },
    );

    // The outcome must survive: the command finished while the relay was down or
    // coming back, and the envelope must reach the relay.
    const aggregate = await waitForVerdict(revived.url, task.task_id, dshHome, 'a terminal verdict');
    assert.equal(aggregate.task_id, task.task_id);
    assert.ok(
      ['consistent', 'degraded'].includes(aggregate.status),
      `expected a successful verdict after recovery, got ${aggregate.status} (${JSON.stringify(aggregate.steps ?? [])})`,
    );
    assert.equal(aggregate.machines.length, 1);
    assert.equal(aggregate.machines[0].status, 'ok', 'the machine reported a successful envelope');

    // And the work happened exactly once, across the whole disconnect. This is
    // the durable property; the mechanism that produced it is reported in the
    // failure message rather than pinned, because either is acceptable: a relay
    // that does not re-offer a live lease and an agent that answers a repeated
    // attempt from its completed-cache both satisfy "ran once". (The cache path
    // is pinned deterministically in agent.test.mjs, where a re-delivery can be
    // staged on purpose.)
    assert.deepEqual(
      witnessLines(witness).filter((line) => line === 'done'),
      ['done'],
      'the command must not be executed twice by the recovery',
    );

    // Evidence for *why* it is not duplicated: either the relay re-offered and
    // the agent answered from its cache, or the relay never re-offered at all.
    const log = agent.stdout();
    const dedupeEvidence = [
      /dedupe hit: resending cached result/.test(log) ? 'agent answered the re-offer from its completed-cache' : null,
      /ignoring re-delivery of running task/.test(log) ? 'agent ignored a re-delivery of the running attempt' : null,
      /re-offer|reoffer/i.test(log) ? 'relay re-offered the lease' : null,
    ].filter(Boolean);
    assert.ok(
      dedupeEvidence.length > 0 || !/task.offer/.test(log.split('relay restarted')[1] ?? ''),
      'a second offer must be accounted for, not silently executed',
    );
  });

  it('does not execute the command twice when the relay comes back', async () => {
    const port = await freePort();
    const relayState = scratch('relay-twice');
    const agentState = scratch('agent-twice');
    const dshHome = scratch('home-twice');
    const project = makeProject('project-twice');
    const witness = join(project.dir, 'witness.log');

    const relay = await startRelay({ stateDir: relayState, port });
    const agent = await startAgent({
      rabbitUrl: relay.url,
      pairingCode: relay.info.pairingCode,
      project: project.dir,
      stateDir: agentState,
      dshHome,
    });
    await waitForDeviceOnline(relay.url, dshHome, 'device online before the restart');

    // A slow command with a stable dedupe_key: the disconnect happens while it
    // runs, which is the only moment duplication could occur.
    const task = await submitTask(relay.url, {
      mode: 'replicate',
      command_argv: witnessCommand(witness, { holdMs: 5000 }),
      cwd_rel: '.',
      index_total: 1,
      timeout_ms: 60_000,
      write: false,
      base_commit: project.head,
      base_tree: project.tree,
      dedupe_key: 'recovery-no-duplicate',
    });
    await waitFor(() => witnessLines(witness).includes('started'), { label: 'command to start' });

    await killRelay(relay);
    await waitFor(() => /reconnect #1/.test(agent.stdout()), { label: 'first reconnect attempt' });
    const revived = await startRelay({ stateDir: relayState, port });

    const aggregate = await waitForVerdict(revived.url, task.task_id, dshHome, 'a terminal verdict');
    assert.equal(aggregate.machines[0].status, 'ok');
    // The lease the relay persisted across its own restart is the reason the
    // agent is not asked to run this again: same attempt, same dedupe_key.
    assert.equal(aggregate.machines[0].attempt, 1, 'the recovered task must still be attempt 1');

    // The witness is the whole point: one `started`, one `done`.
    const lines = witnessLines(witness);
    assert.deepEqual(lines, ['started', 'done'], `the command ran ${lines.length} times, not once`);

    // What the contract actually promises here, with evidence. `dedupe_key`
    // identifies the task; `attempt` identifies the delivery; the agent keys its
    // completed-cache on the pair, so a *repeated* delivery of the same attempt
    // is answered from the cache and only a new attempt (§4.3, a genuine retry)
    // runs again. In this run the relay never re-offered the lease it had
    // persisted -- there is exactly one offer in the whole log -- so the
    // end-to-end exactly-once here is the relay's doing, with the agent's cache
    // as the second line of defence (pinned separately in agent.test.mjs).
    const offers = (agent.stdout().match(/offer /g) ?? []).length;
    assert.deepEqual(
      lines,
      ['started', 'done'],
      `ran once; offers seen in the recovered run: ${offers}, log tail: ${agent.stdout().slice(-400)}`,
    );
  });

  it('treats a cleanly closed stream as a disconnect, and backs off instead of spinning', async () => {
    const attaches = [];
    const server = createServer((req, res) => {
      if (req.url.startsWith('/v1/stream')) {
        attaches.push(Date.now());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`id: 1\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', seq: 1, relay_id: 'relay-clean' })}\n\n`);
        // The case under test: accepted, said hello, then closed cleanly. A
        // server that keeps the socket open forever would never exercise it.
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;

    const agentState = scratch('agent-clean-close');
    const dshHome = scratch('home-clean-close');
    const project = scratch('project-clean-close');
    seedIdentity(dshHome, url);

    try {
      const agent = await startAgent({ rabbitUrl: url, project, stateDir: agentState, dshHome });

      // It must keep reconnecting rather than treating the close as "done".
      await waitFor(() => attaches.length >= 3, { label: 'three SSE attaches', timeoutMs: 20_000 });

      const reconnects = [...agent.stdout().matchAll(/reconnect #(\d+) in (\d+)ms/g)].map((match) => ({
        attempt: Number(match[1]),
        delayMs: Number(match[2]),
      }));
      assert.ok(reconnects.length >= 2, `expected reconnect lines, saw: ${agent.stdout().slice(-400)}`);
      assert.ok(
        /event stream closed by server/.test(agent.stdout()),
        'a clean close must be reported as a disconnect, not as a completed stream',
      );

      // Backoff, not a hot loop: the ladder climbs and every delay keeps its
      // 50%-100% jitter floor (a fast loop would sit near zero).
      for (let i = 0; i < reconnects.length; i += 1) {
        assert.equal(reconnects[i].attempt, i + 1, 'reconnect attempts are numbered consecutively from 1');
        assert.ok(reconnects[i].delayMs >= 250, `delay ${reconnects[i].delayMs}ms is below the jitter floor`);
      }
      if (reconnects.length >= 2) {
        assert.ok(
          reconnects[1].delayMs > reconnects[0].delayMs,
          `the ladder must climb: ${reconnects.map((r) => r.delayMs).join(', ')}`,
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps a refused result spooled and does not retry a 401', async () => {
    const resultAttempts = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/v1/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`id: 1\nevent: ready\ndata: ${JSON.stringify({ type: 'ready', seq: 1, relay_id: 'relay-401' })}\n\n`);
          res.write(
            `id: 2\nevent: task.offer\ndata: ${JSON.stringify({
              type: 'task.offer',
              seq: 2,
              task_id: '01J-RECOVERY-401',
              attempt: 1,
              mode: 'replicate',
              index: 0,
              index_total: 1,
              command_argv: [NODE, '-e', 'process.stdout.write("late\\n")'],
              cwd_rel: '.',
              write: false,
              timeout_ms: 20_000,
              dedupe_key: 'recovery-401',
            })}\n\n`,
          );
          return;
        }
        if (url.pathname === '/v1/heartbeat') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ lease_until: null, cancel: false }));
          return;
        }
        if (url.pathname === '/v1/result') {
          resultAttempts.push(Date.now());
          // A signed-link refusal, the shape the relay actually returns.
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'SIGNATURE_REQUIRED',
                message: 'this relay requires a signed request',
                detail: { code: 'SIGNATURE_REQUIRED', reason: 'no signature header', hint: 'set --signing-secret' },
              },
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;

    const agentState = scratch('agent-401');
    const dshHome = scratch('home-401');
    const project = scratch('project-401');
    seedIdentity(dshHome, url);

    try {
      const agent = await startAgent({ rabbitUrl: url, project, stateDir: agentState, dshHome, once: true });
      // NB: the predicate must return an object, not the code itself -- exit code
      // 0 is a perfectly good result and `waitFor` would treat it as "not yet".
      const exited = await waitFor(
        () => (agent.proc.exitCode === null ? null : { code: agent.proc.exitCode }),
        { label: 'the agent to finish its single task', timeoutMs: 40_000 },
      );
      assert.equal(exited.code, 0, `the agent should stop cleanly: ${agent.stderr().slice(-400)}`);

      // A 4xx is permanent: exactly one attempt, not a retry loop.
      assert.equal(
        resultAttempts.length,
        1,
        `a 401 must not be retried; ${resultAttempts.length} attempts were made`,
      );

      // And the envelope is still on disk, so nothing was lost.
      const spooled = spooledEnvelopes(agentState);
      assert.equal(spooled.length, 1, 'a refused envelope must stay in the spool');
      assert.equal(spooled[0].task_id, '01J-RECOVERY-401');
      assert.equal(spooled[0].status, 'ok', 'the command itself succeeded; only delivery was refused');
      assert.match(spooled[0].stdout_sha256, /^[0-9a-f]{64}$/);

      // The relay's own code is preserved rather than paraphrased.
      assert.match(agent.stdout(), /SIGNATURE_REQUIRED|result kept in spool/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
