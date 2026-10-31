import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRemoteRequestBroker, REMOTE_REQUEST_CODE } from '../src/relay/remote-requests.mjs';

const key = Buffer.alloc(32, 7).toString('base64');

describe('P1.5 remote request mailbox', () => {
  it('stores one pending request per target and consumes it once', () => {
    let now = 1000;
    const broker = createRemoteRequestBroker({ ttlMs: 500, now: () => now });
    assert.equal(broker.post({ session_id: 's1', target: 'm1', viewer_public_key: key }).ok, true);
    assert.equal(broker.post({ session_id: 's2', target: 'm1', viewer_public_key: key }).ok, true);
    const taken = broker.take('m1');
    assert.equal(taken.ok, true);
    assert.equal(taken.session_id, 's2');
    assert.equal(taken.viewer_public_key, key);
    assert.equal(broker.take('m1').code, REMOTE_REQUEST_CODE.NOT_FOUND);
    now += 1000;
    broker.post({ session_id: 's3', target: 'm2', viewer_public_key: key });
    now += 1000;
    assert.equal(broker.take('m2').code, REMOTE_REQUEST_CODE.NOT_FOUND);
  });

  it('refuses malformed bodies and wrong key sizes', () => {
    const broker = createRemoteRequestBroker();
    assert.equal(broker.post({ session_id: 's', target: 'm', viewer_public_key: 'AAAA' }).code, REMOTE_REQUEST_CODE.BAD);
    assert.equal(broker.post({ session_id: '', target: 'm', viewer_public_key: key }).code, REMOTE_REQUEST_CODE.BAD);
    assert.equal(broker.post(null).code, REMOTE_REQUEST_CODE.BAD);
  });
});
