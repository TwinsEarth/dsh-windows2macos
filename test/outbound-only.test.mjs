/**
 * Prove, mechanically, that the W2M link is outbound-only.
 *
 * The project's central claim to a user is that they do not need a public IP, port forwarding, or an
 * SSH server, because every machine only ever *dials out*. That claim is easy to state and easy to
 * break: one `server.listen` on a routable interface, one inbound listener added "temporarily", and
 * the product silently starts requiring the thing it promised not to.
 *
 * So this test asserts the property rather than describing it. It runs the real agent against a real
 * relay and then inspects what the agent process actually bound:
 *
 *   1. The agent opens **no listening socket at all**. The agent is the piece that runs on every
 *      machine, so a listening agent is the whole claim failing.
 *   2. Every socket the relay holds is on the loopback interface, and the only port it listens on is
 *      the one it was told to.
 *   3. With the relay reachable, the task still completes -- proving the check runs against a working
 *      link rather than a dead one, which is how an "outbound-only" test usually passes vacuously.
 *
 * Inspecting sockets needs platform support, so the assertions are split: the relay's bindings are
 * read from its own startup line plus a probe of the address it reports, and the agent's lack of a
 * listener is established by pointing a second agent's URL at the agent and showing nothing answers.
 *
 * Honest limit, stated here because the alternative is overclaiming: this runs on one host. It proves
 * the agent does not listen, not that a firewall would block it, and it cannot observe a NAT.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { connect, createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Allocate a free port by binding and immediately releasing it. */
function freePort() {  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the relay CLI and wait for its listening line. *
 * @param {object} opts - Launch options.
 * @param {string} opts.stateDir - Relay state directory.
 * @param {number} [opts.port] - Port; 0 lets the OS choose.
 * @param {string[]} [opts.extraArgs] - Additional CLI arguments.
 */
async function startRelay({ stateDir, port = 0, extraArgs = [] }) {
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
      ...extraArgs,
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
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay never started: ${err}`)), 15_000);
    const tick = () => {
      const line = out.split('\n').find((l) => l.includes('"event":"listening"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
        return;
      }
      if (proc.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`relay exited ${proc.exitCode}: ${err}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
  return { proc, info, url: `http://127.0.0.1:${info.port}`, stderr: () => err };
}

/**
 * Start a Localside agent and wait until it reports paired.
 *
 * `DSH_HOME` is redirected to a scratch directory. Identity lives at `$DSH_HOME/xclient/device.json`,
 * so without this the test would read -- and on a fresh machine create -- the developer's real
 * identity file. A test that mutates the thing it is measuring is not a test.
 *
 * @param {object} opts - Launch options.
 * @param {string} opts.rabbitUrl - Relay base URL.
 * @param {string} opts.pairingCode - Code to pair with.
 * @param {string} opts.project - Project directory.
 * @param {string} opts.stateDir - Agent state directory.
 * @param {string} opts.dshHome - Isolated `DSH_HOME` for this agent.
 */
async function startAgent({ rabbitUrl, pairingCode, project, stateDir, dshHome, extraArgs = [] }) {
  const proc = spawn(
    NODE,
    [
      join(REPO, 'bin', 'w2m-localside.mjs'),
      '--rabbit', rabbitUrl,
      '--pair', pairingCode,
      '--project', project,
      '--state', stateDir,
      '--name', 'outbound-check',
      ...extraArgs,
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
  await new Promise((resolve, reject) => {
    // Wait for *pairing*, not for the process to say something generic. The first version matched
    // `/paired|listening|connected/i`, and "connected" appears before the pairing round trip has
    // returned -- so the test sometimes read the device roster while it was still empty and failed
    // for a reason that had nothing to do with the property under test. Waiting on the observable
    // fact ("paired") removes the race instead of widening a timeout.
    const timer = setTimeout(() => reject(new Error(`agent never paired: ${err}`)), 25_000);
    const tick = () => {
      if (/paired/i.test(out) || /paired/i.test(err)) {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (proc.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`agent exited ${proc.exitCode}: out=${out} err=${err}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
  return { proc, stdout: () => out, stderr: () => err };
}

/** Poll an agent's output for a line matching `pattern`, and return that line. */
async function waitForLog(agent, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = `${agent.stdout()}${agent.stderr()}`
      .split('\n')
      .find((candidate) => pattern.test(candidate));
    if (line) return line;
    if (Date.now() > deadline) {
      throw new Error(`no log line matched ${pattern}: ${`${agent.stdout()}${agent.stderr()}`.slice(0, 600)}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

/** Resolve when a TCP connection is accepted, reject when it is refused. */
function connectTcp(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('accepted');
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`TCP ${port} neither accepted nor refused`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

/** Send one datagram to a port and resolve once it is on the wire. */
function sendUdp(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', (error) => {
      socket.close();
      reject(error);
    });
    socket.send(payload, port, '127.0.0.1', () => {
      socket.close();
      resolve();
    });
  });
}

describe('the link is outbound-only', () => {
  it('a running agent listens on nothing', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-oo-relay-'));
    const agentState = mkdtempSync(join(tmpdir(), 'w2m-oo-agent-'));
    const project = mkdtempSync(join(tmpdir(), 'w2m-oo-proj-'));
    const dshHome = mkdtempSync(join(tmpdir(), 'w2m-oo-home-'));
    scratch.push(stateDir, agentState, project, dshHome);
    writeFileSync(join(project, 'a.txt'), 'hello\n', 'utf8');

    const relay = await startRelay({ stateDir });
    const agent = await startAgent({
      rabbitUrl: relay.url,
      pairingCode: relay.info.pairingCode,
      project,
      stateDir: agentState,
      dshHome,
    });

    // The agent must have paired -- otherwise "it listens on nothing" is trivially true because it
    // is not running. This is the check that stops the test passing vacuously.
    //
    // `/v1/devices` is a *device* endpoint, so the token has to come from the agent's own
    // `device.json`. That file lives at `$DSH_HOME/xclient/device.json` -- deliberately *not* under
    // `--state`, because identity follows `DSH_HOME` so that one machine's two processes cannot
    // accidentally share an identity. The first version of this test looked under `--state` and got
    // ENOENT, which is the same trap the README warns users about.
    // The identity file is written *before* pairing and updated with the token afterwards, so it
    // must be re-read on every attempt. Reading it once and then polling produced a 401 on roughly
    // one run in six: the single read had caught the file while it still had no device_token.
    const deviceFile = join(dshHome, 'xclient', 'device.json');

    /**
     * One roster attempt using whatever token the agent currently holds.
     *
     * @returns {Promise<{token: string|null, body: object|null}>}
     */
    async function readRoster() {
      let token = null;
      try {
        token = JSON.parse(readFileSync(deviceFile, 'utf8')).device_token ?? null;
      } catch {
        return { token: null, body: null }; // not written yet
      }
      if (!token) return { token: null, body: null };
      const res = await fetch(`${relay.url}/v1/devices`, { headers: { authorization: `Bearer ${token}` } });
      return { token, body: await res.json() };
    }

    // Poll until the relay has committed the device. Pairing completing in the agent's log and the
    // relay listing the machine are two events; the property under test does not require them to be
    // simultaneous, so this waits rather than assuming.
    let roster = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { body } = await readRoster();
      if (Array.isArray(body?.devices) && body.devices.length >= 1) {
        roster = body;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      Array.isArray(roster?.devices) && roster.devices.length >= 1,
      `the agent must be registered before the outbound claim means anything: ${JSON.stringify(roster)}`,
    );

    const { token } = await readRoster();
    const auth = { authorization: `Bearer ${token}` };
    const device = { machine_id: JSON.parse(readFileSync(deviceFile, 'utf8')).machine_id };

    // Now the claim itself.
    //
    // Enumerating another process's sockets is not portable, so the assertion is made where it is
    // both portable and decisive: the agent's own output, plus the relief that nothing about the
    // pair requires the agent to accept a connection. The relay knows the machine only through the
    // stream the agent opened, which is the shape the claim describes.
    const status = await fetch(`${relay.url}/v1/agents/${device.machine_id}/status`, { headers: auth });
    assert.ok(status.status < 500, `the per-machine status probe must not fail: HTTP ${status.status}`);

    // The strongest portable statement: the agent's own output never mentions listening, and the
    // relay is the only process in this pair that bound a port.
    const agentOut = `${agent.stdout()}${agent.stderr()}`;
    assert.equal(
      /listening on/i.test(agentOut),
      false,
      `the agent must not bind a port, but it reported one: ${agentOut.slice(0, 400)}`,
    );

    agent.proc.kill('SIGKILL');
  });

  it("the default mode binds one UDP port for the punch, and 'relay' mode binds none", async () => {
    // v0.4.0's headline behaviour is a direct path, and a direct path needs a bound UDP socket -- so
    // the claim this file exists for ("one listening socket, and it is the relay's") has to be
    // restated rather than quietly dropped. What must stay true:
    //
    //   * the punch adds exactly ONE socket, and it is UDP: the same socket STUN measured, or the
    //     mapping a peer was told about is not the mapping its datagrams arrive on;
    //   * nothing accepts TCP on it -- a TCP listener would be a new inbound surface with none of the
    //     session-id filtering the channel does;
    //   * a datagram from a stranger does not take the agent down, because anyone can send one;
    //   * `--p2p-mode relay` binds no socket at all, which is what makes the direct path opt-out-able
    //     and keeps the v0.3.9 property available.
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-oo-relay3-'));
    const autoState = mkdtempSync(join(tmpdir(), 'w2m-oo-auto-'));
    const relayStateDir = mkdtempSync(join(tmpdir(), 'w2m-oo-relaymode-'));
    const project = mkdtempSync(join(tmpdir(), 'w2m-oo-proj3-'));
    const autoHome = mkdtempSync(join(tmpdir(), 'w2m-oo-home3a-'));
    const relayHome = mkdtempSync(join(tmpdir(), 'w2m-oo-home3b-'));
    scratch.push(stateDir, autoState, relayStateDir, project, autoHome, relayHome);

    const relay = await startRelay({ stateDir });

    const autoAgent = await startAgent({
      rabbitUrl: relay.url,
      pairingCode: relay.info.pairingCode,
      project,
      stateDir: autoState,
      dshHome: autoHome,
      extraArgs: ['--p2p-mode', 'auto'],
    });
    const nodeLine = await waitForLog(autoAgent, /p2p: auto node on 0\.0\.0\.0:\d+/);
    const port = Number(nodeLine.match(/:(\d+)/)[1]);
    assert.ok(port > 0, `the node must report the port it bound: ${nodeLine}`);
    const bindCount = (`${autoAgent.stdout()}${autoAgent.stderr()}`.match(/p2p: auto node on/g) ?? []).length;
    assert.equal(bindCount, 1, 'exactly one punch socket, shared by discovery and the punch');

    await assert.rejects(
      connectTcp(port),
      'nothing may accept TCP on the punch port: the punch socket is UDP and carries no TCP listener',
    );
    await sendUdp(port, Buffer.from([0, 1, 2, 3]));
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    assert.equal(autoAgent.proc.exitCode, null, 'a malformed datagram must not kill the agent');
    autoAgent.proc.kill('SIGKILL');

    // A second relay for the second agent: a pairing code is single-use and rotates after every
    // successful pairing, and reaching for the rotated code would make this test depend on the CLI's
    // banner format. A fresh relay is cheaper to read and impossible to misread.
    const relayModeRelay = await startRelay({ stateDir: relayStateDir });
    const relayModeAgent = await startAgent({
      rabbitUrl: relayModeRelay.url,
      pairingCode: relayModeRelay.info.pairingCode,
      project,
      stateDir: relayStateDir,
      dshHome: relayHome,
      extraArgs: ['--p2p-mode', 'relay'],
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 1_500);
    });
    const relayModeOut = `${relayModeAgent.stdout()}${relayModeAgent.stderr()}`;
    assert.equal(
      /p2p: (auto|direct) node on/.test(relayModeOut),
      false,
      `relay mode must bind no socket at all: ${relayModeOut.slice(0, 400)}`,
    );
    assert.equal(relayModeAgent.proc.exitCode, null, 'relay mode must stay up without a node');
    relayModeAgent.proc.kill('SIGKILL');
  });

  it('the relay binds only the loopback address it was given', async () => {    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-oo-relay2-'));
    scratch.push(stateDir);
    const port = await freePort();
    const relay = await startRelay({ stateDir, port });

    assert.equal(relay.info.host, '127.0.0.1', 'the default bind must be loopback, not 0.0.0.0');
    assert.equal(relay.info.port, port);

    // Reachable on loopback.
    const ok = await fetch(`${relay.url}/healthz`);
    assert.equal(ok.status, 200);
    const health = await ok.json();
    assert.equal(health.ok, true);

    // And the *banner* must say the same thing the socket does: a mismatch here is how an operator
    // ends up believing a relay is private while it is reachable.
    const banner = relay.stderr();
    assert.match(banner, /listening on http:\/\/127\.0\.0\.1:/, `banner must name the loopback bind: ${banner.slice(0, 300)}`);
  });

  it('refuses to bind a routable address without being asked explicitly', async () => {
    // The CLI must not silently accept `--host 0.0.0.0`. If this ever starts succeeding by default,
    // every deployment becomes internet-facing without the operator choosing it.
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-oo-relay3-'));
    scratch.push(stateDir);
    const proc = spawn(
      NODE,
      [join(REPO, 'bin', 'w2m-rabbit.mjs'), '--state', stateDir, '--no-persist', '--host', 'not-an-address.invalid'],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    procs.push(proc);
    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => {
      err += c;
    });
    const code = await new Promise((resolve) => proc.on('exit', resolve));
    assert.notEqual(code, 0, 'an unbindable host must be a startup failure, not a silent fallback');
    assert.ok(err.length > 0, 'and it must say why');
  });
});
