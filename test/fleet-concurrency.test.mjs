/**
 * Concurrency: what happens when several machines publish at the same time.
 *
 * ## What this file is actually testing
 *
 * v1.0.12 closed the end-to-end gap for **one machine at a time** and recorded concurrency as unverified. The honest
 * question is narrow: the blob store keeps its ownership index as a read-modify-write
 * (`readBlobIndex` -> mutate -> `writeBlobIndex`), and a lost update there would produce **a stored blob with no
 * owner**, which is unreadable by the fleet that wrote it.
 *
 * ## Why it might be safe, stated so the test can falsify it
 *
 * `RabbitState.putFleetBlob` and `Persistence.putBlob` do no awaiting: every filesystem call in that path is the
 * **synchronous** `fs` API. The request handler awaits the body first, and after that the whole
 * read-mutate-write runs to completion inside one Node job. On a single-threaded event loop that makes each publish
 * atomic with respect to every other request **on the same relay process**.
 *
 * **That reasoning is exactly what this file tests rather than asserts.** If any part of the path ever becomes
 * asynchronous, these tests fail with a lost index entry -- which is far better than discovering it in a fleet.
 *
 * ## What is deliberately NOT covered
 *
 * **Two relay processes sharing one state directory.** The design is one relay per fleet; two processes over one
 * directory would need real file locking and is out of scope. Recorded here so "concurrency is tested" is not read as
 * "any topology is safe".
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';

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

async function startRelay() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-conc-relay-'));
  cleanup.push(stateDir);
  const relay = createRelayServer({ logger: null, operatorToken: 'op', stateDir, persist: true });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  return relay;
}

async function pair(relay, machineId, fleetId) {
  const res = await fetch(`${relay.url}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairing_code: relay.state.createPairingCode(fleetId === undefined ? {} : { fleetId }),
      machine_id: machineId,
      machine_name: machineId,
      platform: PLATFORM,
      caps: CAPS,
    }),
    signal: AbortSignal.timeout(30000),
  });
  // Read the body BEFORE asserting: `assert.equal(s, want, await res.text())` evaluates its message argument
  // unconditionally, so passing a body read as the message consumes it and the later `.json()` throws
  // "Body is unusable".
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text).device_token;
}

const put = (relay, token, text) => fetch(`${relay.url}/v1/fleet/blobs/${sha256(text)}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
  body: text,
  signal: AbortSignal.timeout(30000),
});

describe('concurrent publishing', () => {
  it('does not lose an ownership entry when ten publishes race', async () => {
    const relay = await startRelay();
    try {
      const token = await pair(relay, 'conc-1');
      const docs = Array.from({ length: 10 }, (_, i) => `document ${i}\n`);

      // Fired together, no awaiting in between: this is the shape that would expose a lost update.
      const results = await Promise.all(docs.map((doc) => put(relay, token, doc)));
      for (const res of results) {
        const body = res.status === 201 ? '' : await res.text();
        assert.equal(res.status, 201, body);
      }

      // Every blob must still be readable AND still owned. A lost index entry shows up as a 404 here.
      for (const doc of docs) {
        const got = await fetch(`${relay.url}/v1/fleet/blobs/${sha256(doc)}`, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
        });
        assert.equal(got.status, 200, `blob for ${JSON.stringify(doc.trim())} was lost or unowned`);
        assert.equal(await got.text(), doc);
      }

      const index = relay.persistence.readBlobIndex();
      assert.equal(Object.keys(index).length, 10, 'ten publishes must leave ten ownership entries');
      for (const doc of docs) {
        assert.ok(index[sha256(doc)], 'every blob must have an owner record');
        assert.equal(index[sha256(doc)].fleet_id, null, 'legacy scope: the shared null fleet');
      }
    } finally {
      await relay.close();
    }
  });

  it('leaves the latest pointer naming one of the documents that were actually written', async () => {
    const relay = await startRelay();
    try {
      const token = await pair(relay, 'conc-2');
      const docs = Array.from({ length: 8 }, (_, i) => `racing document ${i}\n`);
      await Promise.all(docs.map((doc) => put(relay, token, doc)));

      const pointer = await (await fetch(`${relay.url}/v1/fleet/blobs/latest`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      })).json();

      const known = new Set(docs.map(sha256));
      assert.ok(known.has(pointer.hash), 'the pointer must name a document that was written, not a torn value');

      // And whatever it names must still be readable: a pointer to a lost blob is the failure this guards.
      const got = await fetch(`${relay.url}/v1/fleet/blobs/${pointer.hash}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      });
      assert.equal(got.status, 200);
      assert.ok(docs.includes(await got.text()), 'the pointer must resolve to one of the actual documents');
    } finally {
      await relay.close();
    }
  });

  it('keeps two fleets separate when they publish at the same moment', async () => {
    const relay = await startRelay();
    try {
      const tokenA = await pair(relay, 'conc-A', 'conc-fleet-A');
      const tokenB = await pair(relay, 'conc-B', 'conc-fleet-B');
      const docA = 'from fleet A\n';
      const docB = 'from fleet B\n';
      await Promise.all([put(relay, tokenA, docA), put(relay, tokenB, docB)]);

      const latestOf = async (token) => (await fetch(`${relay.url}/v1/fleet/blobs/latest`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      })).json();

      assert.equal((await latestOf(tokenA)).hash, sha256(docA), "A's pointer must name A's document");
      assert.equal((await latestOf(tokenB)).hash, sha256(docB), "B's pointer must name B's document");

      const index = relay.persistence.readBlobIndex();
      assert.equal(index[sha256(docA)].fleet_id, 'conc-fleet-A');
      assert.equal(index[sha256(docB)].fleet_id, 'conc-fleet-B');
    } finally {
      await relay.close();
    }
  });

  it('reports a stable pointer once the racing publishes have settled', async () => {
    const relay = await startRelay();
    try {
      const token = await pair(relay, 'conc-3');
      const docs = Array.from({ length: 6 }, (_, i) => `settled ${i}\n`);
      await Promise.all(docs.map((doc) => put(relay, token, doc)));

      const read = async () => (await fetch(`${relay.url}/v1/fleet/blobs/latest`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      })).json();
      const first = await read();
      const second = await read();
      assert.equal(first.hash, second.hash, 'the pointer must not drift after the writers have stopped');
      assert.equal(first.published_at, second.published_at);
    } finally {
      await relay.close();
    }
  });
});
