/**
 * Does a real agent actually run a pipeline chain?
 *
 * Everything else about `pipeline` is tested at the state and report layer, where a chain is just
 * data. The question this file answers cannot be answered there: **does the machine run the stages, in
 * order, and stop at the first failure?** That requires a real relay, a real agent, and a real command
 * whose side effects can be read back.
 *
 * The witness is a file each stage appends to. An ordering claim proved by inspecting a returned
 * status field would be a claim about the reporter, not about what ran; appending to a file is done by
 * the stage itself, in the order the stages execute.
 *
 * Honest limit: one host, one agent. This proves the chain executes and stops; it says nothing about
 * whether a chain started on two machines stays in step, because nothing in this design couples them
 * -- each machine runs the whole chain independently, which is the point of the chosen semantics.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The agent's own fingerprint function. The anchor the relay checks is this value, not a git tree SHA.
import { treeFingerprint } from '../src/agent/git.mjs';

// `require` is not available in ESM, and the git helper below uses `spawnSync` synchronously.
const require = createRequire(import.meta.url);

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;

const scratch = [];
const procs = [];

after(() => {
  for (const p of procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Run git, failing loudly. */
function git(args, cwd) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A git repo with one commit, so the agent can compute anchors. */
function makeRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `w2m-pipe-${name}-`));
  scratch.push(dir);
  writeFileSync(join(dir, '.gitattributes'), '* text=auto eol=lf\n', 'utf8');
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(['init', '--quiet', '-b', 'main'], dir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'add', '-A'], dir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'base'], dir);
  return dir;
}

/** Wait until `check()` returns a truthy value, or fail with `label`. */
async function waitFor(check, { label, timeoutMs = 25_000, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = await check();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Start the relay CLI and wait for its listening line. */
async function startRelay({ stateDir, port = 0 }) {
  const proc = spawn(
    NODE,
    [
      join(REPO, 'bin', 'w2m-rabbit.mjs'),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--state', stateDir,
      '--json',
      '--no-persist',
      '--pair-rate-limit', '0',
      '--operator-token', 'op-token',
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  procs.push(proc);
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    out += c;
  });
  proc.stderr.on('data', (c) => {
    err += c;
  });
  const info = await waitFor(
    () => {
      const line = out.split('\n').find((l) => l.includes('"event":"listening"'));
      return line ? JSON.parse(line) : null;
    },
    { label: `relay to listen (stderr: ${err.slice(0, 200)})` },
  );
  return { proc, info, url: `http://127.0.0.1:${info.port}` };
}

/**
 * Start an agent against a relay. `DSH_HOME` is redirected, never the real one.
 *
 * `--allowed-commands` is required in practice: the agent's allow-list is **default-deny**, and
 * without it every offer is refused with `COMMAND_NOT_ALLOWED` -- correctly, and with a warning on
 * startup saying so. The first version of this test omitted it and spent a minute waiting for a
 * verdict from work that was never permitted to start.
 */
async function startAgent({ rabbitUrl, pairingCode, project, stateDir, dshHome, allowedCommands = [NODE] }) {
  const proc = spawn(
    NODE,
    [
      join(REPO, 'bin', 'w2m-localside.mjs'),
      '--rabbit', rabbitUrl,
      '--pair', pairingCode,
      '--project', project,
      '--state', stateDir,
      '--name', 'pipeline-check',
      '--allowed-commands', JSON.stringify(allowedCommands),
    ],
    {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DSH_HOME: dshHome },
    },
  );
  procs.push(proc);
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    out += c;
  });
  proc.stderr.on('data', (c) => {
    err += c;
  });
  await waitFor(() => /paired/i.test(out) || /paired/i.test(err), {
    label: `agent to pair (out=${out.slice(0, 200)} err=${err.slice(0, 300)})`,
  });
  return { proc, stdout: () => out, stderr: () => err };
}

/**
 * The base commit and tree the relay checks every machine's envelope against.
 *
 * `base_tree` must be the agent's `treeFingerprint` value: the relay compares it to the envelope's
 * `pre_tree_fingerprint`, which uses `git-temp-index-tree/v1`. A git tree SHA is a different value,
 * and sending one makes every task `unverifiable`.
 */
async function anchorsOf(project) {
  const anchor = await treeFingerprint({ cwd: project });
  assert.equal(anchor.error, null, `treeFingerprint failed: ${JSON.stringify(anchor)}`);
  return {
    base_commit: git(['rev-parse', 'HEAD'], project),
    base_tree: anchor.fingerprint,
  };
}

/** POST a task and return the parsed response. */
async function postTask(url, body) {
  const res = await fetch(`${url}/v1/task`, {
    method: 'POST',
    headers: { authorization: 'Bearer op-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/**
 * Read a task's aggregate report.
 *
 * `GET /v1/tasks/{id}` sits below the auth boundary that requires a **device** token, not the operator
 * token: the operator token authorises dispatching, while reading fleet state is a machine action.
 * Passing the operator token here produced a 401 that looked like a broken report endpoint; it was the
 * relay correctly refusing the wrong credential.
 *
 * @param {string} url - Relay base URL.
 * @param {string} taskId - Task to read.
 * @param {string} deviceToken - The reading machine's own token.
 */
async function report(url, taskId, deviceToken) {
  const res = await fetch(`${url}/v1/tasks/${taskId}`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  const json = await res.json().catch(() => null);
  const aggregate = json?.aggregate ?? null;
  // The aggregate's `machines` is a projection that deliberately omits envelopes; the raw leases
  // carry them. Reaching for `aggregate.machines[0].envelope` reads `undefined`, which is exactly what
  // the first version of this test did.
  const leases = Array.isArray(json?.leases) ? json.leases : [];
  const envelope = leases.find((l) => l.envelope)?.envelope ?? null;
  return { status: res.status, json, aggregate, envelope, verdict: aggregate?.status ?? null };
}

/**
 * Wait for a task to reach a verdict that is neither pending nor still waiting on its deadline.
 *
 * @param {string} url - Relay base URL.
 * @param {string} taskId - Task to watch.
 * @param {string} deviceToken - The reading machine's own token.
 */
async function waitForVerdict(url, taskId, deviceToken) {
  return waitFor(
    async () => {
      const r = await report(url, taskId, deviceToken);
      if (r.status !== 200 || r.verdict === null) return null;
      return ['pending', 'timeout'].includes(r.verdict) ? null : r;
    },
    { label: `task ${taskId} to reach a verdict` },
  );
}

/** The device token the agent wrote, which is what read endpoints accept. */
function readDeviceToken(dshHome) {
  return JSON.parse(readFileSync(join(dshHome, 'xclient', 'device.json'), 'utf8')).device_token;
}

describe('pipeline end to end: a real agent runs the chain', () => {
  it('runs every stage in order and reports them individually', async () => {
    const relayState = mkdtempSync(join(tmpdir(), 'w2m-pe-relay-'));
    const agentState = mkdtempSync(join(tmpdir(), 'w2m-pe-agent-'));
    const dshHome = mkdtempSync(join(tmpdir(), 'w2m-pe-home-'));
    const project = makeRepo('order');
    scratch.push(relayState, agentState, dshHome);

    const relay = await startRelay({ stateDir: relayState });
    await startAgent({
      rabbitUrl: relay.url,
      pairingCode: relay.info.pairingCode,
      project,
      stateDir: agentState,
      dshHome,
    });

    // Each stage appends its own name. The file's content is the ordering evidence: it is written by
    // the stages themselves, so it cannot be right unless they ran in that order.
    const witness = join(project, 'order.txt');
    const stage = (name) => `require('fs').appendFileSync(${JSON.stringify(witness)}, ${JSON.stringify(`${name}\n`)})`;
    const created = await postTask(relay.url, {
      mode: 'pipeline',
      ...(await anchorsOf(project)),
      stages: [
        { command_argv: [NODE, '-e', stage('one')] },
        { command_argv: [NODE, '-e', stage('two')] },
        { command_argv: [NODE, '-e', stage('three')] },
      ],
      cwd_rel: '.',
      timeout_ms: 60_000,
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));

    const taskId = created.json.task_id;
    const done = await waitForVerdict(relay.url, taskId, readDeviceToken(dshHome));

    assert.equal(readFileSync(witness, 'utf8'), 'one\ntwo\nthree\n', 'the stages ran in the declared order');

    // The per-stage record has to reach the relay, or a reader cannot tell which stage failed.
    assert.equal(done.verdict, 'consistent', 'one machine ran the whole chain and reported ok');
    // The wire does not publish envelopes (see the file header), so the per-stage record is asserted in
    // broadcast.test.mjs against the state object. What is only knowable here is that every stage ran
    // and the machine reported ok -- which the witness and the verdict together establish.
    assert.equal(done.aggregate?.counts?.ok, 1);
    assert.equal(done.aggregate?.machines?.[0]?.exit_code, 0, 'the chain exited 0');
    assert.equal(done.aggregate?.machines?.[0]?.status, 'ok');
  });

  it('stops at the first failing stage and does not run the rest', async () => {
    const relayState = mkdtempSync(join(tmpdir(), 'w2m-ps-relay-'));
    const agentState = mkdtempSync(join(tmpdir(), 'w2m-ps-agent-'));
    const dshHome = mkdtempSync(join(tmpdir(), 'w2m-ps-home-'));
    const project = makeRepo('stop');
    scratch.push(relayState, agentState, dshHome);

    const relay = await startRelay({ stateDir: relayState });
    await startAgent({
      rabbitUrl: relay.url,
      pairingCode: relay.info.pairingCode,
      project,
      stateDir: agentState,
      dshHome,
    });

    const witness = join(project, 'stop.txt');
    const mark = (name) => `require('fs').appendFileSync(${JSON.stringify(witness)}, ${JSON.stringify(`${name}\n`)})`;
    const created = await postTask(relay.url, {
      mode: 'pipeline',
      ...(await anchorsOf(project)),
      stages: [
        { command_argv: [NODE, '-e', mark('ran')] },
        // Exits non-zero: the chain must stop here.
        { command_argv: [NODE, '-e', 'process.exit(3)'] },
        { command_argv: [NODE, '-e', mark('must-not-run')] },
      ],
      cwd_rel: '.',
      timeout_ms: 60_000,
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));

    const done = await waitForVerdict(relay.url, created.json.task_id, readDeviceToken(dshHome));

    const content = readFileSync(witness, 'utf8');
    // The third stage must not have run. This is the assertion the whole file exists for: a chain
    // that kept going after a failure would be reporting work it should never have done.
    assert.equal(content, 'ran\n', `only the first stage may have run, saw: ${JSON.stringify(content)}`);
    assert.notEqual(done.verdict, 'consistent', 'a failed chain is not consistent');

    // The chain's exit code is the failing stage's, which is what makes a single non-zero exit
    // interpretable; which stage it came from is in the envelope (asserted in broadcast.test.mjs).
    assert.equal(done.aggregate?.machines?.[0]?.exit_code, 3, "the chain's exit code is the failing stage's");
    assert.equal(done.aggregate?.machines?.[0]?.status, 'nonzero_exit');
  });
});

void existsSync;
