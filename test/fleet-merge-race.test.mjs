/**
 * Merge under contention: what happens when a third machine publishes while a merge is reading.
 *
 * ## Why this is the remaining gap, stated precisely
 *
 * v1.0.13 verified concurrent *publishing*. v1.0.12 verified the memory actions end to end, one machine at a time.
 * **Neither covered a merge racing a publish**, and the merge has a two-step read that the publish can break:
 *
 *   1. `GET /v1/fleet/blobs/latest`         -- learn the hash
 *   2. `GET /v1/fleet/blobs/<hash>`         -- fetch the bytes, re-hash, merge
 *
 * Between those two steps the pointer can advance (harmless: the merge still reads the blob it was told about) or the
 * blob can be **evicted** (fatal if unhandled: a 404 where the code expected bytes).
 *
 * ## What "correct" means here
 *
 * There is no single right answer for which document a racing merge sees -- that is the nature of a read that is not
 * in a transaction. What **is** required:
 *
 *   * it never throws an error it cannot name;
 *   * it never produces a **torn merge**: a result whose recorded decision does not match the document it actually
 *     read;
 *   * it never writes the local file, under any outcome;
 *   * when the blob vanishes mid-flight, it says so by name rather than crashing.
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
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';

import * as plugin from '../src/plugin/tools.mjs';
import { createRelayServer } from '../src/relay/server.mjs';

const CAPS = {
  case_sensitive_fs: false, symlinks: false, exec_bit: false,
  python: null, npm: null, node: 'v24.21.0', write: true,
};
const PLATFORM = { os: 'windows', os_version: '10.0.26100', arch: 'x64', shell: 'pwsh', shell_version: '7.4.0' };
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const cleanup = [];
after(async () => {
  for (const dir of cleanup) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
const tmp = async (p) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), p));
  cleanup.push(dir);
  return dir;
};

function makeCtx() {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(!tools.has(definition.name));
        tools.set(definition.name, definition);
        return definition;
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    inject(_names, callback) { callback(ctx); },
  };
  return { ctx, tools };
}

/**
 * Stand up a relay, a paired device, and a plugin wired at them.
 *
 * @param {{localDoc: string}} options
 */
async function standUp(localDoc) {
  const relayStateDir = await tmp('w2m-race-relay-');
  const relay = createRelayServer({ logger: null, operatorToken: 'op', stateDir: relayStateDir, persist: true });
  await relay.listen({ host: '127.0.0.1', port: 0 });

  const pairRes = await fetch(`${relay.url}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairing_code: relay.state.createPairingCode(),
      machine_id: 'race-machine', machine_name: 'race', platform: PLATFORM, caps: CAPS,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const pairBody = await pairRes.text();
  assert.equal(pairRes.status, 200, pairBody);
  const deviceToken = JSON.parse(pairBody).device_token;

  const stateDir = await tmp('w2m-race-state-');
  await fs.writeFile(path.join(stateDir, 'device.json'), JSON.stringify({
    machine_id: 'race-machine', machine_name: 'race', device_token: deviceToken, rabbit_url: relay.url,
  }, null, 2), 'utf8');

  const profileDir = await tmp('w2m-race-profile-');
  const memoryFile = path.join(profileDir, 'fleet-memory.md');
  await fs.writeFile(memoryFile, localDoc, 'utf8');

  const { ctx, tools } = makeCtx();
  await applyPinned(ctx, { rabbitUrl: relay.url, stateDir, profileDir, operatorToken: 'op' });

  const publishVia = (doc) => fetch(`${relay.url}/v1/fleet/blobs/${sha256(doc)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/octet-stream' },
    body: doc,
    signal: AbortSignal.timeout(30000),
  });

  return { relay, deviceToken, memoryFile, publishVia, memory: tools.get('w2m_memory') };
}

/** A named refusal from this plugin is `W2M_*`; anything else escaping a tool call is a crash. */
function namedOrCrash(error) {
  const code = String(error?.code ?? error?.name ?? '');
  return /^W2M_|^ERR_ASSERTION$/.test(code) ? 'named' : 'crash';
}

describe('merging while a third machine publishes', () => {
  it('never tears a merge and never writes the local file, under repeated races', async () => {
    const localDoc = ['# Fleet memory', '- 〔id:timeout〕default timeout is 300 s'].join('\n');
    const fleetA = ['# Fleet memory', '- 〔id:timeout〕default timeout is 600 s'].join('\n');
    const fleetB = ['# Fleet memory', '- 〔id:timeout〕default timeout is 900 s'].join('\n');
    const values = { '300 s': '300', '600 s': '600', '900 s': '900' };

    const { relay, memory, memoryFile, publishVia } = await standUp(localDoc);
    try {
      // Seed one fleet document so the merge has something to read.
      await publishVia(fleetA);

      let succeeded = 0;
      let refused = 0;
      for (let round = 0; round < 20; round += 1) {
        const nextDoc = round % 2 === 0 ? fleetB : fleetA;
        // Fire the merge and a publish together: the merge's two-step read overlaps the publisher.
        const [mergeOutcome] = await Promise.allSettled([
          memory.execute({ action: 'merge' }, {}),
          publishVia(nextDoc),
        ]);

        if (mergeOutcome.status === 'rejected') {
          assert.equal(namedOrCrash(mergeOutcome.reason), 'named',
            `a racing merge must fail by name, not crash: ${mergeOutcome.reason?.stack ?? mergeOutcome.reason}`);
          refused += 1;
        } else {
          const merged = JSON.parse(mergeOutcome.value);
          assert.equal(merged.ok, true);
          assert.equal(merged.wrote_anything, false, 'a merge must never write the local file');
          // **Torn-merge check**: the recorded decision must agree with the text it produced.
          if (merged.decisions.length === 1) {
            const decision = merged.decisions[0];
            assert.equal(decision.id, 'timeout');
            const carried = Object.keys(values).find((v) => merged.merged_text.includes(v));
            assert.ok(carried, 'the merged text must carry one of the actual documents');
            if (decision.winner === 'local') {
              assert.ok(merged.merged_text.includes('300 s'), 'winner=local must carry the local value');
            } else {
              assert.ok(/600 s|900 s/.test(merged.merged_text), 'winner=fleet must carry a fleet value');
            }
          }
          succeeded += 1;
        }
        // Whatever happened, the local document is untouched.
        assert.equal(await fs.readFile(memoryFile, 'utf8'), localDoc, 'the local file must survive every race');
      }
      assert.equal(succeeded + refused, 20, 'every round resolved one way or the other');
      assert.ok(succeeded > 0, 'at least one merge must complete -- otherwise this tested nothing');
    } finally {
      await relay.close();
    }
  });

  it('names the failure when the blob vanishes between the pointer read and the fetch', async () => {
    const localDoc = ['# Fleet memory', '- 〔id:timeout〕default timeout is 300 s'].join('\n');
    const fleetDoc = ['# Fleet memory', '- 〔id:timeout〕default timeout is 600 s'].join('\n');

    const { relay, memory, publishVia } = await standUp(localDoc);
    try {
      await publishVia(fleetDoc);
      // Remove the blob behind the relay's back while the pointer still names it -- what oldest-first eviction does.
      const blobPath = path.join(relay.persistence.dir, 'blobs', sha256(fleetDoc).slice(0, 2), sha256(fleetDoc));
      await fs.rm(blobPath, { force: true });

      const outcome = await Promise.allSettled([memory.execute({ action: 'merge' }, {})]);
      assert.equal(outcome[0].status, 'rejected', 'a merge with no fleet blob must not pretend to succeed');
      const error = outcome[0].reason;
      assert.equal(namedOrCrash(error), 'named', `must fail by name, not crash: ${error?.stack ?? error}`);
      assert.equal(error.code, 'W2M_NOT_FOUND', 'and the name must say what was missing');
    } finally {
      await relay.close();
    }
  });
});
