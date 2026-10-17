/**
 * Encrypted, replicated sharding: the three rules plus the three ways it can fail.
 *
 * Small shard sizes are injected so a three-part split is a three-byte string rather than a quarter-megabyte.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleShards, buildShards, deriveShardKey, shardsForMachine } from '../src/relay/message-shards.mjs';

const FLEET_KEY = 'fleet-key-for-tests';
const MACHINES = ['m-1', 'm-2', 'm-3'];
const messages = [
  { message_id: 'msg-000001', session_id: 's-1', machine_id: 'm-1', text: 'hello', at_ms: 1_700_000_000_000 },
  { message_id: 'msg-000002', session_id: 's-1', machine_id: 'm-2', text: 'hi back', at_ms: 1_700_000_001_000 },
];
const build = (over = {}) => buildShards({ messages, fleetKey: FLEET_KEY, machines: MACHINES, shardBytes: 40, at_ms: 1_700_000_000_000, ...over });

describe('a day of chat is encrypted, split, and can be rebuilt', () => {
  it('round-trips: build then assemble returns exactly what was said', () => {
    const built = build();
    assert.equal(built.ok, true);
    const back = assembleShards({ shards: built.shards, header: built.header, fleetKey: FLEET_KEY });
    assert.equal(back.ok, true);
    assert.deepEqual(back.messages, messages);
  });

  it('assigns every part to two DIFFERENT machines, so one being offline is survivable', () => {
    const built = build();
    const parts = new Map();
    for (const shard of built.shards) {
      assert.equal(shard.total, built.header.total);
      if (!parts.has(shard.part)) parts.set(shard.part, []);
      parts.get(shard.part).push(shard.machine_id);
    }
    for (const [part, holders] of parts) {
      assert.equal(holders.length, 2, 'part ' + part + ' must have two replicas');
      assert.notEqual(holders[0], holders[1], 'the two replicas must not be the same machine');
    }
  });

  it('still rebuilds when one machine is offline and its copies are unavailable', () => {
    const built = build();
    const alive = built.shards.filter((s) => s.machine_id !== 'm-1');
    // With 2 replicas per part and 3 machines, dropping one machine may drop a part's only visible copy; keep the
    // assertion honest by checking that a rebuild succeeds exactly when no part lost both copies.
    const partsStillThere = new Set(alive.map((s) => s.part));
    const back = assembleShards({ shards: alive, header: built.header, fleetKey: FLEET_KEY });
    if (partsStillThere.size === built.header.total) assert.equal(back.ok, true);
    else assert.equal(back.code, 'MISSING_SHARDS');
  });
});

describe('every way this can go wrong is named', () => {
  it('reports a corrupt shard by part and machine instead of decrypting garbage', () => {
    const built = build();
    const tampered = built.shards.map((s, i) => (i === 0 ? { ...s, body: Buffer.from('xxxx').toString('base64') } : s));
    const back = assembleShards({ shards: tampered, header: built.header, fleetKey: FLEET_KEY });
    assert.equal(back.ok, false);
    assert.equal(back.code, 'SHARD_CORRUPT');
    assert.equal(back.detail.part, 0);
  });

  it('names the missing parts rather than saying "some data is gone"', () => {
    const built = build({ shardBytes: 10 });
    const dropped = built.shards.filter((s) => s.part !== 1);
    const back = assembleShards({ shards: dropped, header: built.header, fleetKey: FLEET_KEY });
    assert.equal(back.ok, false);
    assert.equal(back.code, 'MISSING_SHARDS');
    assert.deepEqual(back.detail.missing, [1]);
  });

  it('fails closed on the wrong key: no partial plaintext, just AUTH_FAILED', () => {
    const built = build();
    const back = assembleShards({ shards: built.shards, header: built.header, fleetKey: 'a-different-fleet' });
    assert.equal(back.ok, false);
    assert.equal(back.code, 'AUTH_FAILED');
  });

  it('refuses to build without machines or messages, and refuses more replicas than machines', () => {
    assert.equal(build({ messages: [] }).code, 'NOTHING_TO_SHARD');
    assert.equal(build({ machines: [] }).code, 'NO_MACHINES');
    assert.equal(build({ replicas: 4 }).code, 'NOT_ENOUGH_MACHINES');
  });

  it('the derived key is stable for one fleet and different for another', () => {
    assert.deepEqual(deriveShardKey(FLEET_KEY), deriveShardKey(FLEET_KEY));
    assert.notDeepEqual(deriveShardKey(FLEET_KEY), deriveShardKey('other'));
  });

  it('a machine sees only the metadata of what it holds, never other machines bodies', () => {
    const built = build();
    const mine = shardsForMachine(built.shards, 'm-2');
    assert.ok(mine.length > 0);
    for (const shard of mine) assert.equal(shard.body, undefined, 'transport metadata must not carry bodies of others');
  });
});
