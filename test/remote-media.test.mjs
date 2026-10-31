import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRemoteMediaBroker, parseRemoteFrame, REMOTE_MEDIA_CODE } from '../src/relay/remote-media.mjs';

describe('P1.5 encrypted relay media broker', () => {
  it('stores one latest ciphertext frame per session and consumes it once', () => {
    let now = 1000;
    const broker = createRemoteMediaBroker({ maxBytes: 47 * 1024, ttlMs: 1000, now: () => now });
    assert.equal(broker.open('s1', 'm1').ok, true);
    assert.equal(broker.put('s1', 'm1', Buffer.alloc(2048, 9)).ok, true);
    assert.equal(broker.put('s1', 'm1', Buffer.alloc(1024, 8)).ok, true);
    const taken = broker.take('s1', 'm1');
    assert.equal(taken.ok, true);
    assert.equal(taken.bytes, 1024);
    assert.equal(broker.take('s1', 'm1').code, REMOTE_MEDIA_CODE.NOT_FOUND);
    now += 2000;
    assert.equal(broker.take('s1', 'm1').code, REMOTE_MEDIA_CODE.EXPIRED);
  });

  it('refuses oversized, wrong-target and malformed payloads', () => {
    const broker = createRemoteMediaBroker({ maxBytes: 1000 });
    broker.open('s1', 'm1');
    assert.equal(broker.put('s1', 'm1', Buffer.alloc(1001)).code, REMOTE_MEDIA_CODE.TOO_LARGE);
    assert.equal(broker.put('s1', 'm2', Buffer.alloc(10)).code, REMOTE_MEDIA_CODE.BAD_SESSION);
    assert.equal(broker.put('s1', 'm1', 'not-bytes').code, REMOTE_MEDIA_CODE.BAD_PAYLOAD);
    assert.equal(parseRemoteFrame({ session_id: 's1', target: 'm1', ct: Buffer.from('x').toString('base64') }).ok, true);
    assert.equal(parseRemoteFrame({ session_id: 's1', target: '', ct: 'eA==' }).code, REMOTE_MEDIA_CODE.BAD_SESSION);
  });
});
