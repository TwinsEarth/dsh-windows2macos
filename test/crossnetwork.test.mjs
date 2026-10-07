/**
 * Cross-network end-to-end verification for v0.1.2 (PROTOCOL-v0.1.2.md).
 *
 * `e2e.test.mjs` proves the group works on a laptop over loopback. This file
 * proves the three *deployment shapes* work: behind a sub-path, behind a
 * reverse proxy that sets forwarding headers, and across a link slow enough
 * that lease handling could plausibly go wrong. It also proves the relay
 * survives being restarted underneath a live group.
 *
 * Three deliberate choices about method, because each one decides whether the
 * suite can actually fail:
 *
 *  1. **The relay is driven through its real CLI, as a child process.** Every
 *     scenario starts `bin/w2m-rabbit.mjs` with the flags the protocol
 *     documents (`--base-path`, `--trust-proxy`, `--pair-rate-limit`,
 *     `--operator-token`). Internal JS option names are an implementation
 *     detail that can be renamed at any time; the CLI flags and the HTTP
 *     surface are the contract. Driving the CLI is also the only way to test
 *     a *process* restart, which is what scenario 3 is about.
 *
 *  2. **The two machines are two `git clone`s, not two worktrees.** Two
 *     worktrees of one repository share a HEAD and a ref namespace, so they
 *     can drift in ways a real second machine cannot. Clones are what the
 *     deployment actually looks like.
 *
 *  3. **Latency is injected with a real TCP proxy, not by stubbing `fetch`.**
 *     Scenario 8 has to prove something about the network path, so the delay
 *     is applied by an intermediary the agent genuinely talks to. A stubbed
 *     fetch would prove only that the stub was called.
 *
 * Every scenario is written to fail loudly and name the missing capability,
 * rather than skip. A green run that silently skipped the interesting half
 * would be worse than a red one -- and for v0.1.2 the interesting half is
 * exactly the part being written while this file is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const TMP_ROOT = join(REPO_ROOT, '..', '_work', 'w2m', 'e2e-tmp');
const RABBIT_BIN = join(REPO_ROOT, 'bin', 'w2m-rabbit.mjs');

const NODE = process.execPath;
const GIT = 'git';

/** A task body small enough to finish in well under a second on both machines. */
const SMOKE_ARGV = [NODE, '-e', 'console.log("crossnetwork")'];
const ALLOWED = ['node -e', 'node --test', 'git status'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Set `W2M_E2E_DEBUG_CLEANUP=1` to trace scratch-directory teardown. */
const DEBUG_CLEANUP = process.env.W2M_E2E_DEBUG_CLEANUP === '1';

/* ------------------------------------------------------------------ */
/* scratch management: keep the scene when a scenario fails            */
/* ------------------------------------------------------------------ */

/**
 * Allocate a scratch directory that survives a failure.
 *
 * A failing cross-network scenario is nearly impossible to debug after the
 * fact: the relay's stdout, the state directory and the two checkouts are the
 * evidence. So the directory is only removed when the scenario reached its
 * last line.
 *
 * Two details make that work, and both were learned the hard way:
 *
 *  * The removal hook must be registered *last* (`handle.install()` is called
 *    at the end of a scenario). `node:test` runs `t.after` hooks in
 *    registration order, so a hook registered at the top runs *before* the
 *    relay and agent teardown hooks that `startGroup` added -- and removing a
 *    directory whose relay child process is still running fails on Windows.
 *  * The removal must never be swallowed. An earlier version wrapped it in an
 *    empty `catch`, which turned a teardown race into thirty silently leaked
 *    directories from *passing* runs -- the same "only the code, not the
 *    status, is right" failure this suite exists to catch.
 */
function createScratch(t, name) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, `${name}-`));
  const handle = {
    dir,
    reachedEnd: false,
    /** Register the removal hook. Call this as the last statement of a scenario. */
    install() {
      t.after(async () => {
        if (!handle.reachedEnd) return; // the reporting hook already named the scene
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            rmSync(dir, { recursive: true, force: true });
            if (DEBUG_CLEANUP) process.stderr.write(`[crossnetwork] removed ${dir}\n`);
            return;
          } catch (error) {
            if (attempt === 19) {
              process.stderr.write(
                `\n[crossnetwork] could not remove scratch ${dir}: ${error.message}\n`,
              );
              return;
            }
            // Windows releases a dead process's handles asynchronously.
            await sleep(150);
          }
        }
      });
    },
  };
  // Registered first, so it runs first: name the scene as soon as the scenario
  // is known to have failed, before the teardown noise.
  t.after(() => {
    if (!handle.reachedEnd) {
      process.stderr.write(`\n[crossnetwork] FAILED — scratch kept: ${dir}\n`);
    }
  });
  return handle;
}

/* ------------------------------------------------------------------ */
/* git helpers                                                         */
/* ------------------------------------------------------------------ */

function git(args, cwd) {
  const out = spawnSync(GIT, args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${out.stderr || out.stdout}`);
  }
  return out.stdout.trim();
}

/**
 * One origin, two independent clones -- i.e. two machines.
 *
 * `.gitattributes` is committed before anything else and pins `eol=lf`. This
 * machine's system git config has `core.autocrlf=true`, so without it one
 * clone can end up with CRLF and the other LF; the two trees then fingerprint
 * differently and every comparison degrades to `unverifiable`. That failure
 * mode is silent and looks like a relay bug, which is why the file is written
 * first and asserted in scenario 1.
 */
function makeTwoCloneRepo(rootDir) {
  const origin = join(rootDir, 'origin');
  mkdirSync(origin, { recursive: true });

  git(['init', '--initial-branch=main', '.'], origin);
  writeFileSync(join(origin, '.gitattributes'), '* text=auto eol=lf\n');
  // An ignored file is the only way to make the two machines genuinely differ
  // while their tracked trees -- and therefore their fingerprints -- stay equal.
  writeFileSync(join(origin, '.gitignore'), 'local.ignored\n');
  writeFileSync(join(origin, 'app.mjs'), 'export const answer = 42;\n');
  writeFileSync(join(origin, 'README.md'), '# crossnetwork\n');
  git(['add', '-A'], origin);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'base'], origin);
  const baseCommit = git(['rev-parse', 'HEAD'], origin);

  const a = join(rootDir, 'machine-a');
  const b = join(rootDir, 'machine-b');
  git(['clone', '--quiet', origin, a]);
  git(['clone', '--quiet', origin, b]);

  // Assert the precondition here rather than letting it surface as a
  // mysterious `unverifiable` twenty minutes into the suite.
  const attr = readFileSync(join(a, '.gitattributes'), 'utf8');
  assert.match(attr, /text=auto eol=lf/, 'the clone must carry the LF pin');
  assert.equal(git(['status', '--porcelain'], a), '', 'machine A must be clean after clone');
  assert.equal(git(['status', '--porcelain'], b), '', 'machine B must be clean after clone');

  return { origin, a, b, baseCommit };
}

/* ------------------------------------------------------------------ */
/* relay child-process harness                                         */
/* ------------------------------------------------------------------ */

/**
 * Start `w2m-rabbit` as a real child process.
 *
 * `--json` makes the listening line machine-readable, but the rotated pairing
 * code is still printed as prose (the CLI prints it unconditionally), so both
 * forms are parsed out of the same stream. Reading the rotation from stdout is
 * deliberate: it is how an operator learns the new code, so a test that
 * scraped it from anywhere else would not be testing the documented flow.
 */
function startRelayProcess({ stateDir, port = 0, extraArgs = [], env = {} }) {
  const args = [
    RABBIT_BIN,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--state', stateDir,
    '--json',
    ...extraArgs,
  ];
  const proc = spawn(NODE, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const handle = {
    proc,
    args,
    stateDir,
    stdout: '',
    stderr: '',
    port: null,
    pairingCode: null,
    exited: null,
    stopped: false,
    get baseUrl() {
      return handle.port === null ? null : `http://127.0.0.1:${handle.port}`;
    },
    /** Everything the relay ever printed, for failure messages. */
    get log() {
      return `--- relay stdout ---\n${handle.stdout}\n--- relay stderr ---\n${handle.stderr}`;
    },
  };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    handle.stdout += chunk;
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed?.event === 'listening') {
            handle.port = parsed.port;
            handle.pairingCode = parsed.pairingCode ?? handle.pairingCode;
          }
        } catch {
          /* not the status line */
        }
      }
      const rotated = /NEW PAIRING CODE:\s*(\S+)/.exec(line);
      if (rotated) handle.pairingCode = rotated[1];
      const initial = /PAIRING CODE:\s*(\S+?)\s*[│|]/.exec(line);
      if (initial) handle.pairingCode = initial[1];
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    handle.stderr += chunk;
  });
  proc.on('exit', (code, signal) => {
    handle.exited = { code, signal };
  });

  return handle;
}

async function waitForListening(relay, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (relay.port !== null) return relay;
    if (relay.exited) {
      throw new Error(
        `w2m-rabbit exited before listening (code=${relay.exited.code} signal=${relay.exited.signal})\n` +
          `args: ${relay.args.join(' ')}\n${relay.log}`,
      );
    }
    await sleep(50);
  }
  throw new Error(`w2m-rabbit did not report a listening port within ${timeoutMs}ms\n${relay.log}`);
}

/** Stop the relay, preferring a graceful SIGTERM so state can flush. */
async function stopRelay(relay, { signal = 'SIGTERM', timeoutMs = 8_000 } = {}) {
  if (!relay || relay.stopped) return;
  relay.stopped = true;
  if (relay.proc.exitCode !== null || relay.proc.signalCode !== null) return;
  relay.proc.kill(signal);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (relay.proc.exitCode !== null || relay.proc.signalCode !== null) return;
    await sleep(25);
  }
  relay.proc.kill('SIGKILL');
  await sleep(100);
}

/**
 * Hard-kill the relay: no handlers run, nothing flushes on the way out.
 *
 * This is the point of scenario 3. The protocol promises the ledger is appended
 * synchronously and the device table is snapshotted on change, so a `SIGKILL`
 * must lose nothing. A graceful shutdown would let a "flush on exit"
 * implementation pass a test the guarantee does not actually cover.
 */
async function killRelay(relay) {
  if (!relay || relay.stopped) return;
  relay.stopped = true;
  if (relay.proc.exitCode !== null || relay.proc.signalCode !== null) return;
  relay.proc.kill('SIGKILL');
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (relay.proc.exitCode !== null || relay.proc.signalCode !== null) return;
    await sleep(25);
  }
  throw new Error('relay did not die after SIGKILL');
}

/** Wait for the relay to answer /healthz, mounted prefix or not. */
async function waitForRelayReady(relay, { basePath = '', timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const candidates = [`${relay.baseUrl}${basePath}/healthz`, `${relay.baseUrl}/healthz`];
  let lastError = null;
  while (Date.now() < deadline) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return await res.json();
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(100);
  }
  throw new Error(
    `relay never answered /healthz within ${timeoutMs}ms (last error: ${lastError?.message})\n${relay.log}`,
  );
}

/* ------------------------------------------------------------------ */
/* raw HTTP client (headers matter, bodies do not)                     */
/* ------------------------------------------------------------------ */

/**
 * One HTTP request, returning the status line and raw headers.
 *
 * Scenario 6 is about response *headers*, and `fetch` is entitled to normalise
 * or hide them. This reads them off the wire. The response body is read only
 * far enough to prove the connection produced data, then torn down -- an SSE
 * stream never ends on its own.
 */
function rawRequest(url, { method = 'GET', headers = {}, readBytes = 512, settleMs = 300, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settleTimer = null;
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      let total = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(settleTimer);
        req.destroy();
        res.destroy();
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      };
      res.on('data', (chunk) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= readBytes) return finish();
        // An SSE response never ends on its own, so waiting for `end` would
        // hang until the timeout. Once the first bytes arrive, give the stream
        // a short quiet period and then take what we have.
        if (!settleTimer) settleTimer = setTimeout(finish, settleMs);
        return undefined;
      });
      res.on('end', finish);
      res.on('error', finish);
      return undefined;
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`rawRequest timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

async function postJson(url, body, { token = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    /* leave json null; callers assert on status */
  }
  return { status: res.status, ok: res.ok, json, text };
}

/* ------------------------------------------------------------------ */
/* latency injection: a real intermediary                              */
/* ------------------------------------------------------------------ */

/**
 * A TCP/HTTP proxy that holds every request for `delayMs` before forwarding it.
 *
 * Request delay rather than response delay, because the point is to make each
 * round trip cost more -- that is what a long haul does. Responses are piped
 * through untouched so the SSE stream stays a stream; the request counters are
 * exposed so a test can prove the delay was actually on the path rather than
 * silently bypassed.
 */
function createDelayProxy({ targetHost = '127.0.0.1', targetPort, delayMs }) {
  const stats = { requests: 0, delayedMs: 0, bytesUp: 0, errors: 0 };
  const server = http.createServer((req, res) => {
    stats.requests += 1;
    stats.delayedMs += delayMs;
    setTimeout(() => {
      const upstream = http.request(
        { host: targetHost, port: targetPort, path: req.url, method: req.method, headers: req.headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        stats.errors += 1;
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('proxy upstream error');
      });
      req.on('data', (chunk) => {
        stats.bytesUp += chunk.length;
      });
      req.pipe(upstream);
    }, delayMs);
  });
  // An SSE stream is long-lived; the proxy must not time it out the way a
  // default-configured server would.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 120_000;

  return {
    stats,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve({ port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* components under test                                               */
/* ------------------------------------------------------------------ */

async function loadComponents() {
  const paths = {
    agent: join(REPO_ROOT, 'src', 'agent', 'agent.mjs'),
    identity: join(REPO_ROOT, 'src', 'agent', 'identity.mjs'),
    caps: join(REPO_ROOT, 'src', 'agent', 'caps.mjs'),
    git: join(REPO_ROOT, 'src', 'agent', 'git.mjs'),
  };
  const missing = Object.values(paths).filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(`components under test are missing: ${missing.map((p) => p.replace(REPO_ROOT, '<repo>')).join(', ')}`);
  }
  const agent = await import(pathToFileURL(paths.agent).href);
  const identity = await import(pathToFileURL(paths.identity).href);
  const caps = await import(pathToFileURL(paths.caps).href);
  const gitmod = await import(pathToFileURL(paths.git).href);
  return {
    createAgent: agent.createAgent,
    loadOrCreateIdentity: identity.loadOrCreateIdentity,
    probeCaps: caps.probeCaps,
    detectPlatform: caps.detectPlatform,
    treeFingerprint: gitmod.treeFingerprint,
  };
}

/* ------------------------------------------------------------------ */
/* the group: relay + two machines + the operator's helpers            */
/* ------------------------------------------------------------------ */

/**
 * Bring up one relay and two paired, running machines.
 *
 * `rabbitUrlOverride` is how scenarios point the machines at something other
 * than the relay's own address -- the delay proxy in scenario 8, and the
 * sub-path in scenario 1.
 */
async function startGroup(t, {
  scratchDir,
  relayArgs = [],
  basePath = '',
  port = 0,
  operatorToken = null,
  rabbitUrlOverride = null,
  existingRelay = null,
  label = 'group',
}) {
  const { createAgent, loadOrCreateIdentity, probeCaps, detectPlatform, treeFingerprint } =
    await loadComponents();

  const repo = makeTwoCloneRepo(scratchDir);
  const stateDir = join(scratchDir, 'relay-state');
  mkdirSync(stateDir, { recursive: true });

  // Scenario 8 needs a relay whose port is known *before* the machines exist,
  // so the delay proxy can be put in front of it. `existingRelay` is how that
  // relay is handed over without being started twice.
  let relay;
  if (existingRelay) {
    relay = existingRelay;
  } else {
    // The default pairing budget is 5/min/IP and every machine in this suite
    // shares 127.0.0.1, so two machines leave headroom. A scenario that needs
    // more than five pairings on one relay from one address must either raise
    // `--pair-rate-limit` or set it to 0 -- otherwise it fails with a 429 that
    // looks like a pairing bug. The limiter itself is the subject of
    // scenarios 4 and 5d, which set it explicitly.
    const extraArgs = [...relayArgs];
    if (basePath) extraArgs.push('--base-path', basePath);
    if (operatorToken !== null) extraArgs.push('--operator-token', operatorToken);
    relay = startRelayProcess({ stateDir, port, extraArgs });
    t.after(() => stopRelay(relay));
    await waitForListening(relay);
  }
  const health = await waitForRelayReady(relay, { basePath });
  assert.equal(health.ok, true, `relay /healthz must report ok: ${JSON.stringify(health)}`);

  const mounted = basePath && basePath !== '/' ? basePath.replace(/\/+$/, '') : '';
  const relayRootUrl = relay.baseUrl;
  const rabbitUrl = rabbitUrlOverride ?? `${relayRootUrl}${mounted}`;

  // The operator token is read from the file the protocol says it is written
  // to, not from a constructor argument: the file is part of the contract and
  // a caller that got it some other way would not be exercising it.
  const resolveOperatorToken = async () => {
    if (operatorToken) return operatorToken;
    const tokenPath = join(stateDir, 'operator-token.txt');
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(tokenPath)) {
        const value = readFileSync(tokenPath, 'utf8').trim();
        if (value) return value;
      }
      await sleep(100);
    }
    return null;
  };

  const agents = [];
  const startPromises = [];
  const deviceTokens = [];

  // The pairing code rotates on every successful pairing (§2.2), so the second
  // machine needs the code the *first* pairing produced. That code comes from
  // the pairing response's `next_pairing_code`, not from the relay's stdout:
  // the stdout parse is asynchronous, and under load the second machine would
  // occasionally be handed the already-consumed code and fail with
  // PAIRING_INVALID. Taking it from the response makes the sequence exact.
  let pairingCode = relay.pairingCode;
  assert.ok(pairingCode, `the relay must surface a pairing code at startup\n${relay.log}`);

  for (const [index, dir] of [repo.a, repo.b].entries()) {
    const machineStateDir = join(scratchDir, `agent-state-${index}`);
    mkdirSync(machineStateDir, { recursive: true });
    const identity = loadOrCreateIdentity({
      dir: machineStateDir,
      name: `${label}-machine-${index}`,
      rabbitUrl,
    }).identity;
    const caps = await probeCaps({});
    const platform = await detectPlatform({});
    const agent = createAgent({
      rabbitUrl,
      project: dir,
      stateDir: machineStateDir,
      identity,
      caps,
      platform,
      allowedCommands: ALLOWED,
    });
    agents.push(agent);
    deviceTokens.push(null);

    const paired = await agent.pair(pairingCode);
    assert.ok(agent.identity.device_token, `machine ${index} must hold a device_token after pairing`);
    deviceTokens[index] = agent.identity.device_token;
    pairingCode = paired?.next_pairing_code ?? relay.pairingCode;
  }

  t.after(async () => {
    for (const a of agents) {
      try {
        await a.stop?.();
      } catch {
        /* teardown races are not failures */
      }
    }
    await Promise.allSettled(startPromises);
  });

  for (const a of agents) startPromises.push(a.start());

  const headOf = async (dir) => git(['rev-parse', 'HEAD'], dir);
  const anchorOf = async (dir) => {
    const anchor = await treeFingerprint({ cwd: dir });
    assert.equal(anchor.error, null, `treeFingerprint failed: ${JSON.stringify(anchor)}`);
    return anchor.fingerprint;
  };

  /** Submit work as the *operator*, anchored to machine A's live tree. */
  const submit = async (body) => {
    const token = await resolveOperatorToken();
    assert.ok(
      token,
      `no operator token: neither --operator-token nor <state>/operator-token.txt produced one ` +
        `(PROTOCOL-v0.1.2 §5). ${relay.log}`,
    );
    const anchored = body.base_tree === undefined
      ? { base_commit: await headOf(repo.a), base_tree: await anchorOf(repo.a) }
      : {};
    const res = await postJson(`${rabbitUrl}/v1/task`, { ...anchored, ...body }, { token });
    assert.ok(res.ok, `POST ${rabbitUrl}/v1/task -> ${res.status} ${res.text}`);
    return res.json;
  };

  return {
    repo, relay, stateDir, agents, deviceTokens, rabbitUrl, mounted, relayRootUrl,
    operatorToken: resolveOperatorToken, submit, anchorOf, headOf, treeFingerprint,
  };
}

/**
 * Poll a task until its verdict can no longer change.
 *
 * Identical in spirit to the e2e helper: `partial` while machines are still
 * pending is not settled, because the relay reports it the moment the first
 * result lands.
 */
async function waitForVerdict(group, taskId, { timeoutMs = 90_000, intervalMs = 200 } = {}) {
  const token = group.deviceTokens[0];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${group.rabbitUrl}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = await res.json();
      last = body.aggregate ?? body;
      const machines = last.machines ?? [];
      const pending = machines.filter((m) => m.outcome === 'pending');
      const terminal = last.status && last.status !== 'pending';
      if (terminal && pending.length === 0) return last;
      if (terminal && machines.length > 0 && machines.every((m) => m.lease_state === 'refused')) return last;
    }
    await sleep(intervalMs);
  }
  throw new Error(`task ${taskId} did not settle within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

/* ================================================================== */
/* 1. sub-path deployment                                             */
/* ================================================================== */

test('crossnetwork 1: one relay behind --base-path /w2m, two machines, still consistent', async (t) => {
  const sc = createScratch(t, 'cn1-basepath');
  const group = await startGroup(t, { scratchDir: sc.dir, basePath: '/w2m', label: 'cn1' });

  await t.test('1a. the relay reports the mount point it is serving', async () => {
    const health = await fetch(`${group.relayRootUrl}/w2m/healthz`).then((r) => r.json());
    assert.equal(health.base_path, '/w2m', `healthz.base_path must be the mounted prefix: ${JSON.stringify(health)}`);
  });

  await t.test('1b. both health paths answer, /v1/* only answers under the prefix', async () => {
    // §3: health checks are routinely wired straight to the root by a proxy,
    // but the API must stay behind the prefix or a mis-mounted relay silently
    // serves two addresses.
    const prefixed = await fetch(`${group.relayRootUrl}/w2m/healthz`);
    const root = await fetch(`${group.relayRootUrl}/healthz`);
    assert.equal(prefixed.status, 200, '/w2m/healthz must answer');
    assert.equal(root.status, 200, '/healthz must answer too (reverse proxies often probe the root)');

    const unPrefixedTask = await fetch(`${group.relayRootUrl}/v1/tasks`, {
      headers: { authorization: `Bearer ${group.deviceTokens[0]}` },
    });
    assert.equal(unPrefixedTask.status, 404, 'un-prefixed /v1/* must be 404, not silently routed');
  });

  await t.test('1c. reverse control: the old new URL() form really does 404 here', async () => {
    // This is the assertion that makes 1d meaningful. If the prefix were
    // stripped somewhere else -- or if /v1/* also answered at the root -- the
    // sub-path test would pass even with the original defect present.
    const buggy = new URL('/v1/stream', group.rabbitUrl).toString();
    assert.equal(
      new URL(buggy).pathname,
      '/v1/stream',
      'new URL() must be shown to drop the prefix, otherwise this control proves nothing',
    );
    assert.ok(!new URL(buggy).pathname.startsWith('/w2m'), 'the prefix must be gone from the buggy form');

    const res = await rawRequest(buggy, { headers: { authorization: `Bearer ${group.deviceTokens[0]}` } });
    assert.equal(
      res.status,
      404,
      `the defect's target (${buggy}) must 404 on a sub-path relay; got ${res.status}. ` +
        'If this is 200 the control is void and 1d proves nothing.',
    );
  });

  await t.test('1d. a replicate task submitted under the sub-path is consistent', async () => {
    const created = await group.submit({
      mode: 'replicate',
      command_argv: SMOKE_ARGV,
      index_total: 1,
      timeout_ms: 30_000,
      write: false,
    });
    const verdict = await waitForVerdict(group, created.task_id);
    assert.equal(
      verdict.status,
      'consistent',
      `sub-path replicate must be consistent, got ${verdict.status}: ${JSON.stringify(verdict.machines, null, 2)}`,
    );
    assert.equal(verdict.machines.length, 2, 'both machines must have reported');
  });

  sc.reachedEnd = true;
  sc.install();
});

/* ================================================================== */
/* 2. operator token, three states                                    */
/* ================================================================== */

test('crossnetwork 2: POST /v1/task needs the operator token, not a device token', async (t) => {
  const sc = createScratch(t, 'cn2-operator');
  const OPERATOR = 'operator-token-for-scenario-2';
  const group = await startGroup(t, {
    scratchDir: sc.dir,
    operatorToken: OPERATOR,
    label: 'cn2',
  });

  const taskBody = async () => ({
    base_commit: await group.headOf(group.repo.a),
    base_tree: await group.anchorOf(group.repo.a),
    mode: 'replicate',
    command_argv: SMOKE_ARGV,
    index_total: 1,
    timeout_ms: 30_000,
    write: false,
  });

  await t.test('2a. no Authorization header -> 401 OPERATOR_REQUIRED', async () => {
    const res = await postJson(`${group.rabbitUrl}/v1/task`, await taskBody());
    assert.equal(res.status, 401, `missing credential must be 401, got ${res.status} ${res.text}`);
    assert.equal(
      res.json?.error?.code,
      'OPERATOR_REQUIRED',
      `error code must name the missing credential: ${res.text}`,
    );
  });

  await t.test('2b. a device_token -> 401 and the message says which token is needed', async () => {
    const res = await postJson(`${group.rabbitUrl}/v1/task`, await taskBody(), {
      token: group.deviceTokens[0],
    });
    assert.equal(res.status, 401, `a device token must not authorise work, got ${res.status} ${res.text}`);
    assert.equal(res.json?.error?.code, 'OPERATOR_REQUIRED', `unexpected error code: ${res.text}`);
    // §5.2: the whole point of separating the two tokens is that the failure is
    // diagnosable. A generic "unauthorized" would leave an operator re-pairing
    // machines instead of finding the operator token.
    const message = String(res.json?.error?.message ?? '');
    assert.match(
      message,
      /operator/i,
      `message must name the operator token: ${JSON.stringify(message)}`,
    );
    assert.match(
      message,
      /device/i,
      `message must say that what was supplied is a device token: ${JSON.stringify(message)}`,
    );
  });

  await t.test('2c. the operator token -> 200, and the task actually runs', async () => {
    const res = await postJson(`${group.rabbitUrl}/v1/task`, await taskBody(), { token: OPERATOR });
    assert.equal(res.status, 200, `operator token must authorise work: ${res.status} ${res.text}`);
    const taskId = res.json?.task_id;
    assert.ok(taskId, `a task_id must come back: ${res.text}`);

    const verdict = await waitForVerdict(group, taskId);
    assert.equal(
      verdict.status,
      'consistent',
      `the authorised task must run to completion: ${JSON.stringify(verdict.machines, null, 2)}`,
    );
  });

  await t.test('2d. /healthz advertises that the requirement is on', async () => {
    const health = await fetch(`${group.rabbitUrl}/healthz`).then((r) => r.json());
    assert.equal(
      health.operator_token_required,
      true,
      `healthz must advertise the requirement (§4): ${JSON.stringify(health)}`,
    );
  });

  await t.test('2e. the --json stream does not leak the operator token', async () => {
    // A relay's startup output ends up in CI logs, terminal scrollback and
    // issue reports. The operator token authorises dispatching work to every
    // machine in the group, so it must not ride along in the machine-readable
    // stream: an operator reads it from <state>/operator-token.txt (and from
    // the human-readable banner), never by scraping --json.
    assert.ok(
      !group.relay.stdout.includes(OPERATOR),
      `the operator token appears verbatim in the relay's --json stdout:\n${group.relay.stdout}`,
    );
  });

  sc.reachedEnd = true;
  sc.install();
});

/* ================================================================== */
/* 3 + 7. persistence, restart visibility                             */
/* ================================================================== */

test('crossnetwork 3: a hard relay restart loses no device and no task', async (t) => {
  const sc = createScratch(t, 'cn3-restart');
  const OPERATOR = 'operator-token-for-scenario-3';
  const group = await startGroup(t, {
    scratchDir: sc.dir,
    operatorToken: OPERATOR,
    label: 'cn3',
  });

  // --- before the restart -------------------------------------------------
  const first = await group.submit({
    mode: 'replicate',
    command_argv: SMOKE_ARGV,
    index_total: 1,
    timeout_ms: 30_000,
    write: false,
  });
  const firstVerdict = await waitForVerdict(group, first.task_id);
  assert.equal(firstVerdict.status, 'consistent', JSON.stringify(firstVerdict.machines, null, 2));

  const machineIdBefore = firstVerdict.machines[0].machine_id;
  const healthBefore = await fetch(`${group.rabbitUrl}/healthz`).then((r) => r.json());

  // The idempotency probe rides on its *own* task.
  //
  // It posts a synthetic envelope, which is deliberately not a real machine
  // result: it has no valid anchors and a made-up command_hash. Attaching it to
  // `first` would (correctly) drag that task's aggregate to `unverifiable`,
  // destroying the very verdict 3b exists to assert. Isolating the probe keeps
  // each assertion measuring one thing.
  const probe = await group.submit({
    mode: 'replicate',
    command_argv: [NODE, '-e', 'console.log("dedupe-probe")'],
    index_total: 1,
    timeout_ms: 30_000,
    write: false,
  });
  await waitForVerdict(group, probe.task_id);

  // One envelope posted before the restart, replayed after it. Idempotency that
  // only survives inside a single process is not idempotency: the whole point of
  // the ledger is that `dedupe_key` outlives the process that first saw it.
  const replayEnvelope = {
    envelope_version: '1.0',
    task_id: probe.task_id,
    attempt: 1,
    dedupe_key: 'f'.repeat(64),
    machine_id: machineIdBefore,
    machine_name: 'crossnetwork-replay',
    platform: { os: 'windows', os_version: 'x', arch: 'x64', shell: 'direct-exec', shell_version: null },
    caps: {},
    index: 0,
    index_total: 1,
    mode: 'replicate',
    cwd_rel: '.',
    base_commit: group.repo.baseCommit,
    base_tree: null,
    pre_tree_fingerprint: null,
    post_tree_fingerprint: null,
    fingerprint_algo: 'git-temp-index-tree/v1',
    fingerprint_error: null,
    head_commit: group.repo.baseCommit,
    dirty_before: false,
    command_argv: SMOKE_ARGV,
    command_hash: 'b'.repeat(64),
    shell_id: 'direct-exec',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 1,
    exit_code: 0,
    status: 'ok',
    refusal_reason: null, // §5.1 lists it as required, so the probe must be well-formed
    stdout_sha256: 'c'.repeat(64),
    stdout_bytes: 0,
    stderr_sha256: 'd'.repeat(64),
    stderr_bytes: 0,
    warnings: [],
    envelope_sha256: 'e'.repeat(64),
  };
  const firstReplay = await postJson(`${group.rabbitUrl}/v1/result`, replayEnvelope, {
    token: group.deviceTokens[0],
  });
  assert.equal(firstReplay.status, 200, `pre-restart envelope must be accepted: ${firstReplay.text}`);
  assert.notEqual(
    firstReplay.json?.deduped,
    true,
    `the probe's *first* delivery must not already be a duplicate, or the cross-restart ` +
      `assertion in 3c would be vacuous: ${firstReplay.text}`,
  );

  // --- the restart --------------------------------------------------------
  const port = group.relay.port;
  const stateDir = group.stateDir;
  await killRelay(group.relay); // SIGKILL: nothing gets a chance to flush

  const relay2 = startRelayProcess({
    stateDir,
    port, // same port, so the machines' rabbitUrl is unchanged
    extraArgs: ['--operator-token', OPERATOR],
  });
  t.after(() => stopRelay(relay2));
  await waitForListening(relay2);
  await waitForRelayReady(relay2);
  group.relay = relay2; // the assertions below talk to the new process

  await t.test('3a. machines do not have to pair again', async () => {
    const devices = await fetch(`${group.rabbitUrl}/v1/devices`, {
      headers: { authorization: `Bearer ${group.deviceTokens[0]}` },
    });
    assert.equal(
      devices.status,
      200,
      `the pre-restart device_token must still authenticate — a 401 here means every machine ` +
        `has to be re-paired after a relay restart. ${group.relay.log}`,
    );
    const body = await devices.json();
    assert.ok(
      body.devices.some((d) => d.machine_id === machineIdBefore),
      `device ${machineIdBefore} must survive the restart: ${JSON.stringify(body.devices)}`,
    );

    // Stronger than reading the table: a *new* task must be picked up by the
    // machines that were paired before the restart, over their existing tokens.
    const created = await group.submit({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'console.log("after-restart")'],
      index_total: 1,
      timeout_ms: 40_000,
      write: false,
    });
    const verdict = await waitForVerdict(group, created.task_id, { timeoutMs: 90_000 });
    assert.equal(
      verdict.status,
      'consistent',
      `machines must resume without re-pairing: ${JSON.stringify(verdict.machines, null, 2)}`,
    );
    group.afterRestartTaskId = created.task_id;
    group.afterRestartVerdict = verdict;
  });

  await t.test('3b. tasks from before and after the restart are both in the ledger', async () => {
    const res = await fetch(`${group.rabbitUrl}/v1/tasks?limit=50`, {
      headers: { authorization: `Bearer ${group.deviceTokens[0]}` },
    });
    assert.equal(res.status, 200, `GET /v1/tasks failed: ${res.status}`);
    const body = await res.json();
    const ids = new Set((body.tasks ?? []).map((task) => task.task_id ?? task.id));
    assert.ok(
      ids.has(first.task_id),
      `the task completed before the restart must still be listed — replaying ledger.jsonl is what ` +
        `makes it survive. Ledger has: ${JSON.stringify([...ids])}`,
    );
    assert.ok(
      ids.has(group.afterRestartTaskId),
      `the task created after the restart must be listed: ${JSON.stringify([...ids])}`,
    );

    // The old task must still be *readable in full*, not merely listed: the
    // aggregate is what an operator compares, and it is rebuilt from the ledger.
    const oldTask = await fetch(`${group.rabbitUrl}/v1/tasks/${first.task_id}`, {
      headers: { authorization: `Bearer ${group.deviceTokens[0]}` },
    });
    assert.equal(oldTask.status, 200, 'a pre-restart task must still be retrievable');
    const oldBody = await oldTask.json();
    assert.equal(
      oldBody.aggregate?.status,
      'consistent',
      `the pre-restart verdict must be reconstructed from the ledger: ${JSON.stringify(oldBody.aggregate)}`,
    );
  });

  await t.test('3c. the same dedupe_key is still deduplicated after the restart', async () => {
    const replay = await postJson(`${group.rabbitUrl}/v1/result`, replayEnvelope, {
      token: group.deviceTokens[0],
    });
    assert.equal(replay.status, 200, `replayed envelope must be accepted: ${replay.text}`);
    assert.equal(
      replay.json?.deduped,
      true,
      `the same dedupe_key posted before the restart must still be recognised as a duplicate. ` +
        `Got ${JSON.stringify(replay.json)}. This is the assertion that proves the dedupe index is ` +
        `rebuilt from the ledger rather than from memory.`,
    );
  });

  await t.test('7. relay_id changes and uptime_ms resets across the restart', async () => {
    assert.ok(healthBefore.relay_id, `pre-restart /healthz must expose relay_id (§4): ${JSON.stringify(healthBefore)}`);
    assert.ok(healthBefore.started_at, `pre-restart /healthz must expose started_at: ${JSON.stringify(healthBefore)}`);

    const healthAfter = await fetch(`${group.rabbitUrl}/healthz`).then((r) => r.json());
    assert.ok(healthAfter.relay_id, `post-restart /healthz must expose relay_id: ${JSON.stringify(healthAfter)}`);
    assert.notEqual(
      healthAfter.relay_id,
      healthBefore.relay_id,
      'relay_id must differ after a restart — that is precisely how a client detects one (§8.3)',
    );
    assert.ok(
      healthAfter.uptime_ms < healthBefore.uptime_ms + 1_000,
      `uptime_ms must reset on restart: before=${healthBefore.uptime_ms} after=${healthAfter.uptime_ms}`,
    );
    assert.ok(healthAfter.uptime_ms < 60_000, `a fresh process must report a small uptime: ${healthAfter.uptime_ms}`);
  });

  sc.reachedEnd = true;
  sc.install();
});

/* ================================================================== */
/* 4. pairing rate limit                                              */
/* ================================================================== */

test('crossnetwork 4: /v1/pair is rate limited per IP, and recovers', async (t) => {
  const sc = createScratch(t, 'cn4-ratelimit');
  mkdirSync(TMP_ROOT, { recursive: true });
  const stateDir = join(sc.dir, 'relay-state');
  mkdirSync(stateDir, { recursive: true });

  const LIMIT = 2; // smallest meaningful budget; the window is fixed at 60s by §6
  const relay = startRelayProcess({
    stateDir,
    extraArgs: ['--pair-rate-limit', String(LIMIT)],
  });
  t.after(() => stopRelay(relay));
  await waitForListening(relay);
  await waitForRelayReady(relay);

  const attempt = (n) =>
    postJson(`${relay.baseUrl}/v1/pair`, {
      pairing_code: `PAIR-NOTREAL${n}`,
      machine_id: `ratelimit-probe-${n}`,
      machine_name: `probe-${n}`,
    });

  await t.test('4a. the relay advertises the configured budget', async () => {
    const health = await fetch(`${relay.baseUrl}/healthz`).then((r) => r.json());
    assert.equal(
      health.pair_rate_limit,
      LIMIT,
      `healthz.pair_rate_limit must echo --pair-rate-limit (§4): ${JSON.stringify(health)}`,
    );
  });

  let limited = null;
  const statuses = [];

  await t.test('4b. attempts past the budget return 429 RATE_LIMITED with retry_after_seconds', async () => {
    // Fire well past the budget. Failures count, which is the point: otherwise
    // an attacker gets unlimited guesses by never succeeding.
    for (let i = 1; i <= LIMIT + 4; i += 1) {
      const res = await attempt(i);
      statuses.push(res.status);
      if (res.status === 429 && limited === null) limited = res;
    }
    assert.ok(
      limited,
      `expected a 429 within ${LIMIT + 4} attempts against a budget of ${LIMIT}; got ${JSON.stringify(statuses)}`,
    );
    assert.equal(
      limited.json?.error?.code,
      'RATE_LIMITED',
      `the error code must be RATE_LIMITED: ${limited.text}`,
    );
    const retryAfter = limited.json?.error?.detail?.retry_after_seconds ?? limited.json?.retry_after_seconds;
    assert.equal(
      typeof retryAfter,
      'number',
      `429 must carry retry_after_seconds so a client knows when to come back: ${limited.text}`,
    );
    assert.ok(retryAfter > 0 && retryAfter <= 60, `retry_after_seconds must be within the window: ${retryAfter}`);
  });

  await t.test('4c. the window rolls over and pairing is possible again', async () => {
    const retryAfter = limited.json?.error?.detail?.retry_after_seconds ?? limited.json?.retry_after_seconds ?? 60;
    // The window is a fixed 60s in §6, so this genuinely has to wait. Capped so
    // a bug that reports an absurd retry_after cannot hang the suite forever.
    const waitMs = Math.min(Math.ceil(retryAfter) * 1_000 + 1_500, 90_000);
    process.stderr.write(`[crossnetwork] rate-limit window: waiting ${waitMs}ms as reported\n`);
    await sleep(waitMs);

    // A *valid* pairing must now succeed: this proves the limiter recovered,
    // not merely that it stopped returning 429 for malformed input.
    const pairUrl = `${relay.baseUrl}/v1/pair`;
    const first = await fetch(pairUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_code: relay.pairingCode,
        machine_id: 'ratelimit-recovery',
        machine_name: 'recovery',
      }),
    });
    const body = await first.json().catch(() => null);
    assert.equal(
      first.status,
      200,
      `after the window a valid pairing must succeed again; got ${first.status} ${JSON.stringify(body)}. ` +
        `Statuses seen before: ${JSON.stringify(statuses)}`,
    );
  });

  sc.reachedEnd = true;
  sc.install();
});

/* ================================================================== */
/* 5. proxy header trust boundary                                     */
/* ================================================================== */

test('crossnetwork 5: --trust-proxy is the boundary that decides whether X-Forwarded-Proto counts', async (t) => {
  const sc = createScratch(t, 'cn5-proxy');
  mkdirSync(TMP_ROOT, { recursive: true });

  const bootRelay = async (name, extraArgs) => {
    const stateDir = join(sc.dir, name);
    mkdirSync(stateDir, { recursive: true });
    const relay = startRelayProcess({ stateDir, extraArgs });
    t.after(() => stopRelay(relay));
    await waitForListening(relay);
    await waitForRelayReady(relay);
    return relay;
  };

  const trusting = await bootRelay('trusting', ['--trust-proxy']);
  const suspicious = await bootRelay('suspicious', []);

  await t.test('5a. with --trust-proxy on, the header is believed', async () => {
    const res = await fetch(`${trusting.baseUrl}/healthz`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const health = await res.json();
    assert.equal(
      health.effective_scheme,
      'https',
      `behind a proxy that terminates TLS the relay must report https: ${JSON.stringify(health)}`,
    );
  });

  await t.test('5b. with --trust-proxy on and no header, it falls back to the real listener', async () => {
    const health = await fetch(`${trusting.baseUrl}/healthz`).then((r) => r.json());
    assert.equal(
      health.effective_scheme,
      'http',
      `with no forwarded header the relay must report its own scheme: ${JSON.stringify(health)}`,
    );
  });

  await t.test('5c. with --trust-proxy OFF, the header is ignored', async () => {
    // The security boundary. If this fails, any client can claim to be behind
    // TLS -- and, via X-Forwarded-For, pick its own rate-limit bucket.
    const health = await fetch(`${suspicious.baseUrl}/healthz`, {
      headers: { 'x-forwarded-proto': 'https' },
    }).then((r) => r.json());
    assert.equal(
      health.effective_scheme,
      'http',
      `an untrusted client must not be able to claim https. Got ${JSON.stringify(health)}. ` +
        `This is the forgery boundary called out in §3.`,
    );
  });

  await t.test('5d. with --trust-proxy OFF, X-Forwarded-For cannot move the rate-limit bucket', async () => {
    // Same boundary, measured through a different door: a forged XFF must not
    // give a fresh pairing budget.
    const stateDir = join(sc.dir, 'xff');
    mkdirSync(stateDir, { recursive: true });
    const relay = startRelayProcess({ stateDir, extraArgs: ['--pair-rate-limit', '2'] });
    t.after(() => stopRelay(relay));
    await waitForListening(relay);
    await waitForRelayReady(relay);

    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await postJson(
        `${relay.baseUrl}/v1/pair`,
        { pairing_code: `PAIR-NOPE${i}`, machine_id: `xff-probe-${i}`, machine_name: 'xff' },
        { token: null },
      );
      statuses.push(res.status);
    }
    // Each attempt claims a different client address. If the limiter believed
    // the header without --trust-proxy, every attempt would land in its own
    // bucket and nothing would ever be limited.
    assert.ok(
      statuses.includes(429),
      `rotating X-Forwarded-For must not defeat the limiter when the proxy is untrusted; got ${JSON.stringify(statuses)}`,
    );
  });

  sc.reachedEnd = true;
  sc.install();
});

/* ================================================================== */
/* 6. SSE anti-buffering headers                                      */
/* ================================================================== */

test('crossnetwork 6: the event stream carries anti-buffering headers', async (t) => {
  const sc = createScratch(t, 'cn6-sse');
  mkdirSync(TMP_ROOT, { recursive: true });
  const stateDir = join(sc.dir, 'relay-state');
  mkdirSync(stateDir, { recursive: true });

  const relay = startRelayProcess({ stateDir });
  t.after(() => stopRelay(relay));
  await waitForListening(relay);
  await waitForRelayReady(relay);

  // A device token is needed to reach /v1/stream; pair one directly rather than
  // standing up two machines for a header assertion.
  const paired = await postJson(`${relay.baseUrl}/v1/pair`, {
    pairing_code: relay.pairingCode,
    machine_id: 'sse-probe',
    machine_name: 'sse-probe',
  });
  assert.equal(paired.status, 200, `pairing the probe failed: ${paired.text}`);
  const deviceToken = paired.json.device_token;

  await t.test('6a. raw response headers include the anti-buffering pair', async () => {
    const res = await rawRequest(`${relay.baseUrl}/v1/stream`, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: 'text/event-stream' },
    });

    assert.equal(res.status, 200, `SSE endpoint must answer 200: ${res.status}`);
    assert.match(
      String(res.headers['content-type'] ?? ''),
      /text\/event-stream/,
      `content-type must be text/event-stream: ${JSON.stringify(res.headers)}`,
    );

    // §8.5: the single most common "it connects but no events arrive" failure
    // behind nginx and Cloudflare Tunnel. Both headers are required.
    assert.equal(
      res.headers['x-accel-buffering'],
      'no',
      `X-Accel-Buffering: no is required so nginx-class proxies do not buffer the stream. ` +
        `Headers seen: ${JSON.stringify(res.headers)}`,
    );
    const cacheControl = String(res.headers['cache-control'] ?? '');
    assert.match(
      cacheControl,
      /no-cache/,
      `Cache-Control must contain no-cache: ${JSON.stringify(cacheControl)}`,
    );
    assert.match(
      cacheControl,
      /no-transform/,
      `Cache-Control must contain no-transform, which is what stops a proxy from rewriting the stream: ${JSON.stringify(cacheControl)}`,
    );
  });

  await t.test('6b. the first frame on the wire is ready, and the stream stays open', async () => {
    const res = await rawRequest(`${relay.baseUrl}/v1/stream`, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: 'text/event-stream' },
      readBytes: 1_024,
    });
    assert.match(
      res.body,
      /event: ready/,
      `§3.1: the first frame must be ready; body so far: ${JSON.stringify(res.body.slice(0, 400))}`,
    );
  });

  sc.reachedEnd = true;
  sc.install();
});

/* ================================================================== */
/* 8. 300ms added latency must not expire a lease                      */
/* ================================================================== */

test('crossnetwork 8: 300ms round trips do not make a live machine look dead', async (t) => {
  const sc = createScratch(t, 'cn8-latency');

  // Bring the relay up first so the proxy has a port to forward to.
  mkdirSync(TMP_ROOT, { recursive: true });
  const stateDir = join(sc.dir, 'relay-state');
  mkdirSync(stateDir, { recursive: true });
  const relay = startRelayProcess({ stateDir, extraArgs: [] });
  t.after(() => stopRelay(relay));
  await waitForListening(relay);
  await waitForRelayReady(relay);

  const proxy = createDelayProxy({ targetPort: relay.port, delayMs: 300 });
  const proxyInfo = await proxy.listen();
  t.after(() => proxy.close());

  const group = await startGroup(t, {
    scratchDir: sc.dir,
    label: 'cn8',
    existingRelay: relay, // machines only; the relay is already up behind the proxy
    rabbitUrlOverride: proxyInfo.url,
  });

  await t.test('8a. the delay really is on the path', async () => {
    // Without this, a proxy that never got used would make 8b pass vacuously.
    const before = proxy.stats.requests;
    await fetch(`${proxyInfo.url}/healthz`);
    assert.ok(
      proxy.stats.requests > before,
      `the machines must actually reach the relay through the delay proxy; stats=${JSON.stringify(proxy.stats)}`,
    );
    assert.ok(proxy.stats.delayedMs >= 300, `the proxy must have applied its delay: ${JSON.stringify(proxy.stats)}`);
  });

  await t.test('8b. a 5s task across a 300ms link is still consistent, no lease expired', async () => {
    const created = await group.submit({
      mode: 'replicate',
      command_argv: [NODE, '-e', 'setTimeout(() => process.stdout.write("slow-done"), 5000)'],
      index_total: 1,
      timeout_ms: 40_000,
      write: false,
    });
    const verdict = await waitForVerdict(group, created.task_id, { timeoutMs: 120_000 });

    assert.equal(
      verdict.status,
      'consistent',
      `a 5s task over a 300ms link must still be consistent: ${JSON.stringify(verdict.machines, null, 2)}`,
    );
    assert.ok(
      verdict.machines.every((m) => m.lease_state !== 'expired'),
      `no lease may expire while the machine is heartbeating (that is the double-run hazard): ` +
        `${JSON.stringify(verdict.machines)}`,
    );
    assert.ok(
      proxy.stats.requests > 10,
      `the whole run must have crossed the slow link; stats=${JSON.stringify(proxy.stats)}`,
    );
  });

  sc.reachedEnd = true;
  sc.install();
});
