/**
 * v0.4.0 — the plugin as a **dispatcher**.
 *
 * Five claims are made here, and each one is a way the release could look finished while being
 * broken:
 *
 *   1. **A typo in the new settings is refused at load.** `p2pMode` and `stunServers` are validated
 *      at `apply()` with the setting named. A silent fall back to `auto` would dispatch work over a
 *      path the operator explicitly disabled; a silent fall back to `relay` would disable the
 *      release's headline feature on a machine whose operator asked for it.
 *
 *   2. **The shared server is a default, not an override.** It applies only when neither
 *      `rabbitUrl` nor `W2M_RABBIT_URL` is set, and `w2m_status` always says which of the three won.
 *      A machine quietly talking to a host nobody chose is the failure `rabbit_source` exists to make
 *      impossible to miss. Every assertion here is against `SHARED_SERVER` — never a literal address
 *      — so the test cannot pass while the constant and the behaviour disagree.
 *
 *   3. **A dispatch survives a failed punch.** The offer is pushed over the direct path best effort;
 *      the relay's SSE offer is the delivery. The test drives a *real* unreachable peer — a machine
 *      that paired but never announced — so the failure is the one production produces, not a stub's.
 *
 *   4. **A result that arrives over a channel is durable.** It is written under
 *      `<stateDir>/p2p-inbox/<task_id>__<machine_id>.json` and acknowledged on the same channel; a
 *      malformed frame writes nothing at all.
 *
 *   5. **A path is not a result.** `w2m_wait` surfaces `transport`/`p2p` per machine and the verdict
 *      stays `consistent` when two machines differ only in the path they took. This is asserted
 *      through the plugin against a real relay, because the property spans both halves: the relay
 *      must not compare the field, and neither must the plugin.
 *
 * Harness. A real `createRelayServer` on an ephemeral loopback port and the plugin's real `apply()`
 * and tool handlers, with `globalThis.fetch` *wrapped* rather than stubbed: every request the plugin
 * makes reaches the real relay, and the wrapper only records it. Nothing here fakes a response, so a
 * wrong endpoint, method or header fails the way it would in production.
 *
 * What is injected: `discover` (so no test waits on a STUN server) and `bindUdpSocket` (so "no UDP
 * port was taken" is a count of real binds rather than a promise). Both are the seam the plugin
 * exposes for exactly this, and neither changes what is measured — the socket is a real `dgram`
 * socket and the punches are real UDP.
 *
 * Not covered, and stated so nobody reads more into a green run: a loopback punch is **not** evidence
 * of NAT traversal. These tests prove the code path, the control flow and the bookkeeping.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { P2P_MODES, PUBLIC_STUN_SERVERS, SHARED_SERVER, stunServersWithShared } from '../src/agent/p2p-node.mjs';
import { bindUdpSocket } from '../src/agent/stun.mjs';
import * as plugin from '../src/plugin/tools.mjs';
import { createRelayServer } from '../src/relay/server.mjs';

const OP = 'p2p-plugin-operator-token';

const DEFAULT_PLATFORM = {
  os: 'windows',
  os_version: '10.0.26100',
  arch: 'x64',
  shell: 'pwsh',
  shell_version: '7.4.0',
};
const DEFAULT_CAPS = {
  case_sensitive_fs: false,
  symlinks: false,
  exec_bit: false,
  python: null,
  npm: null,
  node: 'v24.21.0',
  write: true,
};

const ARGV = ['node', '--test'];
const BASE_COMMIT = 'c0ffee1';
const BASE_TREE = 'tree-abc';
const SHELL_ID = 'direct-exec';

const scratch = [];
after(async () => {
  for (const dir of scratch) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------------------------
// Local mirrors of the relay's own derivations
// ---------------------------------------------------------------------------------------------
// Copied from `src/relay/state.mjs` on purpose: a suite must not be able to pass merely because it
// imported the same helper the code under test uses. Where the two have to agree — `computeDedupeKey`
// — the *relay's* stored value is what the test compares against, so a drift shows up as a failure.

/** @param {string} value */
function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Canonical JSON with sorted keys — the relay's `jcs`, mirrored for fixture equality. */
function jcs(value) {
  if (value === undefined || value === null) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : jcs(entry))).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** §4.4: dedupe_key = sha256(task_id + "|" + index + "|" + command_hash + "|" + base_tree). */
function computeDedupeKey(taskId, index, commandHash, baseTree) {
  return sha256Hex(`${taskId}|${index}|${commandHash}|${baseTree}`);
}

/** §4.4 helper: command_hash = sha256(JCS(argv)+"|"+shell_id+"|"+cwd_rel). */
function computeCommandHash(commandArgv, shellId = SHELL_ID, cwdRel = '.') {
  return sha256Hex(`${jcs(commandArgv)}|${shellId}|${cwdRel}`);
}

const CMD_HASH = computeCommandHash(ARGV, SHELL_ID, '.');

// ---------------------------------------------------------------------------------------------
// Relay harness (a local copy of the convention in test/p2p-transport-fields.test.mjs)
// ---------------------------------------------------------------------------------------------

/** One HTTP request with an optional bearer token. */
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
          resolve({ status: res.statusCode, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function startRelay() {
  const relay = createRelayServer({ logger: null, operatorToken: OP, persist: false });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  return relay;
}

async function withRelay(fn) {
  const relay = await startRelay();
  try {
    return await fn(relay);
  } finally {
    await relay.close().catch(() => {});
  }
}

/** Pair a machine and return its device token. */
async function pairDevice(relay, machineId) {
  const res = await request(`${relay.url}/v1/pair`, {
    method: 'POST',
    body: {
      pairing_code: relay.state.createPairingCode(),
      machine_id: machineId,
      machine_name: machineId,
      platform: DEFAULT_PLATFORM,
      caps: DEFAULT_CAPS,
    },
  });
  assert.equal(res.status, 200, `pair failed: ${res.text}`);
  return { token: res.json.device_token, machineId };
}

/** A task body with every field the relay requires. */
function taskBody(over = {}) {
  return {
    mode: 'replicate',
    command_argv: ARGV,
    cwd_rel: '.',
    index_total: 1,
    timeout_ms: 300_000,
    write: false,
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    requirements: {},
    compare_policy: {},
    halt: 'never',
    created_by: 'test',
    ...over,
  };
}

/** A result envelope for a real task, its comparable fields all matching the task. */
function envelopeForTask(taskId, machineId, over = {}) {
  return {
    envelope_version: '1.0',
    task_id: taskId,
    attempt: 1,
    dedupe_key: computeDedupeKey(taskId, over.index ?? 0, CMD_HASH, BASE_TREE),
    machine_id: machineId,
    machine_name: machineId,
    platform: DEFAULT_PLATFORM,
    caps: DEFAULT_CAPS,
    index: 0,
    index_total: 1,
    mode: 'replicate',
    cwd_rel: '.',
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    pre_tree_fingerprint: BASE_TREE,
    post_tree_fingerprint: BASE_TREE,
    fingerprint_algo: 'git-temp-index-tree/v1',
    fingerprint_error: null,
    head_commit: BASE_COMMIT,
    dirty_before: false,
    command_argv: ARGV,
    command_hash: CMD_HASH,
    shell_id: SHELL_ID,
    started_at: '2026-10-07T12:00:00Z',
    ended_at: '2026-10-07T12:00:01Z',
    duration_ms: 1000,
    exit_code: 0,
    status: 'ok',
    refusal_reason: null,
    stdout_sha256: sha256Hex('hello'),
    stdout_bytes: 5,
    stderr_sha256: sha256Hex(''),
    stderr_bytes: 0,
    warnings: [],
    // Required by the relay's own §5.1 check, and the value is not inspected there: the point of this
    // fixture is that the two envelopes below differ *only* in their transport.
    envelope_sha256: 'not-inspected-by-the-relay',
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------------------------

/**
 * A fake `ctx` carrying `tools` and a working `effect` that records its disposer.
 *
 * @returns {{ctx: object, tools: Map<string, object>, warnings: string[], disposers: Function[]}}
 */
function makeCtx() {
  const tools = new Map();
  const warnings = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(definition && typeof definition.name === 'string', 'register() needs a named definition');
        assert.ok(!tools.has(definition.name), `tool \`${definition.name}\` registered twice`);
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
  };
  return { ctx, tools, warnings, disposers };
}

/**
 * Record every request the plugin makes and let it reach the real relay.
 *
 * A wrapper, not a stub: a wrong path, method or header still fails against the relay exactly as it
 * would in production, and the recording exists so a test can assert on the wire body.
 *
 * @returns {{calls: Array<object>, restore: Function}}
 */
function recordFetch() {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const parsed = new URL(url);
    calls.push({
      method: String(init.method ?? 'GET').toUpperCase(),
      url,
      path: parsed.pathname,
      headers: init.headers ?? {},
      body: init.body === undefined || init.body === null ? null : JSON.parse(String(init.body)),
    });
    return previous(input, init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

/** A counting stand-in for `bindUdpSocket`: real sockets, plus proof that a bind happened. */
function countingBinder() {
  const bound = [];
  return {
    bound,
    bindUdpSocket: async () => {
      const result = await bindUdpSocket();
      bound.push({ port: result.local.port, socket: result.socket });
      return result;
    },
  };
}

/** Discovery that reports the socket's own loopback port, so nothing waits on a STUN server. */
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

/** Fast timings, so a test never waits on an interval it is not measuring. */
function testTuning(over = {}) {
  return { refreshMs: 60_000, punchTimeoutMs: 1200, acceptTimeoutMs: 100, announceTtlMs: 5000, ...over };
}

/**
 * Register the plugin and hand back everything an assertion might need.
 *
 * The teardown is mandatory rather than tidy: the node owns a UDP socket and a refresh timer, and a
 * test that left them behind would make the next test's "no port was taken" claim meaningless.
 *
 * @param {object} options
 * @param {object} options.config Config for `apply()`.
 * @returns {Promise<{tools: Map<string, object>, warnings: string[], calls: Array<object>,
 *                    binder: object, node: () => object|null, stop: Function}>}
 */
async function registerPlugin({ config }) {
  const { ctx, tools, warnings, disposers } = makeCtx();
  const recorder = recordFetch();
  const binder = countingBinder();
  let live = null;
  try {
    await plugin.apply(ctx, {
      ...config,
      p2pBlock: {
        bindUdpSocket: binder.bindUdpSocket,
        discover: loopbackDiscovery(),
        tuning: testTuning(),
        onNode: (node) => {
          live = node;
        },
      },
    });
  } catch (error) {
    recorder.restore();
    throw error;
  }
  return {
    tools,
    warnings,
    calls: recorder.calls,
    binder,
    /** The live node, once a tool has started it. Null until then, which is itself asserted. */
    node: () => live,
    stop: async () => {
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          /* already gone */
        }
      }
      recorder.restore();
    },
  };
}

/** Create a throwaway directory that is deliberately not a git work tree. */
async function makeScratchDir(prefix = 'w2m-p2p-plugin-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A state directory holding a `device.json` paired with `relay`, plus the identity in it.
 *
 * The identity is written from the relay's own pairing answer, so the plugin's token is one the relay
 * accepts — a fabricated token would make every announce a 401 and turn the tests below into an
 * assertion about the wrong failure.
 *
 * @returns {Promise<{dir: string, device: object, token: string}>}
 */
async function makeDeviceDir(relay, machineId = 'machine-origin') {
  const paired = await pairDevice(relay, machineId);
  const dir = await makeScratchDir();
  const device = {
    machine_id: machineId,
    machine_name: machineId,
    device_token: paired.token,
    rabbit_url: relay.url,
  };
  await fs.writeFile(path.join(dir, 'device.json'), JSON.stringify(device, null, 2), 'utf8');
  return { dir, device, token: paired.token };
}

/** The resolved `w2m_status` object, parsed the way a model reads it. */
async function statusOf(tools) {
  return JSON.parse(await tools.get('w2m_status').execute({}, {}));
}

/**
 * Assert the shape of a published `p2p` block: the mode verbatim, plus the punch facts (v0.4.x).
 *
 * WHY THIS IS NOT A `deepEqual` ANY MORE
 *
 * The block is the dispatcher's half of the two-way punch, and the executor can only dial back if it
 * travels on the wire: `punch` is the id both ends derive the session from, and `candidates` is where
 * to dial when the dispatcher's own push is swallowed by a symmetric NAT. Those keys are additive —
 * the relay treats `p2p` as an opaque object with a `mode`, and a v0.4.x peer ignores keys it does not
 * read — so the assertion is on what the block *says* rather than on the exact set of keys it has.
 *
 * @param {object} block
 * @param {string} mode
 * @returns {object} The block, for chaining.
 */
function assertP2PBlock(block, mode) {
  assert.equal(block.mode, mode, 'the mode is stated verbatim');
  assert.match(block.punch, /^[0-9a-f]{16}$/, 'a punch id travels with the mode');
  return block;
}

/** One authenticated call against the relay, in the shape `P2PNode` expects. */
async function relayFetch(relay, token, method, pathname, body) {
  const result = await request(`${relay.url}${pathname}`, { method, token, body });
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: result.json,
    error: null,
  };
}

/** Poll `pred` until it holds, or fail with `why`. */
async function waitFor(pred, why, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${why}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until the relay holds a live announcement for `machineId`.
 *
 * The relay is asked directly rather than the plugin's status being polled, because the fact that
 * matters is the one the *dial* will read: `P2PNode.start()` deliberately kicks the first announce
 * off without awaiting it, so "the node is running" and "a peer can find us" are two different
 * moments. Asking the relay removes the race instead of widening a timeout.
 */
async function waitForAnnouncement(relay, machineId, token) {
  await waitFor(async () => {
    const res = await request(`${relay.url}/v1/peer/${encodeURIComponent(machineId)}`, { token });
    return res.status === 200;
  }, `${machineId} announced itself through the relay`);
}

/** Does `file` exist? */
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Configuration is loud and total
// ---------------------------------------------------------------------------------------------

describe('v0.4.0 config: p2pMode', () => {
  it('refuses a bad mode at apply() time, naming the setting and the code', async () => {
    // `''`, `null`, `'AUTO'` and `'p2p'` are the four ways this actually gets typed wrong: an empty
    // env var, a YAML `null`, a capitalised word, and the release's own nickname for the feature.
    // `undefined` is deliberately absent from the list: "the key is not there" is the default case,
    // which the next test covers, while `null` is somebody having written a value and having written
    // it wrong.
    for (const value of ['', null, 'AUTO', 'p2p', 'Auto', ' auto ', 'directt', 42, true]) {
      await assert.rejects(
        () => plugin.apply(makeCtx().ctx, { rabbitUrl: 'http://127.0.0.1:1', p2pMode: value }),
        (error) => {
          assert.equal(error.code, 'W2M_CONFIG', `${JSON.stringify(value)} must be a W2M_CONFIG error`);
          assert.match(error.message, /p2pMode/, `${JSON.stringify(value)} must name the setting`);
          assert.ok(error.hint, 'a configuration error must tell the operator what to set');
          return true;
        },
        `p2pMode ${JSON.stringify(value)} must be refused, never silently defaulted`,
      );
    }
  });

  it('accepts exactly the three contract modes and nothing else', async () => {
    assert.deepEqual([...P2P_MODES], ['auto', 'direct', 'relay']);
    const dir = await makeScratchDir();
    for (const mode of P2P_MODES) {
      const { ctx } = makeCtx();
      await plugin.apply(ctx, { rabbitUrl: 'http://127.0.0.1:1', stateDir: dir, p2pMode: mode });
    }
  });

  it('names W2M_P2P_MODE rather than p2pMode when the environment is what is wrong', async () => {
    const previous = process.env.W2M_P2P_MODE;
    process.env.W2M_P2P_MODE = 'AUTO';
    try {
      await assert.rejects(
        () => plugin.apply(makeCtx().ctx, { rabbitUrl: 'http://127.0.0.1:1' }),
        (error) => {
          assert.equal(error.code, 'W2M_CONFIG');
          assert.match(error.message, /W2M_P2P_MODE/, 'the operator must be sent to the environment');
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.W2M_P2P_MODE;
      else process.env.W2M_P2P_MODE = previous;
    }
  });

  it('defaults to auto when nobody says anything, and binds nothing until a tool runs', async () => {
    const previous = process.env.W2M_P2P_MODE;
    delete process.env.W2M_P2P_MODE;
    const dir = await makeScratchDir();
    const { ctx, disposers } = makeCtx();
    const binder = countingBinder();
    try {
      await plugin.apply(ctx, {
        rabbitUrl: 'http://127.0.0.1:1',
        stateDir: dir,
        p2pBlock: { bindUdpSocket: binder.bindUdpSocket, discover: loopbackDiscovery(), tuning: testTuning() },
      });
      // The node is composed but not started: `apply()` must not bind a socket or run a STUN sweep on
      // behalf of a session that may never dispatch. See the lazy-start note in `createP2PRuntime`.
      assert.equal(binder.bound.length, 0, 'a machine that never dispatches never binds a socket');
      assert.equal(disposers.length, 0, 'no effect owns a node that does not exist yet');
    } finally {
      if (previous !== undefined) process.env.W2M_P2P_MODE = previous;
    }
  });
});

describe('v0.4.0 config: stunServers', () => {
  it('refuses a bad entry at apply() time, naming the setting', async () => {
    for (const value of [
      ['not-a-server'],
      ['stun.example.com:0'],
      ['stun.example.com:70000'],
      [':3478'],
      ['   '],
      [''],
      [1234],
      ['a:1', 'bad'],
    ]) {
      await assert.rejects(
        () => plugin.apply(makeCtx().ctx, { rabbitUrl: 'http://127.0.0.1:1', stunServers: value }),
        (error) => {
          assert.equal(error.code, 'W2M_CONFIG', `${JSON.stringify(value)} must be a W2M_CONFIG error`);
          assert.match(error.message, /stunServers/, `${JSON.stringify(value)} must name the setting`);
          return true;
        },
        `stunServers ${JSON.stringify(value)} must be refused`,
      );
    }
  });

  it('refuses a wrong type rather than falling back silently', async () => {
    for (const value of [42, {}, 'ok:3478,oops', ['stun.example.com:3478', 5]]) {
      await assert.rejects(
        () => plugin.apply(makeCtx().ctx, { rabbitUrl: 'http://127.0.0.1:1', stunServers: value }),
        (error) => error.code === 'W2M_CONFIG' && /stunServers/.test(error.message),
        `${JSON.stringify(value)} must be refused`,
      );
    }
  });

  it('treats an empty list as the default, because the bundled config carries exactly that', async () => {
    // `cordis.patch.yml` ships `stunServers: []` as documentation of the key. A profile that starts
    // from the bundle must load, so "nothing named" is the default rather than an error — while a
    // list of *wrong* entries (above) is still refused.
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay);
      for (const value of [[], [null], [undefined]]) {
        const session = await registerPlugin({
          config: { rabbitUrl: relay.url, stateDir: dir, operatorToken: OP, stunServers: value },
        });
        try {
          const status = await statusOf(session.tools);
          assert.deepEqual(status.config.stunServers, stunServersWithShared(), `${JSON.stringify(value)} means default`);
        } finally {
          await session.stop();
        }
      }
    });
  });

  it('names W2M_STUN_SERVERS when the environment is what is wrong', async () => {
    const previous = process.env.W2M_STUN_SERVERS;
    process.env.W2M_STUN_SERVERS = 'not-a-server';
    try {
      await assert.rejects(
        () => plugin.apply(makeCtx().ctx, { rabbitUrl: 'http://127.0.0.1:1' }),
        (error) => {
          assert.equal(error.code, 'W2M_CONFIG');
          assert.match(error.message, /W2M_STUN_SERVERS/);
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.W2M_STUN_SERVERS;
      else process.env.W2M_STUN_SERVERS = previous;
    }
  });

  it('reports the resolved list with the shared server first and the public fallbacks after it', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay);
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, operatorToken: OP, p2pMode: 'auto' },
      });
      try {
        const status = await statusOf(session.tools);
        assert.equal(status.config.stunServers[0], SHARED_SERVER.stun, 'the shared server leads the list');
        assert.deepEqual(status.config.stunServers, stunServersWithShared());
        for (const fallback of PUBLIC_STUN_SERVERS) {
          assert.ok(status.config.stunServers.includes(fallback), `${fallback} must remain as a fallback`);
        }
      } finally {
        await session.stop();
      }
    });
  });

  it('accepts the comma-separated shape W2M_STUN_SERVERS arrives in', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay);
      const session = await registerPlugin({
        config: {
          rabbitUrl: relay.url,
          stateDir: dir,
          operatorToken: OP,
          stunServers: `${SHARED_SERVER.stun}, stun.example.com:3479`,
        },
      });
      try {
        const status = await statusOf(session.tools);
        assert.deepEqual(status.config.stunServers, [SHARED_SERVER.stun, 'stun.example.com:3479']);
      } finally {
        await session.stop();
      }
    });
  });

  it('applies the config the bundle actually ships', async () => {
    // The bundled `cordis.patch.yml` is the config every user starts from, and nothing else parses it
    // — so a wrong value there is a plugin that refuses to load for everyone. `stunServers: []` is the
    // case that matters: it is documentation of the key, and it must resolve to the default rather
    // than being read as "an empty list of servers".
    const bundled = readBundledConfig();
    assert.equal(bundled.p2pMode, 'auto', 'the bundled default is the direct path with a fallback');
    assert.deepEqual(bundled.stunServers, [], 'the bundle names no server; the default supplies them');
    assert.equal(bundled.rabbitUrl, '', 'the bundle names no relay, so the shared default applies');

    await withoutP2pEnvironment(async () => {
      const { ctx, tools } = makeCtx();
      await plugin.apply(ctx, bundled);
      assert.equal(tools.size, 8);
    });
  });

  it('resolves the bundled empty list to the shared server plus the public fallbacks', async () => {
    await withoutP2pEnvironment(async () => {
      await withRelay(async (relay) => {
        const { dir } = await makeDeviceDir(relay);
        const bundled = readBundledConfig();
        const session = await registerPlugin({
          config: { ...bundled, rabbitUrl: relay.url, stateDir: dir, operatorToken: OP },
        });
        try {
          const status = await statusOf(session.tools);
          assert.deepEqual(status.config.stunServers, stunServersWithShared());
          assert.equal(status.config.stunServers[0], SHARED_SERVER.stun);
        } finally {
          await session.stop();
        }
      });
    });
  });
});

/** The environment keys that would otherwise decide these tests for us. */
const P2P_ENV_KEYS = ['W2M_RABBIT_URL', 'W2M_P2P_MODE', 'W2M_STUN_SERVERS'];

/**
 * Run `fn` with the Rabbit/P2P environment cleared, and put it back whatever it was.
 *
 * Not tidiness: the variables this reads are the ones these tests are about, and a developer machine
 * with `W2M_P2P_MODE=relay` exported would otherwise turn a green suite red for a reason that is not
 * in the code. Restoring the previous values — including "unset" — keeps the suite from leaking into
 * whichever test runs next.
 *
 * @param {() => Promise<unknown>} fn
 */
async function withoutP2pEnvironment(fn) {
  const saved = new Map(P2P_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of P2P_ENV_KEYS) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Read the config block the bundled `cordis.patch.yml` ships.
 *
 * Parsed by hand: this repository has no YAML dependency (a hard rule), and the block is a flat list
 * of scalars. A real DSH host parses the file with its own loader; what this reproduces is the
 * *values*, which is what the plugin has to survive.
 *
 * @returns {Record<string, unknown>}
 */
function readBundledConfig() {
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const start = text.indexOf('- insert:');
  assert.notEqual(start, -1, 'cordis.patch.yml must still declare an insert');
  const config = {};
  for (const line of text.slice(start).split('\n')) {
    const match = /^\s{8}([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.trim();
    if (value === '' || value === "''") config[key] = '';
    else if (value === '[]') config[key] = [];
    else if (value === 'false') config[key] = false;
    else if (value === 'true') config[key] = true;
    else config[key] = value;
  }
  return config;
}

// ---------------------------------------------------------------------------------------------
// 2. The shared server is a default, not an override
// ---------------------------------------------------------------------------------------------

describe('v0.4.0 shared server default', () => {
  it('uses SHARED_SERVER.rabbitUrl and says so when nothing else is set', async () => {
    // `w2m_status` probes whatever `rabbitUrl` resolved to, and this case is the one where that is
    // the shared host — an address no test suite should dial. So the *address* is what is asserted
    // here, from the status block, and the probe itself is covered by the next test, which points the
    // same resolution at a loopback server. Nothing in this test opens a socket to the internet.
    await withoutP2pEnvironment(async () => {
      const dir = await makeScratchDir();
      const session = await registerPlugin({ config: { stateDir: dir, projectDir: dir } });
      try {
        const status = await statusOf(session.tools);

        assert.equal(status.rabbit_source, 'shared-default');
        assert.equal(status.rabbit_url, SHARED_SERVER.rabbitUrl, 'the constant is the only source of truth');
        assert.equal(status.config.rabbitUrl, SHARED_SERVER.rabbitUrl);
        assert.equal(status.relay.configured_url, SHARED_SERVER.rabbitUrl);
        assert.equal(status.relay.probed_url, SHARED_SERVER.rabbitUrl, 'the probe follows the same address');
        // The one-line note §7 asks for, naming the address and the way out.
        const note = status.notes.find((line) => line.includes(SHARED_SERVER.rabbitUrl));
        assert.ok(note, `a note must name the shared default; got:\n${status.notes.join('\n')}`);
        assert.match(note, /rabbitUrl/, 'the note must name the setting to change');
        assert.match(note, /W2M_RABBIT_URL/, 'and the environment override');
      } finally {
        await session.stop();
      }
    });
  });

  it('probes the shared default and reports the refusal when nothing answers there', async () => {
    // The probe side of the shared default, made hermetic: `W2M_RABBIT_URL` replaces the address but
    // not the *source*, so this is still the `env` path — and the case that matters for the default is
    // what the tool says when the address does not answer, which a loopback port that nothing listens
    // on reproduces exactly.
    await withoutP2pEnvironment(async () => {
      await withRelay(async (relay) => {
        const address = relay.url;
        await relay.close();
        process.env.W2M_RABBIT_URL = address;

        const dir = await makeScratchDir();
        const session = await registerPlugin({ config: { stateDir: dir, projectDir: dir } });
        try {
          const status = await statusOf(session.tools);
          assert.equal(status.rabbit_source, 'env');
          assert.equal(status.relay.probed_url, address, 'the probe went where rabbitUrl pointed');
          assert.equal(status.relay.reachable, false, 'nothing is listening there any more');
          assert.ok(status.relay.error, 'and the refusal is reported rather than left null');
          // A relay that cannot be reached must not take `w2m_status` down: the tool still answers.
          assert.equal(status.ok, true);
        } finally {
          await session.stop();
        }
      });
    });
  });

  it('lets an explicit rabbitUrl win, and reports rabbit_source as config', async () => {
    await withoutP2pEnvironment(async () => {
      await withRelay(async (relay) => {
        const dir = await makeScratchDir();
        const session = await registerPlugin({
          config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir },
        });
        try {
          const status = await statusOf(session.tools);
          assert.equal(status.rabbit_source, 'config');
          assert.equal(status.rabbit_url, relay.url);
          assert.equal(status.relay.probed_url, relay.url);
        } finally {
          await session.stop();
        }
      });
    });
  });

  it('lets W2M_RABBIT_URL win over the shared default, and reports rabbit_source as env', async () => {
    await withoutP2pEnvironment(async () => {
      await withRelay(async (relay) => {
        process.env.W2M_RABBIT_URL = relay.url;
        const dir = await makeScratchDir();
        const session = await registerPlugin({ config: { stateDir: dir, projectDir: dir } });
        try {
          const status = await statusOf(session.tools);
          assert.equal(status.rabbit_source, 'env');
          assert.equal(status.rabbit_url, relay.url);
          assert.equal(status.relay.probed_url, relay.url);
          assert.equal(
            status.notes.some((line) => /shared W2M server/.test(line)),
            false,
            'the shared-default note must not appear once something else was chosen',
          );
        } finally {
          await session.stop();
        }
      });
    });
  });

  it('lets an explicit rabbitUrl win over W2M_RABBIT_URL', async () => {
    await withoutP2pEnvironment(async () => {
      process.env.W2M_RABBIT_URL = SHARED_SERVER.rabbitUrl;
      const dir = await makeScratchDir();
      const session = await registerPlugin({
        config: { rabbitUrl: 'http://127.0.0.1:1', stateDir: dir, projectDir: dir },
      });
      try {
        const status = await statusOf(session.tools);
        assert.equal(status.rabbit_source, 'config');
        assert.equal(status.rabbit_url, 'http://127.0.0.1:1');
      } finally {
        await session.stop();
      }
    });
  });

  it('refuses a malformed W2M_RABBIT_URL by name instead of falling back to the shared default', async () => {
    await withoutP2pEnvironment(async () => {
      process.env.W2M_RABBIT_URL = 'not-a-url';
      await assert.rejects(
        () => plugin.apply(makeCtx().ctx, {}),
        (error) => {
          assert.equal(error.code, 'W2M_CONFIG');
          assert.match(error.message, /W2M_RABBIT_URL/);
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Dispatch: routing facts on the wire, and a best-effort push
// ---------------------------------------------------------------------------------------------

/**
 * The relay's own offer for a task, waiting out the P2P offer grace.
 *
 * v0.4.0 holds the relay's copy of an offer for `p2pOfferGraceMs` (1200 ms) when the dispatcher said
 * it would push it directly — `state.mjs` explains why the direct path could never win otherwise. A
 * test that reads the relay's event ring immediately after `POST /v1/task` therefore sees nothing,
 * and "nothing" is not the same as "no offer": it is an offer that has not been published *yet*.
 */
async function offerFor(relay, taskId, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const offer = relay.state.buffer
      .map((entry) => entry.event)
      .find((event) => event.type === 'task.offer' && event.task_id === taskId);
    if (offer) return offer;
    if (Date.now() > deadline) throw new Error(`the relay never emitted an offer for ${taskId}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

describe('v0.4.0 w2m_run routes the offer', () => {
  it('sends origin_machine_id and p2p.mode, and the relay stores both verbatim', async () => {
    await withRelay(async (relay) => {
      const { dir, device } = await makeDeviceDir(relay, 'machine-origin');
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP, machineName: 'origin' },
      });
      try {
        const value = JSON.parse(await session.tools.get('w2m_run').execute({ command_argv: ARGV }, {}));
        assert.equal(value.ok, true);

        const call = session.calls.find((entry) => entry.path === '/v1/task');
        assert.ok(call, 'w2m_run must POST /v1/task');
        assert.equal(call.headers.authorization, `Bearer ${OP}`, 'a dispatch carries the operator token');
        assert.equal(call.body.origin_machine_id, device.machine_id, 'the origin is this machine');
        assertP2PBlock(call.body.p2p, 'auto');
        // The dispatcher's announced candidates travel with the mode once it has announced: they are
        // the address the executor dials back at, published by the machine that knows it best. A node
        // whose first announce is still in flight publishes none, and that is a legal block — the
        // executor falls back to asking the relay.
        if (call.body.p2p.candidates !== undefined) {
          assert.ok(
            call.body.p2p.candidates.every(
              (candidate) => typeof candidate.address === 'string' && Number.isInteger(candidate.port),
            ),
            'every published candidate is an {address, port} pair',
          );
        }

        // What the relay actually recorded — the assertion that matters, because the offer the
        // executor sees is built from the stored task, not from this request body.
        const task = relay.state.getTask(value.task_id);
        assert.equal(task.origin_machine_id, device.machine_id);
        assert.deepEqual(task.p2p, call.body.p2p, 'the relay stores the block verbatim');

        const offer = await offerFor(relay, value.task_id);
        assert.equal(offer.origin_machine_id, device.machine_id);
        assert.deepEqual(offer.p2p, call.body.p2p, 'and republishes it verbatim on the offer');
      } finally {
        await session.stop();
      }
    });
  });

  it('omits origin_machine_id entirely when this machine has no identity', async () => {
    await withRelay(async (relay) => {
      // A stateDir with no device.json: a legal configuration, and the one where the plugin must not
      // invent an id. The relay refuses an empty string, so "absent" is the only honest encoding.
      // A second machine is paired so the dispatch has a target and this test measures the *origin*
      // field rather than the relay's no-device refusal.
      await pairDevice(relay, 'machine-target');
      const emptyDir = await makeScratchDir();
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: emptyDir, projectDir: emptyDir, operatorToken: OP },
      });
      try {
        const value = JSON.parse(await session.tools.get('w2m_run').execute({ command_argv: ARGV }, {}));
        const call = session.calls.find((entry) => entry.path === '/v1/task');
        assert.equal('origin_machine_id' in call.body, false, 'no identity means no field');
        assertP2PBlock(call.body.p2p, 'auto');
        assert.equal(call.body.p2p.candidates, undefined, 'nothing was announced, so nothing is published');
        assert.equal(relay.state.getTask(value.task_id).origin_machine_id, null);
      } finally {
        await session.stop();
      }
    });
  });

  it('states mode relay when the operator turned the direct path off', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay);
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP, p2pMode: 'relay' },
      });
      try {
        const value = JSON.parse(await session.tools.get('w2m_run').execute({ command_argv: ARGV }, {}));
        const call = session.calls.find((entry) => entry.path === '/v1/task');
        assert.deepEqual(call.body.p2p, { mode: 'relay' });
        assert.equal(relay.state.getTask(value.task_id).p2p.mode, 'relay');
        assert.equal(value.direct_pushes.mode, 'relay');
        assert.equal(value.direct_pushes.attempted, 0, 'relay mode never dials');
      } finally {
        await session.stop();
      }
    });
  });

  it('a failed direct push is not an error: the task exists and the tool succeeds', async () => {
    await withRelay(async (relay) => {
      const { dir, device, token } = await makeDeviceDir(relay, 'machine-origin');
      // Both machines hold a lease, which is the ordinary shape of a fleet-wide dispatch: this
      // machine is a target too. The peer paired and never announced, so the relay holds no
      // candidates for it and that punch cannot be attempted — the production failure this path has
      // to survive, produced here by the real relay rather than by a stub.
      await pairDevice(relay, 'machine-unreachable');

      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP },
      });
      try {
        const value = JSON.parse(await session.tools.get('w2m_run').execute({ command_argv: ARGV }, {}));

        assert.equal(value.ok, true, 'a failed punch must not fail the dispatch');
        assert.equal(typeof value.task_id, 'string');
        assert.notEqual(relay.state.getTask(value.task_id), null, 'the relay created the task');

        assert.equal(value.direct_pushes.mode, 'auto');
        assert.equal(value.direct_pushes.attempted, 2, 'one attempt per leased machine');
        const peer = value.direct_pushes.pushes.find((entry) => entry.machine_id === 'machine-unreachable');
        assert.ok(peer, 'the silent machine is named in the pushes');
        assert.equal(peer.ok, false);
        assert.match(peer.error, /P2P_NO_CANDIDATES/, 'the reason is named, not swallowed');
        assert.equal(value.direct_pushes.failed >= 1, true, 'the failure is counted');

        // The lookup the node performed went through the same authenticated path as every other call.
        const lookup = session.calls.find((entry) => entry.path === '/v1/peer/machine-unreachable');
        assert.ok(lookup, 'the node asked the relay for the peer');
        assert.equal(lookup.headers.authorization, `Bearer ${token}`, 'the device token, from device.json');
        assert.equal(token, device.device_token);

        // And the offer the relay emitted is untouched by the failed push, which is the fallback.
        const offer = await offerFor(relay, value.task_id);
        assert.equal(offer.task_id, value.task_id);
      } finally {
        await session.stop();
      }
    });
  });

  it('pushes the relay\'s own dedupe identity, so a double delivery is executed once', async () => {
    await withRelay(async (relay) => {
      const origin = await makeDeviceDir(relay, 'machine-origin');
      const target = await pairDevice(relay, 'machine-target');
      // The target has to be *announced* for a punch to be attempted, and only a node announces, so
      // the target gets a node of its own. The plugin's node can only be one machine's identity, and
      // that machine is the origin — the dispatcher.
      const session = await registerPlugin({
        config: {
          rabbitUrl: relay.url,
          stateDir: origin.dir,
          projectDir: origin.dir,
          operatorToken: OP,
          stunServers: [SHARED_SERVER.stun],
        },
      });
      const { P2PNode } = await import('../src/agent/p2p-node.mjs');
      const targetBinder = countingBinder();
      const targetNode = new P2PNode({
        mode: 'auto',
        rabbitUrl: relay.url,
        machineId: 'machine-target',
        postJson: (pathname, body) => relayFetch(relay, target.token, 'POST', pathname, body),
        getJson: (pathname) => relayFetch(relay, target.token, 'GET', pathname),
        stunServers: [SHARED_SERVER.stun],
        discover: loopbackDiscovery(),
        bindUdpSocket: targetBinder.bindUdpSocket,
        tuning: testTuning(),
      });
      try {
        // Both machines must be announced before the dispatch, and the plugin's node only announces
        // once a tool has started it. Dispatching any earlier would make this a test of an announce
        // race rather than of the push.
        await targetNode.start();
        await waitForAnnouncement(relay, 'machine-target', target.token);
        await statusOf(session.tools);
        await waitForAnnouncement(relay, 'machine-origin', origin.token);

        const received = [];
        targetNode.on('message', (event) => received.push(JSON.parse(String(event.payload))));

        const value = JSON.parse(await session.tools.get('w2m_run').execute({ command_argv: ARGV }, {}));
        await waitFor(() => received.length > 0, 'the offer arrives over the direct path');

        const frame = received[0];
        assert.equal(frame.type, 'task.offer');
        assert.equal(frame.task_id, value.task_id);
        assert.equal(frame.machine_id, 'machine-target');
        assert.deepEqual(frame.command_argv, ARGV);
        assert.equal(frame.origin_machine_id, 'machine-origin');
        // The pushed frame carries the same block the relay published, plus the session for *this*
        // machine: the value the dispatcher's punch and the executor's reverse dial have to meet on,
        // which is only knowable per machine and therefore only in the pushed copy.
        assertP2PBlock(frame.p2p, 'auto');
        assert.deepEqual(
          frame.p2p.candidates,
          relay.state.getTask(value.task_id).p2p.candidates,
          'the push publishes the same candidates the relay holds',
        );
        assert.equal(
          Number.isInteger(frame.p2p.session),
          true,
          `the push names the session: ${JSON.stringify(frame.p2p)}`,
        );

        // The invariant the whole fast path rests on: the pushed identity is the relay's own, so the
        // executor's dedupe sees one delivery whether the frame arrives over the channel or the SSE.
        const lease = relay.state.getTask(value.task_id).leases.get('machine-target');
        assert.equal(frame.dedupe_key, lease.dedupe_key, 'the pushed key is the relay\'s key');
        assert.equal(frame.attempt, lease.attempt);
        assert.equal(frame.index, lease.index);
        const relayOffer = await offerFor(relay, value.task_id);
        assert.equal(frame.dedupe_key, relayOffer.dedupe_key, 'the SSE offer and the push agree');
        assert.equal(frame.attempt, relayOffer.attempt);

        // Both machines announced, so both pushes land — this machine is a leased target of its own
        // task, exactly as a two-machine fleet dispatches. What matters is the frame the *target* got.
        assert.equal(value.direct_pushes.delivered, 2, 'every announced machine was reached');
        const toTarget = value.direct_pushes.pushes.find((entry) => entry.machine_id === 'machine-target');
        assert.equal(toTarget.ok, true, `the push to the target must land: ${toTarget.error}`);
        assert.equal(toTarget.dedupe_key, 'relay-formula', 'the key was derived, not skipped');
      } finally {
        await targetNode.close().catch(() => {});
        await session.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The result inbox
// ---------------------------------------------------------------------------------------------

describe('v0.4.0 result inbox', () => {
  /** A channel stand-in that records what the plugin sends back. */
  function fakeChannel() {
    const sent = [];
    return {
      sent,
      send: async (payload) => {
        sent.push(JSON.parse(String(payload)));
      },
      on: () => {},
      close: () => {},
    };
  }

  it('stores a task.result frame, acknowledges it, and reports the inbox depth', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay, 'machine-origin');
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP },
      });
      try {
        // The direct path is started by the first tool that needs it; `w2m_status` is one of them.
        await statusOf(session.tools);
        const node = session.node();
        assert.ok(node, 'a node must exist once a tool has started the direct path');

        const taskId = '01JINBOX';
        const frame = {
          type: 'task.result',
          task_id: taskId,
          machine_id: 'machine-peer',
          envelope: envelopeForTask(taskId, 'machine-peer', { transport: 'p2p' }),
        };
        const channel = fakeChannel();

        // The node's own `'message'` event: exactly what the accept loop and `dial()` both emit, so
        // the handler this drives is the production one rather than a re-implementation of it.
        node.emit('message', {
          from: 'machine-peer',
          channel,
          peer: { address: '127.0.0.1', port: 1 },
          session: 1,
          payload: Buffer.from(JSON.stringify(frame)),
        });

        const file = path.join(dir, 'p2p-inbox', `${taskId}__machine-peer.json`);
        await waitFor(() => exists(file), 'the result frame is written to the inbox');

        const stored = JSON.parse(await fs.readFile(file, 'utf8'));
        assert.equal(stored.transport, 'p2p');
        assert.equal(stored.task_id, taskId);
        assert.equal(stored.from_machine_id, 'machine-peer');
        assert.deepEqual(stored.frame, frame);
        assert.match(stored.frame_sha256, /^[0-9a-f]{64}$/, 'the stored copy is fingerprinted');

        await waitFor(() => channel.sent.length > 0, 'the acknowledgement is sent back');
        assert.deepEqual(channel.sent[0], { type: 'result.ack', task_id: taskId });

        const status = await statusOf(session.tools);
        assert.equal(status.p2p.inbox.depth, 1, 'w2m_status reports the inbox depth');
        assert.equal(status.p2p.inbox.received, 1);
        assert.equal(status.p2p.inbox.frames, 1);
        assert.equal(status.p2p.transport.socket_bound, true);
        assert.equal(status.p2p.running, true);

        // A second machine's result for the same task is a second file, not an overwrite.
        const second = fakeChannel();
        node.emit('message', {
          from: 'machine-other',
          channel: second,
          peer: { address: '127.0.0.1', port: 2 },
          session: 2,
          payload: Buffer.from(
            JSON.stringify({ type: 'task.result', task_id: taskId, machine_id: 'machine-other' }),
          ),
        });
        await waitFor(
          () => exists(path.join(dir, 'p2p-inbox', `${taskId}__machine-other.json`)),
          'the second machine writes its own file',
        );
        assert.equal((await statusOf(session.tools)).p2p.inbox.depth, 2);
      } finally {
        await session.stop();
      }
    });
  });

  it('refuses a malformed frame without writing anything', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay, 'machine-origin');
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP },
      });
      try {
        await statusOf(session.tools);
        const node = session.node();
        const inbox = path.join(dir, 'p2p-inbox');

        const payloads = [
          'not json at all',
          '{ broken',
          '[1,2,3]',
          '"a string"',
          'null',
          JSON.stringify({ type: 'task.result', machine_id: 'machine-peer' }),
          JSON.stringify({ type: 'task.result', task_id: '01JBAD' }),
          JSON.stringify({ type: 'task.result', task_id: '', machine_id: 'machine-peer' }),
          JSON.stringify({ type: 'task.result', task_id: '   ', machine_id: 'machine-peer' }),
        ];
        for (const payload of payloads) {
          node.emit('message', {
            from: null,
            channel: fakeChannel(),
            peer: { address: '127.0.0.1', port: 3 },
            session: 1,
            payload: Buffer.from(payload),
          });
        }
        // Give the handler room to fail: every one of these is refused asynchronously, so the absence
        // of a file only means something after the microtask queue has drained.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(await exists(inbox), false, 'a refused frame must leave no trace on disk');

        const status = await statusOf(session.tools);
        assert.equal(status.p2p.inbox.depth, 0);
        assert.equal(status.p2p.inbox.received, 0);
        // The status block keeps the last eight refusals: enough to diagnose, bounded so a peer cannot
        // grow the reply without limit.
        assert.equal(status.p2p.inbox.refused.length, 8, 'the refusals are recorded, up to the cap');
        for (const refusal of status.p2p.inbox.refused) {
          assert.match(refusal.reason, /^P2P_FRAME_/, 'the reason is a named code');
        }
      } finally {
        await session.stop();
      }
    });
  });

  it('ignores a frame that is not a task.result instead of calling it a fault', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay, 'machine-origin');
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP },
      });
      try {
        await statusOf(session.tools);
        const node = session.node();
        node.emit('message', {
          from: 'machine-peer',
          channel: fakeChannel(),
          peer: { address: '127.0.0.1', port: 4 },
          session: 1,
          payload: Buffer.from(JSON.stringify({ type: 'result.ack', task_id: '01JACK' })),
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        const status = await statusOf(session.tools);
        assert.equal(status.p2p.inbox.received, 0);
        assert.deepEqual(status.p2p.inbox.refused, [], 'an acknowledgement is not a refused frame');
        assert.equal(await exists(path.join(dir, 'p2p-inbox')), false);
      } finally {
        await session.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 5. w2m_wait: the path is data, not a verdict
// ---------------------------------------------------------------------------------------------

describe('v0.4.0 w2m_wait surfaces the path', () => {
  it("surfaces transport:'p2p' for a machine whose envelope carries it", async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const b = await pairDevice(relay, 'machine-b');
      const created = await request(`${relay.url}/v1/task`, {
        method: 'POST',
        token: OP,
        body: taskBody(),
      });
      assert.equal(created.status, 200, created.text);
      const taskId = created.json.task_id;

      await request(`${relay.url}/v1/result`, {
        method: 'POST',
        token: a.token,
        body: envelopeForTask(taskId, 'machine-a', {
          transport: 'p2p',
          p2p: { mode: 'auto', offer_path: 'p2p', result_path: 'p2p', rtt_ms: 4 },
        }),
      });
      await request(`${relay.url}/v1/result`, {
        method: 'POST',
        token: b.token,
        body: envelopeForTask(taskId, 'machine-b', { transport: 'relay' }),
      });

      const session = await registerPlugin({
        config: {
          rabbitUrl: relay.url,
          stateDir: (await makeDeviceDir(relay, 'machine-origin')).dir,
          projectDir: await makeScratchDir(),
          operatorToken: OP,
        },
      });
      try {
        const value = JSON.parse(
          await session.tools.get('w2m_wait').execute({ task_id: taskId, wait_ms: 2000, poll_ms: 25 }, {}),
        );

        assert.equal(value.ok, true);
        const byId = new Map(value.machines.map((machine) => [machine.machine_id, machine]));
        assert.equal(byId.get('machine-a').transport, 'p2p', 'the fast path is reported per machine');
        assert.equal(byId.get('machine-a').p2p.result_path, 'p2p');
        assert.equal(byId.get('machine-b').transport, 'relay');
        assert.equal(byId.get('machine-b').p2p, null, 'a machine that said nothing is not given a path');
        // Neither field may be reported as protocol drift: they are known optional fields.
        assert.equal(
          value.unknown_fields.includes('transport') || value.unknown_fields.includes('p2p'),
          false,
          `transport/p2p must be known fields; unknown_fields=${JSON.stringify(value.unknown_fields)}`,
        );
      } finally {
        await session.stop();
      }
    });
  });

  it('THE INVARIANT: two machines that differ only in transport stay consistent', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const b = await pairDevice(relay, 'machine-b');
      const created = await request(`${relay.url}/v1/task`, {
        method: 'POST',
        token: OP,
        body: taskBody(),
      });
      const taskId = created.json.task_id;

      // Byte-identical envelopes apart from the path: one says `p2p`, the other says nothing at all,
      // which is exactly the v0.3.9 shape a mixed fleet produces.
      const overP2P = envelopeForTask(taskId, 'machine-a', { transport: 'p2p' });
      const overRelay = envelopeForTask(taskId, 'machine-b');

      assert.equal((await request(`${relay.url}/v1/result`, { method: 'POST', token: a.token, body: overP2P })).status, 200);
      assert.equal((await request(`${relay.url}/v1/result`, { method: 'POST', token: b.token, body: overRelay })).status, 200);

      const session = await registerPlugin({
        config: {
          rabbitUrl: relay.url,
          stateDir: (await makeDeviceDir(relay, 'machine-origin')).dir,
          projectDir: await makeScratchDir(),
          operatorToken: OP,
        },
      });
      try {
        const value = JSON.parse(
          await session.tools.get('w2m_wait').execute({ task_id: taskId, wait_ms: 2000, poll_ms: 25 }, {}),
        );
        assert.equal(
          value.state,
          'consistent',
          `a path difference must never be a result difference; differences=${JSON.stringify(value.differences)}`,
        );
        assert.deepEqual(value.differences, []);
        // Both paths are still reported — consistency is not achieved by hiding the field. The second
        // machine never claimed a path, so it reports none rather than being assigned one.
        const transports = value.machines.map((machine) => machine.transport).sort();
        assert.deepEqual(transports, [null, 'p2p']);
        assert.equal(value.states.length, 2);
      } finally {
        await session.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 6. relay mode: the direct path is off, mechanically
// ---------------------------------------------------------------------------------------------

describe('v0.4.0 p2pMode=relay', () => {
  it('starts no node and binds no UDP port, and still dispatches', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay, 'machine-origin');
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP, p2pMode: 'relay' },
      });
      try {
        const status = await statusOf(session.tools);
        assert.equal(status.p2p.mode, 'relay');
        assert.equal(status.p2p.running, false, 'relay mode never runs a node');
        assert.equal(status.p2p.started, false);
        assert.equal(status.p2p.enabled, false);
        assert.equal(status.p2p.transport.socket_bound, false, 'no socket exists to be bound');
        assert.equal(status.p2p.local, null);
        assert.equal(status.p2p.inbox.depth, 0);
        assert.match(status.p2p.reason, /relay/);

        // The mechanical claim: not one `dgram` bind was attempted. The binder is a real socket
        // factory, so a zero here is a count of real binds rather than a promise about intent.
        assert.equal(session.binder.bound.length, 0, 'relay mode must bind nothing at all');
        assert.equal(session.node(), null, 'and there is no node to bind with');

        // …and the dispatch still works, which is the point of keeping this mode.
        const value = JSON.parse(await session.tools.get('w2m_run').execute({ command_argv: ARGV }, {}));
        assert.equal(value.ok, true);
        assert.equal(value.direct_pushes.attempted, 0);
        assert.equal(relay.state.getTask(value.task_id) !== null, true);
        assert.equal(session.binder.bound.length, 0, 'a dispatch in relay mode still binds nothing');
      } finally {
        await session.stop();
      }
    });
  });

  it('leaves the host\'s effect list untouched, so there is no disposer for a socket that is not there', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay, 'machine-origin');
      const { ctx, disposers } = makeCtx();
      await plugin.apply(ctx, {
        rabbitUrl: relay.url,
        stateDir: dir,
        projectDir: dir,
        operatorToken: OP,
        p2pMode: 'relay',
      });
      assert.equal(disposers.length, 0);
    });
  });
});

describe('v0.4.0 auto mode owns exactly one socket', () => {
  it('binds one UDP socket on an ephemeral port when the direct path is used', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay, 'machine-origin');
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP },
      });
      try {
        await statusOf(session.tools);
        assert.equal(session.binder.bound.length, 1, 'exactly one socket for the node\'s whole life');
        const status = await statusOf(session.tools);
        assert.equal(status.p2p.running, true);
        assert.equal(status.p2p.transport.socket_bound, true);
        assert.equal(status.p2p.transport.address.port, session.binder.bound[0].port);
        assert.equal(status.p2p.enabled, true);

        // A second call must not bind a second socket: `ensureStarted` is idempotent and so is the
        // node's own `start()`.
        await session.tools.get('w2m_run').execute({ command_argv: ARGV }, {});
        assert.equal(session.binder.bound.length, 1, 'the node is never rebound');
      } finally {
        await session.stop();
      }
    });
  });

  it('reports a start failure in w2m_status instead of throwing at load', async () => {
    await withRelay(async (relay) => {
      const { dir } = await makeDeviceDir(relay, 'machine-origin');
      // A node that cannot bind its socket: the case the contract says must be reported, never
      // thrown, because a machine that cannot punch must still dispatch.
      const session = await registerPlugin({
        config: { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP },
      });
      try {
        // Replace the binder's behaviour for this node by starting a *second* plugin whose binder
        // fails, so the failure is the real `P2P_BIND_FAILED` path rather than a stubbed status.
        const failing = await registerPluginWithBinder(async () => {
          throw new Error('socket refused');
        }, { rabbitUrl: relay.url, stateDir: dir, projectDir: dir, operatorToken: OP });
        try {
          const status = await statusOf(failing.tools);
          assert.equal(status.p2p.running, false);
          assert.match(status.p2p.last_error, /P2P_BIND_FAILED/);
          // The relay path is unaffected: a dispatch still succeeds.
          const value = JSON.parse(await failing.tools.get('w2m_run').execute({ command_argv: ARGV }, {}));
          assert.equal(value.ok, true);
          assert.equal(value.direct_pushes.attempted, 0);
          assert.match(value.direct_pushes.error, /P2P_BIND_FAILED/);
        } finally {
          await failing.stop();
        }
      } finally {
        await session.stop();
      }
    });
  });
});

/**
 * Register the plugin with a binder that always fails.
 *
 * Separate from {@link registerPlugin} because the failing binder is the point of that one test and
 * every other test needs a real socket.
 *
 * @param {Function} bindUdpSocket
 * @param {object} config
 */
async function registerPluginWithBinder(bindUdpSocket, config) {
  const { ctx, tools, disposers } = makeCtx();
  const recorder = recordFetch();
  await plugin.apply(ctx, {
    ...config,
    p2pBlock: { bindUdpSocket, discover: loopbackDiscovery(), tuning: testTuning() },
  });
  return {
    tools,
    calls: recorder.calls,
    stop: async () => {
      for (const dispose of disposers) await Promise.resolve(dispose()).catch(() => {});
      recorder.restore();
    },
  };
}
