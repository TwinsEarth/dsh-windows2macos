/**
 * End-to-end verification: one relay, two machines, real commands, real git.
 *
 * Why this file exists separately from the unit tests: the unit tests prove the
 * pieces behave, this proves the *system* behaves. Two Localsides run against
 * one Rabbit on two `git worktree` checkouts of the same repository, executing
 * real commands through the real transport, and every assertion is made against
 * the relay's aggregate verdict.
 *
 * Two environment facts drive the shape of this file, both measured:
 *
 *  1. The same branch cannot be checked out in two worktrees at once
 *     (`fatal: '<branch>' is already used by worktree at ...`), so each machine
 *     gets its own detached HEAD at the same commit -- which is also exactly the
 *     deployment the anchor check is meant to police.
 *  2. A `.gitattributes` of `* text=auto eol=lf` is required, otherwise a
 *     CRLF difference between checkouts shows up as a fingerprint mismatch and
 *     every comparison becomes `unverifiable`.
 *
 * The suite is written to *fail loudly* if a dependency is missing rather than
 * to skip silently: a green run that skipped the interesting half would be worse
 * than a red one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const TMP_ROOT = join(REPO_ROOT, '..', '_work', 'w2m', 'e2e-tmp');

const NODE = process.execPath;
const GIT = 'git';

/** Per-scenario scratch directory, removed unless the scenario failed. */
function scratch(name) {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `${name}-`));
}

function git(args, cwd) {
  const out = spawnSync(GIT, args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${out.stderr || out.stdout}`);
  }
  return out.stdout.trim();
}

/**
 * Build a repository with two worktrees at the same commit.
 *
 * Returns the commit both machines are anchored to, plus the two checkout
 * directories. Detached HEADs are deliberate: it is the only way to have two
 * checkouts of one commit, and it matches how the design intends machines to be
 * placed.
 */
function makeTwoMachineRepo(name) {
  const root = scratch(name);
  const origin = join(root, 'origin');
  mkdirSync(origin, { recursive: true });

  git(['init', '--initial-branch=main', '.'], origin);
  writeFileSync(join(origin, '.gitattributes'), '* text=auto eol=lf\n');
  // `local.ignored` exists so one scenario can create a real, deterministic
  // difference between the machines *without* changing the fingerprint: ignored
  // files are excluded from `git add -A`, so the trees stay identical.
  writeFileSync(join(origin, '.gitignore'), 'local.ignored\n');
  writeFileSync(join(origin, 'app.mjs'), 'export const answer = 42;\n');
  writeFileSync(join(origin, 'README.md'), `# ${name}\n`);
  git(['add', '-A'], origin);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'base'], origin);
  const baseCommit = git(['rev-parse', 'HEAD'], origin);

  const a = join(root, 'machine-a');
  const b = join(root, 'machine-b');
  git(['worktree', 'add', '--detach', a, baseCommit], origin);
  git(['worktree', 'add', '--detach', b, baseCommit], origin);

  return { root, origin, a, b, baseCommit };
}

/** Load the components under test, or fail with a message that names the gap. */
async function loadComponents() {
  const relayPath = join(REPO_ROOT, 'src', 'relay', 'server.mjs');
  const agentPath = join(REPO_ROOT, 'src', 'agent', 'agent.mjs');
  const missing = [relayPath, agentPath].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `components under test are not implemented yet: ${missing
        .map((p) => p.replace(REPO_ROOT, '<repo>'))
        .join(', ')}`,
    );
  }
  // `import()` on Windows rejects a bare `E:\...` path with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME, so absolute paths must become file: URLs.
  const relay = await import(pathToFileURL(relayPath).href);
  const agent = await import(pathToFileURL(agentPath).href);
  const identity = await import(pathToFileURL(join(REPO_ROOT, 'src', 'agent', 'identity.mjs')).href);
  const caps = await import(pathToFileURL(join(REPO_ROOT, 'src', 'agent', 'caps.mjs')).href);
  const gitmod = await import(pathToFileURL(join(REPO_ROOT, 'src', 'agent', 'git.mjs')).href);
  return {
    createRelayServer: relay.createRelayServer ?? relay.createRelay,
    createAgent: agent.createAgent,
    loadOrCreateIdentity: identity.loadOrCreateIdentity,
    probeCaps: caps.probeCaps,
    detectPlatform: caps.detectPlatform,
    treeFingerprint: gitmod.treeFingerprint,
  };
}

/**
 * Poll the relay until a task reaches a *settled* verdict.
 *
 * `partial` with machines still pending is deliberately NOT settled: the relay
 * reports `partial` the moment the first result lands while others are still
 * running, so treating it as final would assert against a verdict the relay has
 * not actually reached. This was a real bug in the first draft of this file.
 */
async function waitForVerdict(baseUrl, taskId, token, { timeoutMs = 40_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = await res.json();
      last = body.aggregate ?? body;
      const machines = last.machines ?? [];
      const pending = machines.filter((m) => m.outcome === 'pending');
      const terminal = last.status && last.status !== 'pending';
      // Settled when there is a status and nothing can still arrive.
      if (terminal && pending.length === 0) return last;
      // A task whose machines are all gone (refused) can legitimately settle
      // with no leases reporting results at all.
      if (terminal && machines.length > 0 && machines.every((m) => m.lease_state === 'refused')) {
        return last;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`task ${taskId} did not settle within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

test('e2e: two machines, one relay, real commands', async (t) => {
  const { createRelayServer, createAgent, loadOrCreateIdentity, probeCaps, detectPlatform, treeFingerprint } =
    await loadComponents();
  assert.equal(typeof createRelayServer, 'function', 'relay must export createRelayServer');
  assert.equal(typeof createAgent, 'function', 'agent must export createAgent');
  assert.equal(typeof loadOrCreateIdentity, 'function', 'identity must export loadOrCreateIdentity');
  assert.equal(typeof probeCaps, 'function', 'caps must export probeCaps');
  assert.equal(typeof treeFingerprint, 'function', 'git must export treeFingerprint');

  const repo = makeTwoMachineRepo('replicate');
  const stateDir = join(repo.root, 'relay-state');
  // A reusable code keeps this test to one line: with rotation on, each machine
  // would have to pair with the code the previous pairing returned, which is the
  // right behaviour for a human at a terminal and noise in a test.
  const relay = createRelayServer({ stateDir, pairingCodeReusable: true });
  const listenInfo = await relay.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = listenInfo.url;
  const pairingCode = listenInfo.pairingCode;

  t.after(async () => {
    await relay.close();
    rmSync(repo.root, { recursive: true, force: true });
  });

  assert.ok(pairingCode, 'relay must surface a pairing code');

  // v0.1.2 §5 splits the credentials in two: a `device_token` authenticates a
  // *machine* on every endpoint except sending work, and the `operator_token`
  // authorises dispatching work. The relay writes the operator token to
  // <state>/operator-token.txt. Both are used below, each where the protocol
  // says it belongs -- this file previously submitted tasks with the device
  // token, which the v0.1.2 security fix deliberately makes impossible.
  const operatorTokenPath = join(stateDir, 'operator-token.txt');
  let operatorToken = null;
  for (let i = 0; i < 50 && !operatorToken; i += 1) {
    if (existsSync(operatorTokenPath)) {
      operatorToken = readFileSync(operatorTokenPath, 'utf8').trim() || null;
    }
    if (!operatorToken) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    operatorToken,
    `relay must write an operator token to ${operatorTokenPath} (§5.1): ${existsSync(operatorTokenPath) ? 'file exists but is empty' : 'file missing'}`,
  );

  const agents = [];
  const startPromises = [];
  t.after(async () => {
    for (const a of agents) await a.stop?.();
    // Swallow rejections: a stop() racing the loop teardown is not a test
    // failure, and an unhandled rejection would crash the runner instead.
    await Promise.allSettled(startPromises);
  });

  let commandToken = null;

  for (const [index, dir] of [repo.a, repo.b].entries()) {
    const machineStateDir = join(repo.root, `agent-state-${index}`);
    mkdirSync(machineStateDir, { recursive: true });

    // The agent takes an explicit identity, caps and platform rather than
    // probing for them: probing is a separate, testable concern (caps.mjs), and
    // keeping it out of the constructor is what lets a machine report honestly
    // instead of guessing.
    const identity = loadOrCreateIdentity({
      dir: machineStateDir,
      name: `e2e-machine-${index}`,
      rabbitUrl: baseUrl,
    }).identity;
    const caps = await probeCaps({});
    const platform = await detectPlatform({});

    const agent = createAgent({
      rabbitUrl: baseUrl,
      project: dir,
      stateDir: machineStateDir,
      identity,
      caps,
      platform,
      // String form on purpose: this is what README and the CLI tell users to
      // write, so the E2E run must exercise `parseAllowedCommands`, not a
      // pre-normalised array.
      allowedCommands: ['node -e', 'node --test', 'git status'],
    });
    agents.push(agent);

    // Pairing is an explicit step, not something `start()` does implicitly: a
    // machine that already holds a token must not be re-paired on every boot.
    await agent.pair(pairingCode);
    assert.ok(agent.identity?.device_token, 'pairing must persist a device_token');
    if (!commandToken) commandToken = agent.identity.device_token;

    // `start()` is the long-running loop -- it does not resolve until `stop()`.
    // Awaiting it would deadlock the suite at the first machine.
    startPromises.push(agent.start());
  }

  // A device token is needed to drive the authenticated endpoints. The agent
  // exposes the identity it paired with, so read it from there rather than
  // re-reading the file.
  if (!commandToken) {
    const idPath = join(repo.root, 'agent-state-0', 'device.json');
    assert.ok(existsSync(idPath), `expected agent identity at ${idPath}`);
    commandToken = JSON.parse(readFileSync(idPath, 'utf8')).device_token;
  }
  assert.ok(commandToken, 'a device_token is required to submit tasks');

  // The relay never holds a working copy, so the anchors must come from a
  // machine. Reading them from machine A is what an operator's `w2m_run` does:
  // the fingerprint is part of the task, and both machines must reproduce it.
  const currentAnchor = async () => {
    const anchor = await treeFingerprint({ cwd: repo.a });
    assert.equal(anchor.error, null, `treeFingerprint failed: ${JSON.stringify(anchor)}`);
    assert.match(String(anchor.fingerprint), /^[0-9a-f]{40}$/, 'fingerprint must be a git tree hash');
    return anchor.fingerprint;
  };

  /**
   * Submit a task anchored to the machines' *current* tree.
   *
   * Recomputing per scenario matters: an earlier scenario that adds or removes a
   * file changes the working tree, so a `base_tree` captured once at the top
   * would make every later task `unverifiable` -- a stale-anchor bug in the test,
   * not in the system.
   */
  const headOf = async (dir) => git(['rev-parse', 'HEAD'], dir);

  const submit = async (body) => {
    const anchored = body.base_tree === undefined
      ? { base_commit: await headOf(repo.a), base_tree: await currentAnchor() }
      : {};
    // Dispatching work is an operator action (§5.2), so this carries the
    // operator token. A device token here would be a 401, by design.
    const res = await fetch(`${baseUrl}/v1/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ ...anchored, ...body }),
    });
    const text = await res.text();
    assert.ok(res.ok, `POST /v1/task -> ${res.status} ${text}`);
    return JSON.parse(text);
  };

  await t.test('1. replicate of an identical command is consistent', async () => {
    const created = await submit({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log("same")'],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
    });

    const verdict = await waitForVerdict(baseUrl, created.task_id, commandToken);
    assert.equal(
      verdict.status,
      'consistent',
      `expected consistent, got ${verdict.status}\n${JSON.stringify(verdict.machines, null, 2)}`,
    );
    assert.equal(verdict.machines.length, 2, 'both machines must appear in the verdict');
  });

  await t.test('2. divergent output is reported as divergent, naming the machine', async () => {
    // A genuine divergence with identical fingerprints. The difference lives in
    // an *ignored* file: `git add -A` honours .gitignore, so both trees still
    // fingerprint identically and the run is verifiable -- which is what makes
    // this a divergence rather than an `unverifiable`. Any difference inside the
    // tracked tree would (correctly) be reported as unverifiable instead, as
    // scenario 6 demonstrates.
    writeFileSync(join(repo.a, 'local.ignored'), 'value-from-a\n');
    writeFileSync(join(repo.b, 'local.ignored'), 'value-from-b\n');

    const created = await submit({
      mode: 'replicate',
      command_argv: [
        NODE,
        '-e',
        'process.stdout.write(require("fs").readFileSync("local.ignored","utf8").trim())',
      ],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
    });

    const verdict = await waitForVerdict(baseUrl, created.task_id, commandToken, { timeoutMs: 40_000 });
    assert.equal(
      verdict.status,
      'divergent',
      `expected divergent, got ${verdict.status}: ${JSON.stringify(verdict.machines, null, 2)}`,
    );
    // The report must be actionable: name the differing field.
    assert.ok(
      (verdict.differences ?? []).length > 0,
      `divergence must name the differing field: ${JSON.stringify(verdict.differences)}`,
    );
  });

  await t.test('3. a non-zero exit is a failure, not a divergence', async () => {
    const created = await submit({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'process.exit(3)'],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
    });
    const verdict = await waitForVerdict(baseUrl, created.task_id, commandToken);
    assert.equal(verdict.status, 'failed', JSON.stringify(verdict.machines, null, 2));
    assert.ok(
      verdict.machines.every((m) => m.exit_code === 3),
      `every machine should report exit 3: ${JSON.stringify(verdict.machines)}`,
    );
  });

  await t.test('4. an unavailable tool is refused, not failed', async () => {
    // Measured: this machine has no `python` on PATH, so the capability gate
    // must refuse rather than let the command fail as a crash.
    const created = await submit({
      mode: 'replicate',
      command_argv: ['python', '-V'],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
      requirements: { toolchain: { python: '*' } },
    });
    const verdict = await waitForVerdict(baseUrl, created.task_id, commandToken);
    assert.ok(
      ['refused', 'failed', 'partial'].includes(verdict.status),
      `unexpected status: ${JSON.stringify(verdict, null, 2)}`,
    );
    const refused = verdict.machines.filter((m) => m.lease_state === 'refused' || m.refusal_reason);
    assert.ok(
      refused.length > 0 || verdict.machines.every((m) => m.exit_code !== 0),
      'an unavailable tool must be refused or fail, never silently succeed',
    );
  });

  await t.test('5. a command outside the whitelist is refused', async () => {
    // Positive control: `node -e` is on the whitelist, so it runs.
    const allowed = await submit({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log("whitelisted")'],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
    });
    const allowedVerdict = await waitForVerdict(baseUrl, allowed.task_id, commandToken);
    assert.equal(allowedVerdict.status, 'consistent', JSON.stringify(allowedVerdict.machines, null, 2));

    // Negative control: `git status` is on the whitelist, `git log` is not, and
    // the whitelist is prefix-based so the longer command is still denied.
    const denied = await submit({
      mode: 'replicate',
      command_argv: ['git', 'log', '--oneline', '-1'],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
    });
    const deniedVerdict = await waitForVerdict(baseUrl, denied.task_id, commandToken);
    assert.ok(
      deniedVerdict.machines.some((m) => m.refusal_reason || m.exit_code !== 0),
      `a non-whitelisted command must be refused: ${JSON.stringify(deniedVerdict.machines)}`,
    );
    assert.ok(
      deniedVerdict.machines.every((m) => m.status !== 'ok'),
      'a denied command must never be reported as ok',
    );
  });

  await t.test('6. a tree that does not match the anchor is unverifiable', async () => {
    // A tracked file is changed on machine A only, so its working tree no longer
    // reproduces `base_tree`. The verdict must be `unverifiable` -- refusal to
    // compare -- and specifically NOT `divergent`, which would report an
    // environment difference as a logic difference.
    const dirtyFile = join(repo.a, 'app.mjs');
    const original = readFileSync(dirtyFile, 'utf8');
    writeFileSync(dirtyFile, `${original}\nexport const tampered = true;\n`);
    try {
      const created = await submit({
        mode: 'replicate',
        command_argv: [NODE, '-e', 'console.log("same")'],
        index_total: 1,
        timeout_ms: 20_000,
        write: false,
      });
      const verdict = await waitForVerdict(baseUrl, created.task_id, commandToken);
      assert.equal(
        verdict.status,
        'unverifiable',
        `expected unverifiable, got ${verdict.status}: ${JSON.stringify(verdict.machines, null, 2)}`,
      );
      assert.notEqual(verdict.status, 'divergent');
    } finally {
      writeFileSync(dirtyFile, original);
    }
  });

  await t.test('7. resubmitting the same result is deduplicated', async () => {
    const created = await submit({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log("dedupe")'],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
    });
    const first = await waitForVerdict(baseUrl, created.task_id, commandToken);
    assert.equal(first.status, 'consistent');

    // Replay an identical envelope for one machine. The relay keys idempotency on
    // (machine_id, dedupe_key, attempt), so this must be reported as a dup and
    // must not add a second record.
    const machinesBefore = first.machines.length;
    const body = {
      envelope_version: '1.0',
      task_id: created.task_id,
      attempt: 1,
      dedupe_key: 'a'.repeat(64),
      machine_id: first.machines[0].machine_id,
      machine_name: 'replay',
      platform: { os: 'windows', os_version: 'x', arch: 'x64', shell: 'direct-exec', shell_version: null },
      caps: {},
      index: 0,
      index_total: 1,
      mode: 'replicate',
      cwd_rel: '.',
      base_commit: repo.baseCommit,
      base_tree: null,
      pre_tree_fingerprint: null,
      post_tree_fingerprint: null,
      fingerprint_algo: 'git-temp-index-tree/v1',
      fingerprint_error: null,
      head_commit: repo.baseCommit,
      dirty_before: false,
      command_argv: [NODE, '-e', 'console.log("dedupe")'],
      command_hash: 'b'.repeat(64),
      shell_id: 'direct-exec',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 1,
      exit_code: 0,
      status: 'ok',
      // §5.1 lists `refusal_reason` as a required envelope field, so a replay
      // probe that omits it is not a well-formed envelope and would be judged
      // `unverifiable` on its own merits rather than on its dedupe_key.
      refusal_reason: null,
      stdout_sha256: 'c'.repeat(64),
      stdout_bytes: 0,
      stderr_sha256: 'd'.repeat(64),
      stderr_bytes: 0,
      warnings: [],
      envelope_sha256: 'e'.repeat(64),
    };
    const post = () => fetch(`${baseUrl}/v1/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${commandToken}` },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    const firstPost = await post();
    const secondPost = await post();
    assert.equal(secondPost.deduped, true, `second POST must be deduplicated: ${JSON.stringify(secondPost)}`);
    void firstPost;

    const after = await fetch(`${baseUrl}/v1/tasks/${created.task_id}`, {
      headers: { authorization: `Bearer ${commandToken}` },
    }).then((r) => r.json());
    assert.equal(after.aggregate?.machines?.length, machinesBefore, 'no extra machine record may appear');
  });

  await t.test('8. a long command is not killed by the lease timer', async () => {
    // 5s with a 10s heartbeat: if the lease were a fixed short timeout this would
    // be reported as expired, which is the double-run hazard the design calls out.
    const created = await submit({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'setTimeout(() => process.stdout.write("done"), 5000)'],
      index_total: 1,
      timeout_ms: 30_000,
      write: false,
    });
    const verdict = await waitForVerdict(baseUrl, created.task_id, commandToken, { timeoutMs: 60_000 });
    assert.equal(verdict.status, 'consistent', JSON.stringify(verdict.machines, null, 2));
    assert.ok(
      verdict.machines.every((m) => m.lease_state !== 'expired'),
      `no lease may expire while the machine is alive: ${JSON.stringify(verdict.machines)}`,
    );
  });

  await t.test('9. split assigns distinct indexes to the machines', async () => {
    const created = await submit({
      mode: 'split',
      command_argv: [NODE, '-e', 'process.stdout.write(String(process.env.W2M_INDEX ?? "no-index"))'],
      index_total: 2,
      timeout_ms: 20_000,
      write: false,
    });
    const verdict = await waitForVerdict(baseUrl, created.task_id, commandToken);
    const indexes = verdict.machines.map((m) => m.index).sort();
    assert.deepEqual(indexes, [0, 1], `split must hand out both shards: ${JSON.stringify(verdict.machines)}`);
  });

  await t.test('10. a device token cannot dispatch work; only the operator token can', async () => {
    // This is the v0.1.2 security fix (§5) exercised against the whole system.
    // Every scenario above goes through `submit()`, which now carries the
    // operator token -- so if the relay ever went back to accepting a device
    // token here, only this scenario would notice.
    const body = {
      base_commit: await headOf(repo.a),
      base_tree: await currentAnchor(),
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log("must not run")'],
      index_total: 1,
      timeout_ms: 20_000,
      write: false,
    };

    const denied = await fetch(`${baseUrl}/v1/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${commandToken}` },
      body: JSON.stringify(body),
    });
    const deniedBody = await denied.json().catch(() => null);
    assert.equal(
      denied.status,
      401,
      `a paired machine must not be able to dispatch work to the group: got ${denied.status} ${JSON.stringify(deniedBody)}`,
    );
    assert.equal(
      deniedBody?.error?.code,
      'OPERATOR_REQUIRED',
      `the refusal must name the missing credential: ${JSON.stringify(deniedBody)}`,
    );

    // Positive control: the operator token performs the same POST successfully.
    // Without this, a relay that rejected *every* POST /v1/task would pass.
    const allowed = await fetch(`${baseUrl}/v1/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify(body),
    });
    assert.equal(allowed.status, 200, `the operator token must still be able to dispatch: ${allowed.status}`);
  });
});
