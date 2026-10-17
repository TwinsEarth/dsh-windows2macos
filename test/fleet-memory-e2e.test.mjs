/**
 * The fleet memory actions, end to end: a real relay, a real profile, a real `fleet-memory.md`.
 *
 * ## Why this file exists
 *
 * Every one of these actions was shipped marked **UNVERIFIED**: `publish`, `pull`, `latest`, `diff`, `merge`. The
 * rule inside `merge` was proven exhaustively against a pure function, and the relay routes were proven against a
 * real relay -- **but nothing had ever executed the tool surface itself.** That is exactly the gap this repository
 * keeps having to restate: a mechanism with no caller is indistinguishable from a finished feature, and a caller with
 * no execution is indistinguishable from a working one.
 *
 * This is the one test that closes it, and it is deliberately a **single scenario rather than five isolated ones**:
 * the property being demonstrated is that the sequence works *together* -- publish, discover, fetch, compare, merge --
 * because that sequence is what a machine actually does.
 */
import assert from 'node:assert/strict';

/**
 * v1.1.6: `autoStartAgent` defaults to true. Cases in this file are about something else, so the harness pins it off
 * once; call sites were renamed first, so this wrapper's own `plugin.apply` is still a real call.
 */
function applyPinned(ctx, config = {}) {
  return plugin.apply(ctx, { autoStartAgent: false, ...config });
}
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as plugin from '../src/plugin/tools.mjs';
import { createRelayServer } from '../src/relay/server.mjs';

const OP = 'operator-token-e2e';
const CAPS = {
  case_sensitive_fs: false, symlinks: false, exec_bit: false,
  python: null, npm: null, node: 'v24.21.0', write: true,
};
const PLATFORM = { os: 'windows', os_version: '10.0.26100', arch: 'x64', shell: 'pwsh', shell_version: '7.4.0' };

const cleanup = [];
after(async () => {
  for (const dir of cleanup) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const tmp = async (prefix) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

/** A throwaway plugin context: just the seams `apply` needs. */
function makeCtx() {
  const tools = new Map();
  const warnings = [];
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(!tools.has(definition.name), `tool \`${definition.name}\` registered twice`);
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: { warn: (m) => warnings.push(String(m)), info: () => {}, error: () => {}, debug: () => {} },
    inject(_names, callback) { callback(ctx); },
  };
  return { ctx, tools, warnings };
}

/**
 * One whole fleet exchange: pair a device against a live relay, then run the five memory actions in the order a
 * machine would.
 */
describe('fleet memory actions, end to end', () => {
  it('publishes, discovers, pulls, compares and merges against a live relay', async () => {
    const relayStateDir = await tmp('w2m-e2e-relay-');
    const relay = createRelayServer({
      logger: null,
      operatorToken: OP,
      stateDir: relayStateDir,
      persist: true,
    });
    await relay.listen({ host: '127.0.0.1', port: 0 });
    try {
      // ---- a real device, paired through the real route ---------------------------------------------------------
      const pairRes = await fetch(`${relay.url}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: relay.state.createPairingCode(),
          machine_id: 'e2e-machine',
          machine_name: 'e2e',
          platform: PLATFORM,
          caps: CAPS,
        }),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(pairRes.status, 200, 'the relay must pair this test device');
      const deviceToken = (await pairRes.json()).device_token;
      assert.equal(typeof deviceToken, 'string');

      // ---- the plugin's own state dir, holding that device ----------------------------------------------------
      const stateDir = await tmp('w2m-e2e-state-');
      await fs.writeFile(path.join(stateDir, 'device.json'), JSON.stringify({
        machine_id: 'e2e-machine', machine_name: 'e2e', device_token: deviceToken, rabbit_url: relay.url,
      }, null, 2), 'utf8');

      // ---- a profile with a real collective memory ------------------------------------------------------------
      const profileDir = await tmp('w2m-e2e-profile-');
      const memoryFile = path.join(profileDir, 'fleet-memory.md');
      const localDoc = [
        '# Fleet memory',
        '- 〔id:timeout〕default timeout is 300 s',
        '- 〔id:rotate〕memory.jsonl rotates at 1 MB',
      ].join('\n');
      await fs.writeFile(memoryFile, localDoc, 'utf8');

      const { ctx, tools } = makeCtx();
      await applyPinned(ctx, { rabbitUrl: relay.url, stateDir, profileDir, operatorToken: OP });
      const memory = tools.get('w2m_memory');
      assert.ok(memory, 'w2m_memory must be registered');

      // ---- publish --------------------------------------------------------------------------------------------
      const published = JSON.parse(await memory.execute({ action: 'publish' }, {}));
      assert.equal(published.ok, true, published.error?.message);
      assert.match(published.hash, /^[0-9a-f]{64}$/);
      assert.equal(published.bytes, Buffer.byteLength(localDoc));

      // ---- latest: discovery without being told the hash ------------------------------------------------------
      const latest = JSON.parse(await memory.execute({ action: 'latest' }, {}));
      assert.equal(latest.ok, true);
      assert.equal(latest.hash, published.hash, 'the pointer must name what publish just wrote');
      assert.equal(latest.published_by, 'e2e-machine');

      // ---- pull latest: the ergonomic form, verified by re-hash ------------------------------------------------
      const pulled = JSON.parse(await memory.execute({ action: 'pull', hash: 'latest' }, {}));
      assert.equal(pulled.ok, true, pulled.error?.message);
      assert.equal(pulled.via_latest, true);
      assert.equal(pulled.hash, published.hash);
      assert.equal(pulled.content, localDoc, 'the bytes must round-trip exactly');

      // ---- diff: same document, so nothing differs -------------------------------------------------------------
      const same = JSON.parse(await memory.execute({ action: 'diff' }, {}));
      assert.equal(same.same, true);
      assert.equal(same.differing_lines, 0);
      assert.equal(same.wrote_anything, false);

      // ---- the fleet moves ahead: another publisher replaces the document --------------------------------------
      const fleetDoc = [
        '# Fleet memory',
        '- 〔id:timeout〕default timeout is 600 s',
        '- 〔id:rotate〕memory.jsonl rotates at 1 MB',
      ].join('\n');
      const fleetPut = await fetch(`${relay.url}/v1/fleet/blobs/${await sha256(fleetDoc)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/octet-stream' },
        body: fleetDoc,
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(fleetPut.status, 201, await fleetPut.text());

      // ---- diff now reports the divergence, and writes nothing -------------------------------------------------
      const differ = JSON.parse(await memory.execute({ action: 'diff' }, {}));
      assert.equal(differ.same, false);
      assert.ok(differ.differing_lines > 0, 'a changed fact must show up as a difference');
      assert.equal(differ.wrote_anything, false);
      assert.equal(await fs.readFile(memoryFile, 'utf8'), localDoc, 'diff must not touch the local document');

      // ---- merge applies the rule and returns TEXT, still writing nothing --------------------------------------
      const merged = JSON.parse(await memory.execute({ action: 'merge' }, {}));
      assert.equal(merged.ok, true, merged.error?.message);
      assert.equal(merged.wrote_anything, false);
      assert.equal(merged.decisions.length, 1, 'one divergent id, one recorded decision');
      assert.equal(merged.decisions[0].id, 'timeout');
      // Neither side declared a repair, so the default layer applies: the newer publication wins.
      assert.equal(merged.decisions[0].winner, 'fleet');
      assert.equal(merged.decisions[0].layer, 'default');
      assert.match(merged.merged_text, /600 s/, 'the merged text must carry the winning value');
      assert.match(merged.merged_text, /<!-- timeout -> fleet \(default\)/, 'the choice must be auditable');
      assert.equal(await fs.readFile(memoryFile, 'utf8'), localDoc, 'merge must not touch the local document either');
    } finally {
      await relay.close();
    }
  });
});

/** The hash the relay will check the PUT body against. */
async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
