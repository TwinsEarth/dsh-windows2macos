#!/usr/bin/env node
/**
 * Verify the fleet-join path without a relay, a pairing code, or a real account.
 *
 * ## Why this exists
 *
 * The join is two halves: **pair** (read the account, derive the fleet key, `POST /v1/pair`, write
 * `device.json`) and **run** (`agent.start()`, which opens an SSE stream bound to the public relay
 * for the life of the process). Only the first half is what this script is about, and the second half
 * makes it impossible to test honestly with a real agent: any test that starts one talks to
 * `202.182.123.154` and never returns.
 *
 * That is how the in-process join shipped broken for several releases -- the code that was supposed
 * to join threw on every start (`createAgent: identity.machine_id is required`), and nothing
 * exercised it. `src/plugin/tools.mjs` exposes `setCreateAgentForTests`, so this script can drive the
 * join sequence against a stub agent and assert what a real one would have been asked to do.
 *
 * ## What it proves
 *
 * 1. **The agent is constructed with a real identity.** The defect this catches is
 *    `identity: identityOptions.identity` where nothing ever assigned that property, so `createAgent`
 *    received `undefined` and threw before anything could pair.
 * 2. **A late account still joins.** The mount path runs while the account profile is cold (which is
 *    what DSH does -- `getPlatformSession().userId` is null until a `getProfile` has happened), and
 *    the machine must still join once the account answers.
 * 3. **The token is persisted.** `agent.pair()` only sets `device_token` in memory; a machine that
 *    pairs and does not write it answers 401 to everything after the next restart.
 * 4. **A missing hardware fingerprint does not cost the fleet key.** The key comes from the account's
 *    `userId`; the fingerprint only affects the serial number. On Windows both fingerprint sources can
 *    come back empty, and that used to discard the key after computing it.
 * 5. **A machine that holds a token never re-pairs.** The relay allows five pairings a minute.
 *
 * Usage:
 *
 *   node scripts/verify-join.mjs
 *
 * Exits 0 when every property holds, 1 otherwise, naming the first that does not.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../src/plugin/tools.mjs';
import { createAccountIdentity } from '../src/chatops/account.mjs';

/** A UUID: `deriveAccountFleetKey` refuses anything shorter as "the account code, not the id". */
const USER_ID = '9d6f2a1c-4e7b-4a3d-9f1e-2b8c5d0a7e64';

/** What the stub relay hands back, so the persisted value can be compared exactly. */
const PAIRED_TOKEN = 'tok-verify-join-0123456789';

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    process.stdout.write(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}\n`);
    failures.push(label);
  }
}

const stateDir = await mkdtemp(join(tmpdir(), 'w2m-verify-join-'));
const deviceFile = join(stateDir, 'device.json');
const previousDeviceFile = process.env.DSH_DEVICE_FILE;
// `deviceFilePath()` honours this, so the run reads and writes a throwaway identity rather than the
// real `~/.dsh/xclient/device.json` -- including the token write.
process.env.DSH_DEVICE_FILE = deviceFile;

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const log = { info: [], warn: [] };

/** Every `agent.pair()` this run performed. */
const pairCalls = [];
/** Any request that reached a `/v1/pair` fetch: with a stub agent, there should be none. */
const unexpectedPairPosts = [];

/** A `deepseekAccount` shaped service that answers only once `ready` is set. */
let ready = false;
const accountService = {
  async getDeviceIdentity() {
    return ready ? { deviceId: 'device-1', userId: USER_ID } : { deviceId: 'device-1' };
  },
};

const tools = new Map();
const started = [];
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return definition; } },
  logger: {
    info: (m) => log.info.push(String(m)),
    warn: (m) => log.warn.push(String(m)),
    error: () => {},
    debug: () => {},
  },
  get: (name) => (name === 'deepseekAccount' ? accountService : null),
  effect: (fn) => { started.push(Promise.resolve().then(fn)); },
};

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.endsWith('/v1/pair')) {
    unexpectedPairPosts.push(href);
    return new Response(
      JSON.stringify({ device_token: PAIRED_TOKEN, protocol_version: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (href.endsWith('/healthz')) {
    return new Response(JSON.stringify({ ok: true, protocol_version: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`verify-join: unexpected request ${href}`);
};

/** The deferred join timer is a real 15 s `unref`'d timer; this run does not need to wait for it. */
globalThis.setTimeout = function swallowJoinRetry(fn, ms, ...rest) {
  if (typeof ms === 'number' && ms >= 15000) return { unref() {} };
  return realSetTimeout(fn, ms, ...rest);
};

const agents = [];
plugin.setCreateAgentForTests(async (options) => {
  const record = { options, paired: null };
  const agent = {
    identity: () => options.identity,
    status: () => ({}),
    async pair(pairingCode, userId, fleetKey) {
      record.paired = { pairingCode, userId, fleetKey };
      pairCalls.push(record);
      return { device_token: PAIRED_TOKEN, protocol_version: 1 };
    },
    async start() {},
    async stop() {},
  };
  record.agent = agent;
  agents.push(record);
  return agent;
});

const token = () => readFile(deviceFile, 'utf8').then((t) => JSON.parse(t).device_token, () => null);

/**
 * Wait until a predicate holds, or give up.
 *
 * `ctx.effect` receives the *promise* `startLocalStack` returns, but the plugin does not await it and
 * neither may this script assume it has finished by the time `apply()` resolves. Waiting on the
 * observable state (a token on disk, a pairing recorded) is the honest synchronisation here: it is
 * the same condition the production code branches on. Whether the join completes during the mount
 * continuation or during a tool call is deliberately not asserted -- both are correct.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => realSetTimeout(resolve, 50));
  }
  return predicate();
}

/** Run a tool body, giving up after a deadline: its own work is not this script's subject. */
async function runTool(tool, ms = 8000) {
  if (!tool) return;
  await Promise.race([
    Promise.resolve().then(() => tool.execute({}, {})).catch(() => {}),
    new Promise((resolve) => realSetTimeout(resolve, ms)),
  ]);
}

try {
  process.stdout.write('late-account join\n');

  // Mount with the profile cold: the state DSH is actually in when the plugin applies.
  await plugin.apply(ctx, { p2pMode: 'relay', autoStartAgent: true, stateDir, projectDir: stateDir });
  await Promise.all(started);
  // The mount path derives with a short budget; give it room to finish before judging.
  await waitFor(() => pairCalls.length > 0, 6000);

  check('the agent is constructed', agents.length === 1, `agents=${agents.length}`);
  check(
    'the agent receives a real identity (createAgent requires identity.machine_id)',
    Boolean(agents[0]?.options?.identity?.machine_id),
    'identity was undefined -- the in-process join would throw on every start',
  );
  check('nothing is paired while the account cannot be read', (await token()) === null);
  check('no pairing is attempted without a fleet key', pairCalls.length === 0, `pairings=${pairCalls.length}`);
  check(
    'the machine says it is in no fleet rather than staying silent',
    log.warn.some((w) => /not in a fleet yet/.test(w)),
  );

  // The profile loads -- minutes later in production; the next call here. A tool call is the moment
  // the account is guaranteed to exist, and it is what must finish the join.
  ready = true;
  const status = tools.get('w2m_status');
  check('w2m_status is registered', Boolean(status));
  await runTool(status);
  await waitFor(() => pairCalls.length > 0, 8000);

  check('the machine joins once the account answers', pairCalls.length === 1, `pairings=${pairCalls.length}`);
  check('the token is persisted, not just held in memory', (await token()) === PAIRED_TOKEN);
  const fleetKey = pairCalls[0]?.paired?.fleetKey ?? null;
  check('the pairing presents a derived fleet key', typeof fleetKey === 'string' && fleetKey.length === 43);
  check(
    'the pairing names the identity on disk',
    pairCalls[0]?.options?.identity?.machine_id === agents[0]?.options?.identity?.machine_id,
  );
  check('no pairing went over the stub agent (the stub owns pair())', unexpectedPairPosts.length === 0);

  // Further calls must not re-pair: the relay allows five a minute.
  for (let i = 0; i < 3; i += 1) await runTool(status);
  check('a machine holding a token never re-pairs', pairCalls.length === 1, `pairings=${pairCalls.length}`);

  process.stdout.write('fleet key without a hardware fingerprint\n');
  const identity = createAccountIdentity({
    platform: 'win32',
    account: { async getDeviceIdentity() { return { deviceId: 'device-1', userId: USER_ID }; } },
    // What `readHardwareValues` returns on a Windows host where both sources come back empty.
    hardware: { read: async () => null },
  });
  const resolved = await identity.resolve();
  check(
    'no fingerprint means no serial number, and that is reported',
    resolved.ok === false && resolved.reason === 'no_hardware_source',
  );
  check('no serial number is invented', resolved.sn === undefined);
  check(
    'the fleet key survives the fingerprint failure',
    typeof resolved.fleetKey === 'string' && resolved.fleetKey.length === 43,
  );
  check('the account code travels with it', typeof resolved.accountCode === 'string' && resolved.accountCode.length === 8);
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  plugin.setCreateAgentForTests(null);
  if (previousDeviceFile === undefined) delete process.env.DSH_DEVICE_FILE;
  else process.env.DSH_DEVICE_FILE = previousDeviceFile;
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed:\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write('\nall checks passed\n');
process.exit(0);
