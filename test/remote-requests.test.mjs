import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRemoteRequestBroker, REMOTE_ACK_CODE, REMOTE_REQUEST_CODE } from '../src/relay/remote-requests.mjs';

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

  it('carries the warm-up transport intent without changing the relay default', () => {
    const broker = createRemoteRequestBroker();
    assert.equal(broker.post({
      session_id: 's-web',
      target: 'm1',
      viewer_public_key: key,
      viewer_machine_id: 'v1',
      transport: 'webrtc',
    }).ok, true);
    const taken = broker.take('m1');
    assert.equal(taken.transport, 'webrtc');
    assert.equal(taken.viewer_machine_id, 'v1');
    broker.post({ session_id: 's-old', target: 'm2', viewer_public_key: key });
    const old = broker.take('m2');
    assert.equal(old.transport, 'relay');
    assert.equal(old.viewer_machine_id, null);
  });

  it('keeps a warm-up ack until its viewer reads it once', () => {
    let now = 1000;
    const broker = createRemoteRequestBroker({ ackTtlMs: 500, now: () => now });
    assert.equal(broker.ack({
      session_id: 's1',
      target: 'm1',
      viewer_machine_id: 'v1',
      ok: true,
      code: 'WEBRTC_PREPARED',
    }).ok, true);
    assert.equal(broker.takeAck('m1', 's1', 'v2').code, REMOTE_ACK_CODE.FORBIDDEN, 'another machine cannot consume it');
    const got = broker.takeAck('m1', 's1', 'v1');
    assert.equal(got.ok, true);
    assert.equal(got.prepared, true);
    assert.equal(broker.takeAck('m1', 's1', 'v1').code, REMOTE_ACK_CODE.NOT_FOUND);
    now += 1000;
    broker.ack({ session_id: 's2', target: 'm2', viewer_machine_id: 'v1', ok: false, code: 'WEBRTC_POOL_UNAVAILABLE' });
    now += 1000;
    assert.equal(broker.takeAck('m2', 's2', 'v1').code, REMOTE_ACK_CODE.NOT_FOUND);
  });

  it('refuses an ack without a boolean answer', () => {
    const broker = createRemoteRequestBroker();
    assert.equal(broker.ack({ session_id: 's', target: 'm', viewer_machine_id: 'v' }).code, REMOTE_ACK_CODE.BAD);
    assert.equal(broker.ack(null).code, REMOTE_ACK_CODE.BAD);
  });
});
